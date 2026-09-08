# RoughBid — checklist de conclusão

Data: 8 de setembro de 2026. Este documento separa o que está fechado em código
do que só pode ser fechado com credenciais de produção ou uma decisão comercial.
Nada aqui declara certificado um ciclo que não foi executado.

## Estado do repositório

Verificado nesta sessão, com dependências instaladas (`npm ci`):

| Verificação | Comando | Resultado |
| --- | --- | --- |
| Suíte completa | `npm test` | 368 testes, 0 falhas |
| Typecheck backend/worker | `npx tsc --noEmit` | limpo |
| Typecheck app web | `npx tsc --noEmit -p apps/web/app/tsconfig.json` | limpo |
| Schema Prisma | `npm run db:validate` | válido |
| Build de produção | `npm run build` | gera `dist/`, `dist/app/`, `dist/landing/` |

O build exige `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`; valores
apenas de compilação bastam para validar o build, e são os que a CI usa.

## Fechado nesta entrega

- **Gate de CI incondicional** (`.github/workflows/ci.yml`): typecheck backend e
  web, validação do schema Prisma, suíte completa e build de produção em todo
  push para `main` e em todo pull request. O workflow anterior
  (`durable-ai-plan.yml`) só disparava em uma branch e num conjunto de paths, o
  que permitia que mudanças fora daquela lista chegassem em `main` sem execução.
- **Checkout de marketplace recusado na primitiva** (`apps/api/src/billing/stripe.ts`):
  `createCheckoutRequest` agora rejeita qualquer chave `marketplace_*`. O endpoint
  já respondia 503, mas a primitiva tratava toda chave não-`project_` como
  assinatura — um preço de marketplace configurado por engano geraria cobrança
  recorrente sem conceder produto algum. Coberto por teste.
- **Documento de propostas corrigido** (`docs/architecture/client-view-proposals.md`):
  dizia "API e UI a seguir" enquanto `apps/api/src/proposals/routes.ts`,
  `ClientProposalPage.tsx` e o rewrite `/proposal/:token` já estavam em produção.

## Pendências que exigem produção ou decisão sua

Nenhuma destas é limitação de código. Todas dependem de credencial real, de uma
execução autorizada ou de um preço que ainda não foi definido.

### 1. Validar uma leitura de IA real (maior prioridade)

O diagnóstico `ai_provider_failure` foi implementado mas nunca observou uma
falha real. Até uma execução autorizada, a causa do incidente de produção do
Gemini permanece desconhecida.

1. Confirmar `GEMINI_API_KEY` e `GEMINI_MODEL` na Vercel (produção).
2. Ativar `PAID_PLAN_READINGS_ENABLED=true` ou usar o caminho gratuito do
   proprietário (`FREE_OWNER_READINGS_ENABLED`, `FREE_OWNER_WORKSPACE_ID`).
3. Rodar uma análise em um projeto do workspace do proprietário.
4. Se falhar, ler o código e a referência UUID do `ai_provider_failure` e cruzar
   com a tabela de `docs/readiness/2026-09-08-ai-provider-diagnostics.md`.

Sem esse passo, os itens 2 e 4 não podem ser avaliados com honestidade.

### 2. Primeiro convite do piloto com pessoa real

O ciclo email → ativação → PDF → geração → lembrete → expiração existe apenas em
teste automatizado; nenhum convite foi enviado. Requer `PILOT_READINGS_ENABLED=true`,
`PILOT_INVITE_SIGNING_SECRET`, `CRON_SECRET` e `RESEND_WEBHOOK_SECRET`.

Começar por **um** convite no preset `Sample` (7 dias, 1 projeto). Observar a
qualidade real antes de liberar 60 dias ou ampliar o grupo. Cada projeto reserva
US$0,25 do teto de US$125; o painel mostra vagas e orçamento.

### 3. Preço por projeto

O checkout por projeto fica desabilitado enquanto `PROJECT_PRICING_VERSION`,
`PROJECT_COST_BASE_CENTS`, `PROJECT_COST_PAGE_CENTS`, `PROJECT_COST_TRADE_CENTS`,
`PROJECT_PAYMENT_FIXED_CENTS` e `PROJECT_PAYMENT_FEE_BPS` estiverem em branco.
Definir exige o custo medido por leitura — que só existe depois do item 1.

### 4. Ciclo Stripe exercitado

`capabilities.billing:true` descreve configuração, não certifica o ciclo. Em
modo `test`, vinculado à conta correta, exercitar: compra, renovação, falha de
pagamento, cancelamento, portal, e o desconto refletido no projeto. Confirmar
que os webhooks assinados chegam e que `billing_customers` é populado.

### 5. Mensalidades: definir ou remover

`BILLING_MEMBERSHIPS_ENABLED=false` e nenhum `STRIPE_PRICE_PLAN_*` configurado.
Decisão binária: definir preço e termos aprovados, criar os preços na Stripe e
validar o ciclo do item 4 — ou remover a UI de planos da `BillingPage`. Manter
botões indisponíveis é a pior das três opções para um cliente novo.

### 6. Worker durável

`AI_PLAN_DURABLE_ENABLED=false` e `PDF_PAGE_PROCESSING_ENABLED=false`. Hoje a
leitura de IA roda inline no request da Edge Function, com `maxDuration: 180`
em `vercel.json`. Um PDF grande em um dia lento do provedor estoura esse teto.
Para fechar: publicar `Dockerfile.worker` com Redis (`REDIS_URL`) apontando para
o mesmo Supabase, confirmar o heartbeat e só então ligar as duas flags. O código
já falha fechado se nenhum worker vivo for visto.

### 7. Marketplace: construir ou remover

Quatro SKUs (`marketplace_new_england_codes`, `marketplace_regional_material_prices`,
`marketplace_labor_benchmarks`, `marketplace_supplier_import`) existem no tipo
`BillingPriceKey` sem nenhuma concessão de produto implementada. Agora recusados
em três camadas. Removê-los do tipo é seguro quando a decisão for não vendê-los.

### 8. Supabase: proteção contra senha vazada

Continua desativada. Aceitável enquanto a autenticação for exclusivamente magic
link — mas isso precisa ser uma decisão registrada, e a proteção precisa ser
ativada antes de oferecer senha como alternativa.

### 9. Data-limite do piloto

A configuração atual interrompe novas análises do piloto em **1 de dezembro de
2026** até revisão de preço e modelo. Conta do proprietário e clientes pagos não
dependem dessa data. Revisar antes, não depois.

## Não bloqueadores

- Bundle do app acima de 500 kB sem code splitting. Só vale mexer se o tempo de
  carregamento real incomodar.
- O servidor MCP Mapify (`.mcp.json`) falhou ao conectar na sessão desta
  auditoria (`CONNECTION_CLOSED`). Está configurado, não verificado.
- Limites de produto já declarados e ainda válidos: revisão humana obrigatória
  das medições e preços, sem feeds de preço de terceiros, sem verificação
  automática de conformidade com códigos, sem abertura de ticket de suporte.
