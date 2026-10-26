# Arquitetura — Wagering Processor

Decisões, trade-offs e limitações da solução para o desafio
<https://github.com/junglegaming/backend-challenge>. O projeto está em construção: cada seção separa
o que **está implementado**, o que foi **decidido como desenho** e o que está **pendente**. Nada
aqui descreve como existente o que ainda não foi implementado e testado.

## Camadas

- `src/domain/`: regras de negócio (`Money`, `Wallet`, `WagerTransaction`, ledger), sem NestJS,
  MikroORM ou SDKs (contrato §6.1).
- `src/application/`: casos de uso e portas (ex.: `OpenWallet`, `WalletRepository`).
- `src/database/`: schema, migrations e implementações MikroORM das portas.
- `src/wallets/`, `src/health/`, `src/auth/`: borda HTTP (NestJS). Controllers só leem a entrada,
  chamam o caso de uso e traduzem o resultado para HTTP.

## Autenticação (contrato §2)

**Decisão: autenticação não implementada nesta etapa.** O contrato aceita essa opção desde que a
decisão seja documentada, o desenho pretendido seja descrito e exista um ponto de extensão explícito
no código.

### O que está implementado

- `AuthGuard` (`src/auth/auth.guard.ts`), registrado como guard global pelo `AuthModule`
  (`APP_GUARD` com `useExisting: AuthGuard`). **Ele aceita todas as requisições e não identifica
  quem chama.** Nenhum endpoint está protegido, inclusive `POST /wallets`.
- A aplicação registra no log, na inicialização, o aviso
  `Autenticação desativada: o AuthGuard global aceita todas as requisições`.
- `@Public()` (`src/auth/public.decorator.ts`) marca as rotas que nunca exigirão autenticação. Hoje
  marca o `HealthController` (contrato §2 e §9: os endpoints de health ficam abertos). O guard atual
  não lê a marcação; ela existe para a implementação real.
- Testes: `test/unit/auth.guard.test.ts` (o guard aceita tudo; health é público; `POST /wallets`
  não é) e `test/integration/auth-extension.integration.test.ts` (sem credenciais, `POST /wallets`
  responde 201; substituindo o provider `AuthGuard` por um guard que nega rotas não públicas,
  `POST /wallets` responde 403 e `GET /health/live` continua 200).

### O que não existe

Não há usuários, tokens, credenciais, papéis, políticas de autorização, nem tabela própria de
usuários. Nenhuma dependência de autenticação foi adicionada.

### Desenho que seria adotado

1. **Identity Provider externo** com OIDC (o contrato sugere Keycloak ou Zitadel), em container no
   Docker Compose. Cada provedor de jogos é um client OAuth 2.0 que obtém tokens pelo fluxo
   _client credentials_. Nada de autenticação artesanal.
2. **Validação do token no `AuthGuard`**: o guard substitui o atual, lê `Authorization: Bearer`,
   valida assinatura (JWKS do IdP, com cache), emissor, audiência e expiração, e responde `401`
   quando o token falta ou é inválido. Rotas `@Public()` continuam liberadas.
3. **Identidade do provedor como porta**: um `ProviderIdentityPort` (aplicação) expõe o
   `providerId` autenticado, extraído de uma claim do token. Em `POST /wagering/transactions`, um
   `providerId` do payload diferente do autenticado é recusado com `403`.
4. **Mensagens SQS**: tratadas como canal interno confiável (contrato §2), sem token; o `providerId`
   da mensagem continua sujeito às mesmas validações de domínio.

Pendente de decisão: quem pode chamar `POST /wallets` (provedor, operador ou backoffice) e com qual
escopo.

## Limite de valores monetários no armazenamento

- `Money` não tem limite: os centavos são `bigint` sem teto, e o domínio continua genérico.
- As colunas monetárias do PostgreSQL são `bigint` (inteiro de 64 bits com sinal): de
  `-9223372036854775808` a `9223372036854775807` centavos, ou seja, até `92233720368547758.07`.
- O limite é técnico, da persistência. Por isso é verificado no adaptador
  (`MikroOrmWalletRepository`), **antes** de abrir a transação, para todos os valores gravados
  (saldo, valor da `OPENING`, valor e saldos do lançamento). Fora da faixa, o adaptador lança
  `AmountOutOfStorageRangeError`, declarado na porta `WalletRepository`, e nada é gravado.
- Em `POST /wallets`, esse erro é entrada inválida: `400`, com o valor e a faixa na mensagem. Sem a
  verificação, o PostgreSQL recusaria o valor com um erro genérico e a API responderia `500`.
- Não há limite de negócio além do armazenamento: o contrato não define um.

## ORM, mapeamento do `Money` e estratégia transacional (contrato §4)

O contrato pede que a escolha do ORM, o mapeamento do `Money` e a estratégia transacional sejam
justificados aqui.

### Implementado

- **ORM: MikroORM 7.2.5**, a opção preferencial do contrato (Unit of Work, Identity Map,
  `EntityManager.transactional()`, `LockMode`). O mapeamento usa `EntitySchema` em
  `src/database/schema/`, separado do domínio: o domínio não importa o ORM e os repositórios recebem
  e devolvem objetos de domínio, nunca entidades gerenciadas.
- **Mapeamento do `Money`**: cada valor ocupa uma coluna de centavos `bigint`
  (`BigIntType('bigint')`, lida no JavaScript como `bigint`, nunca `number`) e a moeda fica em
  `currency char(3)` com `CHECK` de formato. Ex.: `wallets.balance_cents`,
  `wager_transactions.money_cents`, e `money_cents`, `balance_before_cents` e `balance_after_cents`
  no ledger. A FK composta `(wallet_id, currency) → wallets (id, currency)` garante que o lançamento
  tenha a moeda da wallet.
- **Schema e migrations**: as garantias do §5.9 (unicidade, não-negatividade, imutabilidade do
  ledger por trigger de `UPDATE`/`DELETE`, reversão única por referência) ficam no schema, declaradas
  no metadado das entidades para a migration e o snapshot permanecerem sincronizados. A migration é
  versionada e reversível (`up` e `down`), sem sincronização automática.
- **Estratégia transacional**: cada operação de escrita usa um fork do `EntityManager` e uma única
  `em.fork().transactional(...)`. A abertura de wallet grava wallet, `OPENING` e lançamento `CREDIT`
  na mesma transação. Testes de integração forçam falha no último `INSERT` e confirmam o rollback.
- **Limitação contornada**: o MikroORM 7.2.5 não preenche a FK composta do ledger (envia `currency`
  como `undefined`). O lançamento é gravado com SQL cru no contexto da mesma transação
  (`em.getTransactionContext()`); os placeholders são formatados e escapados pelo MikroORM no
  cliente, e os erros são convertidos pelo driver para as exceções tipadas do ORM.

### Decidido como desenho

- Todo lançamento do ledger usa o mesmo caminho de gravação, dentro da transação da operação.
- Nenhuma chamada externa (SQS, HTTP) dentro de uma transação de banco. Eventos só depois do
  commit, por Outbox transacional (exigências do contrato, §5.4 e §11; ainda não implementado).

### Pendente

- Reidratação de wallets e transações a partir do banco (`findById`, consultas do §9) e leitura do
  ledger pelo ORM, que pode esbarrar na mesma limitação da FK composta.
- Uso de `LockMode`, que depende da estratégia de concorrência (abaixo).

## Concorrência (contrato §8)

O contrato define a `walletId` como unidade de concorrência, exige correção com três ou mais
instâncias e pede que a estratégia (lock pessimista, otimista com retry limitado, update atômico
condicionado ou combinação) seja justificada aqui. O broker é otimização, não garantia.

### Implementado

- **Abertura concorrente**: a unicidade de `player_id` + `currency` é garantida pela constraint
  `wallets_player_id_currency_unique`, sem checagem prévia em memória. Testes com requisições
  simultâneas (repositório e HTTP) confirmam uma wallet, uma `OPENING` e um lançamento.
- **Última barreira no banco**: `CHECK` de saldo não negativo na wallet e nos saldos do lançamento,
  equação contábil do lançamento e `UNIQUE (wallet_id, transaction_id)` no ledger.
- A coluna `version` existe (começa em 1, com `CHECK version >= 1`), mas **ainda não é usada** para
  controle de concorrência.

### Decidido como desenho

Ainda **não há estratégia escolhida**. Qualquer escolha precisa respeitar o contrato: lock ou
condição por wallet, nunca global (§5.6); nada de `read → calculate → update` sem controle (§5.7);
correção com múltiplas instâncias (§5.8); e o banco como responsável final pelas invariantes.

### Pendente

- Escolher e justificar a estratégia antes de implementar débitos e créditos (BET, WIN, REFUND,
  ROLLBACK).
- Testes de concorrência com paralelismo real, incluindo o cenário obrigatório (saldo `100.00`, duas
  apostas simultâneas de `80.00`: uma `PROCESSED`, outra `REJECTED`, saldo final `20.00` e um único
  débito) e múltiplas instâncias.

## Decisões, trade-offs e limitações (contrato §14)

- **SQS local com ElasticMQ, não LocalStack/MiniStack**: o §4 cita LocalStack ou MiniStack. O
  LocalStack passou a exigir token de autenticação para iniciar (versão 2026.03.0); o ElasticMQ
  oferece API compatível com o SQS, sem credenciais. O `README.md` não registra avaliação do
  MiniStack. Limitação: o
  ElasticMQ não reporta `MessageRetentionPeriod` (ver `README.md`).
- **SQL cru para o ledger**: contorna a limitação do MikroORM descrita no §4 acima, ao custo de
  depender do escape de valores do próprio ORM, e não de parâmetros enviados ao PostgreSQL.
- **Autenticação não implementada**: ver a seção acima; a API não está protegida.
- **Limitações do schema atual**:
  - transações em estado terminal ainda podem ser alteradas por `UPDATE` direto no banco (só o
    ledger tem trigger de imutabilidade);
  - a FK do lançamento para a transação não garante que a transação seja da mesma wallet;
  - a reversão única por referência depende de `reference_transaction_id` ser preenchido só quando a
    reversão é aplicada;
  - `TRUNCATE`/`DROP` do ledger não são cobertos pelo trigger: dependem das permissões da role da
    aplicação na implantação.
- **Ids**: UUID v4 (`randomUUID`); os exemplos do contrato usam UUID v7, o que não é exigido.
- **Regras de negócio sem definição no contrato**, ainda abertas: tratamento de operações de valor
  zero, taxonomia de `failureCode`, e se WIN, BET e LOSS exigem ou admitem referência.

## Ainda não implementado

Submissão e processamento de transações (`POST /wagering/transactions`), idempotência,
Inbox/Outbox, consumo SQS, retry e DLQ (§6.5, §9 a §11), consultas e reconciliação pela API,
observabilidade (§12) e `GET /health/ready`.
