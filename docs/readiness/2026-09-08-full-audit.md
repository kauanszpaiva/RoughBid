# RoughBid: auditoria e piloto limitado

Data: 8 de setembro de 2026. Conta proprietária confirmada no banco e navegador: `kauan@kspdominion.group`.

## Resultado implementado

O proprietário recebe um painel **Access invitations** para inserir até 25 emails, selecionar uma oferta, enviar o convite, copiar o link privado, acompanhar ativação/entrega/orçamento e revogar acesso. Cada convite exige login com o email confirmado e cria um workspace próprio; participantes não entram no workspace do proprietário. Não há destinatários inventados nem envio automático para contatos existentes.

| Oferta | Duração após ativação | Projetos permitidos |
|---|---|---|
| Sample | 7 dias | 1 projeto no total |
| Limited month | 30 dias | 1 projeto por janela móvel de 7 dias |
| Pilot | 60 dias | 2 projetos por janela móvel de 7 dias |

Em todas as ofertas: um PDF por projeto, até 10 MiB e 10 páginas, uma tentativa de IA por projeto. Falhas de análise continuam contabilizadas. Excluir arquivos/projetos, mudar de workspace ou repetir requests não devolve cotas. O convite precisa ser ativado em 14 dias; reenviar não estende o prazo. Ofertas maiores exigem nova revisão do orçamento e não são editáveis pelo participante.

A conta proprietária não tem cotas comerciais de projetos/análises, não entra no orçamento do piloto e não abre checkout do RoughBid. Permanecem limites técnicos do processamento, permissões entre workspaces e consentimento para enviar PDFs à IA. Custos do provedor para uso do proprietário continuam sendo custos operacionais da KSP; não representam uma cobrança de assinatura ao proprietário.

## Proteção dos US$150

- Banco limita o grupo a 25 participantes, US$125 em reservas totais e US$5 por participante. Os US$25 restantes ficam como margem fora da verba liberada.
- Cada projeto reserva US$0,25 de maneira atômica antes da chamada. Reserva não é uma fatura da Google nem uma medição de gasto real; o painel identifica essa diferença.
- Piloto usa exclusivamente `gemini-2.5-flash`, sem ferramentas, fallback, cache ou retry automático: até 32.000 tokens de entrada contados pelo provedor, 4.096 de saída e thinking desativado.
- Nos preços verificados de US$0,30/M de entrada e US$2,50/M de saída, a chamada limitada tem teto calculado de US$0,01984, coberto pela reserva de US$0,25. [Preços oficiais](https://ai.google.dev/gemini-api/docs/pricing), [contagem de tokens](https://ai.google.dev/gemini-api/docs/tokens).
- O caminho falha antes da geração quando a contagem não é válida. Mudança de preço/modelo exige revisão; a configuração atual interrompe novas análises do piloto em 1 de dezembro de 2026 até revisão técnica. A conta proprietária e clientes pagos não dependem dessa data.
- O endpoint legado Supabase `roughbid-plans` foi aposentado com resposta 410. Uploads diretos no bucket legado ficam bloqueados para piloto ativo; o upload Vercel tem tamanho máximo assinado. O servidor confere bytes e páginas reais.
- Este orçamento cobre as chamadas patrocinadas do piloto. Uso do proprietário, clientes pagos, hospedagem e outros serviços não são contabilizados como API patrocinada dos 25 usuários. A fatura real da Google não foi acessada nesta auditoria.

## Cobrança e término

Foi recomendado e implementado acesso inicial **sem cartão**. Ao expirar, termina a IA patrocinada; arquivos e trabalho manual continuam acessíveis. Próximo uso pago exige o checkout normal. Não existe débito automático sem a adesão do participante a preço e pagamento futuros. Cobrança automática após 60 dias precisaria de fluxo de assinatura aceito na entrada.

Pilotos ativos e proprietário não podem abrir checkout de projeto ou mensalidade. Uma conta com assinatura vigente ou checkout de mensalidade aberto não pode ativar piloto e continuar renovando silenciosamente. Nenhuma assinatura é cancelada automaticamente.

Clientes públicos podem se cadastrar independentemente e usar cobrança por projeto. A cotação considera PDF/escopo e é apresentada antes do checkout. Mensalidades ainda não têm IDs de preços configurados na Vercel: seus botões ficam indisponíveis. Nenhum valor mensal foi inventado ou ativado.

O checkout de mensalidade agora tem idempotência persistida, identidade fixa de cliente e proteção contra assinaturas duplicadas. Webhooks verificam assinatura/modo e consultam assinatura/fatura atuais; snapshots antigos não sobrescrevem novos. Desconto exige fatura paga. [Auditoria de billing](./2026-09-08-billing-audit.md).

## Emails e operação

Resend confirmou domínio de envio verificado e entregas anteriores de login RoughBid. Os novos convites têm termos claros, botão de ativação e token vinculado ao email. A chave de assinatura fica somente no servidor.

Um cron horário processa lembretes de 7 dias, 1 dia e vencimento, com fila persistida, tentativas limitadas e idempotência. O webhook Resend verifica assinatura, data e duplicatas; acompanha entrega, atraso, falha, bounce e reclamação. Emails com entrega problemática e convites revogados deixam de receber lembretes. [Operação do painel](../operations/limited-access-invitations.md).

## Evidência e limites da auditoria

- Antes da mudança: produção READY no commit `45afaff`; API health 200; 7 contas, 11 projetos, 6 leituras `needs_review` e 11 `failed` no histórico. Esses registros incluem QA e não são uma taxa de falhas de clientes reais.
- Conta proprietária com `is_platform_admin=true`; nenhum cliente de assinatura registrado em `billing_customers` no momento da consulta.
- Testes completos: 350 passaram. Verificação posterior dos arquivos alterados: 41 testes passaram; TypeScript raiz e web passaram. Testes PostgreSQL executaram limites, falsificação, exclusão, expiração, orçamento, concorrência de checkout, filas e assinaturas de webhook.
- Cinco migrações aditivas/corretivas aplicadas em produção: 0027, 0029, 0030, 0031 e 0032. Nenhum cliente recebeu convite durante a implementação; orçamento reservado inicial US$0.
- Nenhuma cobrança real, assinatura ou novo preço Stripe foi criado. O ciclo de compra/renovação/cancelamento com a conta Stripe de produção ainda não está certificado. Flags de configuração e testes locais não substituem essa evidência.
- O ciclo completo de um participante real (email recebido, ativação, PDF, geração e vencimento) ainda depende do primeiro convite selecionado pelo proprietário. Os testes automatizados cobrem os estados; não são apresentados como uso real.
- Supabase ainda informa proteção contra senhas vazadas desativada. O produto usa magic link; a proteção deve ser ativada antes de oferecer senha como alternativa. Funções públicas de proposta são deliberadamente acessíveis por token e precisam permanecer protegidas pelo escopo do token; avisos de linter não foram classificados automaticamente como exploração.
- O endpoint público de solicitação de login ainda precisa de limitação distribuída por origem/email contra abuso. Não há dado de produção suficiente para afirmar taxa de entrega ou sucesso de checkout.

## Próximas decisões comerciais

1. Usar o painel para selecionar os destinatários e o preset. Começar pelo teste de um projeto permite observar qualidade real antes de liberar 60 dias.
2. Definir e validar mensalidades somente se forem desejadas; cobrança atual por projeto permanece separada.
3. Validar a primeira compra de cliente e o ciclo Stripe em ambiente de teste vinculado à conta correta, sem efetuar cobrança real de QA.
4. Conferir custo/falhas reais no provedor e revisar o preço fixado antes de dezembro. Não ampliar o grupo ou as cotas sem recalcular o orçamento.
