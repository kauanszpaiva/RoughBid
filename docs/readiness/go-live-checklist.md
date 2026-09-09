# RoughBid — release gate final

Data: 9 de setembro de 2026.

## Escopo desta release

Esta release fecha o **RoughBid para demonstração do fundador e piloto controlado**.
Ela não declara lançamento comercial geral (GA) de assinaturas ou preço por projeto,
porque esses preços ainda exigem decisão comercial explícita e ciclo Stripe real.

O objetivo do gate é simples: ninguém chama o produto de pronto baseado apenas em
build verde. A release precisa ter código verificável, provider real, budget limitado,
persistência real e produção saudável.

## Evidência já verificada em produção

- Produção atual na Vercel está `READY` e vinculada ao `main`.
- `GET /api/health` respondeu HTTP 200.
- `GET /api/capabilities` respondeu HTTP 200 com `aiReadingAvailable:true`,
  `billing:true` e `billingPortal:true`; memberships Starter/Pro/Team continuam
  intencionalmente desativadas.
- Em **8 de setembro de 2026 às 21:20 UTC**, uma leitura real de planta completou
  com `gemini-3.8-flash`, status `needs_review`, sem `processing_error` e com
  **98 findings persistidos** em Supabase. O resultado exige revisão humana.
- O Google documenta `gemini-3.8-flash` como GA e pronto para produção. O mesmo
  modelo já foi comprovado no runtime do RoughBid.

## Fechado no release candidate

- **CI incondicional** em todo pull request e push para `main`: suíte, typecheck
  backend/worker, typecheck web, Prisma e build de produção.
- **Gate específico da IA** preservado com verificações do boundary do provider,
  reload persistido e visualização PDF desktop/mobile sob CSP de produção.
- **Marketplace recusado na primitiva Stripe** enquanto não existir concessão de
  produto correspondente.
- **Landing atualizada** para não dizer que AI plan reading é algo futuro quando
  a função já existe e foi comprovada.
- **Brand metadata normalizada** para `RoughBid`.
- **Piloto fixado em `gemini-3.8-flash`**, usando uma única tentativa bounded,
  sem fallback pago e com limite de 32k tokens de entrada + 4.096 de saída.
- **Reserva conservadora de US$0,25 antes do provider** permanece obrigatória.
  Pela tarifa introdutória documentada do Gemini 3.8 Flash em 9/09/2026, o teto
  teórico desse envelope é aproximadamente US$0,03936 por análise.
- **Migration `0034_pilot_budget_and_model_alignment.sql`** reduz o teto do cohort
  de US$125 para o limite aprovado de **US$100**, falha fechado se reservas já
  ultrapassarem esse limite e alinha o RPC do piloto ao Gemini 3.8 Flash.
- Testes de regressão impedem que o modelo do piloto ou o teto aprovado sejam
  silenciosamente revertidos.

## Estado do budget do piloto antes da promoção

Consulta live antes desta release:

- cohort: `founding-pilot-60d`
- capacidade: 25
- budget configurado: US$125 (divergente da decisão aprovada)
- budget reservado: US$0
- reservas de leitura: 0

Portanto a redução para US$100 não invalida nenhuma reserva existente.

## Gate de promoção para produção

A promoção deve usar **um único SHA exato** do PR #39 e obedecer esta ordem:

1. Confirmar CI e Durable AI Plan Gate verdes no SHA final.
2. Confirmar preview Vercel `READY` para o mesmo SHA.
3. Aplicar **somente** `0034_pilot_budget_and_model_alignment.sql` no projeto
   Supabase `piasgpciojstjalaqazu`.
4. Verificar no banco: `pilot_cohorts.budget_cents = 10000`,
   `reserved_cents <= budget_cents` e o RPC aceita o modelo esperado.
5. Fazer merge do PR #39 em `main`.
6. Esperar a Vercel promover o commit de `main` e confirmar deployment `READY`.
7. Smoke: `/api/health`, `/api/capabilities`, `/`, `/app/`.
8. Verificar logs de runtime após o smoke.
9. Confirmar que uma leitura antiga continua recarregando findings persistidos.

Não aplicar `0023–0025` nesta promoção. O worker durável não está implantado e
essas migrations pertencem a uma arquitetura opcional de escala, não ao caminho
inline que já foi comprovado em produção.

## Rollback

Se o novo deployment falhar antes de qualquer usuário externo iniciar o piloto:

1. Reverter o deployment Vercel ao deployment de produção anterior.
2. Manter o budget do banco em US$100; não reabrir o teto de US$125.
3. Manter o piloto externo desativado até app e RPC voltarem a concordar sobre
   o modelo autorizado.
4. Owner/admin continua com o caminho comprovado de leitura real e pode ser
   usado para diagnóstico.

A migration reduz risco financeiro e não precisa ser revertida para recuperar a
produção. Em caso de incompatibilidade app/RPC, falhar fechado é preferível a
executar provider fora do envelope aprovado.

## Não bloqueia esta release de piloto/demo

### Primeiro convite externo

Ainda não foi enviado. Isso inicia operação com uma pessoa real e deve acontecer
somente depois da promoção acima. Começar com **um** convite `Sample` (7 dias,
1 projeto), observar qualidade e só então ampliar.

### Worker durável

`AI_PLAN_DURABLE_ENABLED=false` e `PDF_PAGE_PROCESSING_ENABLED=false` devem
continuar assim. Não existe worker Railway implantado hoje. Criar infraestrutura
nova/custo recorrente é uma decisão separada. O caminho inline já concluiu uma
leitura real em aproximadamente 11 segundos no teste live observado.

### Preço por projeto e memberships

Não inventar preço para completar checklist. Checkout por projeto e memberships
só entram em GA depois de preço/termos aprovados, Stripe testado ponta a ponta e
margem revalidada. Para esta release, o escopo é fundador + piloto controlado.

### Marketplace

Continua propositalmente bloqueado até existir produto/concessão correspondente.

### Supabase leaked-password protection

Não bloqueia enquanto autenticação permanecer magic-link only. Torna-se gate se
senha for oferecida como alternativa.

## Data-limite operacional

Novas análises do piloto param em **1 de dezembro de 2026** até nova revisão de
preço/modelo. Isso evita continuar gastando sob premissas de tarifa antigas.
