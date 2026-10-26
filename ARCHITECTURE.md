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

- Consultas do §9 (`GET /wallets/:id`, ledger, transações) e leitura do ledger pelo ORM, que pode
  esbarrar na mesma limitação da FK composta. Hoje a wallet só é reidratada dentro da transação de
  processamento, sob lock.

## Concorrência (contrato §8)

O contrato define a `walletId` como unidade de concorrência, exige correção com três ou mais
instâncias e pede que a estratégia (lock pessimista, otimista com retry limitado, update atômico
condicionado ou combinação) seja justificada aqui. O broker é otimização, não garantia.

### Estratégia escolhida: lock pessimista da linha da wallet

Implementada para `BET` em `MikroOrmWagerTransactionRepository.applyToLockedWallet`. Numa única
transação SQL, no isolamento padrão do PostgreSQL (`READ COMMITTED`):

1. `SELECT … FROM wallets WHERE id = ? FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`);
2. nova consulta de idempotência, já sob o lock;
3. decisão de domínio (`applyBet`) sobre a wallet lida;
4. `INSERT` da transação (estado final, `failureCode`, saldo observado);
5. se houve débito: `UPDATE wallets … WHERE id = ? AND version = <versão lida>` e `INSERT` do
   lançamento `DEBIT`;
6. `COMMIT`. Qualquer erro desfaz tudo.

**Por que lock pessimista.** A BET concorrente precisa de um resultado de negócio (`REJECTED` por
saldo insuficiente, §8), não de um erro de conflito. Com o lock, a segunda transação espera a
primeira e, ao obter o lock, lê o saldo já confirmado (em `READ COMMITTED`, `FOR UPDATE` devolve a
versão mais recente da linha): decide `REJECTED` de forma determinística, sem retry. O controle
otimista exigiria repetir leitura e decisão a cada colisão (retry limitado que, numa wallet
disputada, pode se esgotar sem decisão de negócio). Um `UPDATE … WHERE balance_cents >= ?` levaria a
regra de saldo para o SQL, fora do domínio (`Wallet.debit`), e ainda precisaria de leitura separada
para gravar a rejeição com o saldo observado. Com o lock, a decisão continua inteira no domínio.

**Como impede saldo negativo e lost update.** Leitura, decisão e escrita do saldo ocorrem com a
linha travada; nenhuma outra transação de qualquer instância escreve na wallet nesse intervalo. Em
defesa adicional: o `UPDATE` exige a versão lida (afetar zero linhas aborta a transação), o
`CHECK (balance_cents >= 0)` da wallet e os `CHECK`s de saldo e equação contábil do ledger. Um teste
de mutação (remover o `FOR UPDATE`) faz falhar os três testes de BETs concorrentes: a guarda de
versão aborta as transações perdedoras.

**Escopo do lock.** Uma linha de `wallets` (a unidade de concorrência é a `walletId`). Não há lock
global nem em memória. Cada transação trava uma única wallet, portanto não há ciclo de locks entre
wallets (sem deadlock por ordem). Wallets diferentes não se bloqueiam: há teste que segura o lock de
uma wallet e confirma uma BET em outra enquanto a primeira espera.

**Retries.** Nenhum retry automático da decisão: com o lock não há conflito transitório entre BETs
da mesma wallet. A única corrida restante é a de duas submissões com a mesma chave (ou a mesma
operação externa) em wallets **diferentes**, que não compartilham lock: o `UNIQUE` do banco recusa a
segunda, a transação dela é desfeita e o resultado confirmado é relido (replay ou conflito), sem
reaplicar efeito. Erros de infraestrutura (conexão, timeout) sobem para o chamador; reenviar a mesma
submissão é seguro porque nada foi confirmado ou o resultado confirmado é devolvido como replay.

**Atomicidade.** Transação, saldo, versão, lançamento e o saldo observado do replay são gravados na
mesma transação. Há teste que força falha no último `INSERT` (ledger) depois de a transação e o
`UPDATE` do saldo já terem sido enviados, confirma o `ROLLBACK` e mostra que o reenvio aplica o efeito
exatamente uma vez.

### Testes que sustentam as garantias (`test/integration/bet-processing.integration.test.ts`)

- **Cenário obrigatório em dois processos do sistema operacional** (`test/support/bet-worker.ts`,
  cada um com o próprio MikroORM e pool de conexões, sincronizados por `READY`/`GO`): duas BETs de
  `80.00` sobre `100.00` → uma `PROCESSED`, uma `REJECTED` (`INSUFFICIENT_FUNDS`), saldo `20.00`, um
  único `DEBIT`; a reentrega das duas é replay e não debita de novo.
- **Três processos independentes**, uma BET de `40.00` cada, sobre `100.00` → duas aplicadas, uma
  rejeitada, saldo `20.00`.
- **Vinte BETs concorrentes** de `10.00` sobre `100.00`, distribuídas entre dois pools no mesmo
  processo → dez aplicadas, dez rejeitadas, saldo `0.00`, nenhum saldo negativo.
- Reconciliação ao final: em todas as wallets do banco de teste, saldo materializado igual à soma do
  ledger; toda BET `PROCESSED` com exatamente um `DEBIT` e toda `REJECTED` sem lançamento.

O que esses testes **não** comprovam: execução com várias instâncias da aplicação NestJS completa ou
em máquinas diferentes. Os processos do teste usam o mesmo caso de uso e repositório da aplicação,
contra o mesmo PostgreSQL, que é quem garante a serialização.

### Pendente

- Aplicar a mesma estratégia aos créditos e reversões (WIN, REFUND, ROLLBACK) quando forem
  implementados, reutilizando `applyToLockedWallet`.
- Timeout de espera pelo lock (`lock_timeout`) não está configurado: uma transação presa seguraria
  as BETs daquela wallet até o timeout de conexão ou o fim da transação.

## Processamento de BET e idempotência (contrato §7 e §9)

Caso de uso `SubmitWagerTransaction` (`src/application/submit-wager-transaction.ts`). Nesta etapa só
processa `BET`; não há endpoint HTTP nem consumidor SQS.

- **Regras** (domínio, `applyBet`): débito com um lançamento `DEBIT` e transação `PROCESSED`; saldo
  insuficiente, moeda diferente da wallet ou wallet de outro player → `REJECTED`, sem lançamento e
  sem alterar saldo nem versão (§6.4 e §7, regra 6). A rejeição é gravada e auditável.
- **`failureCode`** (§7.2, taxonomia própria, `src/application/failure-codes.ts`):
  `INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `PLAYER_WALLET_MISMATCH`. Só os códigos que esta etapa
  produz; o código de reversão sem saldo (§7, regra 9) e o de referência inexistente (§7.1) entram com
  essas operações.
- **`payloadHash`** (§9): SHA-256 hexadecimal do JSON canônico (chaves ordenadas, sem espaços) de
  `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`,
  `money` (`{ amount, currency }`, 2 casas) e `referenceExternalTransactionId` quando presente. A
  `Idempotency-Key` e metadados de transporte não entram.
- **Idempotência persistente**, garantida pelo banco (`UNIQUE (idempotency_key)` e
  `UNIQUE (provider_id, external_transaction_id)`), gravada na mesma transação do efeito:
  - mesma chave e mesmo `payloadHash` → resultado original, com `idempotentReplay: true` e o saldo
    observado na época (§7, regra 7), inclusive de uma rejeição;
  - mesma chave com outro payload → `IdempotencyConflictError` (conflito, não replay);
  - mesma operação `(providerId, externalTransactionId)` sob outra chave →
    `DuplicateExternalTransactionError`. Decisão: a chave é a fonte da verdade (§9), então não é
    replay; também não reaplica o efeito.
  - Testado com submissões simultâneas, com um ORM recém-criado (sem estado em memória) e entre
    wallets diferentes (corrida resolvida pelo `UNIQUE`).
- **Saldo observado**: coluna `wager_transactions.result_balance_cents` (migration
  `Migration20261026012348_bet_result_balance`), obrigatória em submissões `PROCESSED`/`REJECTED`
  (`CHECK`) e não negativa. Pré-condição da migration: não existirem submissões concluídas sem esse
  valor; antes desta etapa nenhum código as gravava (só a `OPENING`, isenta).
- **Recusado sem gravar nada** (regras não definidas pelo contrato ou fora desta etapa): `WIN`,
  `LOSS`, `REFUND`, `ROLLBACK`, BET de valor `0.00`, BET com `referenceExternalTransactionId`
  (`UnsupportedSubmissionError`); wallet inexistente (`WalletNotFoundError`; a FK impede gravar a
  transação).
- **Reutilização futura**: `POST /wagering/transactions` e o consumidor SQS chamarão o mesmo
  `SubmitWagerTransaction`, com a `Idempotency-Key` do header ou da mensagem. O consumidor ainda
  precisará da Inbox e do Outbox na mesma transação (§6.5), que não existem.

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
  zero e se WIN, BET e LOSS exigem ou admitem referência. A taxonomia de `failureCode` está definida
  só para a BET (seção acima).

## Ainda não implementado

`POST /wagering/transactions` e o mapeamento HTTP dos resultados, processamento de WIN, LOSS, REFUND
e ROLLBACK, `PENDING_REFERENCE` e seu worker (§7.1), Inbox/Outbox, consumo SQS, retry e DLQ (§6.5,
§10 e §11), consultas e reconciliação pela API, observabilidade (§12) e `GET /health/ready`.
