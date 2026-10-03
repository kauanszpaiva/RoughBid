-- Scheduled obligations are not simultaneous provider expenditure. The complete
-- immutable purchase and per-run budgets remain; every call still acquires the
-- company breaker under its original lock and records its full reservation.
alter table public.takeoff_runs drop constraint takeoff_runs_status_check;
alter table public.takeoff_runs add constraint takeoff_runs_status_check check
  (status in ('queued','processing','waiting_budget','needs_review','ready','failed','cancelled'));
alter table public.takeoff_runs add column not_before timestamptz,
  add column waiting_reason text check(waiting_reason is null or waiting_reason='company_budget'),
  add column budget_wait_started_at timestamptz,
  add column error_code text;
alter table public.takeoff_passes add column budget_wait_event_id uuid references public.api_usage_events(id);
create index takeoff_budget_wait_due on public.takeoff_runs(not_before,budget_wait_started_at)
  where status in ('waiting_budget','queued');

create or replace function public.paid_full_capacity_ready(p_reserve_usd numeric,p_call_reservation_usd numeric,p_quote_id uuid default null) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare policy public.provider_spend_policy;
begin
  select * into policy from public.provider_spend_policy where singleton for share;
  return coalesce(found and policy.enabled and p_reserve_usd>0 and p_reserve_usd<=100000
    and p_call_reservation_usd>0 and policy.call_reservation_usd=p_call_reservation_usd
    and policy.spend_cap_usd>=p_call_reservation_usd and p_reserve_usd>=p_call_reservation_usd,false);
end $$;

create function public.paid_full_capacity_policy() returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('enabled',p.enabled,'spend_cap_usd',p.spend_cap_usd,
    'rolling_window_seconds',extract(epoch from p.rolling_window),'call_reservation_usd',p.call_reservation_usd,
    'available_usd',greatest(0,p.spend_cap_usd
      -coalesce((select sum(case when s.status='captured' and s.telemetry_known then s.estimated_cost_usd else s.reserved_usd end)
        from public.provider_spend_reservations s where s.created_at>now()-p.rolling_window),0)
      -coalesce((select sum(g.reserved_usd) from public.geometry_provider_spend_reservations g where g.created_at>now()-p.rolling_window),0)))
    from public.provider_spend_policy p where p.singleton;
$$;

create or replace function private.check_paid_full_company_exposure() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare policy public.provider_spend_policy; used numeric; quote_ uuid; run_ uuid; next_run uuid;
begin
  select * into policy from public.provider_spend_policy where singleton for update;
  if not found or not policy.enabled then raise exception 'Company AI spend is disabled'; end if;
  select coalesce(sum(case when status='captured' and telemetry_known then estimated_cost_usd else reserved_usd end),0)
    into used from public.provider_spend_reservations where created_at>now()-policy.rolling_window;
  select used+coalesce(sum(reserved_usd),0) into used from public.geometry_provider_spend_reservations where created_at>now()-policy.rolling_window;
  if tg_table_name='provider_spend_reservations' then
    run_:=new.takeoff_run_id;
    if run_ is not null then
      select payment_quote_id into quote_ from public.takeoff_runs where id=run_ and payment_kind='paid';
      if quote_ is not null then
        if not private.full_takeoff_authorized(run_,new.user_id) or not private.paid_full_dispatch_current(run_) then raise exception 'Paid Full authorization revoked'; end if;
        if not exists(select 1 from public.project_reading_quotes q where q.id=quote_
          and (q.full_contract->'pricing'->>'operatingReserveUsd')::numeric/nullif((q.full_contract->>'maximumCalls')::integer,0)=new.reserved_usd)
          then raise exception 'Paid Full call reservation differs from the purchased contract'; end if;
      end if;
    end if;
  end if;
  -- One waiting run owns the next turn. This check and the actual reservation
  -- use the same policy row lock, including geometry and other providers.
  select id into next_run from public.takeoff_runs r where budget_wait_started_at is not null
    and ((status='waiting_budget' and not_before<=now()) or status='processing')
    and cancel_requested_at is null and private.full_takeoff_authorized(r.id,r.requested_by)
    and private.paid_full_dispatch_current(r.id)
    order by budget_wait_started_at,id limit 1;
  if next_run is not null and next_run is distinct from run_ then raise exception 'Company AI spend limit reached: waiting reading has the next turn'; end if;
  if used+new.reserved_usd>policy.spend_cap_usd then raise exception 'Company AI spend limit reached'; end if;
  if run_ is not null then update public.takeoff_runs set budget_wait_started_at=null where id=run_; end if;
  return new;
end $$;

create function public.inspect_full_takeoff_v2_pass(p_run_id uuid,p_lease_id uuid,p_page_number integer,p_pass_type text,p_attempt integer,p_idempotency_key text)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; saved public.takeoff_passes;
begin
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing'
    and cancel_requested_at is null and worker_lease_expires_at>now();
  if not found or not private.full_takeoff_authorized(r.id,r.requested_by) or not private.paid_full_dispatch_current(r.id) then raise exception 'Full Takeoff lease authorization invalid'; end if;
  if p_attempt<>1 or p_idempotency_key!~'^[a-f0-9]{64}$' then raise exception 'Full Takeoff pass identity invalid'; end if;
  select p.* into saved from public.takeoff_passes p join public.plan_sheets s on s.id=p.plan_sheet_id
    where p.takeoff_run_id=r.id and s.physical_page_number=p_page_number and p.pass_type=p_pass_type and p.attempt=p_attempt;
  if not found then return 'run'; end if;
  if saved.idempotency_key<>p_idempotency_key then raise exception 'Full Takeoff pass identity conflicts'; end if;
  if saved.status='succeeded' then return 'already_succeeded'; elsif saved.status='blocked' then return 'already_blocked';
  elsif saved.status='queued' and saved.budget_wait_event_id is not null then return 'run'; end if;
  raise exception 'Full Takeoff pass requires reconciliation';
end $$;

create function private.full_takeoff_event_funded(p_run_id uuid,p_event_id uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.provider_spend_reservations s join public.api_usage_events e on e.id=s.event_id
    where s.event_id=p_event_id and s.takeoff_run_id=p_run_id and s.status='reserved'
      and e.operation='rb1:'||p_run_id::text||':generate:pending');
$$;
create function public.begin_funded_full_takeoff_v2_pass(p_run_id uuid,p_lease_id uuid,p_page_number integer,p_pass_type text,p_attempt integer,p_idempotency_key text,p_event_id uuid)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not private.full_takeoff_event_funded(p_run_id,p_event_id) then raise exception 'Full Takeoff dispatch has no funded reservation'; end if;
  return public.begin_full_takeoff_v2_pass(p_run_id,p_lease_id,p_page_number,p_pass_type,p_attempt,p_idempotency_key);
end $$;

create function public.inspect_full_takeoff_region(p_run_id uuid,p_lease_id uuid,p_page_number integer,p_page_sha256 text,
  p_pass_type text,p_region_key text,p_region jsonb,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; saved public.takeoff_region_checkpoints;
begin
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing'
    and cancel_requested_at is null and worker_lease_expires_at>now();
  if not found or not private.full_takeoff_authorized(r.id,r.requested_by) or not private.paid_full_dispatch_current(r.id) then raise exception 'Full Takeoff lease authorization invalid'; end if;
  if not exists(select 1 from public.plan_sheets where takeoff_run_id=r.id and physical_page_number=p_page_number and page_sha256=p_page_sha256) then raise exception 'Regional source identity invalid'; end if;
  select * into saved from public.takeoff_region_checkpoints where takeoff_run_id=r.id and physical_page_number=p_page_number and pass_type=p_pass_type and region_key=p_region_key;
  if not found then return jsonb_build_object('disposition','run'); end if;
  if saved.idempotency_key is distinct from p_idempotency_key or saved.region is distinct from p_region then raise exception 'Regional identity conflicts'; end if;
  if saved.status in ('succeeded','blocked') and saved.result is not null then return jsonb_build_object('disposition','saved','result',saved.result); end if;
  raise exception 'Regional checkpoint requires reconciliation';
end $$;
create function public.begin_funded_full_takeoff_region(p_run_id uuid,p_lease_id uuid,p_page_number integer,p_page_sha256 text,
  p_pass_type text,p_region_key text,p_region jsonb,p_idempotency_key text,p_event_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not private.full_takeoff_event_funded(p_run_id,p_event_id) then raise exception 'Regional dispatch has no funded reservation'; end if;
  return public.begin_full_takeoff_region(p_run_id,p_lease_id,p_page_number,p_page_sha256,p_pass_type,p_region_key,p_region,p_idempotency_key);
end $$;

create function public.wait_full_takeoff_budget(p_run_id uuid,p_lease_id uuid,p_event_id uuid,p_page_number integer,p_pass_type text,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; policy public.provider_spend_policy; used numeric; retry_at timestamptz; entry record; current_pass uuid;
begin
  select * into policy from public.provider_spend_policy where singleton for update;
  if not found or not policy.enabled or policy.call_reservation_usd>policy.spend_cap_usd then raise exception 'Company processing capacity unavailable'; end if;
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing'
    and cancel_requested_at is null and worker_lease_expires_at>now() for update;
  if not found or not private.full_takeoff_authorized(r.id,r.requested_by) or not private.paid_full_dispatch_current(r.id) then raise exception 'Full Takeoff lease authorization invalid'; end if;
  if not exists(select 1 from public.api_usage_events where id=p_event_id and workspace_id=r.workspace_id and user_id=r.requested_by
      and operation='rb1:'||r.id::text||':generate:blocked_spend_limit')
    or exists(select 1 from public.provider_spend_reservations where event_id=p_event_id)
    then raise exception 'Budget wait requires proven pre-dispatch refusal'; end if;
  if exists(select 1 from public.api_usage_events e join public.provider_spend_reservations s on s.event_id=e.id where s.takeoff_run_id=r.id
    and e.operation in ('rb1:'||r.id::text||':generate:pending','rb1:'||r.id::text||':generate:failed_unknown'))
    or exists(select 1 from public.takeoff_region_checkpoints where takeoff_run_id=r.id and status='processing')
    then raise exception 'Uncertain provider dispatch cannot wait or retry'; end if;
  select p.id into current_pass from public.takeoff_passes p join public.plan_sheets s on s.id=p.plan_sheet_id
    where p.takeoff_run_id=r.id and s.physical_page_number=p_page_number and p.pass_type=p_pass_type and p.idempotency_key=p_idempotency_key;
  if exists(select 1 from public.takeoff_passes where takeoff_run_id=r.id and
    (status='failed' or status='processing' and (id is distinct from current_pass or p_pass_type not in ('discipline','conflict_detection','completeness'))))
    then raise exception 'Uncertain pass cannot wait or retry'; end if;
  -- A regional parent is an aggregate, never itself a dispatched call. Only
  -- proved-complete child regions survive; there is no processing child here.
  update public.takeoff_passes set status='queued',budget_wait_event_id=p_event_id where id=current_pass and status='processing';
  select coalesce(sum(amount),0) into used from (
    select case when status='captured' and telemetry_known then estimated_cost_usd else reserved_usd end amount from public.provider_spend_reservations where created_at>now()-policy.rolling_window
    union all select reserved_usd from public.geometry_provider_spend_reservations where created_at>now()-policy.rolling_window) x;
  retry_at:=now()+interval '15 seconds';
  if used+policy.call_reservation_usd>policy.spend_cap_usd then
    for entry in select * from (
      select created_at+policy.rolling_window expires_at,case when status='captured' and telemetry_known then estimated_cost_usd else reserved_usd end amount
        from public.provider_spend_reservations where created_at>now()-policy.rolling_window
      union all select created_at+policy.rolling_window,reserved_usd from public.geometry_provider_spend_reservations where created_at>now()-policy.rolling_window
    ) x order by expires_at loop
      used:=used-entry.amount; retry_at:=greatest(retry_at,entry.expires_at+interval '1 second');
      exit when used+policy.call_reservation_usd<=policy.spend_cap_usd;
    end loop;
  end if;
  update public.takeoff_runs set status='waiting_budget',not_before=retry_at,waiting_reason='company_budget',
    budget_wait_started_at=coalesce(budget_wait_started_at,now()),worker_lease_id=null,worker_lease_expires_at=null,
    error_code=null,processing_error=null,updated_at=now() where id=r.id;
  return jsonb_build_object('id',r.id,'status','waiting_budget','not_before',retry_at,'waiting_reason','company_budget');
end $$;

create function public.due_full_takeoff_budget_runs(p_version text) returns table(run_id uuid)
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_version<>'takeoff-v2.2-durable' then return; end if;
  update public.takeoff_runs r set status='failed',error_code='reading_authorization_ended',
    processing_error='This reading needs review before processing can continue.',waiting_reason=null,not_before=null,updated_at=now()
    where r.status='waiting_budget' and (not private.full_takeoff_authorized(r.id,r.requested_by) or not private.paid_full_dispatch_current(r.id));
  return query select r.id from public.takeoff_runs r where r.orchestrator_version=p_version and r.status='waiting_budget'
    and r.not_before<=now() and r.cancel_requested_at is null order by r.budget_wait_started_at,r.id limit 25;
end $$;

create function public.fail_full_takeoff_boundary(p_run_id uuid,p_lease_id uuid,p_error_code text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_error_code not in ('source_unavailable','source_changed','consent_changed','reading_configuration_unavailable','provider_result_uncertain','reading_authorization_ended','run_budget_exhausted') then raise exception 'Unsupported reading diagnostic'; end if;
  update public.takeoff_runs set status='failed',error_code=p_error_code,
    processing_error=case p_error_code when 'source_unavailable' then 'The uploaded file could not be opened. Please check the file.'
      when 'source_changed' then 'The file changed after this reading was authorized.' when 'consent_changed' then 'The reading approval needs to be confirmed again.'
      when 'reading_configuration_unavailable' then 'The reading setup needs attention before processing can continue.'
      when 'run_budget_exhausted' then 'This reading reached its approved total budget.'
      else 'Saved progress needs review before processing can continue.' end,
    worker_lease_id=null,worker_lease_expires_at=null,updated_at=now()
    where id=p_run_id and worker_lease_id=p_lease_id and status='processing';
  return found;
end $$;

revoke all on function public.paid_full_capacity_policy(),public.inspect_full_takeoff_v2_pass(uuid,uuid,integer,text,integer,text),
  public.begin_funded_full_takeoff_v2_pass(uuid,uuid,integer,text,integer,text,uuid),
  public.inspect_full_takeoff_region(uuid,uuid,integer,text,text,text,jsonb,text),public.begin_funded_full_takeoff_region(uuid,uuid,integer,text,text,text,jsonb,text,uuid),
  public.wait_full_takeoff_budget(uuid,uuid,uuid,integer,text,text),public.due_full_takeoff_budget_runs(text),public.fail_full_takeoff_boundary(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.paid_full_capacity_policy(),public.inspect_full_takeoff_v2_pass(uuid,uuid,integer,text,integer,text),
  public.begin_funded_full_takeoff_v2_pass(uuid,uuid,integer,text,integer,text,uuid),
  public.inspect_full_takeoff_region(uuid,uuid,integer,text,text,text,jsonb,text),public.begin_funded_full_takeoff_region(uuid,uuid,integer,text,text,text,jsonb,text,uuid),
  public.wait_full_takeoff_budget(uuid,uuid,uuid,integer,text,text),public.due_full_takeoff_budget_runs(text),public.fail_full_takeoff_boundary(uuid,uuid,text)
  to service_role;
revoke all on function private.full_takeoff_event_funded(uuid,uuid) from public,anon,authenticated;

-- Existing identity and lifecycle guards are retained below.
create or replace function public.claim_full_takeoff_v2(p_run_id uuid,p_worker_id text,p_version text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; f public.project_files; lease uuid;
begin
  if p_version<>'takeoff-v2.2-durable' or length(coalesce(p_worker_id,'')) not between 1 and 160 then raise exception 'Invalid Full Takeoff worker'; end if;
  select * into r from public.takeoff_runs where id=p_run_id and mode='full' and orchestrator_version=p_version for update;
  if not found then raise exception 'Full Takeoff run unavailable'; end if;
  if r.status='waiting_budget' and r.not_before>now() then return jsonb_build_object('skip',true,'status',r.status); end if;
  if r.status in ('needs_review','ready','failed','cancelled') then return jsonb_build_object('skip',true,'status',r.status); end if;
  if not private.full_takeoff_authorized(r.id,r.requested_by) or not private.paid_full_dispatch_current(r.id) then raise exception 'Full Takeoff authorization revoked'; end if;
  if r.status='processing' and r.worker_lease_expires_at>now() then raise exception 'Full Takeoff is already leased'; end if;
  if r.cancel_requested_at is not null then
    update public.takeoff_runs set status='cancelled',updated_at=now() where id=r.id;
    return jsonb_build_object('skip',true,'status','cancelled');
  end if;
  if exists(select 1 from public.api_usage_events e join public.provider_spend_reservations s on s.event_id=e.id where s.takeoff_run_id=r.id and e.operation in ('rb1:'||r.id::text||':generate:pending','rb1:'||r.id::text||':generate:failed_unknown')) or exists(select 1 from public.takeoff_region_checkpoints where takeoff_run_id=r.id and status='processing') or exists(select 1 from public.takeoff_passes where takeoff_run_id=r.id and status in ('processing','failed')) then
    update public.takeoff_runs set status='failed',processing_error='An uncertain pass requires reconciliation before another provider call.',worker_lease_id=null,worker_lease_expires_at=null,updated_at=now() where id=r.id;
    return jsonb_build_object('skip',true,'status','failed','reconciliation_required',true);
  end if;
  select * into f from public.project_files where id=r.file_id and workspace_id=r.workspace_id and project_id=r.project_id and processing_status not in ('uploading','failed');
  if not found then raise exception 'Full Takeoff file unavailable'; end if;
  lease:=gen_random_uuid();
  update public.takeoff_runs set status='processing',not_before=null,waiting_reason=null,error_code=null,started_at=coalesce(started_at,now()),worker_id=p_worker_id,worker_lease_id=lease,
    worker_lease_expires_at=now()+interval '90 seconds',worker_heartbeat_at=now(),updated_at=now() where id=r.id;
  return jsonb_build_object('skip',false,'lease_id',lease,'workspace_id',r.workspace_id,'project_id',r.project_id,'file_id',r.file_id,
    'requested_by',r.requested_by,'manifest',r.manifest,'storage_path',f.storage_path);
end $$;

create or replace function public.begin_full_takeoff_v2_pass(p_run_id uuid,p_lease_id uuid,p_page_number integer,p_pass_type text,p_attempt integer,p_idempotency_key text)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; s public.plan_sheets; saved public.takeoff_passes;
begin
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing' and cancel_requested_at is null and worker_lease_expires_at>now() for update;
  if not found then raise exception 'Full Takeoff lease invalid'; end if;
  if not private.full_takeoff_authorized(r.id,r.requested_by) then raise exception 'Full Takeoff authorization revoked'; end if;
  if p_attempt<>1 or p_idempotency_key!~'^[a-f0-9]{64}$' then raise exception 'Full Takeoff pass identity invalid'; end if;
  select * into s from public.plan_sheets where takeoff_run_id=r.id and workspace_id=r.workspace_id and project_id=r.project_id and physical_page_number=p_page_number;
  if not found then raise exception 'Full Takeoff physical sheet unavailable'; end if;
  select * into saved from public.takeoff_passes where takeoff_run_id=r.id and plan_sheet_id=s.id and pass_type=p_pass_type and attempt=p_attempt;
  if found then
    if saved.idempotency_key<>p_idempotency_key then raise exception 'Full Takeoff pass identity conflicts'; end if;
    if saved.status='succeeded' then return 'already_succeeded'; elsif saved.status='blocked' then return 'already_blocked'; end if;
    if saved.status='queued' and saved.budget_wait_event_id is not null then
      update public.takeoff_passes set status='processing',budget_wait_event_id=null,started_at=now() where id=saved.id; return 'run';
    end if;
    raise exception 'Full Takeoff pass requires reconciliation';
  end if;
  insert into public.takeoff_passes(takeoff_run_id,workspace_id,project_id,plan_sheet_id,pass_type,attempt,status,idempotency_key,started_at)
    values(r.id,r.workspace_id,r.project_id,s.id,p_pass_type,p_attempt,'processing',p_idempotency_key,now());
  update public.takeoff_runs set progress=progress||jsonb_build_object('currentPage',p_page_number,'currentPass',p_pass_type),updated_at=now() where id=r.id;
  return 'run';
end $$;

create or replace function public.cancel_full_takeoff_v2(p_run_id uuid,p_user_id uuid,p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs;
begin
  if not private.full_takeoff_authorized(p_run_id,p_user_id) then raise exception 'Full Takeoff access denied'; end if;
  select * into r from public.takeoff_runs where id=p_run_id and workspace_id=p_workspace_id and orchestrator_version='takeoff-v2.2-durable' for update;
  if not found then raise exception 'Full Takeoff run unavailable'; end if;
  if r.status in ('queued','processing','waiting_budget') then
    update public.takeoff_runs set not_before=null,waiting_reason=null,budget_wait_started_at=null,cancel_requested_at=now(),status='cancelled',worker_lease_id=null,worker_lease_expires_at=null,updated_at=now() where id=r.id;
    r.status:='cancelled';
  end if;
  return jsonb_build_object('id',r.id,'status',r.status);
end $$;

create or replace function public.restart_full_takeoff_v2(p_run_id uuid,p_user_id uuid,p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs;
begin
  if not private.full_takeoff_authorized(p_run_id,p_user_id) or not private.paid_full_dispatch_current(p_run_id) then raise exception 'Full Takeoff access denied'; end if;
  select * into r from public.takeoff_runs where id=p_run_id and workspace_id=p_workspace_id and requested_by=p_user_id and orchestrator_version='takeoff-v2.2-durable' for update;
  if not found or r.status not in ('failed','cancelled','queued') then raise exception 'Full Takeoff cannot restart'; end if;
  if exists(select 1 from public.api_usage_events e join public.provider_spend_reservations s on s.event_id=e.id where s.takeoff_run_id=r.id and e.operation in ('rb1:'||r.id::text||':generate:pending','rb1:'||r.id::text||':generate:failed_unknown')) or exists(select 1 from public.takeoff_region_checkpoints where takeoff_run_id=r.id and status='processing') or exists(select 1 from public.takeoff_passes where takeoff_run_id=r.id and status in ('processing','failed')) then raise exception 'Full Takeoff requires reconciliation'; end if;
  update public.takeoff_runs set status='queued',cancel_requested_at=null,processing_error=null,worker_id=null,worker_lease_id=null,worker_lease_expires_at=null,updated_at=now() where id=r.id;
  return jsonb_build_object('id',r.id,'status','queued','completedCheckpointsPreserved',true);
end $$;

create or replace function public.accept_paid_full_quote(p_quote_id uuid,p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_contract_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.project_reading_quotes; policy public.provider_spend_policy; slots numeric; windows_ numeric;
begin
  select * into policy from public.provider_spend_policy where singleton for update;
  perform 1 from public.profiles where id=p_user_id for update;
  if not found or not public.paid_full_daily_capacity_ready(p_user_id,p_quote_id) then raise exception 'Daily Full Takeoff limit reached before checkout'; end if;
  select * into q from public.project_reading_quotes where id=p_quote_id and user_id=p_user_id and workspace_id=p_workspace_id
    and project_id=p_project_id and mode='full_v2' and livemode for update;
  if not found or q.status<>'quoted' or q.expires_at<=now() or q.full_contract_hash is distinct from p_contract_hash
    or not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator'))
    or not exists(select 1 from public.workspaces where id=p_workspace_id and ai_processing_consented_at is not null)
    then raise exception 'Current paid Full consent is required'; end if;
  if not public.paid_full_capacity_ready((q.full_contract->'pricing'->>'operatingReserveUsd')::numeric,
    (q.full_contract->'pricing'->>'operatingReserveUsd')::numeric/nullif((q.full_contract->>'maximumCalls')::integer,0),q.id) then raise exception 'Company capacity cannot cover this Full reading'; end if;
  slots:=floor(policy.spend_cap_usd/policy.call_reservation_usd);
  windows_:=ceil((q.full_contract->>'maximumCalls')::numeric/nullif(slots,0));
  if q.full_contract->>'executionPolicy' is distinct from 'one-durable-run-budget-wait-no-uncertain-replay'
    or windows_ is null or now()+(greatest(0,windows_-1)+case when (public.paid_full_capacity_policy()->>'available_usd')::numeric<policy.call_reservation_usd then 1 else 0 end)*policy.rolling_window >= (q.full_contract->'pricing'->>'expiresAt')::timestamptz
    then raise exception 'Paid Full schedule exceeds the reviewed price validity'; end if;
  insert into public.paid_full_payment_holds(quote_id,reserved_usd) values(q.id,(q.full_contract->'pricing'->>'operatingReserveUsd')::numeric)
    on conflict(quote_id) do nothing;
  if exists(select 1 from public.paid_full_payment_holds where quote_id=q.id and released_at is not null) then raise exception 'Paid Full payment hold was released'; end if;
  if q.full_consent is null then
    update public.project_reading_quotes set full_consent=jsonb_build_object('confirmed',true,'approvedBy',p_user_id,'approvedAt',now(),'contractHash',p_contract_hash)
      where id=q.id returning * into q;
  end if;
  return to_jsonb(q);
end $$;

create or replace function public.create_paid_full_quote(p_input jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.project_reading_quotes; q public.project_reading_quotes;
begin
  v:=jsonb_populate_record(null::public.project_reading_quotes,p_input);
  perform 1 from public.provider_spend_policy where singleton for share;
  if not public.paid_full_daily_capacity_ready(v.user_id) then raise exception 'Daily Full Takeoff limit reached before checkout'; end if;
  perform 1 from public.workspaces where id=v.workspace_id and ai_processing_consented_at is not null for update;
  if not found or not exists(select 1 from public.workspace_members where workspace_id=v.workspace_id and user_id=v.user_id and role in ('admin','estimator'))
    or not exists(select 1 from public.project_files where id=v.file_id and workspace_id=v.workspace_id and project_id=v.project_id and processing_status not in ('uploading','failed'))
    then raise exception 'Paid Full access denied'; end if;
  if v.mode is distinct from 'full_v2' or v.livemode is distinct from true or v.full_contract->>'version' is distinct from 'paid-full-v1'
    or v.full_contract->>'executionPolicy' is distinct from 'one-durable-run-budget-wait-no-uncertain-replay'
    or v.full_contract->'manifest'->>'fileSha256' is distinct from v.file_sha256
    or (v.full_contract->'manifest'->>'physicalPageCount')::integer is distinct from v.page_count
    or (v.full_contract->'pricing'->>'amountCents')::integer is distinct from v.amount_cents
    or (v.full_contract->'pricing'->>'costCents')::integer is distinct from v.cost_cents
    or v.full_contract->'pricing'->>'currency' is distinct from 'usd'
    or coalesce(v.full_contract_hash,'')!~'^[a-f0-9]{64}$'
    or jsonb_typeof(v.full_contract->'providers') is distinct from 'array'
    or jsonb_array_length(v.full_contract->'providers')<>1 then raise exception 'Invalid paid Full contract'; end if;
  if not public.paid_full_capacity_ready((v.full_contract->'pricing'->>'operatingReserveUsd')::numeric,
    (v.full_contract->'pricing'->>'operatingReserveUsd')::numeric/nullif((v.full_contract->>'maximumCalls')::integer,0)) then raise exception 'Company capacity cannot cover this Full reading'; end if;
  select * into q from public.project_reading_quotes where mode='full_v2' and workspace_id=v.workspace_id and project_id=v.project_id
    and file_id=v.file_id and user_id=v.user_id and full_contract_hash=v.full_contract_hash and full_contract=v.full_contract and status<>'revoked'
    and (paid_at is not null or expires_at>now()+interval '31 minutes' or (expires_at>now() and stripe_session_id is not null))
    order by created_at desc limit 1;
  if found then return to_jsonb(q); end if;
  insert into public.project_reading_quotes(workspace_id,project_id,file_id,user_id,file_sha256,page_count,trades,scope,amount_cents,cost_cents,
    pricing_version,membership,livemode,mode,full_contract,full_contract_hash)
    values(v.workspace_id,v.project_id,v.file_id,v.user_id,v.file_sha256,v.page_count,v.trades,v.scope,v.amount_cents,v.cost_cents,
      v.pricing_version,v.membership,true,'full_v2',v.full_contract,v.full_contract_hash) returning * into q;
  return to_jsonb(q);
end $$;

create or replace function public.finish_full_takeoff_v2(p_run_id uuid,p_lease_id uuid,p_summary jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; state text; completed integer; blocked integer; expected integer; missing_regions boolean:=false;
begin
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing' and cancel_requested_at is null and worker_lease_expires_at>now() for update;
  if not found then raise exception 'Full Takeoff lease invalid'; end if;
  if not private.full_takeoff_authorized(r.id,r.requested_by) then raise exception 'Full Takeoff authorization revoked'; end if;
  select count(*) filter(where status in ('succeeded','blocked')),count(*) filter(where status in ('blocked','failed','processing')) into completed,blocked from public.takeoff_passes where takeoff_run_id=r.id;
  expected:=(r.manifest->>'physicalPageCount')::integer*10;
  if exists(select 1 from public.api_usage_events e join public.provider_spend_reservations s on s.event_id=e.id where s.takeoff_run_id=r.id
    and e.operation in ('rb1:'||r.id::text||':generate:pending','rb1:'||r.id::text||':generate:failed_unknown')) then raise exception 'Uncertain dispatch cannot complete a reading'; end if;
  if r.payment_kind='paid' then
    select exists(select 1 from public.plan_sheets s cross join (values ('discipline'),('conflict_detection'),('completeness')) stage(name)
      where s.takeoff_run_id=r.id and (select count(*) from public.takeoff_region_checkpoints c where c.takeoff_run_id=r.id
        and c.plan_sheet_id=s.id and c.pass_type=stage.name and c.status in ('succeeded','blocked'))
        <>power((r.manifest->'paidAuthorization'->'contract'->>'regionGrid')::integer,2)) into missing_regions;
  end if;
  state:=case when completed<>expected or missing_regions then 'failed' else 'needs_review' end;
  update public.takeoff_runs set status=state,error_code=case when state='failed' then 'reading_incomplete' else null end,processing_error=case when state='failed' then 'Some parts of this reading need attention before it can be completed.' else null end,completed_at=now(),worker_lease_id=null,worker_lease_expires_at=null,updated_at=now(),
    progress=progress||jsonb_build_object('completed',completed,'total',expected),
    output_summary=jsonb_build_object('takeoff_v2',jsonb_build_object('mode','full_v2','releaseStatus',case when completed=expected and blocked=0 and not missing_regions then 'review_ready' else 'blocked' end,
      'budgetStatus','awaiting_measurement_and_price_evidence','humanReviewRequired',true,'summary',p_summary)) where id=r.id;
  if r.payment_kind='paid' then
    update public.project_reading_quotes set status=case when state='needs_review' then 'complete' else 'failed' end where id=r.payment_quote_id and status<>'revoked';
    if state='needs_review' then update public.paid_full_payment_holds set released_at=now(),release_reason='completed' where quote_id=r.payment_quote_id and released_at is null; end if;
  end if;
  return jsonb_build_object('id',r.id,'status',state,'releaseStatus',case when completed=expected and blocked=0 and not missing_regions then 'review_ready' else 'blocked' end,'humanReviewRequired',true);
end $$;
