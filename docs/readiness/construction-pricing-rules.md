# RoughBid — catálogo e regras de precificação

Versão 1.1.0 · 2 de outubro de 2026 · Especificação para implementação, sem cotação comercial ou alteração de produção.

O catálogo acompanha **72 composições originais, 179 componentes de materiais e 48 tipos de equipamento**, em 12 categorias. Cobre preparação/demolição, concreto, estrutura, cobertura, isolamento, drywall, acabamentos, pisos, cerâmica, portas/janelas, instalações básicas e limpeza. É um ponto de partida extensível: não representa todo o escopo de qualquer imóvel. Não contém preços locais, produtividade presumida, percentuais fixos de perdas ou conteúdo de bases comerciais como RSMeans.

**Dois preços separados:** o orçamento da obra remunera materiais, trabalho e equipamentos de construção. O preço do RoughBid remunera uso do software, processamento, infraestrutura e atendimento. Uma margem da assinatura não pode alterar a margem da obra.

## Contrato de dados

Arquivo principal: `RoughBid-Catalogo-Base.json`, `schema_version: 1.1.0`. A revisão acrescenta os contratos tributário e de validade de cotações; os IDs, as 72 composições e as 179 expressões de demanda permanecem iguais.

| Bloco | Uso na implementação |
|---|---|
| `assemblies[]` | IDs estáveis `RB-…`, descrição, unidade, entradas de escopo, materiais, trabalho, equipamentos, dependências e exclusões |
| `measurement.evidence` | Documento, revisão, página/foto, anotação, origem da escala e revisão humana |
| `materials[].measure_expression` | AST restrita a `input`, `constant` e `multiply`; sem executar texto como código |
| `materials[].purchase` | Cobertura líquida, unidade comercial, lote mínimo, incremento e preço da embalagem |
| `labor` | Produtividade da equipe, horas, composição da equipe e custo de cada função |
| `equipment_catalog` / `equipment_flags` | Necessidade por método, especificação, duração e despesas da máquina |
| `height_access_profiles` | Dados do local que determinam método, alcance, carga e acesso |
| `formulas` | Fórmulas e pré-condições, sem completar parâmetros ausentes |
| `tax_cost_contract` / `tax_charge_ledger[]` | Convenção única de tributos no custo e identidade de cada cobrança, evitando somá-la novamente |
| `supplier_quote_contract` / `supplier_quotes[]` | Cotações imutáveis por item/configuração, local e data, com evidência e validade |
| `saas_pricing` | Tabela-alvo existente, consumo por fornecedor, reservas e cálculo mensal/por projeto |

`null` significa **pendente**, nunca zero. Zero só é válido quando alguém confirmou ausência, não aplicabilidade ou custo incluído em outro item. Um campo vazio não deve ativar `0`, `1`, produtividade média, preço nacional ou um produto “parecido”. Inputs da AST têm escopo no componente; `assembly_quantity` resolve para a quantidade da composição. Os demais inputs não podem ser unidos pelo nome entre componentes.

Fluxo sugerido: `draft → measured → scope_reviewed → priced → approved`. Guardar revisões de composição, preços e fontes no orçamento para que a atualização do catálogo não mude uma proposta antiga. IDs adicionais podem ser criados por empresa, preservando origem e versão.

Uma composição selecionada exige revisão de seus materiais: `active` está pendente até a escolha do sistema. Alternativas como concreto usinado/ensacado e método de cura são mutuamente exclusivas. Em subcontratos completos, marcar quais materiais, trabalho e máquinas estão incluídos para não somá-los outra vez. Ferragens incluídas na porta, manta integrada ao piso, placa de suporte repetida entre drywall/tile e cabos já compostos por condutores merecem verificação explícita.

## Quantidades, perdas e embalagens

1. Medir área, comprimento, volume, massa ou contagem com unidade e origem. Área de piso não substitui área de parede; área projetada de telhado não substitui área inclinada. Dedução de vãos e múltiplas faces precisam de política explícita.
2. Identificar SKU/sistema e sua cobertura útil. Dimensão nominal, área da embalagem e cobertura após sobreposição podem diferir. No concreto ensacado, rendimento é volume do **produto e peso de saco específicos**; a ficha QUIKRETE 1101 ilustra essa distinção. Não foi adotado rendimento universal. [QUIKRETE — ficha do produto](https://www.quikrete.com/pdfs/data_sheet-concrete%20mix%201101.pdf)
3. Se a medida confirmada é zero, comprar zero. Nos demais casos, calcular `demanda = medida × (1 + perda_confirmada)` e `embalagens_brutas = demanda ÷ cobertura_líquida_por_embalagem`. Comprar `ceil(max(mínimo_confirmado, embalagens_brutas) ÷ incremento) × incremento`, respeitando simultaneamente mínimo e múltiplo de compra. Aplicar mínimos somente quando há demanda ativa; escopo confirmado como zero não gera pedido mínimo.
4. Aplicar camadas/demãos **na demanda ou na cobertura total do sistema**, uma vez. Transpasse deve estar na geometria ou na cobertura útil; não somá-lo novamente como perda. Recortes podem exigir lista/otimização de cortes antes da compra.
5. Agregar demandas do mesmo SKU apenas quando local, prazo, lote/condição e pool de compra forem compatíveis. Arredondar embalagens após a agregação e alocar o custo rastreavelmente. Não arredondar cada cômodo e somar sobras como se fossem inevitáveis.

Perdas variam com paginação, dimensões comerciais, reaproveitamento, dano e método. Produtividade e perdas precisam vir de histórico da empresa, medição ou hipótese expressamente aprovada. Uma foto sem escala pode apoiar identificação visual; não revela espessura, estrutura, redes ocultas ou toda a lista de materiais.

O portfólio USG diferencia painéis por aplicação, espessura e desempenho. A ficha exata do produto e o sistema de parede/teto devem ser confirmados antes de tornar dois itens comparáveis; o catálogo não presume equivalência por serem “drywall”. A referência foi lida no trecho oficial indexado; a abertura direta do arquivo falhou nesta pesquisa. [USG — portfólio de painéis](https://www.usg.com/api/download-center/v1/assets/c28cdf38-a9c0-51d3-80b2-7df4530fb89f?country=us&download=true)

## Mão de obra

`horas_equipe = quantidade ÷ produtividade_da_equipe × fator_do_local + preparação + limpeza`.

`custo_trabalho = Σ(pessoas_da_função × horas_de_participação × custo_carregado_por_pessoa_hora)`.

Uma hora de equipe pode representar várias horas de pessoas. A produtividade da equipe já depende de sua composição: não multiplicar a produção pelo número de pessoas novamente. Registrar participação parcial de funções, visitas, espera, tempo de montagem/desmontagem e horas extras. Duração em dias depende do calendário e de equipes simultâneas; não é intercambiável com horas de trabalho.

O OEWS/BLS é referência de **salário de empregados** por ocupação e geografia; exclui autônomos e proprietários de firmas não incorporadas e não representa tarifa faturável de empreiteiro. Selecionar ocupação, área, período e estatística antes de usar como benchmark. Nenhum salário foi importado. [BLS — definições](https://www.bls.gov/oes/oes_ques.htm), [BLS — tabelas por período e local](https://www.bls.gov/oes/tables.htm)

Construir o custo carregado com salário, política de horas extras, encargos, workers’ compensation, benefícios e outras alocações efetivas, na mesma base de horas. Não duplicar parcelas já contidas na taxa fornecida. O ECEC descreve categorias de remuneração e benefícios, mas sua média não substitui a estrutura real da empresa. O preço cobrado ao cliente acrescenta os itens de orçamento aplicáveis e a política comercial. [BLS — custos de remuneração do empregador](https://www.bls.gov/ecec/)

## Equipamentos, altura e acesso

Equipamento é uma decisão de método e local. Antes da seleção, coletar altura da superfície, altura necessária de plataforma, alcance horizontal, largura/altura da rota, dimensões das aberturas, inclinação, capacidade do piso/solo, carga de pessoas e materiais, obstáculos, redes elétricas, clima, ventilação e energia. Dados críticos ausentes levam a `needs_site_review`.

Altura de plataforma e altura de trabalho comercial são campos distintos. A ficha JLG também separa capacidade e condições de uso; esses dados devem ser verificados no modelo/configuração selecionados. Não converter toda altura em uma única faixa de preço nem selecionar máquina só pelo pé-direito. [JLG — especificações E18](https://verticallifts.jlg.com/)

A orientação OSHA para plataformas tipo tesoura destaca avaliação do local, uso conforme instruções e proteção adequada. O catálogo organiza perguntas e custos; o método precisa ser validado por responsável competente para o local, equipamento e jurisdição. Não existe limiar genérico de altura cadastrado como substituto dessa avaliação. [OSHA — uso de plataformas tipo tesoura](https://www.osha.gov/sites/default/files/publications/OSHA3842.pdf)

`custo_equipamento = componentes_de_custo_normalizados_sem_tributo + tributos_de_custo_da_linha_alocados_uma_vez`.

Os componentes incluem aluguel, horas excedentes, entrega, retirada, mobilização, montagem/desmontagem, operador não incluído na mão de obra, combustível/energia e taxas confirmadas. Valores cotados com imposto incluído devem ser decompostos a partir da evidência antes desta soma. Não somar o imposto novamente sobre um valor bruto que já o contém. Cada imposto remete ao `tax_charge_id` descrito abaixo.

Usar períodos e horas de medidor do fornecedor, incluindo tempo retido e regra de encerramento de locação. “Mês de aluguel” não deve presumir um número de dias. Considerar alternativa própria com custo de propriedade/operação documentado, sem acumular aluguel e custo próprio. Taxas de abastecimento, devolução e serviços dependem do contrato; não foram copiados preços ou percentuais. [United Rentals — termos de locação](https://www.unitedrentals.com/legal/rental-service-terms-us)

Uma máquina ou mobilização compartilhada aparece uma vez no orçamento; alocações às composições somam 100%. Ferramentas já cobertas por encargo de mão de obra não recebem outra cobrança sem separar o escopo. Duração, tarifa e taxas pendentes impedem total final.

## Orçamento da obra

`base_custo = custos_diretos_com_tributos_das_linhas + overhead_alocado + contingência_explícita + tributos_não_recuperáveis_ainda_não_alocados`.

**Convenção única:** o custo final de cada linha de material, equipamento ou subcontrato já inclui seus tributos de custo não recuperáveis. A fórmula global acrescenta somente `unallocated_nonrecoverable_taxes`: cobranças identificadas que ainda não constam de nenhuma linha direta, overhead, contingência ou outra alocação. Não acrescentar uma segunda vez todos os impostos das compras.

`tax_charge_ledger[]` identifica cada cobrança econômica por `tax_charge_id` e referência original do fornecedor/documento. Guardar valor, moeda, origem, inclusão no preço cotado, recuperabilidade, tratamento e alocações. Dividir uma cobrança entre linhas é permitido quando as parcelas somam seu valor uma única vez; criar outro ID para a mesma referência econômica não permite repetir a cobrança. Uma cobrança alocada ou embutida não pode também entrar em `unallocated_nonrecoverable_taxes`.

Para materiais: `custo_entregue = embalagens × preço_normalizado_sem_imposto + frete_e_taxas_normalizados_sem_imposto + tributos_não_recuperáveis_da_linha_alocados_uma_vez`. Imposto embutido no preço comercial precisa de valor e evidência para ser decomposto e recomposto, sem presumir taxa. Imposto, frete ou preço desconhecido impede total final confirmado. Lista tributária vazia não significa imposto zero.

**Teste sintético de aritmética, sem representar cotação ou regra fiscal local:** material de 100 mais imposto de 10 resulta em custo direto de 110. Se não há cobrança tributária ainda não alocada, a base continua 110; somar os mesmos 10 novamente e chegar a 120 é erro. Se o fornecedor cotou 110 já com os 10 incluídos, a decomposição comprovada é 100 + 10 = 110. Os dois casos constam do JSON e passaram na validação.

Overhead é custo indireto; contingência é provisão de risco; lucro é resultado pretendido. Manter linhas e bases separadas. Tributo cobrado em nome do governo não deve ser tratado automaticamente como lucro; incidência sobre materiais, serviços, aluguel e preço final depende da jurisdição e do contrato.

- Com **markup** `u` sobre custo: `preço = base_custo × (1 + u)`.
- Com **margem** `m` sobre receita: `preço = base_custo ÷ (1 − m)`.
- Conversão: `m = u ÷ (1 + u)` e `u = m ÷ (1 − m)`.

Usar uma política por base, sem acumular margem e markup. Todos os componentes necessários devem estar resolvidos; caso contrário, apresentar **subtotal conhecido + pendências**, sem chamar de preço fechado. Gerar cenários somente com hipóteses rotuladas, valores de entrada rastreáveis e revisão humana.

## Preço do RoughBid: assinatura mensal e leitura por projeto

A tabela existente do usuário é a fonte das metas. **Referência recebida do coordenador:** o implementador encontrou 50% para leitura avulsa e valores de 40%, 35%, 30% e 20% para categorias de assinatura; mensais estavam `TBD`. Até este documento, faltam arquivo/linhas, associação exata de categorias e definição de margem versus markup. Os números são preservados em `reported_existing_targets_unverified`, com `may_drive_live_pricing: false`. Não são preços, meta de lucro líquido ou autorização para substituir a tabela original.

Para cada provedor/modelo, registrar preço efetivo e data por medidor: tokens de entrada/saída, imagem, página/OCR, chamada ou outro medidor realmente cobrado. Registrar câmbio quando necessário. Não inferir custo por página a partir de uma tarifa de tokens sem uma estimativa de consumo documentada. O registro separa estimativa, uso real, tentativa e chave de idempotência.

`custo_primeira_tentativa = Σ(unidades_estimadas_por_medidor × tarifa_vigente_do_medidor)`.

`custo_projeto_conservador = primeira_tentativa + reserva_de_retries + reserva_de_fallback + OCR/armazenamento/egress/exportação + atendimento_alocado`.

Separar custo esperado para previsão financeira do limite máximo autorizado para a cadeia de tentativas permitida. Definir quantidade máxima de retries, motivos válidos, orçamento por job e regras de interrupção antes da chamada. Saldo de API — inclusive os US$ 5 mencionados — **não é autorização de gasto**, e saldos de fornecedores não são intercambiáveis. Esta pesquisa não executou chamadas pagas.

Para assinatura, estimar custo mensal do pacote com quantidade de projetos, páginas/imagens, limites de processamento, concorrência, retenção, consumo incluído, suporte e parcela de infraestrutura. Definir excedentes e comportamento ao atingir limite. Não precificar plano ilimitado usando apenas uma média sem limitar exposição de uso. Para leitura avulsa, cotar as características reais do arquivo e a cadeia de processamento permitida.

Se a tabela definir **margem sobre receita**, com taxa de pagamento percentual `f` e fixa `b`, o modelo simplificado é:

`preço_antes_dos_tributos_de_venda = (base_custo + b) ÷ (1 − margem_alvo − f)`.

Se definir **lucro absoluto** `L`: `preço = (base_custo + L + b) ÷ (1 − f)`. Se definir markup, aplicar a fórmula correspondente e apurar a margem resultante após taxas. Denominador deve ser positivo. Taxa sobre total com tributos, conversão, transação internacional, reembolso ou outros encargos exige o modelo real do processador, não esta fórmula simplificada. Não usar a mesma taxa fixa por projeto quando ela pertence a uma cobrança mensal única.

Mensal e avulso continuam **pendentes** até a tabela existente e os custos serem confirmados. Não há novos nomes de planos, preços mensais, limites comerciais ou margens inventados. O caminho manual deve continuar disponível; o processamento pago requer entitlement/reserva confiável no servidor. Falha de IA não cria quantidades ou resultados sintéticos.

## Cotação de varejo e dados necessários

Antes de comparar preços, conferir fabricante/modelo/SKU, material e grau, dimensões, desempenho, acabamento, quantidade por embalagem, cobertura útil, acessórios incluídos e condição. Depois comparar mesma região/ZIP ou entrega, loja, moeda, data, estoque, tributos, frete, mínimos e elegibilidade de promoção. Um produto tecnicamente diferente deve aparecer como alternativa a revisar, não como substituto equivalente mais barato. Não foi verificado acesso de parceiro ou inventado estoque/preço de loja.

O `supplier_quote_contract` define uma entidade de cotação por item/SKU ou configuração de equipamento. Cada registro guarda fornecedor, especificação, loja/filial, ZIP da obra/entrega, canal, moeda, unidade e embalagem, cobertura, estoque, componentes de preço/frete/retirada/impostos/taxas, URL ou documento, origem, datas, validade e fuso IANA da obra. Cotações e cobranças tributárias permanecem vazias neste pacote: não foram inventados fornecedores, preços ou evidências.

Materiais apontam para `supplier_quotes[].supplier_quote_id` por `purchase.supplier_quote_id`; equipamentos usam `cost_inputs.source_quote_id`. Os campos antigos de preço e data são apenas snapshots derivados da cotação referenciada, sem poder estabelecer atualidade por conta própria. Uma atualização cria novo registro imutável e referência de substituição; não muda silenciosamente a evidência de uma proposta anterior.

| `freshness_state` | Significado e consequência |
|---|---|
| `fresh` | Item/local/unidade/moeda compatíveis, evidência válida para a data solicitada no fuso da obra, componentes de custo resolvidos e disponibilidade confirmada |
| `stale` | Validade do fornecedor ou política documentada vencida, ou data pretendida sem suporte atual |
| `awaiting_location` | ZIP, filial necessária ou fuso da obra pendente |
| `partner_access_required` | A fonte requer acesso de parceiro não disponível/autorizado |
| `quote_required` | Cotação, identidade, evidência de data, regra de validade ou algum custo necessário está incompleto |
| `source_error` | Consulta/revalidação falhou; preservar a evidência anterior sem renovar suas datas |
| `availability_unknown` | Estoque/disponibilidade do item exato, local e período não foi confirmado |
| `out_of_stock` | Fonte confirma indisponibilidade; não classificar como pronto para compra |

`observed_at` registra quando consultamos. `source_updated_at`, quando conhecido, registra a atualização na origem. `price_as_of_at` e sua base indicam a data que a evidência realmente sustenta. Consultar hoje um feed/cache com preço antigo **não renova o preço**. Sem data de atualização na fonte, só outra evidência suficiente — cotação do fornecedor ainda válida ou observação direta documentada do preço ao vivo para aquele SKU/local — pode sustentar atualidade. O timestamp de leitura do cache, sozinho, não serve.

Guardar validade inicial/final do fornecedor, política de idade máxima aplicável, momento da avaliação e data de preço solicitada. Nenhum prazo de atualização é presumido. Datas usam ISO 8601 com deslocamento e os limites do dia usam o fuso da obra. Ausência de data/base/evidência suficiente, política de validade ou fuso impede `fresh`. “Consultado hoje” e “preço válido para hoje” são rótulos distintos.

Cada bloqueio mantém motivo e evidência; o estado principal não apaga os demais. **Preço, frete, imposto ou taxa necessária desconhecidos bloqueiam total final confirmado**, inclusive quando parte do custo é conhecida. `confirmed_included` exige valor e evidência de inclusão, e não pode ser somado outra vez; `confirmed_not_applicable` exige confirmação explícita. Mostrar subtotal parcial e pendências continua permitido. Só registros `fresh`, com disponibilidade aplicável e componentes resolvidos, podem sustentar total completo confirmado.

Casos sintéticos de validação do contrato: cache lido hoje com preço vencido permanece `stale`; frete ou imposto desconhecido gera `quote_required`; ZIP/fuso ausente gera `awaiting_location`; ausência de data suficiente sem cotação válida ou evidência direta impede `fresh`. Nenhum desses casos autoriza consulta paga, compra ou uso de credenciais.

Para ativação comercial faltam: **local/ZIP e moeda; tabela-alvo existente com semântica e categorias; custos/limites dos provedores; política real de cobrança; salários/custos carregados e produtividade da empresa; SKUs e cotações locais; condições do local e regras tributárias**. Esses dados não impedem integrar o catálogo e o fluxo de revisão, mas impedem publicar preços completos como confirmados.

Validação realizada: parse JSON, contagem, IDs únicos, referências de unidade/fórmula/equipamento/perfil/fonte, compatibilidade dimensional da AST e preservação de preços/produtividades/coberturas/perdas como `null`. Na revisão 1.1.0 foram preservados integralmente os registros de composições/equipamentos e verificadas a identidade tributária, a fórmula que soma somente tributos ainda não alocados e a entidade de cotação/estados de validade. Os exemplos numéricos 100 + 10 = 110 são exclusivamente testes sintéticos. Não foram executadas medição de obra, cotação local, testes de campo, integração no repositório ou publicação por este pacote.
