# Wagering Processor

Solução para o desafio técnico **Distributed Wagering Processor**, da Jungle Gaming:
<https://github.com/junglegaming/backend-challenge>

O objetivo é um serviço financeiro distribuído que processa transações de apostas vindas de
múltiplos provedores, mantendo correção financeira, idempotência persistente e consistência entre
saldo e ledger sob concorrência, mensagens duplicadas, entregas fora de ordem e falhas de processo.

## Status

**Em construção.** Neste momento o repositório contém apenas a fundação do projeto (ferramentas e
configuração). Ainda **não há** código de domínio, API, banco de dados, migrations, mensageria nem
testes. Esta seção será atualizada a cada etapa concluída; nada será descrito como pronto antes de
estar implementado e verificado.

## Stack alvo

Definida pelo desafio e ainda não implementada:

| Item                                          | Escolha                                            |
| --------------------------------------------- | -------------------------------------------------- |
| Runtime, gerenciador de pacotes e test runner | Bun 1.x                                            |
| Linguagem                                     | TypeScript em modo estrito                         |
| Framework                                     | NestJS                                             |
| Banco de dados                                | PostgreSQL                                         |
| Mensageria                                    | AWS SQS (FIFO) em ambiente local                   |
| Orquestração local                            | Docker Compose                                     |
| ORM e migrations                              | MikroORM, com migrations versionadas e reversíveis |

## Pré-requisitos

- [Git](https://git-scm.com/)
- [Bun](https://bun.sh/) 1.4 ou superior (a base foi preparada com Bun 1.4.4)
- Docker Desktop com Docker Compose (será necessário a partir da etapa de infraestrutura)

## Como começar

```bash
bun install
bun run lint
```

## Scripts disponíveis

| Script             | Descrição                                        |
| ------------------ | ------------------------------------------------ |
| `bun run lint`     | Verifica formatação e regras de lint com o Biome |
| `bun run lint:fix` | Aplica as correções automáticas do Biome         |
| `bun run format`   | Formata os arquivos com o Biome                  |

## Segurança

Este é um repositório público. Não versione senhas, tokens, chaves ou credenciais reais. Arquivos
`.env` são ignorados pelo Git; apenas o modelo `.env.example`, com valores fictícios, será
versionado quando existirem variáveis de ambiente.
