-- Photo transport metadata only. All funds stay in provider_spend_reservations.
alter table public.photo_takeoff_runs add column photo_bridge_fence bigint not null default 0,add column photo_bridge_lease_id uuid,
 add column photo_bridge_worker_id uuid,add column photo_bridge_worker_generation uuid;
create table public.photo_bridge_operations(
 id uuid primary key default gen_random_uuid(),run_id uuid not null references public.photo_takeoff_runs(id),operation_key text not null,
 event_id uuid not null unique default gen_random_uuid(),state text not null default 'planned'check(state in('planned','waiting_budget','reserved','dispatching','completed','dispatch_unknown','failed_final')),
 state_version bigint not null default 1,spec jsonb not null,operation_spec_sha256 text,dispatch_payload_sha256 text,source_hashes jsonb,
 dispatch_token uuid,result jsonb,result_sha256 text,result_usage jsonb,cost_state text not null default 'unreserved'check(cost_state in('unreserved','reserved','captured','held_unknown')),
 captured_usd_micros bigint,not_before timestamptz,error_code text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(result is null or octet_length(result::text)<=500000),check(operation_spec_sha256 is null or operation_spec_sha256~'^[a-f0-9]{64}$'),
 check(dispatch_payload_sha256 is null or dispatch_payload_sha256~'^[a-f0-9]{64}$'),check(result_sha256 is null or result_sha256~'^[a-f0-9]{64}$'),unique(run_id,operation_key),
 foreign key(run_id,operation_key)references public.photo_stage_checkpoints(run_id,operation_key));
create table private.photo_bridge_nonces(auth_context text not null,nonce_sha256 text not null,body_sha256 text not null,signed_at bigint not null,
 operation_id uuid not null references public.photo_bridge_operations(id),created_at timestamptz not null default now(),primary key(auth_context,nonce_sha256));
alter table public.photo_bridge_operations enable row level security;alter table private.photo_bridge_nonces enable row level security;
revoke all on public.photo_bridge_operations,private.photo_bridge_nonces from public,anon,authenticated,service_role;
create function private.photo_bridge_view(o public.photo_bridge_operations)returns jsonb language sql immutable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('id',o.id,'run_id',o.run_id,'event_id',o.event_id,'reservation_id',case when o.cost_state='unreserved'then null else o.event_id end,
 'state',o.state,'state_version',o.state_version::text,'spec',o.spec,'operation_spec_sha256',o.operation_spec_sha256,'dispatch_payload_sha256',o.dispatch_payload_sha256,
 'result_ref',case when o.state='completed'then o.id end,'result_sha256',o.result_sha256,'cost_state',o.cost_state,'captured_usd_micros',o.captured_usd_micros::text,'not_before',o.not_before,'error_code',o.error_code);
$$;
create function private.photo_bridge_run(p_command jsonb)returns public.photo_takeoff_runs language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;begin
 if p_command->>'protocol'is distinct from 'photo-complete-v1'or coalesce(p_command->>'action','')not in('submit_stage','get_operation','reconcile_operation')
 or coalesce(p_command->'worker'->>'fence','')!~'^[1-9][0-9]{0,18}$'then raise exception 'bridge_authority_denied';end if;
 select * into r from public.photo_takeoff_runs where id=(p_command->>'run_id')::uuid for update;
 if not found or r.manifest->>'completeVersion'is distinct from 'photo-complete-v1'or r.status<>'processing'or r.cancel_requested_at is not null or r.lease_expires_at<=now()
 or r.lease_id is distinct from(p_command->'worker'->>'lease_id')::uuid or r.photo_bridge_lease_id is distinct from r.lease_id
 or r.photo_bridge_worker_id is distinct from(p_command->'worker'->>'worker_id')::uuid or r.photo_bridge_worker_generation is distinct from(p_command->'worker'->>'worker_generation')::uuid
 or r.photo_bridge_fence is distinct from(p_command->'worker'->>'fence')::bigint or not private.complete_photo_authorized(r.id)
 or(r.manifest->>'expiresAt')::timestamptz<=now()then raise exception 'bridge_authority_denied';end if;return r;end $$;
create function public.prepare_photo_bridge_operation(p_run_id uuid,p_lease_id uuid,p_worker_id uuid,p_generation uuid,p_operation_key text,p_profile jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;o public.photo_bridge_operations;op jsonb;assets_ jsonb;prior_ jsonb;approval_ jsonb;stage_ public.photo_stage_checkpoints;begin
 select * into r from public.photo_takeoff_runs where id=p_run_id and lease_id=p_lease_id and status='processing'and lease_expires_at>now()and cancel_requested_at is null for update;
 if not found or p_worker_id is null or p_generation is null or r.worker_id<>p_worker_id::text or not private.complete_photo_authorized(r.id)
 or(r.manifest->>'expiresAt')::timestamptz<=now()then raise exception 'bridge_authority_denied';end if;
 if p_profile is distinct from r.manifest->'profile'or p_profile->>'version'is distinct from 'photo-complete-v1'or p_profile::text like '%"apiKey"%'or octet_length(p_profile::text)>50000 then raise exception 'bridge_profile_invalid';end if;
 select value into op from jsonb_array_elements(r.manifest->'operations')where value->>'key'=p_operation_key;
 select * into stage_ from public.photo_stage_checkpoints where run_id=r.id and operation_key=p_operation_key;
 if op is null or stage_.run_id is null or stage_.stage is distinct from op->>'stage' or stage_.asset_ids is distinct from array(select value::uuid from jsonb_array_elements_text(op->'assetIds'))then raise exception 'bridge_source_invalid';end if;
 if op->>'stage'<>'observation'and exists(select 1 from public.photo_stage_checkpoints where run_id=r.id and stage='observation'and status<>'completed')
 or op->>'stage'='risk_review'and exists(select 1 from public.photo_stage_checkpoints where run_id=r.id and stage='reconciliation'and status<>'completed')then raise exception 'bridge_stage_prerequisites_pending';end if;
 select jsonb_agg(a order by a->>'id')into assets_ from jsonb_array_elements(r.manifest->'assets')a where (a->>'id')::uuid=any(stage_.asset_ids);
 if jsonb_array_length(assets_)<>cardinality(stage_.asset_ids)or exists(select 1 from jsonb_array_elements(assets_)a where not exists(select 1 from public.photo_assets p
 where p.id=(a->>'id')::uuid and p.workspace_id=r.workspace_id and p.project_id=r.project_id and p.status='ready'and p.sha256=a->>'sha256'))then raise exception 'bridge_source_invalid';end if;
 if r.photo_bridge_lease_id is distinct from p_lease_id then update public.photo_takeoff_runs set photo_bridge_fence=photo_bridge_fence+1,photo_bridge_lease_id=p_lease_id,
 photo_bridge_worker_id=p_worker_id,photo_bridge_worker_generation=p_generation where id=r.id returning * into r;
 elsif r.photo_bridge_worker_id is distinct from p_worker_id or r.photo_bridge_worker_generation is distinct from p_generation then raise exception 'bridge_fence_conflict';end if;
 approval_:=case when r.photo_quote_id is null then r.manifest->'includedAuthorization'else jsonb_build_object('quoteId',r.photo_quote_id,'paymentRevision',r.payment_revision,'contractHash',r.manifest->>'purchaseContractHash')end;
 select * into o from public.photo_bridge_operations where run_id=r.id and operation_key=p_operation_key for update;
 if found then
 if o.spec->'profile'is distinct from p_profile or o.spec->'approved_contract'is distinct from approval_ or o.spec->'operation'is distinct from op or o.spec->'assets'is distinct from assets_ then raise exception 'bridge_spec_conflict';end if;
 else
 select coalesce(jsonb_agg(s.operation_key order by s.operation_key),'[]'::jsonb)into prior_ from public.photo_stage_checkpoints s where s.run_id=r.id and s.status='completed'
 and (op->>'stage'<>'observation'and s.stage='observation'and s.asset_ids&&stage_.asset_ids or op->>'stage'='risk_review'and s.stage='reconciliation'and s.asset_ids&&stage_.asset_ids);
 insert into public.photo_bridge_operations(run_id,operation_key,spec)values(r.id,p_operation_key,jsonb_build_object('schema_version',1,'protocol','photo-complete-v1',
 'run_id',r.id,'workspace_id',r.workspace_id,'project_id',r.project_id,'user_id',r.requested_by,'operation_key',p_operation_key,'operation',op,'assets',assets_,'profile',p_profile,
 'approved_contract',approval_,'references',coalesce(r.manifest->'references','[]'::jsonb),'previous_stage_keys',prior_,'stage_version',1,'authorized_attempt',1))returning * into o;end if;
 return jsonb_build_object('operation',private.photo_bridge_view(o),'worker',jsonb_build_object('worker_id',p_worker_id,'worker_generation',p_generation,'lease_id',p_lease_id,'fence',r.photo_bridge_fence::text));end $$;
create function public.authorize_photo_bridge_command(p_command jsonb,p_auth_context text,p_nonce_sha256 text,p_body_sha256 text,p_signed_at bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;o public.photo_bridge_operations;n private.photo_bridge_nonces;replay_ boolean:=false;begin
 r:=private.photo_bridge_run(p_command);
 if coalesce(p_auth_context,'')!~'^[a-zA-Z0-9_:/.-]{1,200}$'or coalesce(p_nonce_sha256,'')!~'^[a-f0-9]{64}$'or coalesce(p_body_sha256,'')!~'^[a-f0-9]{64}$'
 or p_signed_at is null or abs(extract(epoch from clock_timestamp())-p_signed_at)>90 then raise exception 'bridge_auth_expired';end if;
 select * into o from public.photo_bridge_operations where id=(p_command->>'operation_id')::uuid and run_id=r.id for update;if not found then raise exception 'bridge_authority_denied';end if;
 insert into private.photo_bridge_nonces(auth_context,nonce_sha256,body_sha256,signed_at,operation_id)values(p_auth_context,p_nonce_sha256,p_body_sha256,p_signed_at,o.id)on conflict do nothing;
 if not found then select * into n from private.photo_bridge_nonces where auth_context=p_auth_context and nonce_sha256=p_nonce_sha256;
 if n.body_sha256<>p_body_sha256 or n.signed_at<>p_signed_at or n.operation_id<>o.id then raise exception 'bridge_nonce_conflict';end if;replay_:=true;end if;
 return jsonb_build_object('replay',replay_,'operation',private.photo_bridge_view(o),'run',jsonb_build_object('workspace_id',r.workspace_id,'project_id',r.project_id,'requested_by',r.requested_by,'manifest',r.manifest,'photo_quote_id',r.photo_quote_id,'payment_revision',r.payment_revision));end $$;
create function public.reserve_photo_bridge_operation(p_command jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;o public.photo_bridge_operations;route jsonb;error_ text;begin
 perform 1 from public.provider_spend_policy where singleton for update;r:=private.photo_bridge_run(p_command);
 if p_command->>'action'<>'submit_stage'then raise exception 'bridge_read_only';end if;
 select * into o from public.photo_bridge_operations where id=(p_command->>'operation_id')::uuid and run_id=r.id for update;if not found then raise exception 'bridge_authority_denied';end if;
 if o.state not in('planned','waiting_budget')then return private.photo_bridge_view(o);end if;
 route:=o.spec->'profile'->'routes'->(o.spec->'operation'->>'stage');
 insert into public.api_usage_events(id,workspace_id,project_id,user_id,provider,model,operation)
 values(o.event_id,r.workspace_id,r.project_id,r.requested_by,route->>'provider',route->>'model','rb1:'||r.id||':generate:pending')on conflict do nothing;
 update public.api_usage_events set operation='rb1:'||r.id||':generate:pending'where id=o.event_id;
 begin
 perform public.reserve_complete_photo_spend(o.event_id,r.id,r.lease_id,o.operation_key,r.workspace_id,r.requested_by,route->>'provider',route->>'model',(route->>'maximumCallCostUsd')::numeric);
 exception when others then get stacked diagnostics error_=message_text;
 if error_ like 'Company AI spend limit reached%'then
 update public.api_usage_events set operation='rb1:'||r.id||':generate:blocked_spend_limit'where id=o.event_id;
 update public.photo_bridge_operations set state='waiting_budget',error_code='company_budget',not_before=private.company_next_capacity_at((o.spec->'operation'->>'reservationUsd')::numeric),state_version=state_version+1,updated_at=now()where id=o.id returning * into o;return private.photo_bridge_view(o);
 elsif error_='Provider run spend limit reached'then
 update public.api_usage_events set operation='rb1:'||r.id||':generate:blocked_spend_limit'where id=o.event_id;
 update public.photo_bridge_operations set state='failed_final',error_code='run_budget_exhausted',state_version=state_version+1,updated_at=now()where id=o.id returning * into o;return private.photo_bridge_view(o);
 else raise;end if;end;
 update public.photo_bridge_operations set state='reserved',cost_state='reserved',error_code=null,not_before=null,state_version=state_version+1,updated_at=now()where id=o.id returning * into o;return private.photo_bridge_view(o);end $$;
create function public.claim_photo_bridge_dispatch(p_command jsonb,p_expected_state_version bigint,p_operation_spec_sha256 text,p_dispatch_payload_sha256 text,p_source_hashes jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;o public.photo_bridge_operations;hashes_ jsonb;begin
 perform 1 from public.provider_spend_policy where singleton for update;r:=private.photo_bridge_run(p_command);
 if p_expected_state_version is null or p_expected_state_version<1 or p_command->>'action'<>'submit_stage'or coalesce(p_operation_spec_sha256,'')!~'^[a-f0-9]{64}$'
 or coalesce(p_dispatch_payload_sha256,'')!~'^[a-f0-9]{64}$'or p_command->>'expected_operation_spec_sha256'is distinct from p_operation_spec_sha256
 or p_command->>'expected_stage_version'is distinct from '1'then raise exception 'bridge_payload_invalid';end if;
 select * into o from public.photo_bridge_operations where id=(p_command->>'operation_id')::uuid and run_id=r.id for update;if not found then raise exception 'bridge_authority_denied';end if;
 select jsonb_build_object('assets',jsonb_agg(jsonb_build_object('id',a->>'id','sha256',a->>'sha256')order by a->>'id'))into hashes_ from jsonb_array_elements(o.spec->'assets')a;
 if p_source_hashes is distinct from hashes_ or exists(select 1 from jsonb_array_elements(o.spec->'assets')a where not exists(select 1 from public.photo_assets p
 where p.id=(a->>'id')::uuid and p.workspace_id=r.workspace_id and p.project_id=r.project_id and p.status='ready'and p.sha256=a->>'sha256'))then raise exception 'bridge_source_invalid';end if;
 if o.state<>'reserved'or o.state_version<>p_expected_state_version then return jsonb_build_object('won',false,'operation',private.photo_bridge_view(o));end if;
 if not exists(select 1 from public.provider_spend_reservations s where s.event_id=o.event_id and s.photo_run_id=r.id and s.photo_stage_key=o.operation_key and s.status='reserved'
 and s.reserved_usd=(o.spec->'operation'->>'reservationUsd')::numeric)then raise exception 'bridge_reservation_missing';end if;
 update public.photo_bridge_operations set state='dispatching',state_version=state_version+1,operation_spec_sha256=p_operation_spec_sha256,
 dispatch_payload_sha256=p_dispatch_payload_sha256,source_hashes=p_source_hashes,dispatch_token=gen_random_uuid(),updated_at=now()where id=o.id returning * into o;
 return jsonb_build_object('won',true,'operation',private.photo_bridge_view(o),'dispatch_token',o.dispatch_token);end $$;
create function public.finalize_photo_bridge_operation(p_operation_id uuid,p_dispatch_token uuid,p_result jsonb,p_result_sha256 text,p_usage jsonb,p_outcome text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.photo_bridge_operations; amount numeric; prefix_ text;
begin
  perform 1 from public.provider_spend_policy where singleton for update;
  -- A replaced lease may still record the result of its one committed dispatch.
  -- It cannot retrieve/deliver it without fresh authority through the read RPC.
  perform 1 from public.photo_takeoff_runs where id=(select run_id from public.photo_bridge_operations where id=p_operation_id) for update;
  select * into o from public.photo_bridge_operations where id=p_operation_id for update;
  if not found or p_dispatch_token is null or o.dispatch_token is distinct from p_dispatch_token then raise exception 'bridge_dispatch_token_invalid'; end if;
  if p_outcome is null or p_outcome not in ('result','unknown') or jsonb_typeof(p_usage) is distinct from 'object'
    or (p_outcome='result' and (jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>500000 or coalesce(p_result_sha256,'')!~'^[a-f0-9]{64}$'))
    or (p_outcome='unknown' and (p_result is not null or p_result_sha256 is not null)) then raise exception 'bridge_result_invalid'; end if;
  if o.state in ('completed','dispatch_unknown') then
    if o.state is distinct from (case when p_outcome='result' then 'completed' else 'dispatch_unknown' end)
      or o.result is distinct from p_result or o.result_sha256 is distinct from p_result_sha256 or o.result_usage is distinct from p_usage
      then raise exception 'bridge_result_conflict'; end if;
    return private.photo_bridge_view(o);
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
  update public.photo_bridge_operations set state=case when p_outcome='result' then 'completed' else 'dispatch_unknown' end,
    state_version=state_version+1,result=p_result,result_sha256=p_result_sha256,result_usage=p_usage,
    cost_state=case when amount is null then 'held_unknown' else 'captured' end,captured_usd_micros=case when amount is null then null else ceil(amount*1000000)::bigint end,
    error_code=case when p_outcome='unknown' then 'dispatch_outcome_unknown' end,updated_at=now() where id=o.id returning * into o;
  if o.state='completed' then
    update public.photo_takeoff_runs r set status='queued',error_code=null,lease_id=null,lease_expires_at=null,not_before=null,updated_at=now()
    where r.id=o.run_id and r.status='blocked'and r.error_code='bridge_delivery_pending'and r.cancel_requested_at is null and private.complete_photo_authorized(r.id)
    and(r.manifest->>'expiresAt')::timestamptz>now()and not exists(select 1 from public.photo_bridge_operations x where x.run_id=r.id and x.state in('dispatching','dispatch_unknown','failed_final'));
  end if;
  return private.photo_bridge_view(o);
end $$;

create function public.read_photo_bridge_result(p_command jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;o public.photo_bridge_operations;begin
 r:=private.photo_bridge_run(p_command);select * into o from public.photo_bridge_operations where id=(p_command->>'operation_id')::uuid and run_id=r.id;
 if not found or o.state<>'completed'or o.result is null then raise exception 'bridge_result_unavailable';end if;
 return jsonb_build_object('result',o.result,'result_sha256',o.result_sha256);end $$;
create function public.photo_provider_bridge_schema_ready()returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('ready',to_regclass('public.photo_bridge_operations')is not null and to_regprocedure('private.company_next_capacity_at(numeric)')is not null,'reservationCapability','reviewed-operation-reservations-v1','photoCapability','photo-bridge-v1');$$;

create function private.photo_waiting_operation_reservation(p_run_id uuid)returns numeric language sql stable security definer set search_path=public,pg_temp as $$
 select (op->>'reservationUsd')::numeric from public.photo_takeoff_runs r cross join lateral jsonb_array_elements(r.manifest->'operations')with ordinality x(op,n)
 join public.photo_stage_checkpoints s on s.run_id=r.id and s.operation_key=op->>'key'
 where r.id=p_run_id and s.status<>'completed'order by n limit 1;
$$;
create or replace function public.wait_complete_photo_budget(p_run_id uuid,p_lease_id uuid,p_event_id uuid)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;next_ timestamptz;required_ numeric;begin
 perform 1 from public.provider_spend_policy where singleton for update;
 select * into r from public.photo_takeoff_runs where id=p_run_id and lease_id=p_lease_id and status='processing'and lease_expires_at>now()for update;
 if not found or not private.complete_photo_authorized(r.id)or exists(select 1 from public.photo_stage_checkpoints where run_id=r.id and status in('admitted','processing'))
 or not exists(select 1 from public.api_usage_events where id=p_event_id and user_id=r.requested_by and workspace_id=r.workspace_id and project_id=r.project_id and operation='rb1:'||r.id::text||':generate:blocked_spend_limit')
 or exists(select 1 from public.provider_spend_reservations where event_id=p_event_id)then raise exception 'Photo unsent budget receipt unavailable';end if;
 required_:=private.photo_waiting_operation_reservation(r.id);if required_ is null then raise exception 'Photo waiting operation unavailable';end if;
 next_:=private.company_next_capacity_at(required_);
 -- NULL is a preserved wait with no provable release time, never an automatic retry.
 if next_ is not null then next_:=greatest(now()+interval '15 seconds',next_);end if;
 update public.photo_takeoff_runs set status=case when next_>=(manifest->>'expiresAt')::timestamptz or(manifest->>'expiresAt')::timestamptz<=now()then'blocked'else'waiting_budget'end,
 error_code=case when next_>=(manifest->>'expiresAt')::timestamptz or(manifest->>'expiresAt')::timestamptz<=now()then'processing_review_required'else'company_spend_limit'end,
 not_before=next_,budget_wait_started_at=coalesce(budget_wait_started_at,now()),lease_id=null,lease_expires_at=null,updated_at=now()where id=r.id returning * into r;
 return jsonb_build_object('id',r.id,'status',r.status,'not_before',r.not_before);end $$;
create or replace function public.due_complete_photo_runs(p_profile_hash text)returns jsonb language sql security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id)),'[]'::jsonb)from(select r.id from public.photo_takeoff_runs r where profile_hash=p_profile_hash
 and manifest->>'completeVersion'='photo-complete-v1'and(status='queued'or status='processing'and lease_expires_at<=now()
 or status='waiting_budget'and((manifest->>'expiresAt')::timestamptz<=now()or(not_before is null or not_before<=now())and private.company_next_capacity_at(private.photo_waiting_operation_reservation(r.id))<=now()))
 and cancel_requested_at is null and private.complete_photo_authorized(r.id)order by budget_wait_started_at nulls last,created_at limit 20)x;
$$;

-- Saved bridge results fund attachment, not a second dispatch.
create or replace function public.claim_complete_photo_takeoff(p_run_id uuid,p_worker_id text,p_profile_hash text)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;lease uuid;
begin
 select * into r from public.photo_takeoff_runs where id=p_run_id and profile_hash=p_profile_hash for update;
 if not found or not private.complete_photo_authorized(r.id)then raise exception 'Complete photo authorization unavailable';end if;
 if r.status in('needs_review','blocked','cancelled')then return jsonb_build_object('skip',true,'status',r.status);end if;
 if r.status='processing'and r.lease_expires_at>now()then raise exception 'Photo run already leased';end if;
 if r.cancel_requested_at is not null or (r.manifest->>'expiresAt')::timestamptz<=now()then
 update public.photo_takeoff_runs set status=case when cancel_requested_at is not null then 'cancelled'else'blocked'end,error_code='processing_review_required',not_before=null,updated_at=now()where id=r.id;
 return jsonb_build_object('skip',true,'status','blocked');end if;
 if r.status='waiting_budget'and(r.not_before>now()or coalesce(private.company_next_capacity_at(private.photo_waiting_operation_reservation(r.id))<=now(),false)is not true)then return jsonb_build_object('skip',true,'status',r.status);end if;
 if exists(select 1 from public.photo_stage_checkpoints s where s.run_id=r.id and s.status in('admitted','processing')and not exists(select 1 from public.photo_bridge_operations o where o.run_id=r.id and o.operation_key=s.operation_key and o.event_id=s.event_id and o.state in('reserved','completed')))
 or exists(select 1 from public.photo_bridge_operations where run_id=r.id and state in('dispatching','dispatch_unknown','failed_final'))then
 update public.photo_takeoff_runs set status='blocked',error_code=case when exists(select 1 from public.photo_bridge_operations where run_id=r.id and state='dispatching')and not exists(select 1 from public.photo_bridge_operations where run_id=r.id and state in('dispatch_unknown','failed_final'))then'bridge_delivery_pending'else'unknown_provider_outcome'end,lease_id=null,lease_expires_at=null,updated_at=now()where id=r.id;
 return jsonb_build_object('skip',true,'status','blocked');end if;
 update public.photo_stage_checkpoints s set status='admitted'where s.run_id=r.id and s.status='processing'and exists(select 1 from public.photo_bridge_operations o where o.run_id=r.id and o.operation_key=s.operation_key and o.event_id=s.event_id and o.state='completed');
 lease:=gen_random_uuid();update public.photo_takeoff_runs set status='processing',worker_id=p_worker_id,lease_id=lease,lease_expires_at=now()+interval '90 seconds',heartbeat_at=now(),
 started_at=coalesce(started_at,now()),not_before=null,error_code=null,updated_at=now()where id=r.id;
 return jsonb_build_object('skip',false,'lease_id',lease,'workspace_id',r.workspace_id,'project_id',r.project_id,'requested_by',r.requested_by,'manifest',r.manifest);
end $$;
create or replace function public.begin_complete_photo_stage(p_run_id uuid,p_lease_id uuid,p_operation_key text,p_event_id uuid)returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;
begin
 select * into r from public.photo_takeoff_runs where id=p_run_id and lease_id=p_lease_id and status='processing'and lease_expires_at>now()and cancel_requested_at is null for update;
 if not found or not private.complete_photo_authorized(r.id)or(r.manifest->>'expiresAt')::timestamptz<=now()then raise exception 'Photo lease authorization unavailable';end if;
 if exists(select 1 from public.photo_bridge_operations where event_id=p_event_id)and not exists(select 1 from public.photo_bridge_operations o join public.provider_spend_reservations s on s.event_id=o.event_id where o.event_id=p_event_id and o.run_id=r.id and o.operation_key=p_operation_key and o.state='completed'and o.result is not null and s.status='captured'and s.photo_run_id=r.id and s.photo_stage_key=p_operation_key)then raise exception 'Photo bridge result is not funded';end if;
 if exists(select 1 from public.photo_stage_checkpoints where run_id=r.id and status='processing')then raise exception 'Photo stage already dispatching';end if;
 update public.photo_stage_checkpoints set status='processing',started_at=now()where run_id=r.id and operation_key=p_operation_key and status='admitted'and event_id=p_event_id;
 if not found then raise exception 'Photo admission receipt missing';end if;return true;end $$;
create or replace function public.resume_complete_photo_takeoff(p_run_id uuid,p_workspace_id uuid,p_user_id uuid,p_profile_hash text)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;begin
 select * into r from public.photo_takeoff_runs where id=p_run_id and workspace_id=p_workspace_id for update;
 if not found or r.requested_by<>p_user_id or r.profile_hash<>p_profile_hash or not private.complete_photo_authorized(r.id)or not public.photo_takeoff_worker_available(p_profile_hash)then raise exception 'Photo resume access denied';end if;
 if r.status='needs_review'or r.status='waiting_budget'and(r.not_before>now()or coalesce(private.company_next_capacity_at(private.photo_waiting_operation_reservation(r.id))<=now(),false)is not true)then return jsonb_build_object('id',r.id,'status',r.status,'not_before',r.not_before);end if;
 if (r.manifest->>'expiresAt')::timestamptz<=now()then raise exception 'Photo processing review required';end if;
 if r.status='processing'and r.lease_expires_at>now()then raise exception 'Photo worker is still active';end if;
 if exists(select 1 from public.photo_stage_checkpoints s where s.run_id=r.id and s.status in('admitted','processing')and not exists(select 1 from public.photo_bridge_operations o where o.run_id=r.id and o.operation_key=s.operation_key and o.event_id=s.event_id and o.state in('reserved','completed')))or exists(select 1 from public.photo_bridge_operations where run_id=r.id and state in('dispatching','dispatch_unknown','failed_final'))then raise exception 'Photo provider reconciliation required';end if;
 update public.photo_takeoff_runs set status='queued',cancel_requested_at=null,not_before=null,error_code=null,lease_id=null,lease_expires_at=null,updated_at=now()where id=r.id;
 return jsonb_build_object('id',r.id,'status','queued','completed_checkpoints_preserved',true);end $$;

create function public.recover_photo_bridge_run(p_run_id uuid,p_lease_id uuid)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;uncertain_ boolean;begin
 select * into r from public.photo_takeoff_runs where id=p_run_id and lease_id=p_lease_id and status='processing'for update;
 if not found or r.cancel_requested_at is not null or not private.complete_photo_authorized(r.id)then raise exception 'Photo recovery access denied';end if;
 if not exists(select 1 from public.photo_bridge_operations where run_id=r.id)then raise exception 'Photo bridge operation unavailable';end if;
 uncertain_:=exists(select 1 from public.photo_bridge_operations where run_id=r.id and state in('dispatching','dispatch_unknown','failed_final'))
 or exists(select 1 from public.photo_stage_checkpoints s where s.run_id=r.id and s.status in('admitted','processing')and not exists(select 1 from public.photo_bridge_operations o where o.run_id=r.id and o.operation_key=s.operation_key and o.event_id=s.event_id and o.state in('reserved','completed')));
 update public.photo_takeoff_runs set status=case when uncertain_ or(manifest->>'expiresAt')::timestamptz<=now()then'blocked'else'queued'end,
 error_code=case when(manifest->>'expiresAt')::timestamptz<=now()then'processing_review_required'when uncertain_ then'bridge_delivery_pending'else null end,
 lease_id=null,lease_expires_at=null,not_before=null,updated_at=now()where id=r.id returning * into r;
 return jsonb_build_object('id',r.id,'status',r.status,'error_code',r.error_code);end $$;
revoke all on function private.photo_bridge_view(public.photo_bridge_operations),private.photo_bridge_run(jsonb),private.photo_waiting_operation_reservation(uuid)from public,anon,authenticated,service_role;
do $$declare item record;begin
 for item in select p.oid::regprocedure identity from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname in
 ('recover_photo_bridge_run','prepare_photo_bridge_operation','authorize_photo_bridge_command','reserve_photo_bridge_operation','claim_photo_bridge_dispatch','finalize_photo_bridge_operation','read_photo_bridge_result','photo_provider_bridge_schema_ready')loop
 execute 'revoke all on function '||item.identity||' from public,anon,authenticated';execute 'grant execute on function '||item.identity||' to service_role';end loop;
end $$;
