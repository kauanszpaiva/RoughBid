# RoughBid — fotos e plantas para orçamento por serviço

Criado: 2 de outubro de 2026. Atualização de produto: 3 de outubro de 2026. Estado do desenho: REVIEW_REQUIRED.

Este documento especifica a reestruturação. Não altera o backend, não configura contas e não comprova prazo ou precisão em produção.

## Resultado esperado

O cliente envia fotos, plantas ou os dois juntos, seleciona um ou mais serviços (fields/trades) e toca em “Gerar orçamento”. RoughBid usa as configurações salvas da empresa para localização, unidades, base de preços e regras comerciais; pede somente informações essenciais que estiverem faltando. Processa o projeto em segundo plano, permite fechar o navegador, mostra progresso real e notifica quando o pacote está disponível. A meta anterior de aproximadamente 50 minutos permanece sujeita a benchmark.

O pacote contém: índice de documentos e revisões; scope of work por trade; takeoff com quantidades e unidades; lista de materiais e perdas; mão de obra; orçamento detalhado; inclusões e exclusões; alternativas; premissas; perguntas e pendências; plantas com marcações; PDF, planilha e dados estruturados.

“Completo” significa que o escopo selecionado foi coberto e suas lacunas foram declaradas. Não significa que uma planta incompleta passou a conter informações inexistentes. Um orçamento com pendência crítica não recebe o mesmo estado de um orçamento pronto para revisão comercial.

## Experiência simples — direção de produto confirmada

**Promessa do produto:** “Envie fotos e/ou plantas. Escolha o serviço. Receba medidas, materiais e orçamento.” Esta é a experiência proposta, não uma afirmação de funcionalidade já entregue.

### 1. Enviar arquivos

Uma única área de upload aceita fotos, plantas e arquivos mistos do mesmo projeto, dentro dos formatos homologados. No celular, oferecer “Tirar foto” e “Escolher arquivos”. Mostrar miniaturas, permitir adicionar/remover arquivos e manter tudo no mesmo orçamento. Enviar uma foto deve ser suficiente para iniciar a análise, mesmo que depois seja necessária uma medida de referência.

Não exigir que a pessoa crie um projeto, organize pastas, classifique cada folha ou escolha uma IA antes de enviar. O sistema cria o registro necessário automaticamente. Fotos complementam o contexto da planta; não geram uma segunda contagem do mesmo cômodo ou elemento.

### 2. Escolher o serviço / field

Seleção por cartões com nomes claros. Exemplos de catálogo proposto: Tile, Flooring, Painting, Drywall, Framing, Roofing e Remodelação. Oferecer apenas serviços homologados, com um ou mais selecionáveis. Remodelação expande para os serviços cobertos pelo produto e deixa essa cobertura visível.

“Área de serviço” é o trade; “área do projeto” é o cômodo ou trecho. Por padrão, analisar todo o escopo enviado para os serviços escolhidos. “Selecionar cômodo/trecho” é uma opção para quem quiser limitar a análise, sem obrigar todos a desenhar ou marcar a planta.

Medida conhecida, material desejado e preço próprio podem ser informados em “Personalizar”, de forma opcional. Localização, unidades, perdas, preços de mão de obra e regra comercial vêm do perfil da empresa quando disponíveis. A falta de preço não deve interromper a medição: o item fica com preço pendente até ter uma base válida.

### 3. Gerar orçamento e receber o resultado

Botão principal: **“Gerar orçamento”**. Mostrar uma etapa em linguagem simples e estimativa de conclusão baseada no processamento real. O usuário pode sair e voltar. Concluído o processamento, abrir o orçamento automaticamente ou pela notificação.

O valor aparece primeiro; os detalhes ficam em abas ou seções recolhíveis:

| Saída | Conteúdo necessário |
| --- | --- |
| Valor | Materiais, mão de obra, adicionais, regra comercial e total para o escopo selecionado. Identificar base de preços, estimativas e valores pendentes. |
| Medidas / takeoff | Áreas, comprimentos, volumes e contagens, com unidades, cômodos e origem da medição. |
| Materiais / lista de compra | Material especificado ou recomendado, quantidade líquida, perda configurada e quantidade de compra. Diferenciar recomendação de material identificado no documento. |
| Serviços / scope of work | O que será executado, inclusões e exclusões, vinculado às quantidades e ao serviço escolhido. |
| Proposta | PDF de orçamento e escopo, além de planilha e lista de compra derivados da mesma revisão. |

Permitir editar quantidade, material, preço e lucro. Recalcular os totais pelo motor determinístico, manter histórico e atualizar as exportações para a revisão editada. Oferecer “Baixar proposta” e “Baixar lista de materiais”; envio externo exige ação do usuário.

### Pedir somente o que falta

- Planta com dimensão explícita ou escala validada: medir os elementos suportados e registrar a evidência.
- Foto sem dimensão de referência ou geometria utilizável: pedir uma medida conhecida, por exemplo a largura da parede ou do piso. Até calibrar, tratar medidas como estimativas; uma referência não garante todas as dimensões de uma cena com perspectiva ou partes ocultas.
- Fotos e plantas com conflito de dimensão ou revisão: destacar o conflito e pedir uma confirmação apenas para os itens afetados.
- Material não especificado: oferecer uma opção recomendada para o orçamento, identificada como recomendação. Não afirmar que a foto revelou a composição interna ou materiais ocultos.
- Preço sem catálogo/cotação válida: mostrar pendência no item e indicar que o total é parcial. Não apresentar esse total como orçamento completo para envio.

O resultado pode estar “Pronto para revisar” ou “Falta uma informação”, com a ação necessária visível. O encerramento técnico do processamento não libera automaticamente uma proposta com pendências críticas. Sem pendências, o pacote precisa conter os serviços, medidas, materiais e valores do escopo escolhido.

Credenciais, fornecedores, filas e configurações técnicas ficam na administração. A tela de orçamento apresenta apenas decisões que ajudam o usuário a executar o serviço.

## O que existe no repositório

O inventário abaixo foi registrado na inspeção de 2 de outubro; não representa uma nova verificação do código nesta atualização de produto.

Inspecionados em `kauanszpaiva/RoughBid`, branch principal: `package.json`, `README.md`, `scripts/worker.ts` e `docs/architecture/ai-plan-reading-pipeline.md`.

- Monorepo com `apps/api`, `apps/web`, `packages/domain` e Supabase.
- Dependência BullMQ e processo de worker já presentes.
- Worker com integração opcional de leitura durável controlada por `AI_PLAN_DURABLE_ENABLED`, configuração de Redis e heartbeat.
- Leitura por lotes de páginas; análise de regiões de plantas densas; extração local de geometria vetorial e texto nativo descritas no documento de arquitetura.
- Rastreamento de evidências, review e política de gasto já descritos.
- Há documentação antiga afirmando que a leitura é apenas síncrona, enquanto o worker atual já possui caminho durável. A implementação deve reconciliar essa documentação com as rotas efetivas.

Não foram inspecionados deploy, credenciais, disponibilidade do Redis, migrações aplicadas nem todos os handlers. Presença de código não comprova ativação em produção.

## Provedores e responsabilidade

| Componente | Responsabilidade proposta | Evidência e condição de integração |
| --- | --- | --- |
| Autodesk Platform Services | Para DWG/RVT/IFC e formatos suportados: conversão, visualização, objetos, geometria e propriedades | Model Derivative tem documentação oficial. Validar a matriz de tradução por formato/versão; propriedades extraídas refletem o modelo fornecido, não garantem que ele esteja completo. |
| AWS Textract | OCR de scans, notas, carimbos e extração de tabelas, principalmente onde não há texto nativo utilizável | API assíncrona documentada; documentos em S3 e notificações SNS/SQS. Não é o motor de medição de paredes e áreas. |
| Gemini | Classificação de folhas e trades, interpretação de notas e imagens, organização de resultados | Processamento de PDFs e saídas estruturadas documentados. Selecionar modelo vigente por configuração; não fixar Gemini 1.5 da captura. |
| Claude | Revisão de escopo, inconsistências entre notas, schedules e extração; interpretação de documentos ambíguos | PDF com texto e imagem documentado. Selecionar modelo vigente por configuração; não fixar Claude 3.5 da captura. |
| Togal.AI | Medição e contagem especializadas, se houver acesso comercial utilizável pelo RoughBid | Produto e integrações comerciais confirmados; API pública e direito de uso embutido no RoughBid não confirmados. Adapter desativado até validação. |
| ReadMyPlans | Candidato alternativo para extração e takeoff | Site anuncia API; schema executável, autenticação, limites, preço e precisão não verificados. Não criar endpoints externos fictícios. |
| UpCodes | Pesquisa de requisitos por jurisdição/edição e relatório de alertas com referências | Ferramentas de pesquisa confirmadas; acesso programático para RoughBid não confirmado. Relatório de pesquisa não equivale a aprovação legal/técnica. |
| Motor de cálculo RoughBid | Normalização de unidades, conversões, perdas, preços, subtotais, contingência e markup | Cálculo determinístico. Usar catálogo da empresa, preços licenciados ou cotações rastreáveis. IA não inventa preço atual. |

Os provedores são complementares. Togal e ReadMyPlans são alternativas dentro do mesmo papel, não duas chamadas obrigatórias para todo arquivo. Claude/Gemini podem revisar partes específicas sem duplicar o conjunto inteiro a cada etapa. Autodesk é usado quando o formato e os dados o justificarem.

## Arquitetura proposta

1. Upload direto para armazenamento privado com URL temporária. A API recebe metadados e não mantém uma requisição de 50 minutos aberta.
2. Validação do arquivo, tenant, assinatura real, tamanho, número de páginas e integridade. Inventário com hash e revisão imutável.
3. Registro transacional do job, autorização de consumo e outbox. Publicação na fila a partir da outbox elimina a lacuna entre banco e Redis.
4. Worker executa etapas curtas e persistidas. Cada etapa salva seu resultado e pode ser retomada após falha.
5. Fontes documentais diferentes convergem para um schema interno comum. Nenhum formato bruto de fornecedor define o domínio do RoughBid.
6. Takeoff e interpretação convergem para validação por trade e reconciliação entre schedules, plantas, detalhes e revisões.
7. Motor de preços gera valores somente quando quantidade, unidade e preço possuem base utilizável.
8. Exportações são produzidas em uma versão imutável do orçamento. Só então o job fica disponível e uma notificação é enfileirada.

Manter frontend/API na Vercel é compatível com esse desenho. Para processamento longo, aproveitar o worker existente em host persistente ou adotar workflow durável. Não aumentar simplesmente o timeout de um handler.

## Meta temporal de 50 minutos

Orçamento inicial de tempo para o desenho, ainda sem benchmark:

| Janela | Resultado esperado |
| --- | --- |
| 0–5 min | Validação, índice, revisão, inventário e roteamento |
| 5–15 min | Conversão necessária, texto nativo/OCR e classificação |
| 15–30 min | Takeoff, áreas, comprimentos, volumes e contagens |
| 30–40 min | Scope, materiais, mão de obra e precificação |
| 40–47 min | Reconciliação, cobertura, inconsistências e pendências |
| 47–50 min | Exportações, persistência final e notificação |

Etapas independentes podem rodar em paralelo com concorrência limitada por quota e gasto. O prazo conta a partir da confirmação de admissão do job; a interface deve informar se a fila está incluída na estimativa exibida.

Validar primeiro conjuntos PDF dentro dos limites atuais do produto, com amostras pequenas, médias e próximas ao limite. CAD/BIM grandes precisam de benchmarks próprios. Medir tempo total, espera na fila e P50/P95 por tamanho/formato, taxa de itens corrigidos e custo real. Só oferecer prazo garantido após essa evidência.

Quando passar de 50 minutos, persistir progresso e atualizar ETA; não marcar sucesso pelo relógio. Entregar antes quando estiver pronto. Arquivo ilegível, escala ausente ou fonte de preço indisponível deve gerar pendência explícita, não quantidades ou valores fictícios.

## Contrato interno de API proposto

Os caminhos abaixo são novos contratos propostos, não endpoints já existentes e não endpoints dos fornecedores.

| Método e caminho | Comportamento |
| --- | --- |
| `POST /api/v2/projects/{projectId}/uploads` | Autoriza upload direto e retorna identificador e URL temporária |
| `POST /api/v2/projects/{projectId}/uploads/{uploadId}/complete` | Verifica objeto, integridade e ownership antes de aceitar o arquivo |
| `POST /api/v2/projects/{projectId}/estimate-jobs` | Recebe revisão de fotos/plantas, serviços selecionados, limite opcional de cômodo/trecho, referências de medida, preferências de material, política de preços e entitlement; retorna `202` e `jobId` |
| `GET /api/v2/estimate-jobs/{jobId}` | Estado, etapa, cobertura, progresso, ETA, gasto e pendências |
| `POST /api/v2/estimate-jobs/{jobId}/cancel` | Solicita cancelamento cooperativo e interrompe novas chamadas |
| `GET /api/v2/estimate-jobs/{jobId}/result` | Resultado versionado, disponível apenas após persistência e exportação |
| `PATCH /api/v2/estimates/{estimateId}/items/{itemId}/review` | Aceita, rejeita ou corrige item com usuário e histórico |
| `POST /api/v2/estimates/{estimateId}/exports` | Exporta uma revisão determinada; devolve job de exportação |

Criação do job exige `Idempotency-Key`. Repetição idêntica reutiliza o job; mesma chave com payload diferente retorna conflito. Toda consulta/mutação verifica o tenant no servidor. Chaves de API ficam no backend.

Preservar as regras atuais de pagamento, consentimento, papéis e owner-free. Um webhook assinado continua sendo a fonte de verdade de pagamento. A nova fila não pode conceder consumo pago apenas porque o navegador declarou que pagou.

Estados de execução: `queued`, `processing`, `needs_input`, `completed`, `failed`, `cancelled`. Separar deles `stage`, `quality_status` e `delivery_status`. `completed` indica processamento encerrado; `quality_status` diferencia `ready_for_review`, `incomplete` e `review_required`. A aprovação para envio ao cliente é um estado comercial separado.

Erros estáveis incluem `INVALID_FILE`, `INCOMPLETE_UPLOAD`, `MISSING_SCALE`, `PROVIDER_UNAVAILABLE`, `BUDGET_EXCEEDED`, `PRICE_SOURCE_MISSING` e `REVISION_CONFLICT`. Não expor o payload sensível bruto do fornecedor ao usuário.

## Evidência por item

Cada item deve registrar documento/hash/revisão, página/folha ou objeto BIM, localização na planta, trecho fonte quando aplicável, método de medição, escala de origem, quantidade, unidade, trade, classificação de confiança, pressupostos e status de revisão. Taxas de preço exigem unidade compatível, região, data e fonte.

Não converter confiança declarada pelo LLM em precisão estatística. Uma quantidade exige geometria calibrada, dimensão explícita ou schedule rastreável. Escala é validada por viewport/região; não aplicar uma escala global a uma folha com detalhes de escalas distintas. Sobreposições de regiões exigem deduplicação espacial. Itens em plantas e schedules precisam de identificadores/regras de reconciliação para não serem contados duas vezes.

Todas as páginas e trades selecionados têm estado de cobertura: processado, pendente, não aplicável com motivo ou falhou. Caps de páginas, segmentos, texto e saída do modelo são registrados; página truncada não aparece como totalmente revisada.

## Scope, takeoff e preço

O escopo descreve serviços incluídos por trade e liga cada serviço às evidências e quantidades. O takeoff mantém quantidade líquida e quantidade de compra separadas; perdas são parâmetros explícitos por material, sem percentual universal.

Materiais e mão de obra possuem linhas separadas. Não aplicar taxa por `EA` a `LF` ou `SF`. Item sem preço confirmado pode aparecer com quantidade válida e preço pendente, mas não desaparecer do orçamento.

Preservar o cálculo comercial vigente após inspeção de `packages/domain`, sem duplicá-lo em prompts. Reserva, desperdício, contingência, markup e margem têm significados distintos. O novo motor não altera essas regras silenciosamente.

Um checklist de código registra jurisdição, edição, data de consulta e referência. Se UpCodes não estiver disponível/licenciado, declarar a etapa indisponível ou usar uma fonte oficial autorizada com rastreabilidade. Não afirmar conformidade a partir de uma resposta genérica de IA.

## Falhas, gasto e recuperação

- Cada etapa possui chave de deduplicação por job/revisão/etapa/fornecedor/versão de configuração.
- Retentativas com backoff e jitter somente para falhas transitórias; respeitar `Retry-After`. Erros permanentes não entram em loop.
- Registrar `provider_job_id` antes de acompanhar um serviço assíncrono. Quando o estado externo for ambíguo, reconciliar antes de reenviar e cobrar novamente.
- Callbacks têm assinatura verificada, deduplicação, proteção contra replay e inbox durável. Eventos fora de ordem não regressam estado final.
- Workers possuem lease e fencing para impedir que um processo antigo sobrescreva um resultado novo. Jobs interrompidos retomam de checkpoints.
- Reservar consumo atomicamente por job e empresa antes de cada chamada; reconciliar reserva com custo real. Incluir OCR, modelos, conversões, worker, storage e exportações no cálculo.
- Fallback pago somente quando autorizado pela política do job. Falha não autoriza trocar para um provedor mais caro sem limite.
- Cancelamento impede novas chamadas e mantém os custos já incorridos registrados. Notificação tem retry próprio e não reexecuta a estimativa.
- Logs usam IDs e métricas; plantas, informações pessoais, tokens e URLs assinadas não devem aparecer indiscriminadamente.

## Sequência de implementação

0. Implementar upload único de fotos/plantas, cartões de serviços, botão “Gerar orçamento” e resultado com valor, medidas, materiais e proposta. Usar configurações salvas e solicitar dados adicionais somente quando necessários; conectar as telas ao processamento real.
1. Inspecionar handlers, schema e testes atuais; reconciliar documentação e ativação durável. Preservar auth, tenant, payment e orçamento existentes.
2. Introduzir job v2, etapas/checkpoints, outbox/inbox e API de status. Fazer a leitura atual rodar no worker de ponta a ponta.
3. Integrar Textract apenas nos documentos/regiões que precisarem de OCR; manter extração nativa como primeiro caminho quando utilizável.
4. Homologar um fornecedor de takeoff com acesso comercial e plantas reais anotadas. Até lá, o produto não promete takeoff completo baseado apenas na interpretação de um LLM.
5. Adicionar roteamento Autodesk para formatos homologados. Validar unidades e propriedades por formato.
6. Acrescentar revisão contextual, price book, reconciliação e geração do pacote.
7. Adicionar pesquisa UpCodes somente com acesso e licença confirmados.
8. Rodar piloto controlado, medir precisão/custo/tempo e ajustar a promessa comercial.

## Critérios de aceite e validação necessária

Nenhum teste de implementação foi executado nesta tarefa; os itens abaixo são critérios para a mudança futura.

- Foto somente, planta somente e fotos + plantas percorrem o mesmo fluxo; serviços podem ser selecionados juntos e itens duplicados entre fontes são reconciliados.
- Dados já salvos da empresa não são pedidos novamente; referências de medida, material e preço são solicitadas somente para pendências reais.
- Uma foto sem base geométrica utilizável não recebe dimensões aprovadas; o pedido de referência permite retomar o mesmo orçamento.
- Resultado apresenta valor, medidas, materiais, scope e exportações para o serviço selecionado; correções recalculam tela e documentos a partir da mesma revisão.
- Upload + job + fechamento do navegador + resultado disponível sem perda de processamento.
- Falha do worker após uma etapa e retomada sem refazer etapas concluídas ou duplicar chamadas faturadas.
- Repetição de criação e callbacks duplicados/fora de ordem sem duplicar orçamento ou gasto.
- Usuário de outro workspace não lê arquivo, job, finding nem exportação.
- Sem escala, sem página ou com revisão conflitante, o item não é publicado como quantidade aprovada.
- Portas, closets, paredes, áreas e elementos de múltiplas folhas comparados com takeoff humano de referência por trade.
- Fonte de preço ausente, unidade incompatível ou gasto esgotado produz pendência explícita e não total enganoso.
- Cobertura de todas as páginas selecionadas verificada mesmo quando houver truncamento ou quota do fornecedor.
- Prazo de 50 minutos medido por faixa de tamanho sob concorrência representativa, incluindo fila.
- PDF/planilha/tela derivados da mesma revisão com totais consistentes.

## Pendências e handoff

Faltam credenciais e condições comerciais dos fornecedores; contrato técnico de takeoff e UpCodes; localização/base de preços padrão; conjuntos de plantas e takeoffs humanos para benchmark; confirmação do worker/Redis e deploy atuais.

O próximo handoff é para backend/infra: inspeção do caminho durável, implementação dos contratos e migrações, sem remover controles de autorização e gasto. O pacote de contexto é este blueprint e os arquivos do repositório citados acima. Integrações externas ficam bloqueadas individualmente até credenciais e contratos serem validados. Estado oficial do desenho: REVIEW_REQUIRED.

## Fontes consultadas

Verificadas em 2 de outubro de 2026:

- Autodesk Model Derivative: https://aps.autodesk.com/developer/overview/model-derivative-api
- Formatos Autodesk: https://aps.autodesk.com/en/docs/model-derivative/v2/developers_guide/supported-translations/supported-translation/
- AWS Textract assíncrono: https://docs.aws.amazon.com/textract/latest/dg/api-async.html
- Claude PDF: https://platform.claude.com/docs/en/build-with-claude/pdf-support
- Gemini PDF: https://ai.google.dev/gemini-api/docs/document-processing
- Togal produto: https://www.togal.ai/
- Togal integrações por trade: https://www.togal.ai/trades/electrical
- ReadMyPlans anúncio de API: https://readmyplans.com/api (documentação executável não recuperada)
- UpCodes ferramentas: https://support.up.codes/support/solutions/articles/63000283467-upcodes-tools-and-features
- Vercel limites: https://vercel.com/docs/functions/limitations
- Repositório inspecionado: https://github.com/kauanszpaiva/RoughBid
