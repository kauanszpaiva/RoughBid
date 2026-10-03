# RoughBid: prévia de preço SaaS mensal e por documento

Esta implementação local calcula propostas revisáveis do preço do **serviço RoughBid**. Não cria cobrança, assinatura, produto Stripe, checkout ou autorização para usar APIs. O orçamento da **obra** continua separado: materiais, mão de obra, equipamentos, overhead e markup pertencem ao orçamento da construção, nunca aos custos operacionais SaaS desta prévia.

## Tabela encontrada

A busca nos arquivos versionados encontrou a política principal em `docs/business-finance-pricing.md:39` (fórmula) e `:45` até `:49` (tabela), seção `Project Reading Price Formula`, e sua constante em `packages/domain/src/project-charge.ts:2`. As margens por leitura são reutilizadas diretamente:

| Associação | Margem alvo sobre a receita da leitura |
| --- | ---: |
| Sem associação (`standard`) | 50% |
| Starter | 40% |
| Pro | 35% |
| Team | 30% |
| Enterprise | 20% |

A política principal registra mensalidades Starter/Pro/Team como **TBD** em `docs/business-finance-pricing.md:116`, `:117` e `:118`; `:53` exige configuração/aprovação antes da ativação. Ela não define margem alvo mensal. `docs/integrations/billing-marketplace.md:35` e a auditoria Stripe de 10/09 dizem que os valores históricos de planos são referências não aprovadas para venda. Portanto, esta entrega não transforma os valores antigos de `billing.ts` em mensalidades aprovadas. O add-on Supplier Price Import de US$49/mês é um produto distinto; seu valor não vira preço da assinatura RoughBid.

## Percurso implementado

`SaasPricingPreview` recebe `isPlatformAdmin` da tela que já verificou a identidade do proprietário. Outros usuários não veem o componente. Ele é um simulador local: não lê dados privados do servidor nem concede acesso. A API continua responsável pelos papéis e pelos controles de cobrança existentes.

1. O proprietário escolhe **por documento** ou **mensalidade**. Os dois modos mantêm entradas independentes.
2. Registra custos técnicos com quantidade, unidade de cobrança, custo unitário, fonte, versão e data. Custos devem ser medidos ou previsão revisada; entradas não revisadas permanecem pendentes.
3. Informa as taxas do método de pagamento e sua fonte. Nenhuma taxa Stripe é presumida.
4. Confirma cobertura de todos os custos aplicáveis, incluindo falhas e operações cuja telemetria ainda é desconhecida. Uma operação aplicável de custo desconhecido deve permanecer como linha pendente, não ser omitida ou zerada.
5. Por documento, a associação escolhe a margem da tabela existente. Na mensalidade, margem, fonte e versão precisam ser informadas explicitamente como parâmetro de planejamento. O usuário confirma que os custos são apenas da associação: as leituras por documento são cobradas separadamente, sem prometer uso ilimitado.
6. A prévia exibe custo técnico, proposta de preço, taxa de pagamento esperada, lucro bruto esperado e pendências. O registro JSON apresenta entradas, fontes e cálculo exato para revisão.

Não há botão de compra nem alteração dos planos/assinaturas atuais. Uma proposta “ready_for_review” continua sem ativação comercial. Inputs locais de planejamento não equivalem a decisão de publicar preços.

## Complexidade e cálculo

O custo de um documento vem dos drivers registrados: páginas físicas, regiões, chamadas de cada etapa/provedor, armazenamento, worker e suporte, conforme aplicável. Não existe coeficiente inventado para “planta complexa”. Por exemplo, mais regiões ou mais chamadas aprovadas aumentam o custo pela quantidade e tarifa documentadas; o simulador não escolhe modelos nem inicia essas chamadas.

Os valores monetários de entrada usam micro-USD inteiros, permitindo tarifas menores que um centavo. Quantidades são inteiras na unidade escolhida; use uma unidade menor quando necessário, como segundo ou byte. O custo agregado é arredondado para cima uma vez ao centavo; o preço final também é arredondado para cima ao centavo:

```text
custo_cents = ceil(sum(quantidade × custo_unitário_micro_USD) / 10000)
preço_cents = ceil((custo_cents + taxa_fixa_cents) × 10000
                  / (10000 - margem_bps - taxa_pagamento_bps))
```

O modo por documento chama o `projectChargeCents` já existente, preservando sua margem. A margem é a parcela da receita após os custos técnicos incluídos e as taxas de pagamento. É margem bruta por serviço, não markup nem lucro líquido da empresa. Impostos, custos gerais ou encargos não incluídos nas linhas não são presumidos pelo cálculo. Não há fallback para tarifa barata ou margem menor. Custos duplicados com o mesmo ID, valores inseguros, fontes/datas/versões ausentes, margem mais taxa igual ou superior a 100%, cobertura incompleta e custos desconhecidos bloqueiam a proposta com `null`. A parte conhecida de custos fica no audit, claramente incompleta. Um total explicitamente zero também pede política comercial, sem assumir processamento grátis.

Taxas e lucro bruto esperados são cálculo econômico segundo as taxas fornecidas, não conciliação de uma transação. Custos previstos são identificados como previsão; não representam invoice do provedor nem saldo de créditos. Os US$5 por API informados pelo usuário não viram um orçamento de execução por este módulo.

## Arquivos e integração

| Arquivo | Função |
| --- | --- |
| `packages/domain/src/saas-pricing.ts` | Cálculo determinístico, tabela existente, validação e audit |
| `apps/web/app/src/services/saasPricing.ts` | Drafts da interface, parsing estrito e export JSON local |
| `apps/web/app/src/components/SaasPricingPreview.tsx` | Formulário responsivo do proprietário, custos, parâmetros, proposta e pendências |
| `packages/domain/test/saas-pricing.test.ts` | Margens, cobertura, nulidade, complexidade, precisão e isolamento dos modos |
| `apps/web/test/saas-pricing-preview.test.ts` | Inputs reais do formulário, parsing, desconhecidos e registro exportado |

Integração sugerida na tela Billing após bootstrap do proprietário:

```tsx
import { SaasPricingPreview } from '../components/SaasPricingPreview';
// Na renderização após verificação da identidade:
{platformAdmin && <SaasPricingPreview isPlatformAdmin={platformAdmin} />}
```

O componente não carrega automaticamente eventos de `api_usage_events` nem publica um snapshot comercial no banco. O proprietário informa fontes de custos/ledger para a proposta local. Para tornar a proposta vendável no futuro, a API deverá fornecer custos completos do run e produzir uma cotação imutável e isolada por workspace, com versão de política, antes de qualquer checkout. Campos numéricos zero de operações `pending`, `unknown` ou `failed_unknown` no ledger são placeholders; não provam custo zero. Os controles de orçamento/reserva dos workers permanecem independentes.

## Validação e ativação

Comando local executado: `node --experimental-strip-types --test packages/domain/test/saas-pricing.test.ts apps/web/test/saas-pricing-preview.test.ts`: **21 testes aprovados**. TypeScript estrito dos três módulos novos aprovado, com `noUncheckedIndexedAccess` e `exactOptionalPropertyTypes`. Fixtures de custos e taxas são explicitamente fictícias para testar a matemática; nenhum número das fixtures é uma tarifa comercial ou API.

Esta frente executou **zero chamadas a provedores, uploads externos ou operações Stripe**. Testes usam somente módulos locais e fixtures.

Pendências comerciais concretas: mensalidades/margens mensais aprovadas, custos técnicos reais por run completo, política de preço versionada para o perfil de processamento atual, método/região/taxas de pagamento e regras comerciais de falha/cancelamento. O preço de uma leitura longa com provedores fortes precisa desses custos; os parâmetros históricos do caminho antigo não comprovam sua rentabilidade.

Ativação desta entrega é apenas revisão e inclusão do simulador proprietário no pacote de frontend, respeitando a autorização de implantação externa. Nenhuma migration é necessária. Rollback: retirar a renderização/import do simulador. Não alterar contratos Stripe, entitlements, reservas, preços publicados ou estimativas da obra.
