-- READ ONLY. Catalog/migration metadata only; no business rows, secret values,
-- function bodies, policy expressions, DDL, RPC execution, or mutations.
-- This gate is for the BEFORE-activation baseline, not for a partial rollout.
-- Any BLOCKER means STOP. READY is compatibility with the 17-file bundle,
-- including its closed-empty owner allowlist prerequisite, not deployment consent.
with
expected_history as (
  select 44::bigint as migration_count, '20260919162447'::text as last_version,
    '946aa68457f650b1446317d7e036fe6b'::text as history_md5
),
actual_history as (
  select count(*) as migration_count, max(version) as last_version,
    md5(string_agg(version||':'||coalesce(name,''), E'\n' order by version)) as history_md5,
    bool_or(version='20260910190303' and name='commercial_spend_and_marketplace') as commercial_present
  from supabase_migrations.schema_migrations
),
expected_columns(table_name,column_name,udt_name) as (values
  ('profiles','id','uuid'),('profiles','is_platform_admin','bool'),
  ('workspaces','id','uuid'),('workspaces','created_by','uuid'),('workspaces','ai_processing_consented_at','timestamptz'),
  ('workspace_members','workspace_id','uuid'),('workspace_members','user_id','uuid'),('workspace_members','role','text'),
  ('projects','id','uuid'),('projects','workspace_id','uuid'),
  ('project_files','id','uuid'),('project_files','workspace_id','uuid'),('project_files','project_id','uuid'),
  ('project_files','storage_path','text'),('project_files','original_name','text'),('project_files','processing_status','text'),
  ('plan_reading_jobs','id','uuid'),('plan_reading_jobs','workspace_id','uuid'),('plan_reading_jobs','project_id','uuid'),
  ('plan_reading_jobs','file_id','uuid'),('plan_reading_jobs','requested_by','uuid'),('plan_reading_jobs','status','text'),
  ('plan_reading_jobs','mode','text'),('plan_reading_jobs','model','text'),('plan_reading_jobs','input_summary','jsonb'),
  ('plan_reading_jobs','output_summary','jsonb'),('plan_reading_jobs','processing_error','text'),
  ('plan_reading_jobs','started_at','timestamptz'),('plan_reading_jobs','completed_at','timestamptz'),
  ('plan_reading_jobs','created_at','timestamptz'),('plan_reading_jobs','updated_at','timestamptz'),
  ('project_reading_quotes','id','uuid'),('project_reading_quotes','workspace_id','uuid'),('project_reading_quotes','project_id','uuid'),
  ('project_reading_quotes','file_id','uuid'),('project_reading_quotes','user_id','uuid'),('project_reading_quotes','job_id','uuid'),
  ('project_reading_quotes','file_sha256','text'),('project_reading_quotes','page_count','int4'),('project_reading_quotes','trades','jsonb'),
  ('project_reading_quotes','scope','text'),('project_reading_quotes','status','text'),('project_reading_quotes','attempts','int4'),
  ('project_reading_quotes','paid_at','timestamptz'),
  ('plan_reading_findings','id','uuid'),('plan_reading_findings','job_id','uuid'),('plan_reading_findings','workspace_id','uuid'),
  ('plan_reading_findings','project_id','uuid'),('plan_reading_findings','file_id','uuid'),('plan_reading_findings','geometry','jsonb'),
  ('api_usage_events','id','uuid'),('api_usage_events','workspace_id','uuid'),('api_usage_events','project_id','uuid'),
  ('api_usage_events','user_id','uuid'),('api_usage_events','provider','text'),('api_usage_events','model','text'),
  ('api_usage_events','operation','text'),('api_usage_events','estimated_cost_usd','numeric'),('api_usage_events','created_at','timestamptz'),
  ('provider_spend_policy','singleton','bool'),('provider_spend_policy','enabled','bool'),('provider_spend_policy','rolling_window','interval'),
  ('provider_spend_policy','spend_cap_usd','numeric'),('provider_spend_policy','call_reservation_usd','numeric'),
  ('provider_spend_reservations','event_id','uuid'),('provider_spend_reservations','job_id','uuid'),
  ('provider_spend_reservations','workspace_id','uuid'),('provider_spend_reservations','user_id','uuid'),
  ('provider_spend_reservations','provider','text'),('provider_spend_reservations','model','text'),('provider_spend_reservations','status','text'),
  ('provider_spend_reservations','reserved_usd','numeric'),('provider_spend_reservations','estimated_cost_usd','numeric'),
  ('provider_spend_reservations','telemetry_known','bool'),('provider_spend_reservations','created_at','timestamptz'),('provider_spend_reservations','settled_at','timestamptz')
),
expected_rls(table_name) as (values
  ('profiles'),('workspaces'),('workspace_members'),('projects'),('project_files'),('plan_reading_jobs'),
  ('project_reading_quotes'),('plan_reading_findings'),('api_usage_events'),('provider_spend_policy'),('provider_spend_reservations')
),
expected_private_base(signature) as (values
  ('auth.uid()'),('private.has_workspace_role(uuid,text[])'),('private.has_product_access()')
),
expected_functions(signature,source_md5,return_type) as (values
  ('public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text)','95bb79d33d531c0c1beb856d6e42fb5f','jsonb'),
  ('public.capture_provider_spend(uuid,numeric)','be77856736844423ef839b4d72705e7b','void'),
  ('public.finish_platform_admin_reading(uuid,uuid,jsonb,jsonb,text)','8db7c408d00ae04f868f765b92dbd119','jsonb')
),
expected_unique(table_name,column_names) as (values
  ('projects',array['id','workspace_id']::text[]),
  ('project_files',array['id','workspace_id','project_id']::text[])
),
expected_fk(table_name,column_names,target_table,target_columns) as (values
  ('project_files',array['project_id','workspace_id']::text[],'projects',array['id','workspace_id']::text[]),
  ('plan_reading_jobs',array['project_id','workspace_id']::text[],'projects',array['id','workspace_id']::text[]),
  ('plan_reading_jobs',array['file_id','workspace_id','project_id']::text[],'project_files',array['id','workspace_id','project_id']::text[]),
  ('provider_spend_reservations',array['event_id']::text[],'api_usage_events',array['id']::text[]),
  ('provider_spend_reservations',array['job_id']::text[],'plan_reading_jobs',array['id']::text[])
),
actual_fk as (
  select r.relname as table_name,tr.relname as target_table,
    array(select a.attname::text from unnest(c.conkey) with ordinality u(attnum,ord) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=u.attnum order by u.ord) as column_names,
    array(select a.attname::text from unnest(c.confkey) with ordinality u(attnum,ord) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=u.attnum order by u.ord) as target_columns
  from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_class tr on tr.oid=c.confrelid
  join pg_namespace n on n.oid=r.relnamespace where n.nspname='public' and c.contype='f'
),
actual_unique as (
  select r.relname as table_name,array_agg(a.attname::text order by u.ordinality) as column_names
  from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace
  cross join lateral unnest(c.conkey) with ordinality as u(attnum,ordinality)
  join pg_attribute a on a.attrelid=r.oid and a.attnum=u.attnum
  where n.nspname='public' and c.contype in ('p','u')
  group by c.oid,r.relname
),
expected_new_relations(name) as (values
  ('private.ai_plan_worker_heartbeats'),('public.takeoff_runs'),('public.plan_sheets'),('public.takeoff_passes'),
  ('public.scale_calibrations'),('public.takeoff_items'),('public.takeoff_evidence'),('public.takeoff_geometry'),
  ('public.assemblies'),('public.assembly_versions'),('public.assembly_components'),('public.price_sources'),('public.price_snapshots'),
  ('public.estimate_versions_v2'),('public.estimate_line_items_v2'),('public.estimate_adjustments_v2'),('public.estimate_recommendations_v2'),('public.estimate_rfis_v2'),
  ('public.full_takeoff_v2_workers'),('public.photo_assets'),('public.photo_takeoff_runs'),('public.photo_takeoff_reviews'),
  ('public.photo_takeoff_steps'),('public.photo_provider_run_budgets'),('public.photo_takeoff_workers'),
  ('public.takeoff_measurement_reviews'),('public.takeoff_measurement_review_events'),('public.takeoff_region_checkpoints'),
  ('public.full_takeoff_provider_budgets'),('public.construction_supplier_quotes'),('public.construction_budget_snapshots'),
  ('public.geometry_provider_jobs'),('public.geometry_provider_candidates'),('public.geometry_provider_review_receipts'),
  ('public.geometry_provider_spend_reservations'),('public.geometry_provider_workers')
),
expected_new_functions(name) as (values
  ('touch_ai_plan_worker'),('ai_plan_worker_available'),('claim_ai_plan_reading'),('heartbeat_ai_plan_reading'),
  ('reserve_platform_admin_reading_async'),('reserve_full_takeoff_v2'),('claim_full_takeoff_v2'),('reserve_photo_takeoff'),
  ('record_takeoff_measurement_review'),('full_takeoff_stage_schema_ready'),('save_construction_supplier_quotes'),
  ('save_construction_budget_snapshot'),('reserve_geometry_provider_job'),('recoverable_geometry_provider_jobs'),('cancel_full_takeoff_v2')
),
expected_absent_columns(table_name,column_name) as (values
  ('plan_reading_jobs','worker_id'),('plan_reading_jobs','worker_lease_id'),('plan_reading_jobs','worker_lease_expires_at'),
  ('plan_reading_jobs','cancel_requested_at'),('provider_spend_reservations','takeoff_run_id'),
  ('provider_spend_reservations','photo_run_id'),('provider_spend_reservations','photo_asset_id')
),
checks(check_name,passed,detail) as (
  select 'history.exact_44_baseline',a.migration_count=e.migration_count and a.last_version=e.last_version and a.history_md5=e.history_md5,
    jsonb_build_object('count',a.migration_count,'lastVersion',a.last_version,'historyMd5',a.history_md5) from actual_history a cross join expected_history e
  union all select 'history.commercial_already_applied',coalesce(commercial_present,false),jsonb_build_object('version','20260910190303','action','DO NOT REAPPLY 0039') from actual_history
  union all select 'column.'||e.table_name||'.'||e.column_name,coalesce(c.udt_name=e.udt_name,false),
    jsonb_build_object('expectedType',e.udt_name,'actualType',c.udt_name)
    from expected_columns e left join information_schema.columns c on c.table_schema='public' and c.table_name=e.table_name and c.column_name=e.column_name
  union all select 'rls.'||e.table_name,coalesce(c.relrowsecurity,false),jsonb_build_object('enabled',c.relrowsecurity)
    from expected_rls e left join pg_class c on c.oid=to_regclass('public.'||e.table_name)
  union all select 'base_function.'||signature,to_regprocedure(signature) is not null,jsonb_build_object('signature',signature) from expected_private_base
  union all select 'dependency.owner_free_allowlist_planned_closed',to_regclass('private.free_owner_workspaces') is null,
    jsonb_build_object('expectedBeforeActivation','absent','requiredFirstMigration','20261002110000_durable_owner_workspace_dependency.sql',
      'action','Create closed-empty allowlist as file 1 of the reviewed 17-file bundle; unexpected existing table means STOP')
  union all select 'writer.'||e.signature,
    coalesce(p.prosecdef and md5(p.prosrc)=e.source_md5 and format_type(p.prorettype,null)=e.return_type
      and not has_function_privilege('anon',p.oid,'execute')
      and not has_function_privilege('authenticated',p.oid,'execute') and has_function_privilege('service_role',p.oid,'execute'),false),
    jsonb_build_object('sourceMd5',md5(p.prosrc),'securityDefiner',p.prosecdef,'returnType',format_type(p.prorettype,null),
      'anonExecute',has_function_privilege('anon',p.oid,'execute'),'authenticatedExecute',has_function_privilege('authenticated',p.oid,'execute'),
      'serviceRoleExecute',has_function_privilege('service_role',p.oid,'execute'))
    from expected_functions e left join pg_proc p on p.oid=to_regprocedure(e.signature)
  union all select 'unique.'||e.table_name||'.'||array_to_string(e.column_names,','),exists(
    select 1 from actual_unique a where a.table_name=e.table_name and a.column_names @> e.column_names and cardinality(a.column_names)=cardinality(e.column_names)),
    jsonb_build_object('columns',e.column_names) from expected_unique e
  union all select 'foreign_key.'||e.table_name||'.'||array_to_string(e.column_names,','),exists(
    select 1 from actual_fk a where a.table_name=e.table_name and a.column_names=e.column_names and a.target_table=e.target_table and a.target_columns=e.target_columns),
    jsonb_build_object('columns',e.column_names,'targetTable',e.target_table,'targetColumns',e.target_columns) from expected_fk e
  union all select 'absence.relation.'||name,to_regclass(name) is null,jsonb_build_object('expected','absent') from expected_new_relations
  union all select 'absence.function.'||e.name,not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=e.name),
    jsonb_build_object('expected','absent') from expected_new_functions e
  union all select 'absence.column.'||e.table_name||'.'||e.column_name,not exists(
    select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=e.table_name and c.column_name=e.column_name),
    jsonb_build_object('expected','absent') from expected_absent_columns e
  union all select 'role.service_role_bypassrls',coalesce((select rolbypassrls from pg_roles where rolname='service_role'),false),jsonb_build_object('expected',true)
)
select '00.summary' as check_name,case when bool_and(coalesce(passed,false)) then 'READY' else 'BLOCKER' end as status,
  jsonb_build_object('phase','before_activation','blockers',count(*) filter(where not coalesce(passed,false)),
    'meaning','READY permits review of the exact 17-file bundle; production changes remain separately authorized') as detail from checks
union all select check_name,case when coalesce(passed,false) then 'READY' else 'BLOCKER' end,detail from checks
order by check_name;
