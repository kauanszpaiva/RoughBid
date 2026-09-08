# Auditoria de cobrança — 8 de setembro de 2026

O modelo executável é cobrança por leitura de projeto, com preço calculado antes do Checkout. Mensalidades oferecem descontos por projeto; não incluem processamento ilimitado. Os valores de catálogo no código não provam que existam preços correspondentes na Stripe.

## Evidência da sessão

- `GET https://roughbid.vercel.app/api/capabilities` respondeu 200 com `aiReadingAvailable:true,billing:true` antes desta alteração. Esse indicador descrevia configuração da cobrança por projeto e habilitava incorretamente os botões de mensalidade.
- A auditoria principal verificou no inventário Vercel a presença de chaves Stripe, mas ausência de `STRIPE_PRICE_PLAN_STARTER`, `STRIPE_PRICE_PLAN_PRO`, `STRIPE_PRICE_PLAN_TEAM` e `STRIPE_PRICE_ID`. Não habilitar mensalidades sem esses preços e validação do ciclo real.
- A auditoria principal encontrou zero registros em `billing_customers`. Isso não substitui uma consulta de assinaturas diretamente na conta Stripe.
- O conector listou uma conta Stripe em teste e produção; sua vinculação exata ao aplicativo não foi confirmada pelo conector. Nenhuma cobrança, preço, assinatura ou configuração Stripe foi criada neste trabalho.

## Correções implementadas

- Checkout de proprietário permanece bloqueado. Durante piloto ativo, cotação paga, Checkout por projeto e Checkout de mensalidade também ficam bloqueados; erro ao verificar o piloto bloqueia a compra. Após expiração, o usuário volta ao fluxo pago normal.
- Mensalidade tem tentativa persistida por usuário, com duração de uma hora e chave de idempotência. Solicitações simultâneas reutilizam a mesma tentativa. Outro plano durante uma tentativa aberta é recusado. O cliente Stripe é fixado ao usuário, e assinaturas existentes são consultadas antes da criação de novo Checkout.
- Retornos de Checkout e portal exigem a origem HTTPS de `APP_URL`. Chave Stripe de modo incompatível é recusada.
- Webhooks verificam assinatura e modo. Eventos de assinatura e `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required` consultam a assinatura atual e sua última fatura. Uma revisão persistida impede que uma consulta antiga sobrescreva outra mais recente. Falha de consulta/persistência responde 503 para permitir repetição.
- O desconto de mensalidade exige assinatura ativa, período futuro e fatura efetivamente paga. Períodos dos itens modernos da Stripe são suportados. Webhooks de produtos não aprovados não alteram a mensalidade.
- Cada plano tem indicador próprio de disponibilidade. O portal foi exposto para gestão de assinaturas existentes. Vendas de marketplace continuam fechadas porque falta o ciclo completo de concessão do produto.

## Limites e pendências

1. Migração `0030_billing_checkout_integrity.sql` aplicada em produção após `0027_limited_pilot.sql` e antes do código. Ela não cria assinaturas nem altera preços.
2. Para habilitar mensalidades, definir preço e termos aprovados, configurar os IDs corretos, verificar a conta/modo, portal e eventos assinados, e exercitar compra em ambiente de teste, renovação, falha, cancelamento e desconto refletido no projeto. `billing:true` não é certificação desse ciclo.
3. O piloto implementado é uma concessão da aplicação, sem cartão. Sua expiração encerra o patrocínio e permite o Checkout normal; não cria automaticamente uma cobrança. Para débito automático ao final de 60 dias, é necessário implementar adesão do participante a uma assinatura com preço futuro claro, forma de pagamento e regras de cancelamento/aviso. Não foi presumida essa autorização do participante.
4. Reembolsos/disputas de leitura já revogam a autorização de processamento. A política operacional de reembolso de mensalidade e seus efeitos sobre descontos ainda precisa ser definida; não foi inventada neste trabalho.
5. O proprietário não é cobrado pelo RoughBid. O provedor de IA pode cobrar custos operacionais da KSP; gratuidade da conta não significa API gratuita.

## Verificação

Testes de API verificaram idempotência, bloqueio de assinatura duplicada, piloto ativo e expirado, erro de verificação do piloto, origem de retorno, assinatura do webhook, consulta atual da assinatura, fatura não paga, modo Stripe e configuração individual dos planos. Testes executando PostgreSQL em PGlite verificaram reutilização concorrente de tentativa, bloqueio de proprietário/piloto, identidade do cliente, revisões fora de ordem, duplicatas, rollback e permissões. TypeScript passou sem erros. Esses testes não efetuam compras externas.

## Documentação primária consultada

- A Stripe informa que não garante a ordem dos eventos e recomenda tratar duplicatas pelos IDs: [Entrega de webhooks](https://docs.stripe.com/webhooks#event-ordering).
- A Stripe distingue assinatura ativa de todas as faturas pagas e recomenda provisionar com `invoice.paid` e status ativo: [Webhooks de assinaturas](https://docs.stripe.com/billing/subscriptions/webhooks).
- Checkout pode coletar o pagamento para depois do período gratuito; sem método de pagamento é necessário definir cancelamento ou pausa: [Configurar avaliações gratuitas](https://docs.stripe.com/payments/checkout/free-trials?locale=pt-BR).
