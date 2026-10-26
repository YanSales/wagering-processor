# Wagering Processor

Solução para o desafio técnico **Distributed Wagering Processor**, da Jungle Gaming:
<https://github.com/junglegaming/backend-challenge>

O objetivo é um serviço financeiro distribuído que processa transações de apostas vindas de
múltiplos provedores, mantendo correção financeira, idempotência persistente e consistência entre
saldo e ledger sob concorrência, mensagens duplicadas, entregas fora de ordem e falhas de processo.

## Status

**Em construção.** Neste momento o repositório contém:

- a fundação do projeto, o bootstrap do NestJS e `GET /health/live`;
- PostgreSQL via Docker Compose, MikroORM e o schema financeiro (wallets, transações e ledger
  imutável), com constraints no banco e migration versionada;
- o domínio (`Money`, `Wallet`, `WagerTransaction`, ledger, reversões e reconciliação), sem
  dependência de framework;
- `POST /wallets`: abertura atômica de wallet (com a transação interna `OPENING` e o lançamento de
  crédito quando o saldo inicial é positivo);
- `POST /wagering/transactions` para `BET`, `WIN` e `LOSS` sem referência e `REFUND` (header
  `Idempotency-Key` obrigatório), pelo caso de uso
  `SubmitWagerTransaction`: débito (BET) ou crédito (WIN, REFUND) com lançamento, ou só o registro
  (LOSS), e o resultado na mesma transação SQL, lock por wallet
  no PostgreSQL e idempotência persistente;
- REFUND que chega antes da BET: gravado em `PENDING_REFERENCE` (HTTP 202) e resolvido pelo worker
  agendado de cada instância, com backoff exponencial e limite de tentativas (§7.1); esgotado o
  limite, `REJECTED` com `REFERENCE_NOT_FOUND`. Falhas operacionais do worker (nem transitórias nem
  de negócio) entram em quarentena com backoff, sem consumir tentativas nem bloquear as demais
  pendências;
- Transactional Outbox (gravação): os eventos de integração de cada operação
  (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`,
  `WalletBalanceChanged`) são gravados em `outbox_messages` no mesmo commit da alteração
  financeira, com a correlação da operação; as transações guardam essa correlação;
- Publisher da outbox (opcional, `OUTBOX_PUBLISHER_ENABLED=true`): publica os eventos confirmados em
  `wager-events.fifo`, em ordem por wallet (`MessageGroupId`), com deduplicação por `eventId`,
  reserva com expiração entre publishers concorrentes e novas tentativas com backoff;
- SQS FIFO local (ElasticMQ), com provisionamento da fila `wager-events.fifo` e de sua DLQ.

Ainda **não há** processamento de WIN e LOSS com referência e ROLLBACK (a API responde 501), Inbox,
consumo de mensagens de entrada, consultas da API, autenticação (só o ponto de extensão) nem
`GET /health/ready`.
Decisões e limitações estão em [`ARCHITECTURE.md`](ARCHITECTURE.md). Esta seção é atualizada a cada
etapa concluída; nada é descrito como pronto antes de estar implementado e verificado.

## Stack alvo

Definida pelo desafio; PostgreSQL, Docker Compose, MikroORM e o SQS local já estão configurados:

| Item                                          | Escolha                                              |
| --------------------------------------------- | ---------------------------------------------------- |
| Runtime, gerenciador de pacotes e test runner | Bun 1.x                                              |
| Linguagem                                     | TypeScript em modo estrito                           |
| Framework                                     | NestJS                                               |
| Banco de dados                                | PostgreSQL 18                                        |
| Mensageria                                    | AWS SQS FIFO; localmente, ElasticMQ 1.7.1            |
| Orquestração local                            | Docker Compose                                       |
| ORM e migrations                              | MikroORM 7, com migrations versionadas e reversíveis |

## Pré-requisitos

- [Git](https://git-scm.com/)
- [Bun](https://bun.sh/) 1.4 ou superior (a base foi preparada com Bun 1.4.4)
- Docker Desktop com Docker Compose v2 ou superior

## Como começar

```bash
bun install
cp .env.example .env            # ajuste a senha local; o .env não é versionado
cp .env.test.example .env.test  # ambiente dos testes com banco (valores fictícios)
bun run db:up                   # PostgreSQL de desenvolvimento
bun run db:test:up              # PostgreSQL de testes (descartável)
bun run sqs:up                  # SQS local (ElasticMQ) e provisionamento das filas
bun run check
bun run dev            # http://localhost:3000/health/live
```

O Bun carrega o `.env` automaticamente na aplicação e no CLI do MikroORM, e o Docker Compose lê
o mesmo arquivo. Os testes **não** usam o `.env`: veja [Testes](#testes). A porta HTTP é lida de `PORT` (padrão `3000`; inteiro entre 1 e 65535).

A aplicação exige o PostgreSQL em execução: na inicialização a API
valida a conexão com `select 1` e encerra com erro se o banco estiver inacessível ou as
credenciais estiverem erradas.

## Banco de dados

| Variável      | Uso                                             |
| ------------- | ----------------------------------------------- |
| `DB_HOST`     | Host do PostgreSQL (local: `127.0.0.1`)         |
| `DB_PORT`     | Porta (também a porta publicada pelo Compose)   |
| `DB_USER`     | Usuário (criado pelo container na 1ª subida)    |
| `DB_PASSWORD` | Senha (nunca versionar; mensagens não a exibem) |
| `DB_NAME`     | Banco (criado pelo container na 1ª subida)      |
- O serviço `postgres` do `compose.yaml` usa `postgres:18.6-alpine`, publica a porta apenas em
  `127.0.0.1`, persiste os dados no volume `postgres-data` e é limitado a 1 CPU e 512 MB.
- Usuário e banco são criados somente quando o volume está vazio. Para recriar do zero, remova o
  volume conscientemente: `docker compose down -v` (**apaga os dados locais**).
- O schema evolui apenas por migrations versionadas em `src/database/migrations`; não há
  sincronização automática. A aplicação não cria o banco (`ensureDatabase: false`).
- As entidades são registradas explicitamente em `src/database/entities.ts`, compartilhado pela
  aplicação e pelo CLI (`src/mikro-orm.config.ts`).

Validar a conexão e o estado das migrations:

```bash
bunx --bun mikro-orm debug   # mostra a config encontrada e testa a conexão
bun run migration:list       # migrations executadas
bun run migration:pending    # migrations pendentes
bun run migration:check      # verifica se o schema mapeado exige nova migration
```

## Worker de referências pendentes (`PENDING_REFERENCE`)

Roda dentro de cada instância da API; o estado fica no PostgreSQL. Variáveis opcionais (valores
inválidos impedem a inicialização):

| Variável                             | Padrão   | Uso                                                      |
| ------------------------------------ | -------- | -------------------------------------------------------- |
| `PENDING_REFERENCE_WORKER_ENABLED`   | `true`   | `false` desliga o agendamento nesta instância            |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | `1000`   | Intervalo entre o fim de uma rodada e a próxima          |
| `PENDING_REFERENCE_BATCH_SIZE`       | `50`     | Máximo de transações por rodada                          |
| `PENDING_REFERENCE_MAX_ATTEMPTS`     | `10`     | Tentativas antes de `REJECTED` com `REFERENCE_NOT_FOUND` |
| `PENDING_REFERENCE_BASE_DELAY_MS`    | `2000`   | Espera até a primeira tentativa; dobra a cada tentativa  |
| `PENDING_REFERENCE_MAX_DELAY_MS`     | `300000` | Teto da espera entre tentativas                          |

Com os padrões, a rejeição por referência inexistente ocorre cerca de 18,5 min após a submissão.

`PENDING_REFERENCE_BASE_DELAY_MS` e `PENDING_REFERENCE_MAX_DELAY_MS` também definem a quarentena de
falhas operacionais (defeito, valor fora do armazenamento), contada em `processing_failures`,
separada de `reference_attempts`. A quarentena não tem limite de ocorrências, nunca vira
`REFERENCE_NOT_FOUND` e só aparece nos logs (`pending_reference_attempt_failed`,
`pending_reference_defer_failed`). Uma política terminal (`FAILED`) ainda não foi decidida.

Política e garantias: `ARCHITECTURE.md`, seção "Referências fora de ordem".

## Mensageria (SQS)

O SQS local é o [ElasticMQ](https://github.com/softwaremill/elasticmq) (`softwaremill/elasticmq-native:1.7.1`),
serviço `sqs` do `compose.yaml`: API compatível com o SQS, sem credenciais reais, porta
`127.0.0.1:9324`, limite de 0,5 CPU e 128 MB, healthcheck em `GET /health`. O LocalStack não foi
usado porque, desde a versão 2026.03.0, exige token de autenticação para iniciar.

| Recurso                 | Configuração (definida em `src/messaging/wager-events.queues.ts`)                     |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `wager-events.fifo`     | FIFO, `ContentBasedDeduplication=false`, visibilidade 30 s, retenção 4 dias           |
| Redrive policy          | Para `wager-events-dlq.fifo` após **5** recebimentos sem exclusão (`maxReceiveCount`) |
| `wager-events-dlq.fifo` | FIFO, `ContentBasedDeduplication=false`, retenção 14 dias                             |

| Variável                 | Uso                                                               |
| ------------------------ | ----------------------------------------------------------------- |
| `AWS_REGION`             | Região do SDK (local: qualquer valor, ex.: `us-east-1`)           |
| `AWS_ACCESS_KEY_ID`      | Lida pelo SDK; localmente, valor fictício (o emulador não valida) |
| `AWS_SECRET_ACCESS_KEY`  | Lida pelo SDK; localmente, valor fictício. Nunca versionar real   |
| `SQS_ENDPOINT`           | URL do emulador; ausente, o SDK usa o SQS da AWS                  |
| `SQS_WAGER_EVENTS_QUEUE` | Nome da fila principal (`.fifo`)                                  |
| `SQS_WAGER_EVENTS_DLQ`   | Nome da DLQ (`.fifo`)                                             |

```bash
bun run sqs:up          # sobe o ElasticMQ, aguarda o healthcheck e provisiona as filas
bun run sqs:provision   # (re)provisiona; idempotente, confere os atributos e falha se divergirem
bun run sqs:inspect     # mostra URL, atributos e contagem de mensagens, sem criar filas
curl http://127.0.0.1:9324/health
```

- **Sem acesso acidental à AWS:** sem `SQS_ENDPOINT`, `sqs:provision`/`sqs:inspect` recusam executar,
  pois o SDK usaria o SQS da AWS e qualquer credencial real da máquina. Para operar na AWS de
  propósito: `bun scripts/sqs.ts provision --aws`. Os testes de mensageria nunca aceitam isso.
- **Estado em memória:** recriar o container (`sqs:down`/`sqs:up`, `db:down`) apaga filas e
  mensagens; `sqs:up` reprovisiona. Não há volume.
- **Garantias:** FIFO ordena por `MessageGroupId` e deduplica por `MessageDeduplicationId` numa
  janela de 5 minutos. Isso **não** é entrega exactly-once: reentregas acontecem e o consumidor
  precisará de idempotência de negócio (Inbox), a ser implementada.
- **DLQ:** apenas isola mensagens que falharam 5 vezes; reprocessamento e reconciliação ainda não
  existem.
- **Limitação do emulador:** o ElasticMQ aceita `MessageRetentionPeriod`, mas não o reporta; o
  provisionamento avisa que esse atributo não pôde ser conferido. No SQS da AWS ele é conferido.
- O `MessagingModule` (`src/messaging/messaging.module.ts`) expõe a verificação de acesso às filas,
  mas ainda não é importado pelo `AppModule` (base para o futuro `/health/ready`).

### Publisher da outbox

Desligado por padrão. Para publicar os eventos gravados em `outbox_messages`, suba e provisione o
SQS (`bun run sqs:up`) e defina `OUTBOX_PUBLISHER_ENABLED=true` no `.env`, além das variáveis do
SQS acima. Várias instâncias podem publicar juntas. Garantias e decisões: `ARCHITECTURE.md`, seção
"Publisher da outbox".

| Variável                            | Padrão  | Uso                                                       |
| ----------------------------------- | ------- | --------------------------------------------------------- |
| `OUTBOX_PUBLISHER_ENABLED`          | `false` | `true` liga o publisher nesta instância                   |
| `OUTBOX_PUBLISHER_POLL_INTERVAL_MS` | `500`   | Intervalo entre o fim de uma rodada e a próxima           |
| `OUTBOX_PUBLISHER_MAX_GROUPS`       | `20`    | Máximo de wallets reservadas por rodada                   |
| `OUTBOX_PUBLISHER_MAX_PER_GROUP`    | `50`    | Máximo de eventos reservados por wallet numa rodada       |
| `OUTBOX_PUBLISHER_LEASE_MS`         | `30000` | Duração da reserva; depois dela, outro publisher assume   |
| `OUTBOX_PUBLISHER_SEND_TIMEOUT_MS`  | `10000` | Timeout de cada envio; até metade da reserva              |
| `OUTBOX_PUBLISHER_RETRY_BASE_MS`    | `1000`  | Espera após a primeira falha de envio; dobra a cada falha |
| `OUTBOX_PUBLISHER_RETRY_MAX_MS`     | `60000` | Teto da espera; não há limite de tentativas               |

Logs (JSON, sem payloads): `outbox_publish_round` (contagens), `outbox_publish_failed` (`eventId`,
`walletId`, tentativa e nome do erro) e `outbox_publish_round_failed`.

## Testes

| Comando                    | Ambiente                    | Precisa de Docker?        |
| -------------------------- | --------------------------- | ------------------------- |
| `bun run test:unit`        | nenhum (`--no-env-file`)    | Não                       |
| `bun run test:integration` | apenas `.env.test`          | Sim: `bun run db:test:up` |
| `bun run test:smoke`       | apenas `.env.test`          | Sim: `bun run db:test:up` |
| `bun run test`             | os três acima, em sequência | Sim                       |
| `bun run test:sqs`         | apenas `.env.test`          | Sim: `bun run sqs:up`     |
- O banco de testes é o serviço `postgres-test` de `compose.test.yaml`: projeto Compose próprio
  (`wagering-processor-test`), dados em `tmpfs` (descartados ao remover o container), porta
  `127.0.0.1:55432` e limite de 256 MB. `bun run db:test:down` não afeta o banco de
  desenvolvimento nem seu volume.
- Testes de integração e smoke chamam `assertTestDatabaseEnv()` (`test/support/test-database.ts`)
  antes de conectar: exigem `NODE_ENV=test` (definido pelo `bun test`) e `DB_NAME` terminado em
  `_test`. Caso contrário, falham com uma mensagem explicando como configurar o ambiente.
- Por que `--env-file=.env.test`: sem ele, `bun test` carrega o `.env` de desenvolvimento e o
  `.env.test` por cima, e variáveis que só existem no `.env` vazam para os testes. Variáveis do
  shell continuam tendo precedência sobre os arquivos; a proteção acima cobre esse caso.
- `test:sqs` usa o ElasticMQ de desenvolvimento, mas cria e remove filas efêmeras com nome único
  (`it-<id>-…fifo`); nunca toca `wager-events.fifo`. Recusa rodar se `SQS_ENDPOINT` estiver
  ausente ou fora do loopback (`test/support/test-sqs.ts`), para nunca atingir o SQS da AWS.
  Não faz parte de `bun run test`/`check`.
- O teste smoke inicia `src/main.ts` com `bun --no-env-file`, porque o processo filho, mesmo
  herdando o ambiente, recarregaria o `.env` do diretório para as variáveis ausentes.

## Scripts disponíveis

| Script                      | Descrição                                                       |
| --------------------------- | --------------------------------------------------------------- |
| `bun run dev`               | Sobe a API com recarga automática                               |
| `bun run start`             | Sobe a API                                                      |
| `bun run lint`              | Verifica formatação e regras de lint com o Biome                |
| `bun run lint:fix`          | Aplica as correções automáticas do Biome                        |
| `bun run format`            | Formata os arquivos com o Biome                                 |
| `bun run typecheck`         | Verifica os tipos com `tsc --noEmit`                            |
| `bun run test`              | Unitários, integração e smoke, em sequência                     |
| `bun run test:unit`         | Testes unitários, sem banco e sem arquivos `.env`               |
| `bun run test:integration`  | Testes em processo com `@nestjs/testing` no banco de teste      |
| `bun run test:smoke`        | Sobe `src/main.ts` em processo separado, no banco de teste      |
| `bun run test:sqs`          | Testes de mensageria no ElasticMQ, com filas efêmeras           |
| `bun run db:up`             | Sobe o PostgreSQL e aguarda ficar saudável                      |
| `bun run db:down`           | Remove os containers de dev, PostgreSQL e SQS (mantém o volume) |
| `bun run db:logs`           | Acompanha os logs do PostgreSQL                                 |
| `bun run db:test:up`        | Sobe o PostgreSQL de testes (tmpfs) e aguarda ficar saudável    |
| `bun run db:test:down`      | Remove o PostgreSQL de testes e seus dados descartáveis         |
| `bun run sqs:up`            | Sobe o ElasticMQ e provisiona as filas                          |
| `bun run sqs:down`          | Remove só o container do ElasticMQ (estado em memória)          |
| `bun run sqs:logs`          | Acompanha os logs do ElasticMQ                                  |
| `bun run sqs:provision`     | Provisiona as filas de forma idempotente e confere atributos    |
| `bun run sqs:inspect`       | Mostra URL e atributos das filas, sem criá-las                  |
| `bun run migration:create`  | Gera uma migration a partir da diferença de schema              |
| `bun run migration:up`      | Aplica as migrations pendentes                                  |
| `bun run migration:down`    | Reverte a última migration                                      |
| `bun run migration:list`    | Lista as migrations executadas                                  |
| `bun run migration:pending` | Lista as migrations pendentes                                   |
| `bun run migration:check`   | Verifica se o schema exige uma nova migration                   |
| `bun run check`             | Lint, typecheck e todos os testes (requer `db:test:up`)         |

## Segurança

Este é um repositório público. Não versione senhas, tokens, chaves ou credenciais reais. Arquivos
`.env` são ignorados pelo Git; apenas os modelos `.env.example` e `.env.test.example`, com valores fictícios,
são versionados.
