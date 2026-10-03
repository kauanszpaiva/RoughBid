-- The bridge owns execution metadata only. Money stays in the existing ledger.
alter table public.takeoff_runs add column bridge_fence bigint not null default 0,
  add column bridge_lease_id uuid, add column bridge_worker_id uuid, add column bridge_worker_generation uuid;

create table public.provider_bridge_operations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.takeoff_runs(id) on delete restrict,
  page_number integer not null, pass_type text not null, region_key text,
  event_id uuid not null unique default gen_random_uuid(),
  state text not null default 'planned' check(state in ('planned','waiting_budget','reserved','dispatching','completed','dispatch_unknown','failed_final')),
  state_version bigint not null default 1,
  spec jsonb not null, operation_spec_sha256 text, dispatch_payload_sha256 text, source_hashes jsonb,
  dispatch_token uuid, result jsonb, result_sha256 text, result_usage jsonb,
  cost_state text not null default 'unreserved' check(cost_state in ('unreserved','reserved','captured','held_unknown')),
  captured_usd_micros bigint, not_before timestamptz, error_code text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(result is null or octet_length(result::text)<=500000),
  check(operation_spec_sha256 is null or operation_spec_sha256~'^[a-f0-9]{64}$'),
  check(dispatch_payload_sha256 is null or dispatch_payload_sha256~'^[a-f0-9]{64}$'),
  check(result_sha256 is null or result_sha256~'^[a-f0-9]{64}$'),
  unique nulls not distinct(run_id,page_number,pass_type,region_key)
);
create table private.provider_bridge_nonces (
  auth_context text not null, nonce_sha256 text not null, body_sha256 text not null,
  signed_at bigint not null, operation_id uuid not null references public.provider_bridge_operations(id),
  created_at timestamptz not null default now(), primary key(auth_context,nonce_sha256)
);
alter table public.provider_bridge_operations enable row level security;
alter table private.provider_bridge_nonces enable row level security;
revoke all on public.provider_bridge_operations,private.provider_bridge_nonces from public,anon,authenticated,service_role;

create function private.provider_bridge_view(o public.provider_bridge_operations) returns jsonb
language sql immutable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('id',o.id,'run_id',o.run_id,'event_id',o.event_id,'reservation_id',case when o.cost_state='unreserved' then null else o.event_id end,
    'state',o.state,'state_version',o.state_version::text,'spec',o.spec,'operation_spec_sha256',o.operation_spec_sha256,
    'dispatch_payload_sha256',o.dispatch_payload_sha256,'result_ref',case when o.state='completed' then o.id end,
    'result_sha256',o.result_sha256,'cost_state',o.cost_state,'captured_usd_micros',o.captured_usd_micros::text,'not_before',o.not_before,'error_code',o.error_code);
$$;

create function private.provider_bridge_run(p_command jsonb) returns public.takeoff_runs
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs;
begin
  if p_command->>'protocol' is distinct from 'takeoff-v2.2-durable'
    or coalesce(p_command->>'action','') not in ('submit_stage','get_operation','reconcile_operation')
    or coalesce(p_command->'worker'->>'fence','')!~'^[1-9][0-9]{0,18}$' then raise exception 'bridge_authority_denied'; end if;
  select * into r from public.takeoff_runs where id=(p_command->>'run_id')::uuid and mode='full'
    and orchestrator_version='takeoff-v2.2-durable' for update;
  if not found or r.status<>'processing' or r.cancel_requested_at is not null or r.worker_lease_expires_at<=now()
    or r.worker_lease_id is distinct from (p_command->'worker'->>'lease_id')::uuid
    or r.bridge_lease_id is distinct from r.worker_lease_id
    or r.bridge_worker_id is distinct from (p_command->'worker'->>'worker_id')::uuid
    or r.bridge_worker_generation is distinct from (p_command->'worker'->>'worker_generation')::uuid
    or r.bridge_fence is distinct from (p_command->'worker'->>'fence')::bigint
    or not private.full_takeoff_authorized(r.id,r.requested_by) or not private.paid_full_dispatch_current(r.id)
    then raise exception 'bridge_authority_denied'; end if;
  return r;
end $$;

create function public.prepare_provider_bridge_full_operation(p_run_id uuid,p_lease_id uuid,p_worker_id uuid,p_generation uuid,
  p_page_number integer,p_pass_type text,p_region_key text,p_profile jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; o public.provider_bridge_operations; sheet jsonb; stage jsonb; prior jsonb; grid integer; approval jsonb;
begin
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and mode='full'
    and orchestrator_version='takeoff-v2.2-durable' and status='processing' and worker_lease_expires_at>now() and cancel_requested_at is null for update;
  if not found or p_worker_id is null or p_generation is null
    or r.worker_id not in (p_worker_id::text,'roughbid-full-'||p_worker_id::text)
    or not private.full_takeoff_authorized(r.id,r.requested_by) or not private.paid_full_dispatch_current(r.id)
    then raise exception 'bridge_authority_denied'; end if;
  if coalesce(p_pass_type,'') not in ('classification','legends_schedules','discipline','reconciliation','conflict_detection','completeness','risk_review')
    or p_profile->>'version' is distinct from 'full-stage-bridge-v1' or p_profile->>'template_version' is distinct from 'full-evidence-v1'
    or jsonb_typeof(p_profile->'stages') is distinct from 'object' or octet_length(p_profile::text)>50000 then raise exception 'bridge_profile_invalid'; end if;
  stage:=p_profile->'stages'->p_pass_type;
  if stage is null or stage ? 'apiKey' or not exists(select 1 from public.full_takeoff_provider_budgets b
    where b.takeoff_run_id=r.id and b.workspace_id=r.workspace_id and b.provider=stage->>'provider' and (stage->>'model')=any(b.approved_models))
    then raise exception 'bridge_budget_not_approved'; end if;
  select s into sheet from jsonb_array_elements(r.manifest->'sheets') s where (s->>'physicalPageNumber')::integer=p_page_number;
  if sheet is null or not exists(select 1 from public.plan_sheets s where s.takeoff_run_id=r.id and s.physical_page_number=p_page_number
    and s.page_sha256=sheet->>'pageSha256') then raise exception 'bridge_source_invalid'; end if;
  grid:=(p_profile->'regionalReview'->>'grid')::integer;
  if coalesce((p_profile->'regionalReview'->>'enabled')::boolean,false) and p_pass_type in ('discipline','conflict_detection','completeness') then
    if grid not in (2,3) or p_region_key is null or not exists(select 1 from generate_series(1,grid) row_,generate_series(1,grid) col_
      where p_region_key='r'||row_||'c'||col_||'g'||grid) then raise exception 'bridge_region_invalid'; end if;
  elsif p_region_key is not null then raise exception 'bridge_region_invalid'; end if;
  if r.bridge_lease_id is distinct from p_lease_id then
    update public.takeoff_runs set bridge_fence=bridge_fence+1,bridge_lease_id=p_lease_id,bridge_worker_id=p_worker_id,bridge_worker_generation=p_generation
      where id=r.id returning * into r;
  elsif r.bridge_worker_id is distinct from p_worker_id or r.bridge_worker_generation is distinct from p_generation then raise exception 'bridge_fence_conflict'; end if;
  approval:=coalesce(r.manifest->'paidAuthorization',r.manifest->'spendApproval');
  if approval is null or approval='null'::jsonb then raise exception 'bridge_approval_missing'; end if;
  select * into o from public.provider_bridge_operations where run_id=r.id and page_number=p_page_number and pass_type=p_pass_type and region_key is not distinct from p_region_key for update;
  if found then
    if o.spec->'profile' is distinct from p_profile or o.spec->'approved_contract' is distinct from approval or o.spec->'sheet' is distinct from sheet
      or o.spec->>'file_sha256' is distinct from r.file_sha256 then raise exception 'bridge_spec_conflict'; end if;
  else
    select coalesce(jsonb_agg(p.id order by s.physical_page_number,p.pass_type,p.id),'[]'::jsonb) into prior
      from public.takeoff_passes p join public.plan_sheets s on s.id=p.plan_sheet_id where p.takeoff_run_id=r.id and p.status in ('succeeded','blocked')
      and (s.physical_page_number=p_page_number or p.pass_type in ('classification','legends_schedules'))
      and not(s.physical_page_number=p_page_number and p.pass_type=p_pass_type);
    insert into public.provider_bridge_operations(run_id,page_number,pass_type,region_key,spec) values(r.id,p_page_number,p_pass_type,p_region_key,
      jsonb_build_object('schema_version',1,'protocol','takeoff-v2.2-durable','run_id',r.id,'workspace_id',r.workspace_id,'project_id',r.project_id,
      'user_id',r.requested_by,'file_id',r.file_id,'file_sha256',r.file_sha256,'sheet',sheet,'pass_type',p_pass_type,'region_key',p_region_key,
      'stage_version',1,'authorized_attempt',1,'approved_contract',approval,'profile',p_profile,'previous_pass_ids',prior)) returning * into o;
  end if;
  return jsonb_build_object('operation',private.provider_bridge_view(o),'worker',jsonb_build_object('worker_id',p_worker_id,
    'worker_generation',p_generation,'lease_id',p_lease_id,'fence',r.bridge_fence::text));
end $$;

create function public.authorize_provider_bridge_command(p_command jsonb,p_auth_context text,p_nonce_sha256 text,p_body_sha256 text,p_signed_at bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; o public.provider_bridge_operations; n private.provider_bridge_nonces; replay_ boolean:=false; path_ text;
begin
  r:=private.provider_bridge_run(p_command);
  if coalesce(p_auth_context,'')!~'^[a-zA-Z0-9_:/.-]{1,200}$' or coalesce(p_nonce_sha256,'')!~'^[a-f0-9]{64}$'
    or coalesce(p_body_sha256,'')!~'^[a-f0-9]{64}$' or p_signed_at is null or abs(extract(epoch from clock_timestamp())-p_signed_at)>90
    then raise exception 'bridge_auth_expired'; end if;
  select * into o from public.provider_bridge_operations where id=(p_command->>'operation_id')::uuid and run_id=r.id for update;
  if not found then raise exception 'bridge_authority_denied'; end if;
  insert into private.provider_bridge_nonces(auth_context,nonce_sha256,body_sha256,signed_at,operation_id)
    values(p_auth_context,p_nonce_sha256,p_body_sha256,p_signed_at,o.id) on conflict do nothing;
  if not found then
    select * into n from private.provider_bridge_nonces where auth_context=p_auth_context and nonce_sha256=p_nonce_sha256;
    if n.body_sha256<>p_body_sha256 or n.signed_at<>p_signed_at or n.operation_id<>o.id then raise exception 'bridge_nonce_conflict'; end if;
    replay_:=true;
  end if;
  select storage_path into path_ from public.project_files where id=r.file_id and workspace_id=r.workspace_id and project_id=r.project_id
    and processing_status not in ('uploading','failed');
  if path_ is null then raise exception 'bridge_source_invalid'; end if;
  return jsonb_build_object('replay',replay_,'operation',private.provider_bridge_view(o),'run',jsonb_build_object('workspace_id',r.workspace_id,
    'project_id',r.project_id,'file_id',r.file_id,'requested_by',r.requested_by,'manifest',r.manifest,'storage_path',path_));
end $$;

create function public.reserve_provider_bridge_operation(p_command jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; o public.provider_bridge_operations; stage jsonb; error_ text;
begin
  perform 1 from public.provider_spend_policy where singleton for update;
  r:=private.provider_bridge_run(p_command);
  if p_command->>'action'<>'submit_stage' then raise exception 'bridge_read_only'; end if;
  select * into o from public.provider_bridge_operations where id=(p_command->>'operation_id')::uuid and run_id=r.id for update;
  if not found then raise exception 'bridge_authority_denied'; end if;
  if o.state not in ('planned','waiting_budget') then return private.provider_bridge_view(o); end if;
  stage:=o.spec->'profile'->'stages'->o.pass_type;
  insert into public.api_usage_events(id,workspace_id,project_id,user_id,provider,model,operation)
    values(o.event_id,r.workspace_id,r.project_id,r.requested_by,stage->>'provider',stage->>'model','rb1:'||r.id||':generate:pending') on conflict do nothing;
  begin
    perform public.reserve_provider_spend(o.event_id,r.id,r.workspace_id,r.requested_by,stage->>'provider',stage->>'model');
  exception when others then
    get stacked diagnostics error_=message_text;
    if error_ like 'Company AI spend limit reached%' then
      update public.api_usage_events set operation='rb1:'||r.id||':generate:blocked_spend_limit' where id=o.event_id;
      update public.provider_bridge_operations set state='waiting_budget',error_code='company_budget',state_version=state_version+1,updated_at=now() where id=o.id returning * into o;
      return private.provider_bridge_view(o);
    elsif error_='Full Takeoff provider run spend limit reached' then
      update public.api_usage_events set operation='rb1:'||r.id||':generate:blocked_spend_limit' where id=o.event_id;
      update public.provider_bridge_operations set state='failed_final',error_code='run_budget_exhausted',state_version=state_version+1,updated_at=now() where id=o.id returning * into o;
      return private.provider_bridge_view(o);
    else raise; end if;
  end;
  update public.api_usage_events set operation='rb1:'||r.id||':generate:pending' where id=o.event_id;
  update public.provider_bridge_operations set state='reserved',cost_state='reserved',error_code=null,not_before=null,state_version=state_version+1,updated_at=now() where id=o.id returning * into o;
  return private.provider_bridge_view(o);
end $$;

create function public.claim_provider_bridge_dispatch(p_command jsonb,p_expected_state_version bigint,p_operation_spec_sha256 text,
  p_dispatch_payload_sha256 text,p_source_hashes jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; o public.provider_bridge_operations;
begin
  perform 1 from public.provider_spend_policy where singleton for update;
  r:=private.provider_bridge_run(p_command);
  if p_expected_state_version is null or p_expected_state_version<1 or p_command->>'action'<>'submit_stage' or coalesce(p_operation_spec_sha256,'')!~'^[a-f0-9]{64}$'
    or coalesce(p_dispatch_payload_sha256,'')!~'^[a-f0-9]{64}$' or coalesce(p_source_hashes->>'page_bytes_sha256','')!~'^[a-f0-9]{64}$'
    or coalesce(p_source_hashes->>'input_bytes_sha256','')!~'^[a-f0-9]{64}$'
    or p_source_hashes->>'file_sha256' is distinct from r.file_sha256
    or p_command->>'expected_operation_spec_sha256' is distinct from p_operation_spec_sha256
    or p_command->>'expected_stage_version' is distinct from '1' then raise exception 'bridge_payload_invalid'; end if;
  select * into o from public.provider_bridge_operations where id=(p_command->>'operation_id')::uuid and run_id=r.id for update;
  if not found then raise exception 'bridge_authority_denied'; end if;
  if o.state<>'reserved' or o.state_version<>p_expected_state_version then return jsonb_build_object('won',false,'operation',private.provider_bridge_view(o)); end if;
  if not exists(select 1 from public.provider_spend_reservations s where s.event_id=o.event_id and s.takeoff_run_id=r.id and s.status='reserved')
    then raise exception 'bridge_reservation_missing'; end if;
  update public.provider_bridge_operations set state='dispatching',state_version=state_version+1,operation_spec_sha256=p_operation_spec_sha256,
    dispatch_payload_sha256=p_dispatch_payload_sha256,source_hashes=p_source_hashes,dispatch_token=gen_random_uuid(),updated_at=now() where id=o.id returning * into o;
  return jsonb_build_object('won',true,'operation',private.provider_bridge_view(o),'dispatch_token',o.dispatch_token);
end $$;

create function public.finalize_provider_bridge_operation(p_operation_id uuid,p_dispatch_token uuid,p_result jsonb,p_result_sha256 text,p_usage jsonb,p_outcome text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.provider_bridge_operations; amount numeric; prefix_ text;
begin
  perform 1 from public.provider_spend_policy where singleton for update;
  -- A replaced lease may still record the result of its one committed dispatch.
  -- It cannot retrieve/deliver it without fresh authority through the read RPC.
  perform 1 from public.takeoff_runs where id=(select run_id from public.provider_bridge_operations where id=p_operation_id) for update;
  select * into o from public.provider_bridge_operations where id=p_operation_id for update;
  if not found or p_dispatch_token is null or o.dispatch_token is distinct from p_dispatch_token then raise exception 'bridge_dispatch_token_invalid'; end if;
  if p_outcome is null or p_outcome not in ('result','unknown') or jsonb_typeof(p_usage) is distinct from 'object'
    or (p_outcome='result' and (jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>500000 or coalesce(p_result_sha256,'')!~'^[a-f0-9]{64}$'))
    or (p_outcome='unknown' and (p_result is not null or p_result_sha256 is not null)) then raise exception 'bridge_result_invalid'; end if;
  if o.state in ('completed','dispatch_unknown') then
    if o.state is distinct from (case when p_outcome='result' then 'completed' else 'dispatch_unknown' end)
      or o.result is distinct from p_result or o.result_sha256 is distinct from p_result_sha256 or o.result_usage is distinct from p_usage
      then raise exception 'bridge_result_conflict'; end if;
    return private.provider_bridge_view(o);
  end if;
  if o.state<>'dispatching' then raise exception 'bridge_dispatch_state_invalid'; end if;
  if (p_usage ? 'input_tokens' and coalesce(p_usage->>'input_tokens','')!~'^[0-9]{1,9}$')
    or (p_usage ? 'output_tokens' and coalesce(p_usage->>'output_tokens','')!~'^[0-9]{1,9}$')
    or length(coalesce(p_usage->>'provider_request_id',''))>250 then raise exception 'bridge_usage_invalid'; end if;
  amount:=(p_usage->>'estimated_cost_usd')::numeric;
  if amount is not null and (amount<0 or amount>100000 or amount::text in ('NaN','Infinity','-Infinity')) then raise exception 'bridge_usage_invalid'; end if;
  if p_outcome='unknown' then amount:=null; end if;
  perform public.capture_provider_spend(o.event_id,amount);
  prefix_:='rb1:'||o.run_id||':generate:';
  update public.api_usage_events set operation=prefix_||case when p_outcome='unknown' then 'failed_unknown' when amount is null then 'tokens_only' else 'measured' end,
    input_tokens=coalesce((p_usage->>'input_tokens')::integer,0),output_tokens=coalesce((p_usage->>'output_tokens')::integer,0),
    estimated_cost_usd=coalesce(amount,0),provider_request_id=p_usage->>'provider_request_id' where id=o.event_id;
  update public.provider_bridge_operations set state=case when p_outcome='result' then 'completed' else 'dispatch_unknown' end,
    state_version=state_version+1,result=p_result,result_sha256=p_result_sha256,result_usage=p_usage,
    cost_state=case when amount is null then 'held_unknown' else 'captured' end,captured_usd_micros=case when amount is null then null else ceil(amount*1000000)::bigint end,
    error_code=case when p_outcome='unknown' then 'dispatch_outcome_unknown' end,updated_at=now() where id=o.id returning * into o;
  return private.provider_bridge_view(o);
end $$;

create function public.read_provider_bridge_result(p_command jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; o public.provider_bridge_operations;
begin
  r:=private.provider_bridge_run(p_command);
  select * into o from public.provider_bridge_operations where id=(p_command->>'operation_id')::uuid and run_id=r.id;
  if not found or o.state<>'completed' or o.result is null then raise exception 'bridge_result_unavailable'; end if;
  return jsonb_build_object('result',o.result,'result_sha256',o.result_sha256);
end $$;

create function public.provider_bridge_schema_ready() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select to_regclass('public.provider_bridge_operations') is not null and to_regclass('private.provider_bridge_nonces') is not null;
$$;

-- Captured money funds attachment of an already completed immutable result,
-- never a second provider dispatch. Bind the precise stage and physical source.
create function private.provider_bridge_funded_stage(p_run uuid,p_event uuid,p_page integer,p_pass text,p_region text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.provider_bridge_operations o join public.provider_spend_reservations s on s.event_id=o.event_id
    join public.plan_sheets ps on ps.takeoff_run_id=o.run_id and ps.physical_page_number=o.page_number
    where o.run_id=p_run and o.event_id=p_event and o.page_number=p_page and o.pass_type=p_pass
    and (o.region_key is not distinct from p_region or (p_region='*' and p_pass in ('discipline','conflict_detection','completeness')))
    and o.state='completed' and o.result is not null and s.takeoff_run_id=p_run and s.status='captured'
    and o.spec->'sheet'->>'pageSha256'=ps.page_sha256);
$$;
create or replace function public.begin_funded_full_takeoff_v2_pass(p_run_id uuid,p_lease_id uuid,p_page_number integer,p_pass_type text,p_attempt integer,p_idempotency_key text,p_event_id uuid)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if exists(select 1 from public.provider_bridge_operations where event_id=p_event_id) then
    if not private.provider_bridge_funded_stage(p_run_id,p_event_id,p_page_number,p_pass_type,null)
      and not private.provider_bridge_funded_stage(p_run_id,p_event_id,p_page_number,p_pass_type,'*') then raise exception 'Full Takeoff bridge result is not funded'; end if;
  elsif not private.full_takeoff_event_funded(p_run_id,p_event_id) then raise exception 'Full Takeoff dispatch has no funded reservation'; end if;
  return public.begin_full_takeoff_v2_pass(p_run_id,p_lease_id,p_page_number,p_pass_type,p_attempt,p_idempotency_key);
end $$;
create or replace function public.begin_funded_full_takeoff_region(p_run_id uuid,p_lease_id uuid,p_page_number integer,p_page_sha256 text,
  p_pass_type text,p_region_key text,p_region jsonb,p_idempotency_key text,p_event_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if exists(select 1 from public.provider_bridge_operations where event_id=p_event_id) then
    if not private.provider_bridge_funded_stage(p_run_id,p_event_id,p_page_number,p_pass_type,p_region_key) then raise exception 'Regional bridge result is not funded'; end if;
  elsif not private.full_takeoff_event_funded(p_run_id,p_event_id) then raise exception 'Regional dispatch has no funded reservation'; end if;
  return public.begin_full_takeoff_region(p_run_id,p_lease_id,p_page_number,p_page_sha256,p_pass_type,p_region_key,p_region,p_idempotency_key);
end $$;

revoke all on function private.provider_bridge_view(public.provider_bridge_operations),private.provider_bridge_run(jsonb) from public,anon,authenticated,service_role;
revoke all on function private.provider_bridge_funded_stage(uuid,uuid,integer,text,text) from public,anon,authenticated,service_role;
revoke all on function public.prepare_provider_bridge_full_operation(uuid,uuid,uuid,uuid,integer,text,text,jsonb),
  public.authorize_provider_bridge_command(jsonb,text,text,text,bigint),public.reserve_provider_bridge_operation(jsonb),
  public.claim_provider_bridge_dispatch(jsonb,bigint,text,text,jsonb),public.finalize_provider_bridge_operation(uuid,uuid,jsonb,text,jsonb,text),
  public.read_provider_bridge_result(jsonb),public.provider_bridge_schema_ready() from public,anon,authenticated;
grant execute on function public.prepare_provider_bridge_full_operation(uuid,uuid,uuid,uuid,integer,text,text,jsonb),
  public.authorize_provider_bridge_command(jsonb,text,text,text,bigint),public.reserve_provider_bridge_operation(jsonb),
  public.claim_provider_bridge_dispatch(jsonb,bigint,text,text,jsonb),public.finalize_provider_bridge_operation(uuid,uuid,jsonb,text,jsonb,text),
  public.read_provider_bridge_result(jsonb),public.provider_bridge_schema_ready() to service_role;

-- Recovery attaches stored evidence; uncertain dispatch and failed parsing remain fenced.
create function private.provider_bridge_region_completed(p_run uuid,p_page integer,p_pass text,p_region text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.provider_bridge_operations o where o.run_id=p_run and o.page_number=p_page
   and o.pass_type=p_pass and o.region_key=p_region and o.state='completed' and o.result is not null);
$$;
create function private.provider_bridge_pass_recoverable(p_run uuid,p_page integer,p_pass text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.provider_bridge_operations o where o.run_id=p_run and o.page_number=p_page and o.pass_type=p_pass)
 and not exists(select 1 from public.provider_bridge_operations o where o.run_id=p_run and o.page_number=p_page and o.pass_type=p_pass
   and o.state not in ('planned','waiting_budget','reserved','completed'))
 and not exists(select 1 from public.takeoff_region_checkpoints c where c.takeoff_run_id=p_run and c.physical_page_number=p_page and c.pass_type=p_pass
   and c.status='processing' and not private.provider_bridge_region_completed(p_run,p_page,p_pass,c.region_key));
$$;
revoke all on function private.provider_bridge_region_completed(uuid,integer,text,text),private.provider_bridge_pass_recoverable(uuid,integer,text) from public,anon,authenticated,service_role;

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
  if exists(select 1 from public.api_usage_events e join public.provider_spend_reservations s on s.event_id=e.id
 where s.takeoff_run_id=r.id and e.operation in ('rb1:'||r.id::text||':generate:pending','rb1:'||r.id::text||':generate:failed_unknown')
 and not exists(select 1 from public.provider_bridge_operations o where o.event_id=e.id and o.run_id=r.id and o.state in ('reserved','completed')))
 or exists(select 1 from public.provider_bridge_operations where run_id=r.id and state in ('dispatching','dispatch_unknown'))
 or exists(select 1 from public.takeoff_region_checkpoints c where c.takeoff_run_id=r.id and c.status='processing'
   and not private.provider_bridge_region_completed(r.id,c.physical_page_number,c.pass_type,c.region_key))
 or exists(select 1 from public.takeoff_passes p join public.plan_sheets s on s.id=p.plan_sheet_id where p.takeoff_run_id=r.id
   and (p.status='failed' or (p.status='processing' and not private.provider_bridge_pass_recoverable(r.id,s.physical_page_number,p.pass_type)))) then
    update public.takeoff_runs set status='failed',processing_error='An uncertain pass requires reconciliation before another provider call.',worker_lease_id=null,worker_lease_expires_at=null,updated_at=now() where id=r.id;
    return jsonb_build_object('skip',true,'status','failed','reconciliation_required',true);
  end if;
  select * into f from public.project_files where id=r.file_id and workspace_id=r.workspace_id and project_id=r.project_id and processing_status not in ('uploading','failed');
  if not found then raise exception 'Full Takeoff file unavailable'; end if;
  update public.takeoff_passes p set status='queued' from public.plan_sheets s where p.plan_sheet_id=s.id and p.takeoff_run_id=r.id
    and p.status='processing' and private.provider_bridge_pass_recoverable(r.id,s.physical_page_number,p.pass_type);
  lease:=gen_random_uuid();
  update public.takeoff_runs set status='processing',not_before=null,waiting_reason=null,error_code=null,started_at=coalesce(started_at,now()),worker_id=p_worker_id,worker_lease_id=lease,
    worker_lease_expires_at=now()+interval '90 seconds',worker_heartbeat_at=now(),updated_at=now() where id=r.id;
  return jsonb_build_object('skip',false,'lease_id',lease,'workspace_id',r.workspace_id,'project_id',r.project_id,'file_id',r.file_id,
    'requested_by',r.requested_by,'manifest',r.manifest,'storage_path',f.storage_path);
end $$;

create or replace function public.restart_full_takeoff_v2(p_run_id uuid,p_user_id uuid,p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs;
begin
  if not private.full_takeoff_authorized(p_run_id,p_user_id) or not private.paid_full_dispatch_current(p_run_id) then raise exception 'Full Takeoff access denied'; end if;
  select * into r from public.takeoff_runs where id=p_run_id and workspace_id=p_workspace_id and requested_by=p_user_id and orchestrator_version='takeoff-v2.2-durable' for update;
  if not found or r.status not in ('failed','cancelled','queued') then raise exception 'Full Takeoff cannot restart'; end if;
  if exists(select 1 from public.api_usage_events e join public.provider_spend_reservations s on s.event_id=e.id
 where s.takeoff_run_id=r.id and e.operation in ('rb1:'||r.id::text||':generate:pending','rb1:'||r.id::text||':generate:failed_unknown')
 and not exists(select 1 from public.provider_bridge_operations o where o.event_id=e.id and o.run_id=r.id and o.state in ('reserved','completed')))
 or exists(select 1 from public.provider_bridge_operations where run_id=r.id and state in ('dispatching','dispatch_unknown'))
 or exists(select 1 from public.takeoff_region_checkpoints c where c.takeoff_run_id=r.id and c.status='processing'
   and not private.provider_bridge_region_completed(r.id,c.physical_page_number,c.pass_type,c.region_key))
 or exists(select 1 from public.takeoff_passes p join public.plan_sheets s on s.id=p.plan_sheet_id where p.takeoff_run_id=r.id
   and (p.status='failed' or (p.status='processing' and not private.provider_bridge_pass_recoverable(r.id,s.physical_page_number,p.pass_type)))) then raise exception 'Full Takeoff requires reconciliation'; end if;
  update public.takeoff_passes p set status='queued' from public.plan_sheets s where p.plan_sheet_id=s.id and p.takeoff_run_id=r.id
    and p.status='processing' and private.provider_bridge_pass_recoverable(r.id,s.physical_page_number,p.pass_type);
  update public.takeoff_runs set status='queued',cancel_requested_at=null,processing_error=null,worker_id=null,worker_lease_id=null,worker_lease_expires_at=null,updated_at=now() where id=r.id;
  return jsonb_build_object('id',r.id,'status','queued','completedCheckpointsPreserved',true);
end $$;

create or replace function public.inspect_full_takeoff_v2_pass(p_run_id uuid,p_lease_id uuid,p_page_number integer,p_pass_type text,p_attempt integer,p_idempotency_key text)
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
  elsif saved.status='queued' and (saved.budget_wait_event_id is not null or private.provider_bridge_pass_recoverable(r.id,p_page_number,p_pass_type)) then return 'run'; end if;
  raise exception 'Full Takeoff pass requires reconciliation';
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
    if saved.status='queued' and (saved.budget_wait_event_id is not null or private.provider_bridge_pass_recoverable(r.id,p_page_number,p_pass_type)) then
      update public.takeoff_passes set status='processing',budget_wait_event_id=null,started_at=now() where id=saved.id; return 'run';
    end if;
    raise exception 'Full Takeoff pass requires reconciliation';
  end if;
  insert into public.takeoff_passes(takeoff_run_id,workspace_id,project_id,plan_sheet_id,pass_type,attempt,status,idempotency_key,started_at)
    values(r.id,r.workspace_id,r.project_id,s.id,p_pass_type,p_attempt,'processing',p_idempotency_key,now());
  update public.takeoff_runs set progress=progress||jsonb_build_object('currentPage',p_page_number,'currentPass',p_pass_type),updated_at=now() where id=r.id;
  return 'run';
end $$;

create or replace function public.inspect_full_takeoff_region(p_run_id uuid,p_lease_id uuid,p_page_number integer,p_page_sha256 text,
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
  if saved.status='processing' and private.provider_bridge_region_completed(r.id,p_page_number,p_pass_type,p_region_key) then return jsonb_build_object('disposition','run'); end if;
  raise exception 'Regional checkpoint requires reconciliation';
end $$;

create or replace function public.begin_full_takeoff_region(p_run_id uuid,p_lease_id uuid,p_page_number integer,p_page_sha256 text,
  p_pass_type text,p_region_key text,p_region jsonb,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; s public.plan_sheets; saved public.takeoff_region_checkpoints; cols integer; rows integer;
begin
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing'
    and worker_lease_expires_at>now() and cancel_requested_at is null for update;
  if not found then raise exception 'Regional worker lease is invalid'; end if;
  if not private.full_takeoff_authorized(r.id,r.requested_by) then raise exception 'Paid Full authorization revoked'; end if;
  select * into s from public.plan_sheets where takeoff_run_id=r.id and physical_page_number=p_page_number
    and workspace_id=r.workspace_id and project_id=r.project_id and page_sha256=p_page_sha256;
  if not found then raise exception 'Regional sheet identity is invalid'; end if;
  perform 1 from public.takeoff_passes where takeoff_run_id=r.id and plan_sheet_id=s.id and pass_type=p_pass_type and attempt=1 and status='processing';
  if not found then raise exception 'Regional parent pass is not processing'; end if;
  if p_pass_type not in ('discipline','conflict_detection','completeness') or p_region_key!~'^r[1-3]c[1-3]g[23]$'
    or p_idempotency_key!~'^[a-f0-9]{64}$' or coalesce(jsonb_typeof(p_region),'null')<>'object'
    or not p_region ?& array['columns','rows','column','row','x','y','width','height']
    or exists(select 1 from jsonb_each(p_region) f where f.key in ('columns','rows','column','row','x','y','width','height')
      and jsonb_typeof(f.value)<>'number') then raise exception 'Regional identity is invalid'; end if;
  cols:=(p_region->>'columns')::integer; rows:=(p_region->>'rows')::integer;
  if cols not in (2,3) or rows<>cols or (p_region->>'column')::integer not between 1 and cols
    or (p_region->>'row')::integer not between 1 and rows
    or p_region_key<>('r'||(p_region->>'row')||'c'||(p_region->>'column')||'g'||cols)
    or (p_region->>'x')::numeric<0 or (p_region->>'y')::numeric<0
    or (p_region->>'width')::numeric<=0 or (p_region->>'height')::numeric<=0
    or (p_region->>'x')::numeric+(p_region->>'width')::numeric>s.width_points
    or (p_region->>'y')::numeric+(p_region->>'height')::numeric>s.height_points
    then raise exception 'Regional rectangle is invalid'; end if;
  select * into saved from public.takeoff_region_checkpoints where takeoff_run_id=r.id and physical_page_number=p_page_number
    and pass_type=p_pass_type and region_key=p_region_key;
  if found then
    if saved.idempotency_key<>p_idempotency_key or saved.region<>p_region or saved.page_sha256<>p_page_sha256 then raise exception 'Regional identity changed'; end if;
    if saved.status in ('succeeded','blocked') and saved.result is not null then return jsonb_build_object('disposition','saved','result',saved.result); end if;
    if saved.status='processing' and private.provider_bridge_region_completed(r.id,p_page_number,p_pass_type,p_region_key) then return jsonb_build_object('disposition','run'); end if;
  raise exception 'Uncertain regional dispatch requires reconciliation';
  end if;
  insert into public.takeoff_region_checkpoints(takeoff_run_id,workspace_id,project_id,plan_sheet_id,physical_page_number,page_sha256,
    pass_type,region_key,region,idempotency_key,status) values(r.id,r.workspace_id,r.project_id,s.id,p_page_number,p_page_sha256,p_pass_type,p_region_key,p_region,p_idempotency_key,'processing');
  update public.takeoff_runs set progress=progress||jsonb_build_object('currentRegion',p_region_key,'currentPage',p_page_number,
    'currentPass',p_pass_type,'regionsPerPass',cols*rows),updated_at=now() where id=r.id;
  return jsonb_build_object('disposition','run');
end $$;
