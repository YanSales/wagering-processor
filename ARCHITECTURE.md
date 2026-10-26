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
  commit, por Outbox transacional (exigências do contrato, §5.4 e §11): a gravação na outbox já
  existe (seção "Transactional Outbox"); a publicação ainda não.

### Pendente

- Consultas do §9 (`GET /wallets/:id`, ledger, transações) e leitura do ledger pelo ORM, que pode
  esbarrar na mesma limitação da FK composta. Hoje a wallet só é reidratada dentro da transação de
  processamento, sob lock.

## Concorrência (contrato §8)

O contrato define a `walletId` como unidade de concorrência, exige correção com três ou mais
instâncias e pede que a estratégia (lock pessimista, otimista com retry limitado, update atômico
condicionado ou combinação) seja justificada aqui. O broker é otimização, não garantia.

### Estratégia escolhida: lock pessimista da linha da wallet

Implementada para `BET`, `WIN` e `LOSS` em `MikroOrmWagerTransactionRepository.applyToLockedWallet`,
o mesmo caminho para débitos, créditos e registros sem movimentação (no LOSS, o passo 5 não
ocorre). Numa única transação SQL, no isolamento padrão do PostgreSQL
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

- Aplicar a mesma estratégia ao ROLLBACK e ao WIN com referência quando forem implementados,
  reutilizando `applyToLockedWallet` e `resolvePendingReference` (o REFUND e o worker de
  `PENDING_REFERENCE` já os usam, seção "Referências fora de ordem").
- Timeout de espera pelo lock (`lock_timeout`) não está configurado: uma transação presa seguraria
  as operações daquela wallet até o timeout de conexão ou o fim da transação.

## Processamento de BET, WIN, LOSS e REFUND, e idempotência (contrato §7 e §9)

Caso de uso `SubmitWagerTransaction` (`src/application/submit-wager-transaction.ts`). Nesta etapa
processa `BET`, `WIN` e `LOSS` sem referência e `REFUND`, pelo mesmo fluxo (a regra de domínio é
escolhida pelo tipo). Exposto por `POST /wagering/transactions` (seção seguinte); não há consumidor
SQS.

- **BET** (domínio, `applyBet`): débito com um lançamento `DEBIT` e transação `PROCESSED`; saldo
  insuficiente, moeda diferente da wallet ou wallet de outro player → `REJECTED`, sem lançamento e
  sem alterar saldo nem versão (§6.4 e §7, regra 6). A rejeição é gravada e auditável.
- **WIN sem referência** (domínio, `applyWin`, §7 tabela: crédito, 1 lançamento `CREDIT`): crédito e
  transação `PROCESSED`, sem regra de saldo; moeda diferente da wallet ou wallet de outro player →
  `REJECTED`, como na BET. As pré-condições comuns (tipo, estado, wallet, player) ficam em
  `assertMovementPreconditions`.
- **WIN com referência: não processado** (`UnsupportedSubmissionError`, HTTP 501). O contrato diz
  que o WIN "pode referenciar a BET da mesma rodada" (§7), com a referência do mesmo provider,
  player, wallet, moeda e rodada (regra 2). O `PENDING_REFERENCE` e o worker (regra 8 e §7.1) já
  existem (usados pelo REFUND), mas o contrato não define o que fazer se a BET referenciada existir
  sem estar `PROCESSED` (a exigência de `PROCESSED` está escrita só para REFUND e ROLLBACK), por isso
  WIN com referência continua recusado. O contrato também não limita o número de WINs por rodada ou
  por BET; nenhuma restrição foi criada.
- **LOSS sem referência** (domínio, `applyLoss`): §7 tabela, "registra o resultado sem mover saldo",
  sem efeito no saldo e sem lançamento (§6.4); `affectsBalance()` é `false` (§6.3); um LOSS aplicado
  é `PROCESSED` (§11: `WagerTransactionProcessed` vale para "qualquer transação aplicada, inclusive
  `LOSS`"). A transação é gravada com o saldo observado; saldo, versão e ledger da wallet não mudam.
  Moeda diferente da wallet (§6.2, regra geral, sem exceção para LOSS) ou wallet de outro player →
  `REJECTED` com `CURRENCY_MISMATCH` ou `PLAYER_WALLET_MISMATCH`, como em BET e WIN.
  - Valor `0.00` é aceito: o contrato não o trata, e a regra registrada no projeto é que LOSS com
    valor maior ou igual a zero não altera o saldo; sem movimentação, nenhuma invariante é afetada.
  - **LOSS com referência: não processado** (HTTP 501). O contrato não diz se LOSS pode ter
    referência nem o que ela referenciaria (a regra 1 só a exige em REFUND/ROLLBACK; a tabela só a
    menciona para WIN). O domínio já recusava referência em LOSS (`validateReference`,
    `UnsupportedReferenceError`).
  - **Concorrência**: o LOSS usa o mesmo `applyToLockedWallet`, com o lock da wallet, embora não a
    altere. O lock faz o saldo observado ser o do ponto de serialização com as BETs e WINs daquela
    wallet e mantém um único caminho de persistência. Limite verificado: nenhum teste demonstra que
    o LOSS _precisa_ desse lock. Sem ele, o LOSS leria um saldo confirmado (`READ COMMITTED`) e as
    corridas de idempotência continuariam resolvidas pelo `UNIQUE`; com a wallet travada por outra
    transação, o LOSS esperaria de qualquer forma, porque a FK de `wager_transactions` faz o
    PostgreSQL pegar `FOR KEY SHARE` na linha da wallet ao inserir a transação.
- **REFUND** (domínio, `applyRefund`; decisão compartilhada `decideRefund`, §7 tabela: crédito, 1
  lançamento `CREDIT`, "reverte uma BET `PROCESSED`, uma única vez"). Sob o lock da wallet, a BET é
  resolvida por `(providerId, referenceExternalTransactionId)` (regra 2):
  - wallet de outro player ou moeda diferente da wallet → `REJECTED` (`PLAYER_WALLET_MISMATCH`,
    `CURRENCY_MISMATCH`), verificados antes da referência;
  - BET válida (mesmo player, wallet, moeda e rodada; tipo BET; `PROCESSED`; mesmo valor, regras 2,
    3 e 5) e ainda não reembolsada (regra 4) → crédito, `PROCESSED`, com o id interno da BET em
    `reference_transaction_id`;
  - BET existente, mas inválida → `REJECTED` **de imediato**, com o código da violação (decisão
    aprovada para o projeto: a referência existe e não vai mudar; esperar não a tornaria válida);
  - BET ausente → `PENDING_REFERENCE` (regra 8), seção seguinte.
  - Regra 4: a persistência informa, sob o lock, se a BET já tem um REFUND `PROCESSED`; o índice
    único `wager_transactions_reversal_once_unique` é a garantia final. Só o REFUND aplicado grava
    `reference_transaction_id`: uma rejeição não ocupa o índice.
  - Valor `0.00` é recusado (501), como BET e WIN: nunca seria igual ao de uma BET aplicada, e a
    regra não está definida. A regra 9 (reversão que deixaria saldo negativo) não se aplica a um
    crédito.
- **`failureCode`** (§7.2, taxonomia própria, `src/application/failure-codes.ts`):
  `INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `PLAYER_WALLET_MISMATCH` (WIN e LOSS usam os dois
  últimos) e, para referências: `REFERENCE_NOT_FOUND` (esgotado o limite, §7.1),
  `REFERENCE_MISMATCH` (outro player, wallet, moeda ou rodada, regra 2), `REFERENCE_KIND_NOT_ALLOWED`
  (regra 3), `REFERENCE_NOT_PROCESSED` (ex.: BET `REJECTED`), `REFERENCE_AMOUNT_MISMATCH` (regra 5) e
  `REFERENCE_ALREADY_REVERSED` (regra 4). O código de reversão sem saldo (§7, regra 9) entra com o
  ROLLBACK.
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
- **Recusado sem gravar nada** (regras não definidas pelo contrato ou fora desta etapa): `ROLLBACK`,
  BET, WIN ou REFUND de valor `0.00`, BET, WIN ou LOSS com `referenceExternalTransactionId`
  (`UnsupportedSubmissionError`); wallet inexistente (`WalletNotFoundError`; a FK impede gravar a
  transação).
- **Limite de armazenamento**: um WIN que levaria o saldo acima do `bigint` (`92233720368547758.07`)
  é recusado antes de gravar (`AmountOutOfStorageRangeError`; testado no PostgreSQL, nada é
  gravado). No HTTP vira 400 `INVALID_REQUEST`, como a entrada fora da faixa; a mensagem começa por
  `money:` embora a causa seja o saldo resultante.
- **Reutilização**: `POST /wagering/transactions` já chama este caso de uso; o consumidor SQS deverá
  chamar o mesmo `SubmitWagerTransaction`, com a chave de idempotência da mensagem. O consumidor
  ainda precisará da Inbox na mesma transação (§6.5), que não existe; a Outbox já é gravada nela.

## Referências fora de ordem: `PENDING_REFERENCE` e o worker agendado (contrato §7.1)

Hoje só o REFUND produz `PENDING_REFERENCE`; o mecanismo não depende do tipo.

**Persistência** (migration `Migration20261026104613_pending_reference_retry`, aditiva e
reversível): colunas `reference_attempts` (tentativas do worker, `>= 0`) e
`next_reference_attempt_at`; `CHECK wager_transactions_pending_reference_schedule_check`:
`PENDING_REFERENCE` exige referência externa e próxima tentativa, e nenhum outro estado tem tentativa
agendada; índice parcial `wager_transactions_pending_reference_due_index` em
`next_reference_attempt_at where status = 'PENDING_REFERENCE'` para a busca do worker. A transação
pendente é gravada inteira (payload, hash, chaves, saldo observado ao aceitar): o reprocessamento não
depende de memória do processo nem da reentrega do provedor.

- **Pré-condição do `up`:** nenhuma linha em `PENDING_REFERENCE`, porque ela violaria o novo
  `CHECK`. Antes desta migration, nenhum código produzia esse estado. As colunas novas usam padrão
  constante (`0`) ou `null` e não reescrevem dados. A validação dos `CHECK`s percorre a tabela sob
  lock exclusivo; numa tabela grande, valeria `NOT VALID` seguido de `VALIDATE CONSTRAINT`.
- **O `down` perde dados:** apaga tentativas e agendamentos. Uma linha ainda em `PENDING_REFERENCE`
  ficaria sem worker, porque a versão anterior não reprocessa. Só reverta sem pendências ou
  aceitando resolvê-las manualmente.

**Política de tentativas** (`ReferenceRetryPolicy`, decisão aprovada; o §7.1 pede um limite
"definido e justificado"): 10 tentativas do worker; a primeira 2 s após a submissão, dobrando até o
teto de 5 min (2, 4, 8, 16, 32, 64, 128, 256, 300 e 300 s). Esgotadas as 10 sem a referência, cerca
de 18,5 min após a submissão: `REJECTED` com `REFERENCE_NOT_FOUND`, sem lançamento. Justificativa:
a reentrega fora de ordem de uma fila at-least-once ocorre em segundos ou minutos; uma pendência de
horas manteria o provedor sem resposta definitiva. Configurável por ambiente (`README.md`); a
submissão e o worker usam a mesma política.

**Worker** (`ReprocessPendingReferences` + `PendingReferenceWorker`, em toda instância da API):

- rodadas sequenciais, com `PENDING_REFERENCE_POLL_INTERVAL_MS` (padrão 1 s) entre o fim de uma e o
  início da próxima, e no máximo `PENDING_REFERENCE_BATCH_SIZE` (50) transações vencidas por rodada,
  das mais antigas para as mais novas. Sem laço sem limite: cada transação é tentada no máximo uma
  vez por rodada, e só quando vence;
- cada tentativa é uma transação SQL: trava a wallet (mesma ordem de locks da submissão), relê a
  transação com `status = 'PENDING_REFERENCE'` e o vencimento, resolve a referência sob o lock e
  aplica a **mesma** regra da submissão (`decideRefund`); grava a transação (tentativa contada), o
  saldo, a versão e o lançamento juntos, com `UPDATE … WHERE status = 'PENDING_REFERENCE'`;
- várias instâncias ou workers: duas tentativas da mesma transação se serializam na wallet, e a
  segunda encontra o estado já gravado (contada como `skipped`). Não há crédito duplo nem tentativa
  contada duas vezes;
- falha transitória (`TransientPersistenceError`): tudo é desfeito, a tentativa não é consumida e a
  transação volta na próxima rodada; nunca é confundida com referência inválida. Falhas operacionais
  também desfazem tudo, são logadas com `transactionId` e `walletId` e põem a transação em
  quarentena (abaixo);
- reinício: nenhum estado em memória; outra instância, ou a mesma reiniciada, continua pelo banco.
  No shutdown, o agendamento para e a rodada em andamento termina. O `MikroOrmCoreModule` é global, e
  o Nest encerra os módulos globais por último: o ORM fecha depois de o worker terminar a rodada.
  Uma falha do próprio log não interrompe o agendamento;
- logs JSON só com contagens e ids, sem valores nem payloads (§12).

**Categorias de falha numa tentativa** (o §7.1 limita as tentativas pela **ausência da
referência**; falhas operacionais não são referência inexistente):

| Categoria                                | Exemplos                                                                                 | Tratamento atual                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Referência ausente                       | BET ainda não chegou                                                                     | nova tentativa com backoff; esgotado o limite, `REJECTED` com `REFERENCE_NOT_FOUND`                                         |
| Referência existente e inválida          | outra rodada, valor, BET `REJECTED`, já reembolsada                                      | `REJECTED` imediato, com o código da violação                                                                               |
| Transitória                              | conexão, deadlock, serialização, servidor indisponível (`isTransientPersistenceFailure`) | tudo desfeito; a tentativa não é consumida; volta na rodada seguinte                                                        |
| Operacional (permanente ou desconhecida) | defeito de código, saldo acima do `bigint` no crédito                                    | tudo desfeito e logado; depois, **quarentena** com backoff (abaixo); nunca consome tentativa nem vira `REFERENCE_NOT_FOUND` |

**Quarentena de falhas operacionais** (decisão aprovada, opção B; migration
`Migration20261026114119_worker_processing_failures`, aditiva e reversível, sem pré-condição):

- a coluna `processing_failures` (`int not null default 0`) conta as falhas operacionais seguidas.
  Ela é separada de `reference_attempts`, que continua contando só as tentativas de resolução e é o
  único contador do limite do §7.1. Os `CHECK`s garantem `processing_failures >= 0` e valor
  diferente de zero só em `PENDING_REFERENCE`;
- depois do rollback da tentativa que falhou, uma transação própria (`deferAfterFailure`) faz
  `SELECT … FOR UPDATE` da linha. Ela só segue se a linha ainda estiver em `PENDING_REFERENCE` e
  vencida no instante da tentativa. Então incrementa o contador e adia a próxima tentativa com a
  **mesma** progressão e o mesmo teto da política, reutilizando `PENDING_REFERENCE_BASE_DELAY_MS` e
  `PENDING_REFERENCE_MAX_DELAY_MS` (2, 4, 8… até 300 s), sem limite de ocorrências;
- o adiamento trava só a linha da transação e nenhum lock depois dela, então não forma ciclo com a
  tentativa (wallet, depois transação). Uma transição concluída ou outro adiamento concorrente fazem
  as condições falharem, e nada é sobrescrito. Mesmo sem essa guarda, os `CHECK`s impediriam
  agendamento ou contador numa linha terminal;
- uma falha ao gravar o adiamento só é relatada (`pending_reference_defer_failed`, `deferFailures`).
  A linha continua vencida, e a rodada segue com as demais;
- falhas transitórias **não** entram em quarentena nem incrementam o contador;
- uma tentativa concluída (`PROCESSED`, `REJECTED` ou reagendada pela ausência da referência) zera o
  contador **no mesmo `UPDATE` da transição**. O histórico só some com o commit dela;
- efeito: uma linha com defeito sai das rodadas seguintes até vencer a quarentena, e as saudáveis
  avançam (teste com 55 linhas com defeito e lote de 50). Corrigida a causa, a linha resolve sozinha
  na próxima tentativa.

**Limite da quarentena — decisão pendente.** Não há saída terminal para falha operacional: uma linha
cujo defeito persiste fica em `PENDING_REFERENCE` indefinidamente, tentada no máximo a cada 5 min,
e só os logs a sinalizam (não há métrica nem alerta). O contrato define `FAILED` como "erro
permanente de infraestrutura (terminal, auditável)" (§6.3), mas não diz quando uma falha
desconhecida passa a ser permanente. Tornar o REFUND terminal impediria o reembolso mesmo depois de
uma correção, então a política (limite K, código, HTTP e procedimento manual) foi adiada.

Achado latente para essa decisão: o controller responde 200 para qualquer status que não seja
`REJECTED` nem `PENDING_REFERENCE`, então um `FAILED` responderia 200. Hoje isso é inalcançável,
porque a persistência recusa gravar `FAILED` (`assertDecision`).

**HTTP e idempotência.** Pendente → 202 com `{ status: "PENDING_REFERENCE", balance }` (saldo
observado ao aceitar). O reenvio devolve o estado atual gravado: 202 enquanto pendente; depois, o
resultado terminal (200 ou 422) com o saldo observado na conclusão. Conflito de payload e operação
externa duplicada seguem iguais.

**Eventos** (§7.1 e §11): a entrada em `PENDING_REFERENCE` grava `WagerTransactionPendingReference`
na outbox; um novo agendamento não grava nada; a resolução grava `WagerTransactionProcessed` e
`WalletBalanceChanged`, e o esgotamento, `WagerTransactionRejected` (`REFERENCE_NOT_FOUND`), cada um
no mesmo commit da transição (seção "Transactional Outbox"). Ainda **não publicados**.

**Testes**: `test/integration/pending-reference.integration.test.ts`. Cobre:

- gravação pendente sem saldo, versão ou ledger, e os `CHECK`s;
- referência incompatível já existente;
- resolução quando a BET chega, com uma única tentativa contada e um crédito;
- backoff persistido até o limite e `REFERENCE_NOT_FOUND`;
- BET incompatível que chega depois, e REFUND concorrente que já reembolsou a BET;
- 10 REFUNDs distintos e simultâneos da mesma BET, em 3 pools, com um único `PROCESSED`;
- REFUND pendente reenviado com outra chave, que resulta em operação externa duplicada e nada
  gravado;
- 3 pools concorrentes;
- REFUND e BET simultâneos;
- 20 reenvios simultâneos e o replay depois da resolução;
- falha transitória sem consumir a tentativa;
- falha no meio da tentativa desfazendo transação, wallet e ledger, seguida da quarentena e da
  resolução depois de vencida;
- reinício com outra instância do ORM;
- reconciliação.

A quarentena tem testes próprios, em
`test/integration/pending-reference-quarantine.integration.test.ts`:

- o backoff persistido;
- 15 falhas seguidas sem `REFERENCE_NOT_FOUND` e sem consumir tentativas;
- a recuperação depois de corrigida a causa, com o contador zerado, tanto com a BET quanto sem ela;
- a starvation, com 55 linhas com defeito e 3 saudáveis;
- a falha transitória sem quarentena;
- a falha ao gravar o adiamento;
- o adiamento que não sobrescreve uma linha concluída nem uma não vencida, em execução sequencial;
- as corridas com o adiamento, em ordem controlada (abaixo);
- o replay de uma linha em quarentena (`PENDING_REFERENCE`);
- os `CHECK`s e a reconciliação.

**Corridas em ordem controlada** (substituem um teste anterior com 3 pools, que dependia de timing):

- uma transação de teste trava a linha (`SELECT … FOR UPDATE`, sem escrever nada) e dois
  participantes reais, em pools separados, são enfileirados atrás dela: o resolver
  (`ReprocessPendingReferences`) e/ou o adiamento (`deferAfterFailure`);
- antes de liberar a linha, o teste **verifica a ordem no PostgreSQL**, em vez de supô-la:
  - por `pg_stat_activity`, cada participante está esperando um lock (identificado pela consulta);
  - por `pg_blocking_pids`, o primeiro é bloqueado pela transação de teste, e o segundo é bloqueado
    pelo **primeiro**, e não o contrário (quem está à frente segura o lock da tupla);
- a espera por cada participante é condicionada: a mesma consulta se repete a cada 10 ms, até 5 s;
  o intervalo não sincroniza nada.

| Cenário | Ordem                                    | Resultado verificado                                                                                                         |
| ------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A       | resolver, depois adiamento               | `PROCESSED` com um crédito; o adiamento devolve `false` e não altera o registro                                              |
| B       | resolver (BET ausente), depois adiamento | o resolver reagenda (data + 4 s, 1 tentativa); o adiamento devolve `false` e não toca na data nem no contador                |
| C       | adiamento, depois resolver               | contador 1 e data + 2 s; o resolver encontra a linha não vencida (`skipped`): nenhuma tentativa consumida, nenhum lançamento |
| D       | dois adiamentos                          | `[true, false]`: só o primeiro altera o registro                                                                             |

Os quatro passaram em 10 execuções seguidas. Limite: a ordem é imposta pela fila de locks do
PostgreSQL, e o teste a observa de fora; não há pontos de sincronização no código de produção.

Mutações conferidas:

- sem a quarentena, 7 testes falham, entre eles o de starvation;
- sem a guarda de elegibilidade do adiamento (status e vencimento), A, B e D falham. Em A, o `CHECK`
  de agendamento recusa a escrita na linha `PROCESSED`, a última barreira;
- sem só a guarda de vencimento do adiamento, B e D falham;
- sem a guarda de vencimento do resolver, C falha;
- com quarentena também em falhas transitórias, os testes de integração e unitário da falha
  transitória falham.

Por HTTP, há 202, 200, 422 e o worker da própria aplicação resolvendo a pendência. Mutações
conferidas:

- sem a releitura do status sob o lock, o teste de workers concorrentes falha;
- sem a consulta da regra 4, os testes de segundo REFUND falham, e o índice único barra o crédito
  duplo.

**Limites conhecidos.**

- A pendência não é antecipada quando a BET chega: ela espera o próximo vencimento, que, depois de
  algumas tentativas, pode estar a até 5 min.
- Falha operacional persistente: a quarentena impede que a linha bloqueie a fila, mas não a encerra.
  `FAILED` é uma decisão pendente (acima).
- Falha transitória **específica de uma linha** (ex.: deadlock repetido só com ela) continua sem
  quarentena e é retentada a cada rodada. Isso é intencional, para não confundir ambiente com
  defeito.
- Várias instâncias leem as mesmas linhas vencidas e esperam umas pelas outras no lock da wallet.
  O resultado continua correto, mas há trabalho repetido; seria possível evitá-lo com
  `SKIP LOCKED`.
- Durante uma indisponibilidade do banco, o worker tenta de novo a cada intervalo de poll, sem
  backoff no nível da rodada.
- O worker roda em processo, junto da API. Não há worker separado nem métrica exportada.

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
`failureCode` quando `REJECTED` (§7.2). `balance` é o saldo observado ao concluir (em
`PENDING_REFERENCE`, ao aceitar).

**Mapeamento HTTP** (o §9 deixa a escolha ao candidato, desde que as situações sejam distintas e
consistentes):

| Situação                                                                                    | Status | Corpo                                              |
| ------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------- |
| `PROCESSED`, nova ou replay                                                                 | 200    | resultado                                          |
| `PENDING_REFERENCE` (aceita, aguardando a referência), nova ou replay                       | 202    | resultado                                          |
| `REJECTED` (saldo, moeda, player, referência), nova ou replay                               | 422    | resultado, com `failureCode`                       |
| Payload inválido, JSON malformado, `Idempotency-Key` ausente/vazia, valor acima do `bigint` | 400    | erro `INVALID_REQUEST`                             |
| Wallet inexistente                                                                          | 404    | erro `WALLET_NOT_FOUND`                            |
| Mesma chave com outro payload                                                               | 409    | erro `IDEMPOTENCY_KEY_CONFLICT`                    |
| Mesma operação externa com outra chave                                                      | 409    | erro `DUPLICATE_EXTERNAL_TRANSACTION`              |
| ROLLBACK, BET, WIN ou REFUND de valor zero, BET, WIN ou LOSS com referência                 | 501    | erro `UNSUPPORTED_SUBMISSION`                      |
| Falha transitória do banco                                                                  | 503    | erro `TRANSIENT_FAILURE`                           |
| Qualquer outro erro                                                                         | 500    | `{ statusCode, message: "Internal server error" }` |

Corpo de erro: `{ statusCode, error, message, code }`, com `code` estável para o provedor decidir sem
ler a mensagem. A rejeição de negócio usa o corpo do resultado, não o de erro: ela foi gravada e é
devolvida igual no replay. O replay mantém o status do resultado gravado (200 ou 422; 202 enquanto
a referência não é resolvida, depois o status do resultado terminal). Nenhuma resposta inclui
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
simultâneos, LOSS registrado sem lançamento (inclusive de valor zero), replay e conflito de LOSS,
LOSS em moeda incompatível (422), REFUND antes da BET (202, replay 202), REFUND aplicado (200),
REFUND com referência incompatível (422), segundo REFUND da mesma BET (422) e o worker agendado
da aplicação resolvendo a pendência (o reenvio passa a 200), entradas inválidas sem efeito e falhas
sem vazamento. Nesses testes o worker fica desligado, exceto no teste do agendamento. As requisições
simultâneas vão a uma única instância da aplicação; o cenário com processos independentes está em
`bet-processing.integration.test.ts`.

**Limitações.** `POST /wallets` ainda usa o corpo de erro padrão do Nest, sem `code`: a consistência do formato
entre endpoints (§9) fica pendente. Um header `Idempotency-Key` repetido chega ao Node como valores
unidos por vírgula e é aceito como uma única chave.

## Transactional Outbox (contrato §6.5 e §11)

**O que existe**: a gravação e o publisher. Cada decisão financeira grava seus eventos de
integração em `outbox_messages` **na mesma transação SQL** que grava a transação, o saldo, a versão
e o lançamento. Ou tudo é confirmado no mesmo commit, ou nada. O publisher (seção "Publisher da
outbox") envia os eventos confirmados para `wager-events.fifo`. **O que ainda não existe**: um
consumidor dos eventos.

**Por que na mesma transação**: publicar antes do commit poderia anunciar uma alteração desfeita
depois; publicar depois do commit, sem registro, perderia o evento se o processo morresse entre os
dois passos (§11, cenário obrigatório). Com a outbox, o commit que confirma a alteração confirma
também o evento, que fica persistido para o publisher mesmo que o processo termine logo em seguida.

**Eventos por operação** (contratos e fábricas do incremento anterior, `src/application/events/`):

| Situação                                                     | Eventos gravados                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| BET, WIN ou REFUND aplicados                                 | `WagerTransactionProcessed` + `WalletBalanceChanged`                                 |
| LOSS aplicado                                                | `WagerTransactionProcessed`                                                          |
| Rejeição de negócio (na submissão ou no worker)              | `WagerTransactionRejected`                                                           |
| Entrada em `PENDING_REFERENCE` (só na submissão)             | `WagerTransactionPendingReference`                                                   |
| Novo agendamento de uma pendência                            | nenhum                                                                               |
| Pendência resolvida                                          | `WagerTransactionProcessed` + `WalletBalanceChanged`                                 |
| Abertura com saldo positivo                                  | `WagerTransactionProcessed` (OPENING) + `WalletBalanceChanged` (0 → saldo, versão 1) |
| Abertura com saldo zero, replay, conflito, falha transitória | nenhum                                                                               |

ROLLBACK continua recusado na submissão; nenhuma regra nova foi criada para ele.

**Onde os eventos são derivados**: nos repositórios, dentro da transação, por `eventsForTransition`
e `eventsForWalletOpening`. O estado anterior não vem do chamador: na submissão, a transação é
criada naquela mesma transação SQL (conferido sob o lock da wallet), então parte de `PENDING`; no
worker, é o `PENDING_REFERENCE` da linha relida com `FOR UPDATE`. Por isso um novo agendamento não
repete o evento de espera. O estado anterior é lido da linha crua, não do objeto de domínio, que a
decisão altera.

**Schema** (`Migration20261026135325_outbox_messages`):

- `id` = `eventId` do envelope; `payload` (`jsonb`) = envelope completo de `toJSON()`, com valores
  em `MoneyProps` (texto decimal, sem `bigint`); `jsonb` preserva o conteúdo, não a ordem das chaves.
- `transaction_id` (FK) é a transação de origem, inclusive de `WalletBalanceChanged`, cujo
  `aggregate_id` é a wallet; `message_group_id` (FK) é a wallet, futuro `MessageGroupId`.
- `UNIQUE (transaction_id, event_type)`: cada tipo sai no máximo uma vez por transação (estados
  terminais, um lançamento por transação, espera só na entrada). É defesa adicional: ela recusa uma
  duplicata, mas não detecta um evento omitido; a transição certa vem da leitura sob o lock.
- CHECK de coerência entre o envelope e as colunas (`eventId`, `eventType`, `version`,
  `aggregateId`, `correlationId`, `walletId` e `transactionId` do `data`).
- Imutabilidade: trigger `content_no_update` recusa UPDATE das colunas de conteúdo; `attempts`,
  `next_attempt_at`, `claimed_until`, `claim_token`, `published_at` e `last_error_code` continuam
  atualizáveis, para o publisher. Linhas publicadas são mantidas; DELETE não é bloqueado.
- Índices parciais de não publicados: por vencimento (`next_attempt_at`, `seq`) e por wallet
  (`message_group_id`, `seq`).

**Correlação**: cada execução de `SubmitWagerTransaction` e `OpenWallet` gera um `correlationId`
no servidor (UUID; sem header de entrada, sem derivar da chave de idempotência), gravado em
`wager_transactions.correlation_id` e em todos os eventos daquela operação. O worker não gera outra:
os eventos da resolução ou do esgotamento usam a correlação gravada na submissão. A migration
preencheu as transações já existentes com uma correlação nova e tornou a coluna obrigatória; assim
não há linha sem correlação para o worker tratar.

**Transações anteriores à migration**: o UUID atribuído pela migration é sintético. Ele permite
correlacionar de forma consistente os eventos gerados a partir da migration, mas não recupera a
correlação original da submissão, que nunca foi gravada. Transações que já estavam em
`PENDING_REFERENCE` antes da migration não recebem retroativamente um evento
`WagerTransactionPendingReference`; se forem resolvidas ou esgotadas depois, os novos eventos usam a
correlação persistida pela migration.

**Entrega at-least-once**. O publisher só marca o evento como publicado depois de o SQS aceitá-lo;
se cair entre o envio e a marcação, o evento é reenviado. Por isso o evento é
gravado uma vez, com `eventId` fixo, e toda republicação envia o mesmo envelope: o consumidor
reconhece a duplicata pelo `eventId`. FIFO com deduplicação não torna isso exactly-once (a janela
de deduplicação do SQS é limitada).

**Ordenação**: `seq` é uma sequência auxiliar, não uma garantia global da ordem dos commits: os
valores da sequência são obtidos fora do controle transacional, então transações concorrentes podem
fazer commit em ordem diferente da de seus números. **Por wallet**, `seq` acompanha a ordem de
commit, mas a garantia é **condicional**: decorre da exclusividade por wallet mantida até o commit,
não da sequência. Nas operações sobre wallets existentes (submissão e worker), os eventos são
gravados enquanto a wallet está bloqueada com `FOR UPDATE`, lock mantido até o commit; na abertura,
os eventos são gravados na mesma transação que cria a wallet, antes de ela ficar visível para outras
transações. Em todos esses caminhos, `seq` só é obtido no `INSERT` da outbox, depois da
exclusividade; assim, a próxima transação da wallet só obtém números depois do commit da anterior.
Dentro de uma transação, `Processed` vem antes de `WalletBalanceChanged`.

A garantia por wallet depende destas premissas, que nem o banco nem o código impõem por completo:

- **Exclusividade antes da gravação**: todo novo caminho que grave na outbox deve obter a
  exclusividade da wallet (`FOR UPDATE` da wallet, ou criá-la na mesma transação) antes do primeiro
  `INSERT`, e mantê-la até o commit. `insertOutboxMessages` não verifica isso. Um `INSERT` sem lock
  obtém o `seq` antes de esperar pela wallet e pode ser confirmado depois de eventos com `seq` maior.
- **`CACHE 1`**: premissa necessária. Com cache maior, cada sessão pré-aloca um bloco de valores, e
  uma sessão com um bloco mais antigo pode gravar, depois do commit de outra, um `seq` menor, mesmo
  com o lock da wallet. É o padrão do PostgreSQL para `bigserial`, conferido pelo teste de integração
  da outbox; não substitui o protocolo de locks nem garante ordem global de commits.
- **`seq` nunca explícito**: a coluna (`bigserial`) aceita valor fornecido no `INSERT`; os caminhos
  de gravação omitem a coluna, e o trigger de imutabilidade só bloqueia `UPDATE`.
- **Sem perda do lock por savepoint**: o PostgreSQL pode perder o lock de uma linha travada e depois
  modificada num savepoint desfeito por `ROLLBACK TO SAVEPOINT`. Hoje não há savepoint entre a
  aquisição do lock e a gravação; uma chamada dentro de transação externa (por exemplo, o futuro
  consumidor com Inbox) precisa preservar isso.
- **Sequência não reiniciada nem redefinida**: `setval`, `ALTER SEQUENCE … RESTART`, `CYCLE` ou uma
  restauração parcial podem invalidar a monotonicidade esperada.

**Entre wallets**, `seq` não indica ordem de commit, e não precisa. A ordem de `seq` também não
garante, por si só, a ordem de publicação no SQS FIFO; isso depende do publisher, que envia os
eventos de cada wallet em ordem de `seq`, só libera um evento de uma wallet quando os anteriores
dela já foram publicados e publica com `MessageGroupId = walletId` (seção seguinte).

**Testes** (`test/integration/outbox.integration.test.ts`, PostgreSQL real): envelope persistido e
coerente com as colunas; eventos por operação (BET, WIN, LOSS, REFUND, rejeição, abertura positiva
e zero); entrada em espera, novo agendamento sem evento, resolução com a correlação original e
esgotamento; falha transitória sem evento; sequência de SQL de uma submissão (`begin`, transação,
saldo, ledger, dois eventos, `commit`); falha na outbox desfaz transação, saldo e ledger (submissão,
worker e abertura); falha no ledger ou no estado não deixa evento órfão; constraints e trigger;
entrega duplicada concorrente com um efeito e dois eventos; `seq` coerente com a ordem de commit
numa wallet; wallets independentes; sequência de `seq` com `CACHE 1`; migration revertida e
reaplicada preenchendo a correlação.

## Publisher da outbox (contrato §11)

`PublishOutbox` (`src/application/outbox/publish-outbox.ts`) executa uma rodada; o
`OutboxPublisherWorker` (`src/messaging/`) agenda as rodadas como o worker de `PENDING_REFERENCE`
(uma por vez, sem estado em memória). A reserva e a marcação estão em `MikroOrmOutboxRepository`
(`src/database/repositories/outbox.repository.ts`), uma instrução SQL por operação, com o relógio
do banco. O envio está em `SqsEventPublisher` (`src/messaging/sqs-event-publisher.ts`).

**Rodada**:

1. **Reserva por wallet**: só a "cabeça" de uma wallet (o evento não publicado de menor `seq`) pode
   ser reservada, se vencida (`next_attempt_at <= now()`) e sem reserva válida. A cabeça é travada
   com `FOR UPDATE SKIP LOCKED` e, na mesma instrução, ela e os eventos seguintes da wallet (até
   `maxPerGroup`) recebem `claim_token` e `claimed_until = now() + lease`. Dois publishers nunca
   reservam a mesma wallet; quem chega depois do commit vê a cabeça reservada.
2. **Envio em ordem**: os eventos de cada wallet saem um de cada vez, em ordem de `seq`, com
   `MessageGroupId = walletId`, `MessageDeduplicationId = eventId`, o envelope gravado como corpo e
   `eventType` como atributo. Cada envio tem timeout (`sendTimeoutMs`, até metade da reserva).
3. **Marcação só depois do aceite**: `published_at` é gravado depois de o SQS aceitar o envio, e só
   se a reserva ainda for do mesmo token. Uma reserva perdida (expirada e assumida por outro
   publisher) interrompe a wallet na rodada, sem sobrescrever o trabalho do outro.
4. **Falha de envio**: o evento não é marcado; `attempts + 1`, `last_error_code` (nome do erro) e
   `next_attempt_at = now() + backoff` (1 s dobrando até 60 s). Os eventos seguintes da wallet não
   são enviados: a wallet espera o evento que falhou. As outras wallets seguem.
5. **Fim da rodada**: as reservas restantes do token são liberadas. Nenhum envio começa depois de
   metade da reserva; o restante fica de margem para o envio em curso e a marcação.

**Recuperação**: um publisher que cai com eventos reservados (antes ou depois de enviar) deixa a
reserva expirar; outro publisher reserva a wallet e reenvia a partir da cabeça, com os mesmos
`eventId`s. É o cenário do §11 (commit, processo morre antes de publicar, outra instância publica).

**Decisões**:

- **Sem limite de tentativas nem DLQ na publicação**: um evento confirmado nunca é descartado
  (§11, "sem perder"), e descartá-lo quebraria a ordem da wallet. Uma falha permanente (ex.: fila
  inexistente) para a wallet afetada com backoff até 60 s e aparece nos logs
  (`outbox_publish_failed`, com `eventId`, `walletId` e o nome do erro); as outras wallets seguem.
- **Desligado por padrão** (`OUTBOX_PUBLISHER_ENABLED=false`): só quando ligado a configuração do
  SQS é lida. Assim a API e os testes que sobem o `AppModule` não dependem do broker. Em produção e
  na demonstração, ligar com a fila provisionada (`bun run sqs:up`).
- **Destino `wager-events.fifo`**: o contrato não define a fila dos eventos de saída. As filas do
  §10 (`wager-transactions.fifo` e a DLQ) são de entrada.
- **Duplicatas possíveis, todas com o mesmo `eventId`**: reenvio após a queda de um publisher, ou um
  envio que excede a reserva. Dentro de 5 min, a deduplicação do SQS as descarta; depois, o
  consumidor deduplica pelo `eventId`. Não é exactly-once.
- **Envio individual** (`SendMessage`), não em lote: simplifica a parada da wallet na primeira
  falha. Vazão: uma wallet por vez em cada publisher; várias instâncias dividem as wallets.

**Testes**:

- `test/unit/publish-outbox.test.ts`: ordem, marcação depois do envio, parada da wallet na falha,
  backoff, reserva perdida, limite de tempo da reserva e liberação mesmo com erro.
- `test/integration/outbox-publisher.integration.test.ts` (PostgreSQL real, broker registrado em
  memória): uma publicação por evento em ordem de `seq`; falha que não marca, reagenda e bloqueia só
  a wallet, depois sai em ordem; dois publishers em pools distintos sem duplicata e com ordem por
  wallet; reserva de publisher caído que expira, é assumida, e cujo token antigo não marca mais.
- `test/sqs/outbox-publisher.sqs.test.ts` (PostgreSQL e ElasticMQ reais, filas efêmeras): grupo,
  deduplicação, atributo, corpo e ordem das mensagens recebidas; reenvio descartado pelo SQS.

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
- **Regras de negócio sem definição no contrato**, ainda abertas: tratamento de BET e WIN de valor
  zero (e de REFUND de valor zero); se BET e LOSS admitem referência e o que um LOSS referenciaria;
  se a BET referenciada por um WIN precisa estar `PROCESSED`; e se há limite de WINs por rodada ou
  por BET (o contrato não define, e nada foi limitado). LOSS de valor zero segue a regra registrada
  no projeto (aceito). A taxonomia de `failureCode` cobre BET, WIN, LOSS e REFUND (seção acima).
- **Worker de referências pendentes no banco, não no SQS**: a fila FIFO não permite atraso por
  mensagem, e o estado (tentativas, próxima data) precisa ser persistente e consultável. A busca é
  periódica e indexada, e cada rodada é limitada. Trade-off: há latência de até um intervalo de
  poll além do backoff.

## Ainda não implementado

WIN e LOSS com referência, ROLLBACK (inclusive a regra 9), Inbox, consumo SQS de
`wager-transactions.fifo`, retry e DLQ da entrada (§6.5 e §10), consultas e reconciliação pela API
(`GET /wallets/:id`, ledger, transações), autenticação real (§2), observabilidade (§12: métricas,
inclusive outbox lag) e `GET /health/ready`. Política terminal (`FAILED`) para falhas operacionais
persistentes do worker: decisão pendente (hoje, quarentena sem fim).
