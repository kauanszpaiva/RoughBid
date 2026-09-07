-- Closed-by-default, TEST-only paid-reading pilot. No model, rate, budget or
-- workspace is enabled by this migration. Operators configure private rows;
-- HTTP callers can only use the narrowly granted service-role RPCs below.
create table if not exists private.plan_reading_pilot_config (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  model text check (model is null or (length(btrim(model)) between 1 and 200 and model = btrim(model))),
  stripe_livemode boolean not null default false check (stripe_livemode = false),
  budget_usd numeric not null default 0 check (budget_usd >= 0 and budget_usd < 'Infinity'::numeric),
  input_usd_per_million numeric check (input_usd_per_million > 0 and input_usd_per_million < 'Infinity'::numeric),
  output_usd_per_million numeric check (output_usd_per_million > 0 and output_usd_per_million < 'Infinity'::numeric),
  max_input_tokens integer check (max_input_tokens > 0),
  max_output_tokens integer check (max_output_tokens between 1 and 8000),
  updated_at timestamptz not null default now(),
  check (not enabled or (
    model is not null and budget_usd > 0
    and input_usd_per_million is not null and output_usd_per_million is not null
    and max_input_tokens is not null and max_output_tokens is not null
  ))
);
insert into private.plan_reading_pilot_config(id) values (1) on conflict (id) do nothing;

create table if not exists private.plan_reading_pilot_workspaces (
  workspace_id uuid primary key references public.workspaces(id) on delete restrict,
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists private.plan_reading_pilot_usage (
  job_id uuid not null references public.plan_reading_jobs(id) on delete restrict,
  attempt integer not null check (attempt between 1 and 2),
  quote_id uuid not null references public.project_reading_quotes(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  state text not null default 'pending' check (state in ('pending','measured','unknown','released')),
  model text not null,
  model_version text,
  input_usd_per_million numeric not null check (input_usd_per_million > 0 and input_usd_per_million < 'Infinity'::numeric),
  output_usd_per_million numeric not null check (output_usd_per_million > 0 and output_usd_per_million < 'Infinity'::numeric),
  max_input_tokens integer not null check (max_input_tokens > 0),
  max_output_tokens integer not null check (max_output_tokens between 1 and 8000),
  reserved_usd numeric not null check (reserved_usd > 0 and reserved_usd < 'Infinity'::numeric),
  input_tokens bigint check (input_tokens > 0),
  output_tokens bigint check (output_tokens >= 0),
  measured_usd numeric check (measured_usd >= 0 and measured_usd < 'Infinity'::numeric),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  primary key(job_id, attempt),
  unique(quote_id, attempt),
  check (state <> 'measured' or (input_tokens is not null and output_tokens is not null
    and measured_usd is not null and model_version is not null and length(btrim(model_version)) between 1 and 200))
);

alter table private.plan_reading_pilot_config enable row level security;
alter table private.plan_reading_pilot_workspaces enable row level security;
alter table private.plan_reading_pilot_usage enable row level security;
revoke all on private.plan_reading_pilot_config, private.plan_reading_pilot_workspaces,
  private.plan_reading_pilot_usage from public, anon, authenticated, service_role;

create or replace function private.plan_reading_pilot_exposure()
returns numeric language sql stable security definer set search_path = pg_catalog
as $$
  select coalesce(sum(case when state in ('pending','unknown') then reserved_usd
    when state = 'measured' then measured_usd else 0 end), 0)
  from private.plan_reading_pilot_usage
$$;
revoke all on function private.plan_reading_pilot_exposure() from public, anon, authenticated, service_role;

create or replace function public.assert_plan_reading_activation(p_workspace_id uuid, p_model text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare c private.plan_reading_pilot_config; worst_case numeric;
begin
  select * into c from private.plan_reading_pilot_config where id = 1;
  if not found or not c.enabled then raise exception 'Plan reading pilot is disabled'; end if;
  if p_model is null or p_model is distinct from c.model or c.stripe_livemode
    or c.model is null or c.budget_usd <= 0
    or c.input_usd_per_million is null or c.output_usd_per_million is null
    or c.max_input_tokens is null or c.max_output_tokens is null then
    raise exception 'Plan reading pilot configuration or model is invalid';
  end if;
  if not exists (select 1 from private.plan_reading_pilot_workspaces
    where workspace_id = p_workspace_id and enabled) then
    raise exception 'Workspace is not enabled for the plan reading pilot';
  end if;
  worst_case := (c.max_input_tokens::numeric * c.input_usd_per_million
    + c.max_output_tokens::numeric * c.output_usd_per_million) / 1000000;
  return jsonb_build_object('enabled', c.enabled, 'model', c.model, 'stripe_livemode', c.stripe_livemode,
    'budget_usd', c.budget_usd, 'input_usd_per_million', c.input_usd_per_million,
    'output_usd_per_million', c.output_usd_per_million, 'max_input_tokens', c.max_input_tokens,
    'max_output_tokens', c.max_output_tokens, 'reserved_usd_per_attempt', worst_case,
    'exposure_usd', private.plan_reading_pilot_exposure());
end $$;
revoke all on function public.assert_plan_reading_activation(uuid,text) from public, anon, authenticated;
grant execute on function public.assert_plan_reading_activation(uuid,text) to service_role;

-- Preserve 0017's payment/tenant/consent transaction, but remove the old
-- unbudgeted public entry point. Re-running 0019 never moves its own wrapper.
do $$ begin
  if to_regprocedure('private.reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text)') is null then
    alter function public.reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text) set schema private;
  end if;
end $$;
revoke all on function private.reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;

create or replace function public.reserve_project_reading(p_quote_id uuid, p_user_id uuid,
  p_workspace_id uuid, p_project_id uuid, p_file_id uuid, p_model text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare cfg jsonb; q public.project_reading_quotes; result jsonb; reserve_usd numeric;
  exposure numeric; job_uuid uuid; attempt_number integer;
begin
  -- One global lock covers every workspace and every settlement. This must be
  -- acquired before workspace/quote/job locks to avoid competing spend holds.
  perform 1 from private.plan_reading_pilot_config where id = 1 for update;
  cfg := public.assert_plan_reading_activation(p_workspace_id, p_model);
  select * into q from public.project_reading_quotes
    where id = p_quote_id and workspace_id = p_workspace_id
      and project_id = p_project_id and file_id = p_file_id;
  if not found then raise exception 'Paid quote required'; end if;
  if q.livemode then raise exception 'Pilot accepts Stripe TEST payments only'; end if;
  if exists (select 1 from private.plan_reading_pilot_usage where quote_id = q.id and state in ('pending','unknown')) then
    raise exception 'Prior pilot usage is pending or unknown; operator reconciliation is required';
  end if;
  result := private.reserve_project_reading(p_quote_id, p_user_id, p_workspace_id, p_project_id, p_file_id, p_model);
  if (result->>'reused')::boolean then return result; end if;
  reserve_usd := (cfg->>'reserved_usd_per_attempt')::numeric;
  exposure := private.plan_reading_pilot_exposure();
  if exposure + reserve_usd > (cfg->>'budget_usd')::numeric then
    -- Raising also rolls back 0017's job/attempt writes in this transaction.
    raise exception 'Plan reading pilot lifetime budget exhausted';
  end if;
  job_uuid := (result->'job'->>'id')::uuid;
  attempt_number := (result->'quote'->>'attempts')::integer;
  insert into private.plan_reading_pilot_usage(job_id,attempt,quote_id,workspace_id,model,
    input_usd_per_million,output_usd_per_million,max_input_tokens,max_output_tokens,reserved_usd)
  values(job_uuid,attempt_number,q.id,p_workspace_id,p_model,
    (cfg->>'input_usd_per_million')::numeric,(cfg->>'output_usd_per_million')::numeric,
    (cfg->>'max_input_tokens')::integer,(cfg->>'max_output_tokens')::integer,reserve_usd);
  return result || jsonb_build_object('pilot',jsonb_build_object(
    'attempt',attempt_number,'reserved_usd',reserve_usd,'model',p_model,
    'input_usd_per_million',cfg->'input_usd_per_million','output_usd_per_million',cfg->'output_usd_per_million',
    'max_input_tokens',cfg->'max_input_tokens','max_output_tokens',cfg->'max_output_tokens'));
end $$;
revoke all on function public.reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text) to service_role;

create or replace function public.record_plan_reading_usage(p_job_id uuid, p_attempt integer,
  p_usage jsonb, p_outcome text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare entry private.plan_reading_pilot_usage; input_count bigint; output_count bigint;
  version_text text; cost numeric; target_state text; budget numeric;
begin
  select budget_usd into budget from private.plan_reading_pilot_config where id = 1 for update;
  if not found then raise exception 'Plan reading pilot configuration is missing'; end if;
  select * into entry from private.plan_reading_pilot_usage
    where job_id = p_job_id and attempt = p_attempt for update;
  if not found then raise exception 'Pilot usage reservation not found'; end if;
  if p_outcome is null or p_outcome not in ('no_provider','measured','unknown') then
    raise exception 'Invalid pilot usage outcome';
  end if;
  target_state := case p_outcome when 'no_provider' then 'released' else p_outcome end;
  if p_outcome = 'measured' then
    if jsonb_typeof(p_usage) is distinct from 'object'
      or jsonb_typeof(p_usage->'input_tokens') is distinct from 'number'
      or jsonb_typeof(p_usage->'output_tokens') is distinct from 'number'
      or p_usage->>'model' is distinct from entry.model
      or jsonb_typeof(p_usage->'model_version') is distinct from 'string' then
      raise exception 'Verified usage counts, pinned model and model version are required';
    end if;
    if (p_usage->>'input_tokens')::numeric <= 0
      or (p_usage->>'input_tokens')::numeric <> trunc((p_usage->>'input_tokens')::numeric)
      or (p_usage->>'output_tokens')::numeric < 0
      or (p_usage->>'output_tokens')::numeric <> trunc((p_usage->>'output_tokens')::numeric) then
      raise exception 'Usage token counts must be nonnegative integers with positive input';
    end if;
    input_count := (p_usage->>'input_tokens')::bigint;
    output_count := (p_usage->>'output_tokens')::bigint;
    version_text := btrim(p_usage->>'model_version');
    if length(version_text) not between 1 and 200 then raise exception 'Model version is required'; end if;
    cost := (input_count::numeric * entry.input_usd_per_million
      + output_count::numeric * entry.output_usd_per_million) / 1000000;
  elsif p_usage is not null and p_usage <> '{}'::jsonb then
    raise exception 'Usage evidence is accepted only for measured settlement';
  end if;
  if entry.state <> 'pending' then
    if entry.state = target_state and (entry.state <> 'measured'
      or (entry.input_tokens = input_count and entry.output_tokens = output_count and entry.model_version = version_text)) then
      return to_jsonb(entry);
    end if;
    raise exception 'Pilot usage was already settled; operator reconciliation is required';
  end if;
  update private.plan_reading_pilot_usage set state = target_state,
    input_tokens = input_count, output_tokens = output_count,
    model_version = version_text, measured_usd = cost, settled_at = now()
    where job_id = p_job_id and attempt = p_attempt returning * into entry;
  -- Never clip real spend to the estimate. An overrun is counted in full and
  -- closes the pilot. Unknown usage retains the entire original reserve.
  if (p_outcome = 'measured' and cost > entry.reserved_usd)
    or private.plan_reading_pilot_exposure() > budget then
    update private.plan_reading_pilot_config set enabled = false, updated_at = now() where id = 1;
  end if;
  return to_jsonb(entry);
end $$;
revoke all on function public.record_plan_reading_usage(uuid,integer,jsonb,text) from public, anon, authenticated;
grant execute on function public.record_plan_reading_usage(uuid,integer,jsonb,text) to service_role;

comment on table private.plan_reading_pilot_usage is
  'Lifetime pilot spend: pending/unknown count full reserve, measured counts exact cost, released counts zero. No automatic unknown-usage recovery.';
