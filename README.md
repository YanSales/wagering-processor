# Wagering Processor

Solução para o desafio técnico **Distributed Wagering Processor**, da Jungle Gaming:
<https://github.com/junglegaming/backend-challenge>

O objetivo é um serviço financeiro distribuído que processa transações de apostas vindas de
múltiplos provedores, mantendo correção financeira, idempotência persistente e consistência entre
saldo e ledger sob concorrência, mensagens duplicadas, entregas fora de ordem e falhas de processo.

## Status

**Em construção.** Neste momento o repositório contém a fundação do projeto (ferramentas e
configuração), o bootstrap mínimo do NestJS com `GET /health/live` e a infraestrutura de
persistência: PostgreSQL via Docker Compose, MikroORM integrado ao NestJS e o mecanismo de
migrations. Ainda **não há** entidades, schema de negócio, migrations, código de domínio,
mensageria nem `GET /health/ready`.
Esta seção será atualizada a cada etapa concluída; nada será descrito como pronto antes de estar
implementado e verificado.

## Stack alvo

Definida pelo desafio; PostgreSQL, Docker Compose e MikroORM já estão configurados:

| Item                                          | Escolha                                              |
| --------------------------------------------- | ---------------------------------------------------- |
| Runtime, gerenciador de pacotes e test runner | Bun 1.x                                              |
| Linguagem                                     | TypeScript em modo estrito                           |
| Framework                                     | NestJS                                               |
| Banco de dados                                | PostgreSQL 18                                        |
| Mensageria                                    | AWS SQS (FIFO) em ambiente local                     |
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

## Testes

| Comando                    | Ambiente                    | Precisa de Docker?        |
| -------------------------- | --------------------------- | ------------------------- |
| `bun run test:unit`        | nenhum (`--no-env-file`)    | Não                       |
| `bun run test:integration` | apenas `.env.test`          | Sim: `bun run db:test:up` |
| `bun run test:smoke`       | apenas `.env.test`          | Sim: `bun run db:test:up` |
| `bun run test`             | os três acima, em sequência | Sim                       |
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
- O teste smoke inicia `src/main.ts` com `bun --no-env-file`, porque o processo filho, mesmo
  herdando o ambiente, recarregaria o `.env` do diretório para as variáveis ausentes.

## Scripts disponíveis

| Script                      | Descrição                                                    |
| --------------------------- | ------------------------------------------------------------ |
| `bun run dev`               | Sobe a API com recarga automática                            |
| `bun run start`             | Sobe a API                                                   |
| `bun run lint`              | Verifica formatação e regras de lint com o Biome             |
| `bun run lint:fix`          | Aplica as correções automáticas do Biome                     |
| `bun run format`            | Formata os arquivos com o Biome                              |
| `bun run typecheck`         | Verifica os tipos com `tsc --noEmit`                         |
| `bun run test`              | Unitários, integração e smoke, em sequência                  |
| `bun run test:unit`         | Testes unitários, sem banco e sem arquivos `.env`            |
| `bun run test:integration`  | Testes em processo com `@nestjs/testing` no banco de teste   |
| `bun run test:smoke`        | Sobe `src/main.ts` em processo separado, no banco de teste   |
| `bun run db:up`             | Sobe o PostgreSQL e aguarda ficar saudável                   |
| `bun run db:down`           | Para e remove o container (mantém o volume de dados)         |
| `bun run db:logs`           | Acompanha os logs do PostgreSQL                              |
| `bun run db:test:up`        | Sobe o PostgreSQL de testes (tmpfs) e aguarda ficar saudável |
| `bun run db:test:down`      | Remove o PostgreSQL de testes e seus dados descartáveis      |
| `bun run migration:create`  | Gera uma migration a partir da diferença de schema           |
| `bun run migration:up`      | Aplica as migrations pendentes                               |
| `bun run migration:down`    | Reverte a última migration                                   |
| `bun run migration:list`    | Lista as migrations executadas                               |
| `bun run migration:pending` | Lista as migrations pendentes                                |
| `bun run migration:check`   | Verifica se o schema exige uma nova migration                |
| `bun run check`             | Lint, typecheck e todos os testes (requer `db:test:up`)      |

## Segurança

Este é um repositório público. Não versione senhas, tokens, chaves ou credenciais reais. Arquivos
`.env` são ignorados pelo Git; apenas os modelos `.env.example` e `.env.test.example`, com valores fictícios,
são versionados.
