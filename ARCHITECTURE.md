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
- `src/wallets/`, `src/wagering/`, `src/health/`, `src/auth/`: borda HTTP (NestJS). Controllers só leem a entrada,
  chamam o caso de uso e traduzem o resultado para HTTP.

## Autenticação (contrato §2)

**Decisão: autenticação não implementada nesta etapa.** O contrato aceita essa opção desde que a
decisão seja documentada, o desenho pretendido seja descrito e exista um ponto de extensão explícito
no código.

### O que está implementado

- `AuthGuard` (`src/auth/auth.guard.ts`), registrado como guard global pelo `AuthModule`
  (`APP_GUARD` com `useExisting: AuthGuard`). **Ele aceita todas as requisições e não identifica
  quem chama.** Nenhum endpoint está protegido, inclusive `POST /wallets` e
  `POST /wagering/transactions`.
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

Implementada para `BET` e `WIN` em `MikroOrmWagerTransactionRepository.applyToLockedWallet`, o mesmo
caminho para débitos e créditos. Numa única transação SQL, no isolamento padrão do PostgreSQL
(`READ COMMITTED`):

1. `SELECT … FROM wallets WHERE id = ? FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`);
2. nova consulta de idempotência, já sob o lock;
3. decisão de domínio (`applyBet` ou `applyWin`) sobre a wallet lida;
4. `INSERT` da transação (estado final, `failureCode`, saldo observado);
5. se houve movimentação: `UPDATE wallets … WHERE id = ? AND version = <versão lida>` e `INSERT` do
   lançamento (`DEBIT` na BET, `CREDIT` no WIN);
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
de mutação (remover o `FOR UPDATE`) faz falhar os três testes de BETs concorrentes e os três de WINs
concorrentes (créditos perdidos, BET e WIN misturados, processos independentes): a guarda de versão
aborta as transações perdedoras.

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
- WIN (`test/integration/win-processing.integration.test.ts`): vinte WINs simultâneos por dois pools
  sem crédito perdido (saldo e versão exatos); BETs e WINs simultâneos na mesma wallet com saldo
  nunca negativo e igual ao ledger; três processos independentes, um WIN cada; WIN numa wallet
  enquanto outra está travada; e a mesma reconciliação para todo WIN (`PROCESSED` com um `CREDIT`,
  `REJECTED` sem lançamento).

O que esses testes **não** comprovam: execução com várias instâncias da aplicação NestJS completa ou
em máquinas diferentes. Os processos do teste usam o mesmo caso de uso e repositório da aplicação,
contra o mesmo PostgreSQL, que é quem garante a serialização.

### Pendente

- Aplicar a mesma estratégia às reversões (REFUND, ROLLBACK) e ao WIN com referência quando forem
  implementados, reutilizando `applyToLockedWallet`.
- Timeout de espera pelo lock (`lock_timeout`) não está configurado: uma transação presa seguraria
  as operações daquela wallet até o timeout de conexão ou o fim da transação.

## Processamento de BET e WIN, e idempotência (contrato §7 e §9)

Caso de uso `SubmitWagerTransaction` (`src/application/submit-wager-transaction.ts`). Nesta etapa
processa `BET` e `WIN` sem referência, pelo mesmo fluxo (a regra de domínio é escolhida pelo tipo).
Exposto por `POST /wagering/transactions` (seção seguinte); não há consumidor SQS.

- **BET** (domínio, `applyBet`): débito com um lançamento `DEBIT` e transação `PROCESSED`; saldo
  insuficiente, moeda diferente da wallet ou wallet de outro player → `REJECTED`, sem lançamento e
  sem alterar saldo nem versão (§6.4 e §7, regra 6). A rejeição é gravada e auditável.
- **WIN sem referência** (domínio, `applyWin`, §7 tabela: crédito, 1 lançamento `CREDIT`): crédito e
  transação `PROCESSED`, sem regra de saldo; moeda diferente da wallet ou wallet de outro player →
  `REJECTED`, como na BET. As pré-condições comuns (tipo, estado, wallet, player) ficam em
  `assertMovementPreconditions`.
- **WIN com referência: não processado** (`UnsupportedSubmissionError`, HTTP 501). O contrato diz
  que o WIN "pode referenciar a BET da mesma rodada" (§7), com a referência do mesmo provider,
  player, wallet, moeda e rodada (regra 2). Mas: referência ausente exige `PENDING_REFERENCE` com
  worker agendado e limite de tentativas (regra 8 e §7.1), que ainda não existem; e o contrato não
  define o que fazer se a BET referenciada existir sem estar `PROCESSED` (a exigência de `PROCESSED`
  está escrita só para REFUND e ROLLBACK). Implementar só o caso "referência presente e válida"
  deixaria o comportamento dependente da ordem de chegada (§3), por isso nada com referência é
  aceito por enquanto. O contrato também não limita o número de WINs por rodada ou por BET; nenhuma
  restrição foi criada.
- **`failureCode`** (§7.2, taxonomia própria, `src/application/failure-codes.ts`):
  `INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `PLAYER_WALLET_MISMATCH` (o WIN usa os dois últimos).
  Só os códigos que esta etapa produz; o código de reversão sem saldo (§7, regra 9) e o de
  referência inexistente (§7.1) entram com essas operações.
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
- **Recusado sem gravar nada** (regras não definidas pelo contrato ou fora desta etapa): `LOSS`,
  `REFUND`, `ROLLBACK`, BET ou WIN de valor `0.00`, BET ou WIN com `referenceExternalTransactionId`
  (`UnsupportedSubmissionError`); wallet inexistente (`WalletNotFoundError`; a FK impede gravar a
  transação).
- **Limite de armazenamento**: um WIN que levaria o saldo acima do `bigint` (`92233720368547758.07`)
  é recusado antes de gravar (`AmountOutOfStorageRangeError`; testado no PostgreSQL, nada é
  gravado). No HTTP vira 400 `INVALID_REQUEST`, como a entrada fora da faixa; a mensagem começa por
  `money:` embora a causa seja o saldo resultante.
- **Reutilização**: `POST /wagering/transactions` já chama este caso de uso; o consumidor SQS deverá
  chamar o mesmo `SubmitWagerTransaction`, com a chave de idempotência da mensagem. O consumidor
  ainda precisará da Inbox e do Outbox na mesma transação (§6.5), que não existem.

## API de submissão de transações (contrato §9)

`POST /wagering/transactions` (`src/wagering/`). O controller lê o header e o corpo, chama
`SubmitWagerTransaction` (injetado pelo `WageringModule`, com o repositório MikroORM) e traduz o
resultado. Não acessa o banco, não move saldo, não cria lançamento e não guarda nada em memória.

**Entrada.** Header `Idempotency-Key` obrigatório (string não vazia; a forma
`{providerId}:{externalTransactionId}` é a recomendada pelo contrato, não exigida). Corpo com
`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind` e
`money: { amount, currency }`; `referenceExternalTransactionId` opcional. Validação manual, sem
dependência nova (`src/wagering/submit-transaction.request.ts`): strings não vazias e sem NUL,
`walletId` UUID (a coluna é `uuid`), `kind` entre `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`
(`OPENING` é interno, §6.3). `money` é lido por `Money.fromProps`: string decimal com exatamente 2
casas, não negativa, moeda ISO-4217, convertida direto para centavos `bigint`, sem passar por
`number`. Campos extras são ignorados.

**Saída.** Resultado gravado: `{ transactionId, status, balance, idempotentReplay }` (§9), mais
`failureCode` quando `REJECTED` (§7.2). `balance` é o saldo observado ao concluir.

**Mapeamento HTTP** (o §9 deixa a escolha ao candidato, desde que as situações sejam distintas e
consistentes):

| Situação                                                                                    | Status | Corpo                                              |
| ------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------- |
| `PROCESSED`, nova ou replay                                                                 | 200    | resultado                                          |
| `REJECTED` (saldo, moeda, player), nova ou replay                                           | 422    | resultado, com `failureCode`                       |
| Payload inválido, JSON malformado, `Idempotency-Key` ausente/vazia, valor acima do `bigint` | 400    | erro `INVALID_REQUEST`                             |
| Wallet inexistente                                                                          | 404    | erro `WALLET_NOT_FOUND`                            |
| Mesma chave com outro payload                                                               | 409    | erro `IDEMPOTENCY_KEY_CONFLICT`                    |
| Mesma operação externa com outra chave                                                      | 409    | erro `DUPLICATE_EXTERNAL_TRANSACTION`              |
| LOSS, REFUND, ROLLBACK, BET ou WIN de valor zero, BET ou WIN com referência                 | 501    | erro `UNSUPPORTED_SUBMISSION`                      |
| Falha transitória do banco                                                                  | 503    | erro `TRANSIENT_FAILURE`                           |
| Qualquer outro erro                                                                         | 500    | `{ statusCode, message: "Internal server error" }` |

Corpo de erro: `{ statusCode, error, message, code }`, com `code` estável para o provedor decidir sem
ler a mensagem. A rejeição de negócio usa o corpo do resultado, não o de erro: ela foi gravada e é
devolvida igual no replay. O replay mantém o status original (200 ou 422). Nenhuma resposta inclui
stack, SQL ou a chave de idempotência de outra submissão.

**Falha transitória.** O repositório converte para `TransientPersistenceError` os SQLSTATEs `08xxx`,
`40001`, `40P01`, `57P01`–`57P03`, `53300`, `55P03` e os erros de socket `ECONNREFUSED`,
`ECONNRESET`, `ETIMEDOUT`, `EPIPE`. O resto é 500. Repetir após 503 é seguro: nada foi confirmado
ou o resultado confirmado volta como replay.

**Idempotência.** O header vai como `idempotencyKey` do caso de uso; replay, conflito e operação
duplicada são os do caso de uso e do PostgreSQL (seção anterior). Testado por HTTP, inclusive com
requisições equivalentes simultâneas e com o replay respondido por outra instância da aplicação
iniciada depois.

**Testes** (`test/integration/wagering-transactions.http.integration.test.ts`, `AppModule` real e
PostgreSQL de teste): BET aplicada e rejeitada, replays, conflitos, cenário obrigatório 80/80
sobre 100 por HTTP (200 e 422, saldo `20.00`, um débito; reentrega sem débito novo), dez BETs
simultâneas, WIN creditado, replay e conflito de WIN, WIN em moeda incompatível (422), BET e WIN
simultâneos, entradas inválidas sem efeito e falhas sem vazamento. As requisições simultâneas vão a
uma única instância da aplicação; o cenário com processos independentes está em
`bet-processing.integration.test.ts`.

**Limitações.** `PENDING_REFERENCE` (aceite pendente, previsto como 202) não é produzido nesta etapa.
`POST /wallets` ainda usa o corpo de erro padrão do Nest, sem `code`: a consistência do formato
entre endpoints (§9) fica pendente. Um header `Idempotency-Key` repetido chega ao Node como valores
unidos por vírgula e é aceito como uma única chave.

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
  zero; se BET e LOSS admitem referência; se a BET referenciada por um WIN precisa estar
  `PROCESSED`; e se há limite de WINs por rodada ou por BET (o contrato não define, e nada foi
  limitado). A taxonomia de `failureCode` cobre só BET e WIN (seção acima).

## Ainda não implementado

WIN com referência, LOSS, REFUND e ROLLBACK, `PENDING_REFERENCE` e seu worker (§7.1),
Inbox/Outbox, consumo SQS, retry e DLQ (§6.5, §10 e §11), consultas e reconciliação pela API
(`GET /wallets/:id`, ledger, transações), autenticação real (§2), observabilidade (§12) e
`GET /health/ready`.
