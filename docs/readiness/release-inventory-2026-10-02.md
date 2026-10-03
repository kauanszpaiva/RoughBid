# RoughBid — inventário de ativação sem chamadas de IA

Inventário da sessão de 2 de outubro de 2026. Metadados remotos conferidos entre **2026-10-02 23:53 e 2026-10-03 00:01 UTC** (2 de outubro, aproximadamente 19:53–20:01 America/New_York). Este documento registra o estado observado; alterações posteriores exigem nova comparação.

**Bloqueio confirmado:** o Supabase de RoughBid está ativo, mas ainda não possui a fundação Full Takeoff nem as tabelas/RPCs novas de plantas, fotos, medições e orçamento. A Vercel possui nomes de credenciais e `REDIS_URL`; isso não comprova acesso aos modelos, conectividade Redis ou execução de worker. Nenhum worker RoughBid foi identificado nos serviços Railway acessíveis.

## Critério da evidência

| Marca | Significado |
| --- | --- |
| Verificado local | Código/configuração versionada ou metadados Git lidos no worktree isolado. |
| Verificado por metadados remotos | Consulta de gerenciamento ou `SELECT` de catálogo respondeu nesta conferência. Não equivale a teste funcional. |
| Não verificado | Sem prova nesta execução; não significa ausente ou inválido. |

Nenhuma inferência, upload para Kamai/APS/LLMs, cobrança, criação de recurso, deploy ou migration foi executada. As consultas de banco foram somente `SELECT` de nomes, assinaturas, privilégios, existência de objetos e estados de controle. Não foram lidos dados de plantas/fotos ou usuários. Nenhum `.env`, conteúdo de `.env.example`, arquivo de autenticação ou valor de chave foi aberto pelo agente; valores de variáveis não foram incluídos em saídas, documento ou artefatos. O CLI usou a sessão autorizada sem extrair/decriptar tokens.

## Código e implantação

| Item | Estado observado | Evidência |
| --- | --- | --- |
| Worktree | Verificado local: `agent/roughbid-stage-engine-20261002`; HEAD da conferência `b8be8107c64f0e4052e9a4c3673ff2a1df5fe8ff`, com alterações adicionais ainda em integração | Git no worktree `roughbid-engine`. |
| Base do pacote | Verificado local: PR98 draft `7dfb9c8edba456a19dcd1b964c1d1837319ebc80` | Base isolada adotada para não duplicar o worker fundador; não está mergeada. |
| Produção Vercel | Verificado por metadados: cinco implantações recentes com target `production`, estado `READY`, branch `main`, commit `808e0b99a14477cb4a6525267e494c894e568766` | `vercel list roughbid --environment production --limit 5 --json`, saída projetada para estado/branch/commit. Nenhuma página de produto foi chamada. |
| Código novo em produção | Não implantado por esta execução | O commit inicial do pacote e o trabalho posterior não foram publicados/mergeados. |
| Limite HTTP | Verificado local: `vercel.json` limita funções a `maxDuration: 300` | O processamento total novo ocorre no worker; não depende da duração da requisição. |
| Caminho antigo do fundador | Verificado local em `origin/main`: `ai-plan/routes.ts:139–143` conserva processamento síncrono para platform admin | O handler de main não contém a factory Full V2. Ter credenciais configuradas não substitui essa mudança de código. |

As ferramentas MCP de Vercel localizaram o projeto, mas consultas detalhadas retornaram `INVALID_ARGUMENT`. O CLI de gerenciamento forneceu a enumeração de nomes e metadados de implantações acima. Não se tomou esse erro de ferramenta como ausência de projeto ou falta de acesso da conta.

## Variáveis Vercel — somente nomes, ambiente e tipo

A enumeração de **Production** retornou 47 nomes. A tabela abaixo contém apenas o subconjunto relevante. Não se verificaram valores de modelos nem validade de credenciais; vários nomes de modelo foram cadastrados como `sensitive`.

| Nomes | Metadado observado |
| --- | --- |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Presentes, `sensitive`, Production. |
| `ANTHROPIC_API_KEY`, `CLAUDE_PLAN_MODEL`, `TAKEOFF_V2_CLAUDE_MODEL` | Presentes, `sensitive`, Production. |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Presentes, `sensitive`, Production. |
| `KIMI_API_KEY`, `DEEPSEEK_API_KEY` | Presentes, `sensitive`, Production. |
| `KAMAI_API_KEY`, `APS_CLIENT_ID`, `APS_CLIENT_SECRET` | Presentes, `sensitive`, Production. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Presentes, `sensitive`, Production. |
| `REDIS_URL` | Presente, `encrypted`, Production; endpoint/conectividade não consultados. |
| `BLOB_READ_WRITE_TOKEN` | Presente, `encrypted`, Production/Preview/Development. |
| `TAKEOFF_V2_ENABLED`, `TAKEOFF_V2_WORKER_ENABLED`, `TAKEOFF_V2_SCHEMA_VERSION` | Ausentes na enumeração completa de Production. O caminho novo exige configuração explícita. |
| `PHOTO_TAKEOFF_ENABLED`, `PHOTO_TAKEOFF_WORKER_ENABLED` | Ausentes na enumeração completa de Production. |
| `AI_PLAN_DURABLE_ENABLED` | Ausente na enumeração completa de Production. |
| `TAKEOFF_V2_RUN_SPEND_LIMITS_JSON`, `PHOTO_TAKEOFF_APPROVED_RUN_BUDGET_USD` | Ausentes na enumeração completa de Production. Nenhum saldo informado foi convertido em aprovação de gasto. |
| `ROUGH_BID_LIVE_TESTS_ENABLED`, `ROUGH_BID_LIVE_TEST_SPEND_APPROVED` | Ambos ausentes em Production; os testes locais também os mantêm desligados. |

Presença de chave na Vercel não configura outro host. O worker exige sua própria configuração manual. Conta/billing, acesso aos identificadores exatos, tarifas aprovadas, permissões de dados e termos de parceiros continuam **não verificados**; não foram realizados testes reais para comprová-los.

Metadados Git do checkout original e do worktree não indicaram modificação de `.env.example` durante esta conferência. O arquivo é rastreado: regras de ignore não protegem um arquivo já rastreado. Isso não é uma declaração de vazamento nem prova sobre seu conteúdo; mantenha apenas placeholders no exemplo e exclua arquivos de credenciais do pacote revisável.

## Supabase — estado real e deriva de migrations

Projeto confirmado pelo nome **RoughBid**, referência `piasgpciojstjalaqazu`, região `us-east-1`, estado `ACTIVE_HEALTHY`. O histórico remoto retornou **44 migrations**, terminando em `20260919162447 / pilot_invite_only_access`.

| Grupo | Verificado por metadados remotos |
| --- | --- |
| Base comercial | `provider_spend_policy`, `provider_spend_reservations`, `api_usage_events` existem com RLS habilitado. O controle compartilhado está habilitado e possui reserva positiva por chamada; nenhum valor monetário foi extraído. |
| Leitura antiga | `plan_reading_jobs` existe com RLS. `private.ai_plan_worker_heartbeats` não existe; colunas de lease/worker/cancelamento pesquisadas em `plan_reading_jobs` não existem. |
| Full V2 | `takeoff_runs`, `takeoff_passes`, `plan_sheets`, `full_takeoff_v2_workers` não existem. |
| Medição/regiões/gasto por run | `takeoff_measurement_reviews`, `takeoff_measurement_review_events`, `takeoff_region_checkpoints`, `full_takeoff_provider_budgets` não existem. |
| Fotos | `photo_assets`, `photo_takeoff_runs`, `photo_takeoff_steps`, `photo_takeoff_reviews`, `photo_takeoff_workers`, `photo_provider_run_budgets` não existem. |
| Orçamento documentado | `construction_supplier_quotes`, `construction_budget_snapshots` não existem. |
| Ledger | Possui `job_id`, `provider`, `model`, `status`, `reserved_usd`, `estimated_cost_usd`, `telemetry_known`; não possui os pais `takeoff_run_id`, `photo_run_id`, `photo_asset_id` necessários ao pacote novo. |

`pg_proc` confirmou ausência das RPCs pesquisadas de Full V2, regiões, medições, fotos e orçamento, incluindo `reserve_full_takeoff_v2`, `claim_full_takeoff_v2`, `full_takeoff_stage_schema_ready`, `record_takeoff_measurement_review`, `reserve_photo_takeoff`, `save_photo_takeoff_review`, `save_construction_supplier_quotes` e `save_construction_budget_snapshot`. As RPCs antigas `touch_ai_plan_worker`, `ai_plan_worker_available`, `claim_ai_plan_reading`, `heartbeat_ai_plan_reading` e `reserve_platform_admin_reading_async` também estão ausentes.

RPCs existentes relevantes:

| RPC | Contrato remoto observado |
| --- | --- |
| `reserve_provider_spend(uuid,uuid,uuid,uuid,text,text)` | `SECURITY DEFINER`; sem execução para anon/authenticated. Consulta booleana da definição confirmou guard `p_provider <> 'gemini'`; não há identificadores OpenAI/Claude na definição. Não foi executada a RPC. |
| `capture_provider_spend(uuid,numeric)` | Existe, `SECURITY DEFINER`, sem execução para anon/authenticated. |
| `finish_platform_admin_reading(uuid,uuid,jsonb,jsonb,text)` | Existe, `SECURITY DEFINER`, sem execução para anon/authenticated; guard de findings entre 1 e 200 ainda presente. Não foi executada a RPC. |

**Não reaplicar migrations antigas pelo número do filename.** A base local `0039_commercial_spend_and_marketplace.sql` corresponde a `20260910190303 / commercial_spend_and_marketplace` no histórico remoto e seus objetos existem. Foundation, hardening e outras migrations antigas também usam timestamps distintos dos filenames locais. Compare nome, objeto, assinatura e constraints; não use `db push` indiscriminado.

## Pacote SQL a revisar para ativação

Ordem de dependências do código local; **nenhum item desta tabela foi aplicado por esta execução**. Confira o histórico e diferenças de schema antes de criar um lote consolidado para o ambiente escolhido.

| Ordem | Arquivo local / dependência | Estado remoto relevante |
| --- | --- | --- |
| Base | `0039_commercial_spend_and_marketplace.sql` | Base já presente como migration remota `20260910190303`; conservar e reconciliar. |
| 1 | `0023_durable_ai_plan_jobs.sql` → `0024_durable_ai_worker_capabilities.sql` → `0025_durable_ai_lease_alignment.sql` | Nomes não constam do histórico remoto; tabela privada, colunas e RPCs de worker pesquisadas ausentes. |
| 2 | `20260910225937_takeoff_v2_foundation.sql` → `20260910233003_takeoff_v2_fk_indexes.sql` | Nomes ausentes do histórico; pais V2 ausentes. Fundação/uniques devem preceder os novos FKs. |
| 3 | `20260919142500_low_cost_ai_provider_spend.sql` → `20260924134500_openai_claude_provider_spend.sql` | Nomes ausentes do histórico; guard vivo continua Gemini-only. Revisar extensões sobre a base comercial existente. |
| 4 | `20260925200000_exhaustive_plan_scan.sql` | Nome ausente do histórico; reserva founder async ausente e finalizador antigo mantém 1–200. |
| 5 | `20261002120000_full_takeoff_v2_durable.sql` | Objetos Full durável ausentes; vincula reservas ao pai real Full V2. |
| 6 | `20261002130000_photo_takeoff.sql` | Objetos de foto ausentes; adiciona pai real de foto, revisão CAS e orçamento específico. |
| 7 | `20261002140000_takeoff_measurement_review.sql` | Medições/revisões ausentes; cálculo determinístico e auditoria de revisão. |
| 8 | `20261002150000_full_takeoff_regions.sql` | Checkpoints regionais ausentes. |
| 9 | `20261002160000_full_takeoff_run_budgets.sql` | Orçamento por provedor/run e readiness RPC ausentes. Depende do ledger e RPC de reserva revistos acima. |
| 10 | `20261002170000_construction_budget.sql` | Cotações/snapshots ausentes; depende dos pais de planta e foto. |

Essa ordem não autoriza DDL. Preserve controles de acesso/custo existentes, faça a revisão de RLS/grants/FKs e valide o lote num banco de desenvolvimento antes de qualquer ativação de produção. Um script que ignore erros e siga para os wrappers de gasto pode deixar o contrato incompatível.

## Redis e worker

Verificado local: `Dockerfile.worker` usa Node 24, instala Poppler, copia API/domínio e inicia `node --experimental-strip-types scripts/worker.ts`; `package.json` oferece `npm run worker`. `scripts/worker.ts` anexa consumidores BullMQ separados, com concorrência 1, somente após configuração explícita e verificação do contrato SQL.

| Componente | Estado |
| --- | --- |
| Queue Full | Código local: `takeoff-full-v2`; versão do job `takeoff-v2.2-durable`; heartbeat SQL obrigatório e worker Redis ativo para aceitar intake. |
| Queue de foto | Código local: fila própria; versão `photo-takeoff-v1`; identidade do perfil público e heartbeat SQL obrigatório. |
| Railway | A conexão listou projetos `KSP Sites` e `JARVIS Cloud`, com três serviços. Metadados de source/start não identificaram repositório `kauanszpaiva/RoughBid` nem o comando do worker. Não foram lidos valores de variáveis, logs ou dados de aplicações. |
| Worker RoughBid em Railway | **Não identificado** no escopo acessível. Isso não prova ausência em outra conta, outro projeto ou host. |
| Worker em outro host | **Não verificado**. Nenhum processo externo foi assumido ou criado. |
| Heartbeat compatível em Supabase | Contrato/tabelas necessários ausentes; não há como atestar um worker compatível com este pacote no banco observado. |
| Redis endpoint, TLS/ACL, ping, filas e consumidor | **Não verificados**. A consulta não abriu o valor de `REDIS_URL`, não acessou Redis nem consumiu jobs. |

Variáveis de base do worker, por nome: `REDIS_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `BLOB_READ_WRITE_TOKEN` ou `OBJECT_STORAGE_*`. Full adiciona `TAKEOFF_V2_ENABLED`, `TAKEOFF_V2_WORKER_ENABLED`, `TAKEOFF_V2_SCHEMA_VERSION`, `TAKEOFF_V2_STAGE_PROVIDER_ENABLED`, configurações de etapas/modelos, `TAKEOFF_V2_MODEL_ATTESTATIONS_JSON` e `TAKEOFF_V2_RUN_SPEND_LIMITS_JSON`. Regiões precisam de ativação e renderer local compatível. Fotos adicionam `PHOTO_TAKEOFF_ENABLED`, `PHOTO_TAKEOFF_WORKER_ENABLED`, `PHOTO_TAKEOFF_SCHEMA_VERSION`, `PRIVATE_PHOTO_DATA_APPROVED`, perfil/modelo/attestations e referência de aprovação do orçamento. As chaves só devem ser configuradas manualmente no ambiente autorizado; cadastro na Vercel não é cópia para o worker.

## Menor sequência externa necessária

**Opção sem novo serviço de worker:** o computador autorizado desta sessão tem Node 24 e Poppler disponíveis (verificados por nome/caminho, sem credenciais), podendo executar `npm run worker` continuamente após configuração manual e schema/Redis conferidos. Não há necessidade técnica de contratar Railway para esse primeiro host. Docker não foi localizado no PATH; não é requisito para execução direta. Uptime/restart desse computador deve ser administrado pelo operador. Não foi iniciado processo conectado a filas remotas. Custo/plano/conectividade do Redis existente continuam não verificados.

1. Revisar o pacote isolado e reconciliar o SQL acima com o histórico/schema real. Escolher explicitamente o ambiente de desenvolvimento para a primeira ativação; ainda não aplicar migrations de produção.
2. Identificar o host autorizado para worker e o Redis já existente. Confirmar seu estado por metadados de gerenciamento, depois configurar manualmente os nomes necessários sem publicar segredos. Não criar infraestrutura por suposição.
3. Instalar o schema revisto e implantar uma versão compatível de API/UI/worker **somente em uma autorização externa posterior**. Validar heartbeat, isolamento e cancelamento sem chamar provedores.
4. Manter etapas de fornecedor desligadas até acesso/capacidade, termos de dados e orçamento serem aprovados separadamente. Kamai/APS exigem os respectivos termos/acessos; cotações de varejo exigem loja/ZIP e acesso permitido ou importação documentada.
5. Se for necessário comprovar inferência real posteriormente, aprovar antes um único teste concreto com dados permitidos e teto de custo. Os US$5 relatados por fornecedor não são saldo verificado nem autorização de consumo. Esta execução não realizou esse teste.

Rollback: desligar intake novo e os flags de fornecedor, cancelar/drenar jobs compatíveis e conservar resultados/checkpoints/receipts/ledger. Não remover tabelas de auditoria, liberar custo incerto ou reexecutar chamadas pagas desconhecidas. Reverter API/worker juntos para uma versão compatível; o worker antigo não satisfaz os novos contratos de schema/orçamento.

A restrição de merge/deploy/migrations decorre da instrução humana explícita da delegação inicial — “Não mergear, publicar/deployar ou aplicar migrations de produção” — reiterada no handoff, além da proibição de testes pagos e uploads a terceiros. Não foi identificada regra AGENTS/SKILL que acrescente uma aprovação. O pacote concreto torna revisáveis código, DDL, alterações de acesso/ledger e rollback antes da decisão externa; trabalho local autorizado não foi interrompido para confirmações redundantes.
