# Wagering Processor

Solução para o desafio técnico **Distributed Wagering Processor**, da Jungle Gaming:
<https://github.com/junglegaming/backend-challenge>

O objetivo é um serviço financeiro distribuído que processa transações de apostas vindas de
múltiplos provedores, mantendo correção financeira, idempotência persistente e consistência entre
saldo e ledger sob concorrência, mensagens duplicadas, entregas fora de ordem e falhas de processo.

## Status

**Em construção.** Neste momento o repositório contém a fundação do projeto (ferramentas e
configuração) e o bootstrap mínimo do NestJS com `GET /health/live`, coberto por testes HTTP.
Ainda **não há** código de domínio, banco de dados, migrations, mensageria nem `GET /health/ready`.
Esta seção será atualizada a cada etapa concluída; nada será descrito como pronto antes de estar
implementado e verificado.

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
bun run check
bun run dev        # http://localhost:3000/health/live
```

A porta HTTP é lida de `PORT` (padrão `3000`; inteiro entre 1 e 65535).

## Scripts disponíveis

| Script                     | Descrição                                                      |
| -------------------------- | -------------------------------------------------------------- |
| `bun run dev`              | Sobe a API com recarga automática                              |
| `bun run start`            | Sobe a API                                                     |
| `bun run lint`             | Verifica formatação e regras de lint com o Biome               |
| `bun run lint:fix`         | Aplica as correções automáticas do Biome                       |
| `bun run format`           | Formata os arquivos com o Biome                                |
| `bun run typecheck`        | Verifica os tipos com `tsc --noEmit`                           |
| `bun run test`             | Executa todos os testes (`bun test`)                           |
| `bun run test:smoke`       | Sobe `src/main.ts` em processo separado e chama a API por HTTP |
| `bun run test:integration` | Testes HTTP em processo com `@nestjs/testing`                  |
| `bun run check`            | Lint, typecheck e testes                                       |

## Segurança

Este é um repositório público. Não versione senhas, tokens, chaves ou credenciais reais. Arquivos
`.env` são ignorados pelo Git; apenas o modelo `.env.example`, com valores fictícios, será
versionado quando existirem variáveis de ambiente.
