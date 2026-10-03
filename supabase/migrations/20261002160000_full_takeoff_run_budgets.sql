-- New Full Takeoff runs require explicit per-provider authorization in addition
-- to the existing shared company breaker. No balance or budget is seeded.
create table public.full_takeoff_provider_budgets (
  takeoff_run_id uuid not null,
  workspace_id uuid not null,
  provider text not null check(provider in ('openai','claude','gemini','kimi','deepseek')),
  approved_models text[] not null check(cardinality(approved_models)>0 and cardinality(approved_models)<=9),
  approved_usd numeric(12,6) not null check(approved_usd>0 and approved_usd<=100000),
  maximum_calls integer not null check(maximum_calls between 1 and 100000),
  approval_ref text not null check(length(approval_ref) between 3 and 200),
  created_at timestamptz not null default now(),
  primary key(takeoff_run_id,provider),
  foreign key(takeoff_run_id,workspace_id) references public.takeoff_runs(id,workspace_id) on delete restrict
);
alter table public.full_takeoff_provider_budgets enable row level security;
revoke all on public.full_takeoff_provider_budgets from anon,authenticated;
grant all on public.full_takeoff_provider_budgets to service_role;

create function public.configure_full_takeoff_run_budget(p_run_id uuid,p_lease_id uuid,p_provider text,p_models text[],
  p_approved_usd numeric,p_maximum_calls integer,p_approval_ref text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; budget public.full_takeoff_provider_budgets;
begin
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing'
    and cancel_requested_at is null and worker_lease_expires_at>now() for update;
  if not found then raise exception 'Full Takeoff budget lease is invalid'; end if;
  if not exists(select 1 from public.profiles where id=r.requested_by and is_platform_admin=true)
    or not exists(select 1 from public.workspace_members where workspace_id=r.workspace_id and user_id=r.requested_by and role in ('admin','estimator'))
    or not exists(select 1 from public.workspaces where id=r.workspace_id and ai_processing_consented_at is not null)
    then raise exception 'Full Takeoff budget access denied'; end if;
  if p_provider not in ('openai','claude','gemini','kimi','deepseek') or p_approved_usd is null or p_approved_usd<=0 or p_approved_usd>100000
    or p_maximum_calls is null or p_maximum_calls not between 1 and 100000 or p_approval_ref is null or length(btrim(p_approval_ref)) not between 3 and 200
    or p_models is null or cardinality(p_models) not between 1 and 9
    or exists(select 1 from unnest(p_models) m where m is null or length(m) not between 3 and 120)
    then raise exception 'Reviewed Full Takeoff budget is invalid'; end if;
  select * into budget from public.full_takeoff_provider_budgets where takeoff_run_id=r.id and provider=p_provider for update;
  if found then
    if budget.approved_models<>p_models or budget.approved_usd<>p_approved_usd or budget.maximum_calls<>p_maximum_calls or budget.approval_ref<>btrim(p_approval_ref)
      then raise exception 'Saved Full Takeoff spending authorization cannot be silently replaced'; end if;
    return true;
  end if;
  insert into public.full_takeoff_provider_budgets(takeoff_run_id,workspace_id,provider,approved_models,approved_usd,maximum_calls,approval_ref)
    values(r.id,r.workspace_id,p_provider,p_models,p_approved_usd,p_maximum_calls,btrim(p_approval_ref));
  return true;
end $$;

alter function public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text) rename to reserve_provider_spend_before_full_run_budget;
revoke all on function public.reserve_provider_spend_before_full_run_budget(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.reserve_provider_spend(p_event_id uuid,p_job_id uuid,p_workspace_id uuid,p_user_id uuid,p_provider text,p_model text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare budget public.full_takeoff_provider_budgets; used numeric; calls integer; company public.provider_spend_policy;
begin
  -- Idempotent legacy and saved reservations keep the original identity guards.
  if not exists(select 1 from public.takeoff_runs where id=p_job_id and workspace_id=p_workspace_id)
    or exists(select 1 from public.provider_spend_reservations where event_id=p_event_id)
    then return public.reserve_provider_spend_before_full_run_budget(p_event_id,p_job_id,p_workspace_id,p_user_id,p_provider,p_model); end if;
  select * into budget from public.full_takeoff_provider_budgets where takeoff_run_id=p_job_id and workspace_id=p_workspace_id and provider=p_provider for update;
  if not found or not p_model=any(budget.approved_models) then raise exception 'Full Takeoff provider run budget is not approved'; end if;
  select * into company from public.provider_spend_policy where singleton for update;
  if not found or not company.enabled then raise exception 'Company AI spend is disabled'; end if;
  select coalesce(sum(case when status='captured' and telemetry_known then estimated_cost_usd else reserved_usd end),0),count(*)::integer
    into used,calls from public.provider_spend_reservations where takeoff_run_id=p_job_id and workspace_id=p_workspace_id and provider=p_provider;
  if used+company.call_reservation_usd>budget.approved_usd or calls>=budget.maximum_calls then raise exception 'Full Takeoff provider run spend limit reached'; end if;
  return public.reserve_provider_spend_before_full_run_budget(p_event_id,p_job_id,p_workspace_id,p_user_id,p_provider,p_model);
end $$;
revoke all on function public.configure_full_takeoff_run_budget(uuid,uuid,text,text[],numeric,integer,text) from public,anon,authenticated;
revoke all on function public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.configure_full_takeoff_run_budget(uuid,uuid,text,text[],numeric,integer,text),
  public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text) to service_role;

create function public.full_takeoff_stage_schema_ready() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select to_regclass('public.takeoff_region_checkpoints') is not null
    and to_regclass('public.takeoff_measurement_reviews') is not null
    and to_regclass('public.full_takeoff_provider_budgets') is not null;
$$;
revoke all on function public.full_takeoff_stage_schema_ready() from public,anon,authenticated;
grant execute on function public.full_takeoff_stage_schema_ready() to service_role;
