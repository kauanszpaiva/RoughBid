# Plano de ativação do schema — 2026-10-03

Nenhuma migration foi aplicada ao Supabase. Preparação, consultas de metadados e testes locais estão autorizados; DDL/deploy de produção exige autorização explícita separada.

## Base concreta

Projeto RoughBid `piasgpciojstjalaqazu`, auditado independentemente somente leitura em 2026-10-03 01:18:52 UTC; hashes 01:20:37 UTC. **44 migrations**, última `20260919162447 / pilot_invite_only_access`; MD5 do histórico ordered version:name: `946aa68457f650b1446317d7e036fe6b`. `0039_commercial_spend_and_marketplace.sql` já corresponde à migration remota `20260910190303 / commercial_spend_and_marketplace`. **Não reaplicar 0039, não alterar seu histórico e não usar db push para resolver a numeração automaticamente.**

As 36 tabelas novas dos 16 arquivos originais estão ausentes. Auditoria complementar às 01:26:17 UTC confirmou private.free_owner_workspaces ausente: a nova migration mínima adicionada como primeiro arquivo resolve a dependência, totalizando37 tabelas/17 arquivos. Não executar0020_owner_free_reading.sql inteiro: ele também altera CHECK e RPCs que não são necessários para esse pré-requisito. O CHECK remoto já inclui labor. As 11 tabelas públicas de base têm RLS ativo; projects(id,workspace_id), project_files(id,workspace_id,project_id) e plan_reading_jobs(id,workspace_id,project_id,file_id) possuem UNIQUE. Ledger comercial ainda Gemini-only; finalizador legado limitado a 200 findings. RPCs comerciais são DEFINER com search_path fixo e EXECUTE service_role=true, anon/authenticated/public=false. Metadados apenas: nenhum segredo, payload ou valor monetário da configuração foi lido.

## Gate antes de aplicar

Executar [roughbid-activation-readonly.sql](../../supabase/preflight/roughbid-activation-readonly.sql) no projeto acima. SQL usa apenas SELECT sobre catálogo/histórico, sem corpos de funções, políticas ou dados de aplicação. `00.summary` deve retornar `READY` e **zero BLOCKER**. Confere histórico comercial, colunas/tipos, RLS, assinaturas/grants/hashes dos RPCs existentes, UNIQUE/FKs de escopo e ausência dos objetos novos. Qualquer BLOCKER interrompe a ativação. Objetos novos presentes indicam execução parcial ou drift: não apagar, não pular e não reaplicar a lista inteira. O gate é para o baseline anterior à ativação e deve bloquear após iniciado o rollout.

## Sequência exata de 17 arquivos adicionais

SHA-256 portátil: SQL UTF-8 normalizado para LF (CRLF/CR→LF), incluindo comentários/espaços. Integridade dos bytes do pacote é conferida separadamente pelo SHA do ZIP. O teste compara cada hash antes da execução.

| Ordem | Arquivo em supabase/migrations | SHA-256 UTF-8 LF |
| --- | --- | --- |
| 1 | 20261002110000_durable_owner_workspace_dependency.sql | fd171d5e045a532a21a07ed1a85bed449f54d0bddab97c1f9de32de95e14ff2c |
| 2 | 0023_durable_ai_plan_jobs.sql | 57a7ece9fce944a6e16ae1db9f7d805025e83f893d4023700d2dd28822ebc77e |
| 3 | 0024_durable_ai_worker_capabilities.sql | 21fbd3e0e78d95ed7fc31b855ee1c9ddebc02e1658f36a6b936d50a05ac1858c |
| 4 | 0025_durable_ai_lease_alignment.sql | 9d83feffeb0b47397baf5963aa62e02d98d3bb5c6415c4d089ae7558528a8209 |
| 5 | 20260910225937_takeoff_v2_foundation.sql | 3c278263e09e8cee8d02132fde169080c44e15a6f074ed2800047260e6201b8d |
| 6 | 20260910233003_takeoff_v2_fk_indexes.sql | 7dbabcd9cd9315730d1897494f0f771c35d3f27cfa8bc07c0870d31c2f4d92f2 |
| 7 | 20260919142500_low_cost_ai_provider_spend.sql | 18495264e64b2313618702e50d2205adea166b7abf57fe3a2bacba963fff5763 |
| 8 | 20260924134500_openai_claude_provider_spend.sql | 81243d9417d1aec0146839a777f9dc842032bbbf882b10f8782703e578219491 |
| 9 | 20260925200000_exhaustive_plan_scan.sql | 0b5f56844c45094ccbfd8f20edda8e60b0141f498815214adb4f5e2589d1629d |
| 10 | 20261002120000_full_takeoff_v2_durable.sql | f5914237deb156b0e78ae910342069e49148a9568c9903bf9dc1497e47e7cf4a |
| 11 | 20261002130000_photo_takeoff.sql | e243d940024afe5fa24da72314f60d6d37a15f9be3e179586272180aca1eec3d |
| 12 | 20261002140000_takeoff_measurement_review.sql | 9f5187aa0d3462810bf5df271dd5974c14e7a3872b8657559a0847bb6e3c2f8d |
| 13 | 20261002150000_full_takeoff_regions.sql | dbf3104c877d9dcfabc48e993dbdd53edc63798d22421348d7c9da9fffec8fac |
| 14 | 20261002160000_full_takeoff_run_budgets.sql | c01d69a7d0e6c70edbe8a519ce43000c7604500d80a319daa20864b90ddee01b |
| 15 | 20261002170000_construction_budget.sql | 1b0de9c1eb11047b78a016db5d62a083ff8f39b5491de6dd24cff102b9b6384a |
| 16 | 20261002180000_geometry_provider_jobs.sql | b9f82bca51e893812dd8b55578424746e20873ceb768a17a9c214cb76ebdd213 |
| 17 | 20261002190000_geometry_construction_budget.sql | 1b7cae47ea66da2e0c18ab941ea1d4fd3d4963291fcd528de36669692c6fffd2 |

Dependências: 1 cria apenas a private.free_owner_workspaces ausente, fechada e sem allowlist; 2–4 leases/capacidades legadas; 5 grafo Takeoff; 6 índices FK; 7 allowlist intermediária do ledger; 8 OpenAI/Claude; 9 varredura acima de 200 findings; 10 Full durável; 11 fotos; 12 revisão de medidas; 13 regiões; 14 orçamento por run; 15 cotações/snapshots; 16 geometria, reservas/cancelamento coordenados; 17 orçamento vinculado à geometria aceita.

## Execução futura a autorizar

1. Conferir projeto, gate READY, SHA do pacote e hashes dos 17 arquivos. Garantir backup restaurável/janela; desativar novo intake Full/foto/Kamai, pausar filas e drenar workers preservando leases/ledger.
2. Após autorização específica de DDL, aplicar os corpos exatos na ordem acima, um arquivo/transaction por vez, registrando nome/versão e hash do bundle aprovado. Não importar/reaplicar o histórico antigo numerado: 0023/0024/0025 são aplicações adicionais rastreáveis do executor aprovado; a versão comercial remota 20260910190303 permanece intocada.
3. Primeiro erro: parar, registrar apenas erro/metadados e prefixo confirmado; revisar a falha antes de autorizar continuação. Não avançar para SQL seguintes e não repetir o conjunto inteiro.
4. Pós-aplicação: conferir RLS/grants service-only, parents UUID/FKs, funções/versões e schema readiness Full; implantar API e worker compatíveis juntos mantendo intake desativado até smoke autorizado.
5. Redis/worker persistente, consentimento, modelos exatos/pricing tables/budgets e credenciais manuais são pré-condições adicionais. Kamai continua desligado até autorização específica de dados/OEM e status terminal real comprovado. Nenhuma chamada paga ou upload externo faz parte deste plano.

## Rollback

Desligar intake/flags, pausar filas, encerrar/cancelar workers com leases e ledger preservados; reverter API/worker juntos para versão anterior compatível. Não deletar jobs, evidências, reservas ou snapshots. Não existe down migration destrutiva aprovada. Voltar código não desfaz RPCs compartilhados: restauração de funções exige plano revisado a partir do backup e do estado dos jobs, nunca reaplicação de 0039 ou DROP em cascata.

## Prova local e seus limites

`node --test supabase/test/schema-activation-sequence.test.mjs`: **2/2 PASS**, 17/17 SQL em ordem, RLS das tabelas principais, grants de cinco writers, geometry_run_id UUID e caso de checksum alterado recusado antes da execução.

Base PGlite equivalente reutiliza apenas DDL dos fixtures exhaustive-plan-scan e ai-provider-spend-openai, adiciona UNIQUE de escopo/page_count e executa 0039 exclusivamente no banco descartável para representar o comercial já instalado. A tabela free_owner_workspaces é removida do fixture antes da execução para que o primeiro SQL seja obrigado a criá-la; o teste confirma zero allowlist rows, RLS e recusa do preflight sobre objetos já aplicados. Stubs: auth.uid=NULL; has_workspace_role/has_product_access=true; process_stripe_event=true; get_pilot_access={active:false}. Sem dados reais ou chamadas remotas. Prova compilação/dependências/grants, não volume real, locks, Stripe, políticas RBAC ou backfills. Testes de fluxo anteriores carregavam subconjuntos e não são apresentados como prova desta sequência completa.

Bloqueadores remanescentes: autorização DDL/deploy, backup/janela, configuração manual de credenciais, fila persistente, preços/modelos e autorizações dos provedores. Orçamento continua parcial e total=null quando faltam fontes/composição/produtividade/revisão fiscal. Schema ativo não comprova resultado comercial completo.
