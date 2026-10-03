-- The 2.50 company policy value is a conservative base hold, not permission
-- to increase the 25 rolling-day cap. Only a NEW paid-v2 consent can freeze
-- larger, independently reviewed per-operation holds. Legacy contracts stay fixed.
create function private.validate_full_operation_contract(c jsonb) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare policy public.provider_spend_policy; op jsonb; route_ jsonb; p jsonb; sheet_ jsonb; t jsonb;
  total_ numeric:=0; cost_ numeric:=0; pages_ integer; amount_ numeric; count_ integer; page_ integer; position_ integer:=0;
  pass_ text; region_ text; expected_ text[]:='{}'; model_ text; input_ numeric; output_ numeric; combined_ numeric;
  input_rate_ numeric; output_rate_ numeric; additional_ numeric; bound_ numeric; expiry_ timestamptz; earliest_ timestamptz;
  stages_ jsonb:='["classification","legends_schedules","discipline","reconciliation","conflict_detection","completeness","risk_review"]'::jsonb;
begin
  select * into policy from public.provider_spend_policy where singleton;
  if not found or policy.enabled is not true or policy.call_reservation_usd is null or policy.spend_cap_usd is null
    or policy.call_reservation_usd<=0 or policy.spend_cap_usd<policy.call_reservation_usd
    or policy.call_reservation_usd::text in ('NaN','Infinity','-Infinity') or policy.spend_cap_usd::text in ('NaN','Infinity','-Infinity') then return false; end if;
  if jsonb_typeof(c) is distinct from 'object' or c->>'version' is distinct from 'paid-full-v2'
    or c->>'executionPolicy' is distinct from 'one-durable-run-budget-wait-no-uncertain-replay'
    or jsonb_typeof(c->'pricing') is distinct from 'object'
    or jsonb_typeof(c->'pricing'->'callReservationUsd') is distinct from 'number'
    or (c->'pricing'->>'callReservationUsd')::numeric<>policy.call_reservation_usd
    or c->'pricing'->>'overheadBasePolicy' is distinct from 'purchase'
    or jsonb_typeof(c->'pricing'->'overheadBaseCents') is distinct from 'number'
    or jsonb_typeof(c->'pricing'->'overheadPageCents') is distinct from 'number'
    or jsonb_typeof(c->'pricing'->'costCents') is distinct from 'number'
    or (c->'pricing'->>'overheadBaseCents')::numeric not between 0 and 9007199254740991
    or (c->'pricing'->>'overheadPageCents')::numeric not between 0 and 9007199254740991
    or trunc((c->'pricing'->>'overheadBaseCents')::numeric)<>(c->'pricing'->>'overheadBaseCents')::numeric
    or trunc((c->'pricing'->>'overheadPageCents')::numeric)<>(c->'pricing'->>'overheadPageCents')::numeric
    or c->'regionGrid' is distinct from '2'::jsonb or c->'stages' is distinct from stages_
    or jsonb_typeof(c->'profile') is distinct from 'object' or c->'profile'->>'version' is distinct from 'full-processing-v2'
    or c->'profile'->>'transport' is distinct from 'bridge'
    or c->'profile'->'regionalReview' is distinct from '{"enabled":true,"grid":2}'::jsonb
    or coalesce(c->>'policyId','')!~'^[a-f0-9]{64}$' or coalesce(c->'profile'->>'profileHash','')!~'^[a-f0-9]{64}$'
    or jsonb_typeof(c->'operations') is distinct from 'array' or jsonb_typeof(c->'providers') is distinct from 'array'
    or jsonb_typeof(c->'profile'->'routes') is distinct from 'object'
    or jsonb_typeof(c->'manifest') is distinct from 'object'
    or jsonb_typeof(c->'manifest'->'physicalPageCount') is distinct from 'number'
    or jsonb_typeof(c->'manifest'->'sheets') is distinct from 'array'
    or coalesce(c->'manifest'->>'fileSha256','')!~'^[a-f0-9]{64}$'
    or exists(select 1 from jsonb_object_keys(c->'manifest') k where k not in ('fileSha256','physicalPageCount','sheets')) then return false; end if;
  pages_:=(c->'manifest'->>'physicalPageCount')::integer;
  if pages_ not between 1 and 200 or (c->'manifest'->>'physicalPageCount')::numeric<>pages_
    or jsonb_array_length(c->'manifest'->'sheets')<>pages_ or jsonb_array_length(c->'operations')<>16*pages_
    or c->'maximumCalls' is distinct from to_jsonb(16*pages_) or jsonb_array_length(c->'providers') not between 1 and 5
    or (select count(*) from jsonb_object_keys(c->'profile'->'routes'))<>7 then return false; end if;
  for sheet_ in select value from jsonb_array_elements(c->'manifest'->'sheets') loop
    position_:=position_+1;
    if sheet_->'physicalPageNumber' is distinct from to_jsonb(position_) or coalesce(sheet_->>'pageSha256','')!~'^[a-f0-9]{64}$'
      or jsonb_typeof(sheet_->'widthPoints') is distinct from 'number' or jsonb_typeof(sheet_->'heightPoints') is distinct from 'number'
      or (sheet_->>'widthPoints')::numeric<=0 or (sheet_->>'heightPoints')::numeric<=0
      or sheet_->'rotationDegrees' is null or sheet_->'rotationDegrees' not in ('0'::jsonb,'90'::jsonb,'180'::jsonb,'270'::jsonb) then return false; end if;
  end loop;
  -- Validate every reviewed route once; operation rows must match it exactly.
  for pass_ in select value from jsonb_array_elements_text(stages_) loop
    route_:=c->'profile'->'routes'->pass_;t:=route_->'tariff';model_:=route_->>'model';
    if jsonb_typeof(route_) is distinct from 'object' or coalesce(route_->>'provider','') not in ('gemini','openai','claude','kimi','deepseek')
      or jsonb_typeof(route_->'model') is distinct from 'string' or coalesce(model_,'')!~'^[a-z0-9][a-z0-9._:-]{0,119}$'
      or coalesce(route_->>'inputKind','') not in ('pdf','images')
      or route_->'attestation'->'accountVerified' is distinct from 'true'::jsonb or route_->'attestation'->'compatibilityVerified' is distinct from 'true'::jsonb
      or route_->>'priceVersion' is distinct from route_->'attestation'->>'priceVersion'
      or jsonb_typeof(route_->'maximumCallCostUsd') is distinct from 'number'
      or route_->'maximumCallCostUsd' is distinct from route_->'attestation'->'maximumCallCostUsd'
      or (route_->>'maximumCallCostUsd')::numeric<=0
      or (route_->>'maximumCallCostUsd')::numeric*1000000<>trunc((route_->>'maximumCallCostUsd')::numeric*1000000)
      or route_->>'provider'='openai' and route_->>'requestPolicy' is distinct from 'explicit-cache-default-v1'
      or jsonb_typeof(t) is distinct from 'object' or t->'standardUncached' is distinct from 'true'::jsonb
      or t->'reasoningIncluded' is distinct from 'true'::jsonb or t->'maximumAcceptedInput' is distinct from 'true'::jsonb
      or jsonb_typeof(t->'inputUsdPerMillion') is distinct from 'number' or jsonb_typeof(t->'outputUsdPerMillion') is distinct from 'number'
      or jsonb_typeof(t->'inputTokenLimit') is distinct from 'number' or jsonb_typeof(t->'outputTokenLimit') is distinct from 'number'
      or jsonb_typeof(t->'additionalRequestUsd') is distinct from 'number' or jsonb_typeof(route_->'maxOutputTokens') is distinct from 'number'
      or coalesce(t->>'source','')!~'^https://' or jsonb_typeof(t->'verifiedAt') is distinct from 'string'
      or jsonb_typeof(t->'expiresAt') is distinct from 'string' then return false; end if;
    input_:=(t->>'inputTokenLimit')::numeric;output_:=(t->>'outputTokenLimit')::numeric;
    input_rate_:=(t->>'inputUsdPerMillion')::numeric;output_rate_:=(t->>'outputUsdPerMillion')::numeric;additional_:=(t->>'additionalRequestUsd')::numeric;
    expiry_:=(t->>'expiresAt')::timestamptz;
    if input_<=0 or output_<=0 or input_<>trunc(input_) or output_<>trunc(output_) or input_>9007199254740991 or output_>9007199254740991
      or input_rate_<=0 or output_rate_<=0 or additional_<0
      or (route_->>'maxOutputTokens')::numeric<4096 or (route_->>'maxOutputTokens')::numeric<>trunc((route_->>'maxOutputTokens')::numeric)
      or output_<(route_->>'maxOutputTokens')::numeric or not isfinite(expiry_) or expiry_<=now()
      or not isfinite((t->>'verifiedAt')::timestamptz) or (t->>'verifiedAt')::timestamptz>now() or (t->>'verifiedAt')::timestamptz>=expiry_ then return false; end if;
    earliest_:=least(earliest_,expiry_);
    if t ? 'combinedContextTokenLimit' then
      if jsonb_typeof(t->'combinedContextTokenLimit') is distinct from 'number' then return false;end if;
      combined_:=(t->>'combinedContextTokenLimit')::numeric;
      if combined_<=0 or combined_<>trunc(combined_) or combined_>9007199254740991 or combined_<(route_->>'maxOutputTokens')::numeric then return false;end if;
      if output_rate_>=input_rate_ then output_:=least(output_,combined_);input_:=least(input_,combined_-output_);
      else input_:=least(input_,combined_);output_:=least(output_,combined_-input_);end if;
    end if;
    bound_:=ceil(((input_*input_rate_+output_*output_rate_)/1000000+additional_)*1000000)/1000000;
    if (route_->>'maximumCallCostUsd')::numeric<bound_ then return false;end if;
  end loop;
  -- Matches runDeepTakeoff inventory first, then sheet/pass and 1-based regions.
  foreach pass_ in array array['classification','legends_schedules'] loop
    for page_ in 1..pages_ loop expected_:=array_append(expected_,'page:'||page_||':'||pass_||':whole');end loop;
  end loop;
  for page_ in 1..pages_ loop
    foreach pass_ in array array['discipline','reconciliation','conflict_detection','completeness','risk_review'] loop
      if pass_ in ('discipline','conflict_detection','completeness') then
        foreach region_ in array array['r1c1g2','r1c2g2','r2c1g2','r2c2g2'] loop expected_:=array_append(expected_,'page:'||page_||':'||pass_||':'||region_);end loop;
      else expected_:=array_append(expected_,'page:'||page_||':'||pass_||':whole');end if;
    end loop;
  end loop;
  position_:=0;
  for op in select value from jsonb_array_elements(c->'operations') loop
    position_:=position_+1;route_:=c->'profile'->'routes'->(op->>'passType');amount_:=(op->>'reservationUsd')::numeric;
    if jsonb_typeof(op) is distinct from 'object' or jsonb_typeof(op->'physicalPageNumber') is distinct from 'number'
      or jsonb_typeof(op->'reservationUsd') is distinct from 'number' or jsonb_typeof(op->'maximumCallCostUsd') is distinct from 'number'
      or (op->>'physicalPageNumber')::integer not between 1 and pages_
      or (op->>'physicalPageNumber')::numeric<>(op->>'physicalPageNumber')::integer
      or coalesce(op->>'passType','') not in ('classification','legends_schedules','discipline','reconciliation','conflict_detection','completeness','risk_review')
      or op->>'provider' is distinct from route_->>'provider' or op->>'model' is distinct from route_->>'model'
      or op->'maximumCallCostUsd' is distinct from route_->'maximumCallCostUsd'
      or amount_ is null or amount_<=0 or amount_::text in ('NaN','Infinity','-Infinity') or amount_>policy.spend_cap_usd
      or amount_*1000000<>trunc(amount_*1000000)
      or amount_<>greatest(policy.call_reservation_usd,(op->>'maximumCallCostUsd')::numeric)
      or op->>'key' is distinct from expected_[position_]
      or op->>'key' is distinct from 'page:'||(op->>'physicalPageNumber')::integer||':'||(op->>'passType')||':'||coalesce(op->>'regionKey','whole') then return false; end if;
    if op->>'passType' in ('discipline','conflict_detection','completeness') then
      if jsonb_typeof(op->'regionKey') is distinct from 'string' or coalesce(op->>'regionKey','') not in ('r1c1g2','r1c2g2','r2c1g2','r2c2g2') then return false;end if;
    elsif op->'regionKey' is distinct from 'null'::jsonb then return false;end if;
    total_:=total_+amount_;cost_:=cost_+(op->>'maximumCallCostUsd')::numeric;
  end loop;
  if (select count(distinct x->>'provider') from jsonb_array_elements(c->'providers') x)<>jsonb_array_length(c->'providers')
    or (select count(distinct x->>'provider') from jsonb_array_elements(c->'operations') x)<>jsonb_array_length(c->'providers') then return false;end if;
  for p in select value from jsonb_array_elements(c->'providers') loop
    select sum((x->>'reservationUsd')::numeric),count(*)::integer into amount_,count_ from jsonb_array_elements(c->'operations') x where x->>'provider'=p->>'provider';
    if amount_ is null or jsonb_typeof(p->'approvedUsd') is distinct from 'number' or amount_ is distinct from (p->>'approvedUsd')::numeric
      or p->'maximumCalls' is distinct from to_jsonb(count_)
      or p->'models' is distinct from (select jsonb_agg(model order by model) from (select distinct x->>'model' model from jsonb_array_elements(c->'operations') x where x->>'provider'=p->>'provider') s) then return false;end if;
  end loop;
  return coalesce(jsonb_typeof(c->'pricing'->'operatingReserveUsd')='number' and jsonb_typeof(c->'pricing'->'providerCostUpperBoundUsd')='number'
    and jsonb_typeof(c->'pricing'->'expiresAt')='string' and jsonb_typeof(c->'profile'->'expiresAt')='string'
    and total_=(c->'pricing'->>'operatingReserveUsd')::numeric and total_>0 and total_<=100000
    and cost_=(c->'pricing'->>'providerCostUpperBoundUsd')::numeric and cost_>0
    and (c->'pricing'->>'costCents')::numeric=ceil(cost_*100)+(c->'pricing'->>'overheadBaseCents')::numeric
      +pages_*(c->'pricing'->>'overheadPageCents')::numeric
    and isfinite((c->'pricing'->>'expiresAt')::timestamptz) and earliest_=(c->'pricing'->>'expiresAt')::timestamptz
    and earliest_=(c->'profile'->>'expiresAt')::timestamptz and earliest_>now(),false);
exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow or invalid_parameter_value then return false;
end $$;

create function private.full_contract_operation_holds(c jsonb) returns setof numeric
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare n integer; value_ numeric; calls_ integer;
begin
  if c->>'version'='paid-full-v2' then
    if private.validate_full_operation_contract(c) is not true then raise exception 'Reviewed Full operation contract invalid';end if;
    return query select (x->>'reservationUsd')::numeric from jsonb_array_elements(c->'operations') x;
  elsif c->>'version'='paid-full-v1' then
    if jsonb_typeof(c->'maximumCalls') is distinct from 'number' or jsonb_typeof(c->'pricing'->'operatingReserveUsd') is distinct from 'number' then
      raise exception 'Legacy Full reservation changed';end if;
    calls_:=(c->>'maximumCalls')::integer;
    if calls_ not between 1 and 3200 or (c->>'maximumCalls')::numeric<>calls_ then raise exception 'Legacy Full reservation changed';end if;
    value_:=(c->'pricing'->>'operatingReserveUsd')::numeric/calls_;
    if value_ is null or value_<=0 or value_::text in ('NaN','Infinity','-Infinity')
      or value_ is distinct from (select call_reservation_usd from public.provider_spend_policy where singleton) then raise exception 'Legacy Full reservation changed';end if;
    for n in 1..calls_ loop return next value_;end loop;
  else raise exception 'Reviewed Full operation contract invalid';end if;
end $$;

alter function public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text) rename to reserve_provider_spend_before_reviewed_operations;
revoke all on function public.reserve_provider_spend_before_reviewed_operations(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.reserve_provider_spend(p_event_id uuid,p_job_id uuid,p_workspace_id uuid,p_user_id uuid,p_provider text,p_model text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if exists(select 1 from public.takeoff_runs where id=p_job_id and manifest->'paidAuthorization'->'contract'->>'version'='paid-full-v2')
    then raise exception 'Reviewed operation reservation required'; end if;
  return public.reserve_provider_spend_before_reviewed_operations(p_event_id,p_job_id,p_workspace_id,p_user_id,p_provider,p_model);
end $$;

create function public.reserve_provider_spend(p_event_id uuid,p_job_id uuid,p_workspace_id uuid,p_user_id uuid,p_provider text,p_model text,p_required_reservation_usd numeric)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare policy public.provider_spend_policy; r public.takeoff_runs; budget public.full_takeoff_provider_budgets; saved public.provider_spend_reservations;
  hold_ numeric; used_ numeric; calls_ integer; c jsonb; op jsonb; bridge public.provider_bridge_operations;
begin
  select * into policy from public.provider_spend_policy where singleton for update;
  if not found or not policy.enabled then raise exception 'Company AI spend is disabled'; end if;
  if p_required_reservation_usd is null or p_required_reservation_usd<=0 or p_required_reservation_usd::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid reviewed operation reserve'; end if;
  select * into r from public.takeoff_runs where id=p_job_id for update;
  c:=r.manifest->'paidAuthorization'->'contract';
  if c->>'version' is distinct from 'paid-full-v2' then
    if p_required_reservation_usd>policy.call_reservation_usd then raise exception 'Legacy operation cannot increase its approved reservation'; end if;
    return public.reserve_provider_spend_before_reviewed_operations(p_event_id,p_job_id,p_workspace_id,p_user_id,p_provider,p_model);
  end if;
  if r.payment_kind<>'paid' or r.workspace_id is distinct from p_workspace_id or r.requested_by is distinct from p_user_id
    or r.status<>'processing' or r.worker_lease_expires_at<=now() or r.cancel_requested_at is not null
    or not private.full_takeoff_authorized(r.id,p_user_id) or not private.paid_full_dispatch_current(r.id)
    or private.validate_full_operation_contract(c) is not true then raise exception 'Paid Full authorization revoked'; end if;
  hold_:=greatest(policy.call_reservation_usd,p_required_reservation_usd);
  select * into bridge from public.provider_bridge_operations where event_id=p_event_id and run_id=r.id;
  if not found then raise exception 'Reviewed Full reservation requires its durable operation'; end if;
  select x into op from jsonb_array_elements(c->'operations') x where (x->>'physicalPageNumber')::integer=bridge.page_number
    and x->>'passType'=bridge.pass_type and x->>'regionKey' is not distinct from bridge.region_key;
  if op is null or op->>'provider' is distinct from p_provider or op->>'model' is distinct from p_model
    or (op->>'maximumCallCostUsd')::numeric is distinct from p_required_reservation_usd or (op->>'reservationUsd')::numeric is distinct from hold_
    then raise exception 'Reviewed Full operation differs from consent'; end if;
  select * into saved from public.provider_spend_reservations where event_id=p_event_id;
  if found then
    if saved.takeoff_run_id<>r.id or saved.workspace_id<>p_workspace_id or saved.user_id is distinct from p_user_id
      or saved.provider<>p_provider or saved.model<>p_model or saved.reserved_usd<>hold_ then raise exception 'Provider spend reservation identity mismatch'; end if;
    return to_jsonb(saved);
  end if;
  if bridge.state not in ('planned','waiting_budget') then raise exception 'Reviewed Full operation is not dispatchable'; end if;
  select * into budget from public.full_takeoff_provider_budgets where takeoff_run_id=r.id and provider=p_provider for update;
  if not found or not p_model=any(budget.approved_models) then raise exception 'Full Takeoff provider run budget is not approved'; end if;
  if not exists(select 1 from public.api_usage_events where id=p_event_id and workspace_id=p_workspace_id and project_id=r.project_id
    and user_id=p_user_id and provider=p_provider and model=p_model and operation='rb1:'||r.id||':generate:pending') then raise exception 'Provider spend event is not authorized'; end if;
  select coalesce(sum(case when status='captured' and telemetry_known then estimated_cost_usd else reserved_usd end),0),count(*)::integer into used_,calls_
    from public.provider_spend_reservations where takeoff_run_id=r.id and provider=p_provider;
  if used_+hold_>budget.approved_usd or calls_>=budget.maximum_calls then raise exception 'Full Takeoff provider run spend limit reached'; end if;
  if hold_>policy.spend_cap_usd then raise exception 'Reviewed operation exceeds company capacity'; end if;
  -- The shared exposure trigger admits all providers and geometry atomically.
  insert into public.provider_spend_reservations(event_id,takeoff_run_id,workspace_id,user_id,provider,model,reserved_usd)
    values(p_event_id,r.id,p_workspace_id,p_user_id,p_provider,p_model,hold_) returning * into saved;
  return to_jsonb(saved);
end $$;

revoke all on function private.validate_full_operation_contract(jsonb),private.full_contract_operation_holds(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text),public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text,numeric) from public,anon,authenticated;
grant execute on function public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text),public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text,numeric) to service_role;

-- Ordered next-fit schedule uses each indivisible operation and current headroom.
create function private.full_contract_schedule_windows(c jsonb,p_cap numeric,p_available numeric) returns integer
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare hold_ numeric; remaining_ numeric; windows_ integer:=0;
begin
 if p_cap is null or p_cap<=0 or p_available is null or p_available<0 then raise exception 'Full processing capacity unavailable'; end if;
 remaining_:=least(p_cap,p_available);
 for hold_ in select * from private.full_contract_operation_holds(c) loop
   if hold_ is null or hold_<=0 or hold_>p_cap then raise exception 'Full operation exceeds company capacity'; end if;
   if hold_>remaining_ then windows_:=windows_+1;remaining_:=p_cap;end if;
   remaining_:=remaining_-hold_;
 end loop;
 return windows_;
end $$;

create or replace function private.check_full_reading_order_schedule(p_order_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare policy jsonb; cap numeric; remaining_ numeric; window_ numeric; windows_ integer:=0; hold_ numeric; q record; count_ integer:=0; expiry_ timestamptz;
begin
 policy:=public.paid_full_capacity_policy();cap:=coalesce((policy->>'window_capacity_usd')::numeric,(policy->>'spend_cap_usd')::numeric);
 remaining_:=(policy->>'available_usd')::numeric;window_:=(policy->>'rolling_window_seconds')::numeric;
 if policy->>'enabled' is distinct from 'true' or cap is null or cap<=0 or remaining_ is null or remaining_<0 or window_ is null or window_<=0 then
  raise exception 'Full order processing capacity unavailable';end if;
 remaining_:=least(cap,remaining_);
 for q in select child.full_contract from public.full_reading_orders o
   cross join lateral jsonb_array_elements(o.contract->'items') with ordinality item(value,position)
   join public.full_reading_order_items i on i.order_id=o.id and i.quote_id=(item.value->>'quote_id')::uuid
   join public.project_reading_quotes child on child.id=i.quote_id where o.id=p_order_id order by item.position loop
  count_:=count_+1;expiry_:=least(expiry_,(q.full_contract->'pricing'->>'expiresAt')::timestamptz);
  for hold_ in select * from private.full_contract_operation_holds(q.full_contract) loop
   if hold_ is null or hold_<=0 or hold_>cap then raise exception 'Full order reservation profile changed';end if;
   if hold_>remaining_ then windows_:=windows_+1;remaining_:=cap;end if;
   remaining_:=remaining_-hold_;
  end loop;
  if now()+windows_*window_*interval '1 second'>=(q.full_contract->'pricing'->>'expiresAt')::timestamptz then
    raise exception 'Full order schedule exceeds the reviewed price validity';end if;
 end loop;
 if count_=0 or count_<>(select count(*) from public.full_reading_order_items where order_id=p_order_id) then raise exception 'Full order reservation profile changed';end if;
 if expiry_ is null or now()+windows_*window_*interval '1 second'>=expiry_ then raise exception 'Full order schedule exceeds the reviewed price validity';end if;
end $$;

-- Geometry has no completion/settlement lifecycle today. Do not infer one from
-- job status: existing rows remain uncertain until explicit cost reconciliation.
alter table public.geometry_provider_spend_reservations add column if not exists settled_at timestamptz;

create function private.company_spend_exposure() returns table(amount numeric,expires_at timestamptz)
language sql stable security definer set search_path=public,pg_temp as $$
  with policy as (select rolling_window from public.provider_spend_policy where singleton), entries as (
    select case when s.status='captured' and s.telemetry_known is true and s.estimated_cost_usd>=0
      and s.estimated_cost_usd::text not in ('NaN','Infinity','-Infinity') and s.settled_at is not null and isfinite(s.settled_at)
      then s.estimated_cost_usd else greatest(s.reserved_usd,case when s.estimated_cost_usd>=0
        and s.estimated_cost_usd::text not in ('NaN','Infinity','-Infinity') then s.estimated_cost_usd else 0 end) end amount,
      case when s.status='captured' and s.telemetry_known is true and s.estimated_cost_usd>=0
        and s.estimated_cost_usd::text not in ('NaN','Infinity','-Infinity') and s.settled_at is not null and isfinite(s.settled_at)
        then greatest(s.settled_at,s.created_at)+p.rolling_window else null end expires_at
    from public.provider_spend_reservations s cross join policy p
    union all
    select case when to_jsonb(g)->>'telemetry_known'='true' and (to_jsonb(g)->>'estimated_cost_usd')::numeric>=0
      and coalesce(to_jsonb(g)->>'estimated_cost_usd','NaN') not in ('NaN','Infinity','-Infinity') and g.settled_at is not null and isfinite(g.settled_at)
      then (to_jsonb(g)->>'estimated_cost_usd')::numeric else greatest(g.reserved_usd,case when (to_jsonb(g)->>'estimated_cost_usd')::numeric>=0
        and coalesce(to_jsonb(g)->>'estimated_cost_usd','NaN') not in ('NaN','Infinity','-Infinity') then (to_jsonb(g)->>'estimated_cost_usd')::numeric else 0 end) end,
      case when to_jsonb(g)->>'telemetry_known'='true' and (to_jsonb(g)->>'estimated_cost_usd')::numeric>=0
        and coalesce(to_jsonb(g)->>'estimated_cost_usd','NaN') not in ('NaN','Infinity','-Infinity') and g.settled_at is not null and isfinite(g.settled_at)
        then greatest(g.settled_at,g.created_at)+p.rolling_window else null end
    from public.geometry_provider_spend_reservations g cross join policy p
  ) select e.amount,e.expires_at from entries e where e.expires_at is null or e.expires_at>now();
$$;

create or replace function public.paid_full_capacity_policy() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  with exposure as (select coalesce(sum(amount),0) used,coalesce(sum(amount) filter(where expires_at is null),0) unresolved
    from private.company_spend_exposure())
  select jsonb_build_object('enabled',p.enabled,'spend_cap_usd',p.spend_cap_usd,
    'rolling_window_seconds',extract(epoch from p.rolling_window),'call_reservation_usd',p.call_reservation_usd,
    'available_usd',greatest(0,p.spend_cap_usd-e.used),'non_expiring_usd',e.unresolved,
    'window_capacity_usd',greatest(0,p.spend_cap_usd-e.unresolved))
    from public.provider_spend_policy p cross join exposure e where p.singleton;
$$;

/** NULL means there is no provable future release; it is not a scheduled retry. */
create function private.company_next_capacity_at(p_required numeric) returns timestamptz
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare policy public.provider_spend_policy; used_ numeric; entry record;
begin
  select * into policy from public.provider_spend_policy where singleton;
  if not found or policy.enabled is not true or p_required is null or p_required<=0
    or p_required::text in ('NaN','Infinity','-Infinity') or p_required>policy.spend_cap_usd then return null;end if;
  select coalesce(sum(amount),0) into used_ from private.company_spend_exposure();
  if used_+p_required<=policy.spend_cap_usd then return now();end if;
  for entry in select expires_at,sum(amount) amount from private.company_spend_exposure() where expires_at is not null group by expires_at order by expires_at loop
    used_:=used_-entry.amount;
    if used_+p_required<=policy.spend_cap_usd then return greatest(now(),entry.expires_at+interval '1 second');end if;
  end loop;
  return null;
end $$;

create function private.full_waiting_operation_reservation(p_run_id uuid) returns numeric
language sql stable security definer set search_path=public,pg_temp as $$
  select case when r.manifest->'paidAuthorization'->'contract'->>'version'='paid-full-v2' then
    (select max((op->>'reservationUsd')::numeric) from public.provider_bridge_operations b
      cross join lateral jsonb_array_elements(r.manifest->'paidAuthorization'->'contract'->'operations') op
      where b.run_id=r.id and b.state='waiting_budget' and (op->>'physicalPageNumber')::integer=b.page_number
        and op->>'passType'=b.pass_type and op->>'regionKey' is not distinct from b.region_key)
    else p.call_reservation_usd end
  from public.takeoff_runs r cross join public.provider_spend_policy p where r.id=p_run_id and p.singleton;
$$;

create or replace function private.check_paid_full_company_exposure() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare policy public.provider_spend_policy; used numeric; quote_ uuid; run_ uuid; next_run uuid; c jsonb;
begin
  select * into policy from public.provider_spend_policy where singleton for update;
  if not found or not policy.enabled then raise exception 'Company AI spend is disabled'; end if;
  select coalesce(sum(amount),0) into used from private.company_spend_exposure();
  if tg_table_name='provider_spend_reservations' then
    run_:=new.takeoff_run_id;
    if run_ is not null then
      select payment_quote_id into quote_ from public.takeoff_runs where id=run_ and payment_kind='paid';
      if quote_ is not null then
        if not private.full_takeoff_authorized(run_,new.user_id) or not private.paid_full_dispatch_current(run_) then raise exception 'Paid Full authorization revoked'; end if;
        select full_contract into c from public.project_reading_quotes where id=quote_;
        if c->>'version'='paid-full-v2' then
          if private.validate_full_operation_contract(c) is not true or not exists(select 1 from public.provider_bridge_operations b
            cross join lateral jsonb_array_elements(c->'operations') op where b.event_id=new.event_id and b.run_id=run_
            and b.state in ('planned','waiting_budget') and (op->>'physicalPageNumber')::integer=b.page_number and op->>'passType'=b.pass_type
            and op->>'regionKey' is not distinct from b.region_key and op->>'provider'=new.provider and op->>'model'=new.model
            and (op->>'reservationUsd')::numeric=new.reserved_usd)
            then raise exception 'Paid Full operation reservation differs from the purchased contract';end if;
        elsif (c->'pricing'->>'operatingReserveUsd')::numeric/nullif((c->>'maximumCalls')::integer,0) is distinct from new.reserved_usd then
          raise exception 'Paid Full call reservation differs from the purchased contract';
        end if;
      end if;
    end if;
  end if;
  -- One waiting run owns the next turn. This check and the actual reservation
  -- use the same policy row lock, including geometry and other providers.
  select id into next_run from public.takeoff_runs r where budget_wait_started_at is not null
    and ((status='waiting_budget' and (not_before<=now() or not_before is null)
      and private.company_next_capacity_at(private.full_waiting_operation_reservation(r.id))<=now()) or status='processing')
    and cancel_requested_at is null and private.full_takeoff_authorized(r.id,r.requested_by)
    and private.paid_full_dispatch_current(r.id)
    order by budget_wait_started_at,id limit 1;
  if next_run is not null and next_run is distinct from run_ then raise exception 'Company AI spend limit reached: waiting reading has the next turn'; end if;
  if used+new.reserved_usd>policy.spend_cap_usd then raise exception 'Company AI spend limit reached'; end if;
  if run_ is not null then update public.takeoff_runs set budget_wait_started_at=null where id=run_; end if;
  return new;
end $$;

create or replace function public.create_paid_full_quote(p_input jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.project_reading_quotes; q public.project_reading_quotes; new_child boolean;
begin
  v:=jsonb_populate_record(null::public.project_reading_quotes,p_input);
  new_child:=p_input->'new_order_child'='true'::jsonb;
  perform 1 from public.provider_spend_policy where singleton for share;
  if not public.paid_full_daily_capacity_ready(v.user_id) then raise exception 'Daily Full Takeoff limit reached before checkout'; end if;
  perform 1 from public.workspaces where id=v.workspace_id and ai_processing_consented_at is not null for update;
  if not found or not exists(select 1 from public.workspace_members where workspace_id=v.workspace_id and user_id=v.user_id and role in ('admin','estimator'))
    or not exists(select 1 from public.project_files where id=v.file_id and workspace_id=v.workspace_id and project_id=v.project_id and processing_status not in ('uploading','failed'))
    then raise exception 'Paid Full access denied'; end if;
  if v.mode is distinct from 'full_v2' or v.livemode is distinct from true or coalesce(v.full_contract->>'version','') not in ('paid-full-v1','paid-full-v2')
    or v.full_contract->>'executionPolicy' is distinct from 'one-durable-run-budget-wait-no-uncertain-replay'
    or v.full_contract->'manifest'->>'fileSha256' is distinct from v.file_sha256
    or (v.full_contract->'manifest'->>'physicalPageCount')::integer is distinct from v.page_count
    or (v.full_contract->'pricing'->>'amountCents')::integer is distinct from v.amount_cents
    or (v.full_contract->'pricing'->>'costCents')::integer is distinct from v.cost_cents
    or v.full_contract->'pricing'->>'currency' is distinct from 'usd'
    or coalesce(v.full_contract_hash,'')!~'^[a-f0-9]{64}$'
    or jsonb_typeof(v.full_contract->'providers') is distinct from 'array'
    or (v.full_contract->>'version'='paid-full-v1' and jsonb_array_length(v.full_contract->'providers')<>1)
    or (v.full_contract->>'version'='paid-full-v2' and private.validate_full_operation_contract(v.full_contract) is not true) then raise exception 'Invalid paid Full contract'; end if;
  if new_child and private.full_source_has_purchase(v.workspace_id,v.project_id,v.user_id,v.file_sha256) then
    raise exception 'PDF already belongs to an accepted or paid purchase'; end if;
  if (public.paid_full_capacity_policy()->>'enabled') is distinct from 'true' then raise exception 'Company capacity cannot cover this Full reading';end if;
  perform private.full_contract_schedule_windows(v.full_contract,coalesce((public.paid_full_capacity_policy()->>'window_capacity_usd')::numeric,(public.paid_full_capacity_policy()->>'spend_cap_usd')::numeric),(public.paid_full_capacity_policy()->>'available_usd')::numeric);
  select * into q from public.project_reading_quotes where mode='full_v2' and workspace_id=v.workspace_id and project_id=v.project_id
    and file_id=v.file_id and user_id=v.user_id and full_contract_hash=v.full_contract_hash and full_contract=v.full_contract and status<>'revoked'
    and (new_child is not true or purchase_order_id is null)
    and (paid_at is not null or expires_at>now()+interval '31 minutes' or (expires_at>now() and stripe_session_id is not null))
    order by created_at desc limit 1;
  if found then return to_jsonb(q); end if;
  insert into public.project_reading_quotes(workspace_id,project_id,file_id,user_id,file_sha256,page_count,trades,scope,amount_cents,cost_cents,
    pricing_version,membership,livemode,mode,full_contract,full_contract_hash)
    values(v.workspace_id,v.project_id,v.file_id,v.user_id,v.file_sha256,v.page_count,v.trades,v.scope,v.amount_cents,v.cost_cents,
      v.pricing_version,v.membership,true,'full_v2',v.full_contract,v.full_contract_hash) returning * into q;
  return to_jsonb(q);
end $$;

create or replace function public.accept_paid_full_quote_before_orders(p_quote_id uuid,p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_contract_hash text)
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
  if not policy.enabled or q.full_contract->>'executionPolicy' is distinct from 'one-durable-run-budget-wait-no-uncertain-replay' then raise exception 'Company capacity cannot cover this Full reading';end if;
  windows_:=private.full_contract_schedule_windows(q.full_contract,coalesce((public.paid_full_capacity_policy()->>'window_capacity_usd')::numeric,policy.spend_cap_usd),(public.paid_full_capacity_policy()->>'available_usd')::numeric);
  if now()+windows_*policy.rolling_window >= (q.full_contract->'pricing'->>'expiresAt')::timestamptz then raise exception 'Paid Full schedule exceeds the reviewed price validity';end if;
  insert into public.paid_full_payment_holds(quote_id,reserved_usd) values(q.id,(q.full_contract->'pricing'->>'operatingReserveUsd')::numeric)
    on conflict(quote_id) do nothing;
  if exists(select 1 from public.paid_full_payment_holds where quote_id=q.id and released_at is not null) then raise exception 'Paid Full payment hold was released'; end if;
  if q.full_consent is null then
    update public.project_reading_quotes set full_consent=jsonb_build_object('confirmed',true,'approvedBy',p_user_id,'approvedAt',now(),'contractHash',p_contract_hash)
      where id=q.id returning * into q;
  end if;
  return to_jsonb(q);
end $$;

create or replace function public.configure_full_takeoff_run_budget(p_run_id uuid,p_lease_id uuid,p_provider text,p_models text[],
  p_approved_usd numeric,p_maximum_calls integer,p_approval_ref text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; budget public.full_takeoff_provider_budgets;
begin
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing'
    and cancel_requested_at is null and worker_lease_expires_at>now() for update;
  if not found then raise exception 'Full Takeoff budget lease is invalid'; end if;
  if not private.full_takeoff_authorized(r.id,r.requested_by) then raise exception 'Full Takeoff budget access denied'; end if;
  if r.payment_kind='paid' and not exists(select 1 from jsonb_array_elements(r.manifest->'paidAuthorization'->'contract'->'providers') p
    where p->>'provider'=p_provider and p->'models'=to_jsonb(p_models) and (p->>'approvedUsd')::numeric=p_approved_usd
      and (p->>'maximumCalls')::integer=p_maximum_calls and p_approval_ref=(r.manifest->'paidAuthorization'->'contract'->>'version')||':'||r.payment_quote_id::text||':'||r.payment_revision::text)
    then raise exception 'Paid Full budget differs from purchased contract'; end if;
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

create or replace function public.reserve_provider_bridge_operation(p_command jsonb) returns jsonb
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
    if r.manifest->'paidAuthorization'->'contract'->>'version'='paid-full-v2' then
      perform public.reserve_provider_spend(o.event_id,r.id,r.workspace_id,r.requested_by,stage->>'provider',stage->>'model',(stage->'attestation'->>'maximumCallCostUsd')::numeric);
    else
      perform public.reserve_provider_spend(o.event_id,r.id,r.workspace_id,r.requested_by,stage->>'provider',stage->>'model');
    end if;
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

create or replace function public.wait_full_takeoff_budget(p_run_id uuid,p_lease_id uuid,p_event_id uuid,p_page_number integer,p_pass_type text,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; policy public.provider_spend_policy; used numeric; retry_at timestamptz; entry record; current_pass uuid; required_ numeric;
begin
  select * into policy from public.provider_spend_policy where singleton for update;
  if not found or not policy.enabled or policy.call_reservation_usd>policy.spend_cap_usd then raise exception 'Company processing capacity unavailable'; end if;
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing'
    and cancel_requested_at is null and worker_lease_expires_at>now() for update;
  if not found or not private.full_takeoff_authorized(r.id,r.requested_by) or not private.paid_full_dispatch_current(r.id) then raise exception 'Full Takeoff lease authorization invalid'; end if;
  required_:=policy.call_reservation_usd;
  if r.manifest->'paidAuthorization'->'contract'->>'version'='paid-full-v2' then
    select (op->>'reservationUsd')::numeric into required_ from public.provider_bridge_operations b
      cross join lateral jsonb_array_elements(r.manifest->'paidAuthorization'->'contract'->'operations') op
      where b.run_id=r.id and b.event_id=p_event_id and b.state='waiting_budget'
      and b.page_number=p_page_number and b.pass_type=p_pass_type
      and (op->>'physicalPageNumber')::integer=b.page_number and op->>'passType'=b.pass_type and op->>'regionKey' is not distinct from b.region_key;
    if required_ is null or required_>policy.spend_cap_usd then raise exception 'Reviewed waiting operation missing';end if;
  end if;
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
  retry_at:=private.company_next_capacity_at(required_);
  -- A currently available slot may still be owned by an older waiting run.
  -- No date is fabricated when uncertain exposure has no known settlement.
  if retry_at is not null then retry_at:=greatest(now()+interval '15 seconds',retry_at);end if;
  update public.takeoff_runs set status='waiting_budget',not_before=retry_at,waiting_reason='company_budget',
    budget_wait_started_at=coalesce(budget_wait_started_at,now()),worker_lease_id=null,worker_lease_expires_at=null,
    error_code=null,processing_error=null,updated_at=now() where id=r.id;
  return jsonb_build_object('id',r.id,'status','waiting_budget','not_before',retry_at,'waiting_reason','company_budget');
end $$;

create or replace function public.due_full_takeoff_budget_runs(p_version text) returns table(run_id uuid)
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_version is distinct from 'takeoff-v2.2-durable' then return;end if;
  update public.takeoff_runs r set status='failed',error_code='reading_authorization_ended',
    processing_error='This reading needs review before processing can continue.',waiting_reason=null,not_before=null,updated_at=now()
    where r.status='waiting_budget' and (private.full_takeoff_authorized(r.id,r.requested_by) is not true or private.paid_full_dispatch_current(r.id) is not true);
  return query select r.id from public.takeoff_runs r where r.orchestrator_version=p_version and r.status='waiting_budget'
    and (r.not_before is null or r.not_before<=now()) and r.cancel_requested_at is null
    and private.full_takeoff_authorized(r.id,r.requested_by) is true and private.paid_full_dispatch_current(r.id) is true
    and private.company_next_capacity_at(private.full_waiting_operation_reservation(r.id))<=now()
    order by r.budget_wait_started_at,r.id limit 25;
end $$;
revoke all on function private.company_spend_exposure(),private.company_next_capacity_at(numeric),private.full_waiting_operation_reservation(uuid) from public,anon,authenticated,service_role;

drop function public.provider_bridge_schema_ready();
create function public.provider_bridge_schema_ready() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('ready',to_regclass('public.provider_bridge_operations') is not null
   and to_regprocedure('public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text,numeric)') is not null,
   'reservationCapability','reviewed-operation-reservations-v1');
$$;
revoke all on function public.provider_bridge_schema_ready() from public,anon,authenticated;
grant execute on function public.provider_bridge_schema_ready() to service_role;
revoke all on function private.full_contract_schedule_windows(jsonb,numeric,numeric) from public,anon,authenticated,service_role;

-- Settlement serializes with admission and cannot erase a known exposure.
-- A later explicit known receipt may resolve uncertainty; retries of the same
-- receipt do not move its rolling-window settlement time.
create or replace function public.capture_provider_spend(p_event_id uuid,p_estimated_cost_usd numeric default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare saved public.provider_spend_reservations;
begin
  perform 1 from public.provider_spend_policy where singleton for update;
  if p_estimated_cost_usd is not null and (p_estimated_cost_usd<0 or p_estimated_cost_usd::text in ('NaN','Infinity','-Infinity')) then
    raise exception 'Provider cost must be finite and nonnegative';end if;
  select * into saved from public.provider_spend_reservations where event_id=p_event_id for update;
  if not found then raise exception 'Provider spend reservation not found';end if;
  if saved.status='captured' and saved.telemetry_known is true then
    if saved.estimated_cost_usd is distinct from p_estimated_cost_usd then raise exception 'Known provider settlement cannot be replaced';end if;
    return;
  end if;
  if saved.status='captured' and p_estimated_cost_usd is null then return;end if;
  update public.provider_spend_reservations set status='captured',estimated_cost_usd=p_estimated_cost_usd,
    telemetry_known=p_estimated_cost_usd is not null,settled_at=now() where event_id=p_event_id;
end $$;

create or replace function public.reserve_paid_full_takeoff_v2(p_quote_id uuid,p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_file_id uuid,p_contract_hash text,p_version text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.project_reading_quotes; r public.takeoff_runs; manifest_ jsonb; sheet jsonb; pages integer;
begin
  perform 1 from public.provider_spend_policy where singleton for update;
  perform 1 from public.profiles where id=p_user_id for update;
  perform 1 from public.workspaces where id=p_workspace_id for update;
  select * into q from public.project_reading_quotes where id=p_quote_id and user_id=p_user_id and workspace_id=p_workspace_id
    and project_id=p_project_id and file_id=p_file_id and mode='full_v2' for update;
  if not found or p_version is distinct from 'takeoff-v2.2-durable' or not q.livemode or q.paid_at is null or q.payment_revision<=0
    or q.status not in ('paid','processing','complete','failed') or q.full_contract_hash is distinct from p_contract_hash
    or q.full_consent->>'approvedBy' is distinct from p_user_id::text or q.full_consent->>'confirmed' is distinct from 'true'
    or q.full_consent->>'contractHash' is distinct from q.full_contract_hash
    or not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator'))
    or not exists(select 1 from public.workspaces where id=p_workspace_id and ai_processing_consented_at is not null)
    then raise exception 'Confirmed paid Full entitlement required'; end if;
  if q.full_run_id is not null then
    select * into r from public.takeoff_runs where id=q.full_run_id;
    if not found or not private.full_takeoff_authorized(r.id,p_user_id) then raise exception 'Paid Full run authorization revoked'; end if;
    return jsonb_build_object('reused',true,'run',jsonb_build_object('id',r.id,'status',r.status,'progress',r.progress,'output_summary',r.output_summary));
  end if;
  if not public.full_takeoff_v2_worker_available(p_version) then raise exception 'Full Takeoff worker unavailable'; end if;
  if (public.paid_full_capacity_policy()->>'enabled') is distinct from 'true'
    or not exists(select 1 from public.paid_full_payment_holds where quote_id=q.id and released_at is null)
    then raise exception 'Company capacity cannot cover this Full reading';end if;
  -- Admission may wait across windows. Validate complete frozen bounds, never average holds.
  perform private.full_contract_schedule_windows(q.full_contract,coalesce((public.paid_full_capacity_policy()->>'window_capacity_usd')::numeric,(public.paid_full_capacity_policy()->>'spend_cap_usd')::numeric),
    (public.paid_full_capacity_policy()->>'available_usd')::numeric);
  manifest_:=q.full_contract->'manifest'; pages:=(manifest_->>'physicalPageCount')::integer;
  if pages not between 1 and 200 or jsonb_typeof(manifest_->'sheets') is distinct from 'array' or jsonb_array_length(manifest_->'sheets')<>pages
    or manifest_->>'fileSha256' is distinct from q.file_sha256 or pages<>q.page_count
    or not exists(select 1 from public.project_files where id=p_file_id and workspace_id=p_workspace_id and project_id=p_project_id
      and processing_status not in ('uploading','failed') and (page_count is null or page_count=0 or page_count=pages)) then raise exception 'Paid Full file revision unavailable'; end if;
  if not public.paid_full_daily_capacity_ready(p_user_id,q.id) then raise exception 'Daily Full Takeoff limit reached'; end if;
  manifest_:=manifest_||jsonb_build_object('paidAuthorization',jsonb_build_object('quoteId',q.id,'paymentRevision',q.payment_revision,
    'contractHash',q.full_contract_hash,'approvedBy',q.user_id,'contract',q.full_contract));
  insert into public.takeoff_runs(workspace_id,project_id,file_id,mode,status,file_sha256,orchestrator_version,requested_by,manifest,progress,payment_kind,payment_quote_id,payment_revision)
    values(p_workspace_id,p_project_id,p_file_id,'full','queued',q.file_sha256,p_version,p_user_id,manifest_,jsonb_build_object('completed',0,'total',pages*10),'paid',q.id,q.payment_revision) returning * into r;
  for sheet in select value from jsonb_array_elements(manifest_->'sheets') loop
    insert into public.plan_sheets(takeoff_run_id,workspace_id,project_id,file_id,physical_page_number,page_sha256,width_points,height_points,rotation_degrees,content_kind,text_quality,status,status_reason)
      values(r.id,p_workspace_id,p_project_id,p_file_id,(sheet->>'physicalPageNumber')::integer,sheet->>'pageSha256',(sheet->>'widthPoints')::numeric,(sheet->>'heightPoints')::numeric,
        (sheet->>'rotationDegrees')::integer,sheet->>'contentKind',sheet->>'textQuality','review_required','Paid deterministic preflight; source evidence and human review required.');
  end loop;
  update public.project_reading_quotes set full_run_id=r.id,status='processing' where id=q.id;
  return jsonb_build_object('reused',false,'run',jsonb_build_object('id',r.id,'status',r.status,'progress',r.progress));
end $$;
create or replace function public.create_full_reading_order(p_input jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.full_reading_orders; c jsonb; price jsonb; item jsonb; q public.project_reading_quotes;
  workspace_ uuid; project_ uuid; user_ uuid; count_ integer; cost_ bigint; amount_ bigint; fixed_ integer; fee_ integer; margin_ integer;
  membership_ text; version_ text; expiry_ timestamptz; used_ integer; first_contract jsonb; allocation_cost_ bigint;
begin
  c:=p_input->'contract'; price:=c->'pricing'; workspace_:=(p_input->>'workspace_id')::uuid;
  project_:=(p_input->>'project_id')::uuid; user_:=(p_input->>'user_id')::uuid;
  if jsonb_typeof(c) is distinct from 'object' or c->>'version' is distinct from 'paid-full-order-v1'
    or c->>'workspace_id' is distinct from workspace_::text or c->>'project_id' is distinct from project_::text or c->>'user_id' is distinct from user_::text
    or c->>'executionPolicy' is distinct from 'one-durable-run-budget-wait-no-uncertain-replay'
    or coalesce(p_input->>'contract_hash','')!~'^[a-f0-9]{64}$' or jsonb_typeof(c->'items') is distinct from 'array'
    or jsonb_array_length(c->'items') not between 1 and 20 then raise exception 'Invalid Full order contract'; end if;
  perform 1 from public.provider_spend_policy where singleton for update;
  perform 1 from public.profiles where id=user_ for update;
  if not found then raise exception 'Full order user unavailable'; end if;
  perform 1 from public.workspaces where id=workspace_ and ai_processing_consented_at is not null for update;
  if not found or not exists(select 1 from public.workspace_members where workspace_id=workspace_ and user_id=user_ and role in ('admin','estimator'))
    or not exists(select 1 from public.projects where id=project_ and workspace_id=workspace_) then raise exception 'Full order access denied'; end if;
  select * into o from public.full_reading_orders where contract_hash=p_input->>'contract_hash' for update;
  if found then
    if o.contract is distinct from c or (o.workspace_id,o.project_id,o.user_id) is distinct from (workspace_,project_,user_) then raise exception 'Full order contract hash conflict'; end if;
    return to_jsonb(o);
  end if;
  count_:=jsonb_array_length(c->'items');
  if (select count(distinct value->>'quote_id') from jsonb_array_elements(c->'items'))<>count_
    or (select count(distinct value->>'file_id') from jsonb_array_elements(c->'items'))<>count_
    or (select count(distinct value->>'file_sha256') from jsonb_array_elements(c->'items'))<>count_ then raise exception 'Duplicate Full order source'; end if;
  perform 1 from public.project_reading_quotes where id in (select (value->>'quote_id')::uuid from jsonb_array_elements(c->'items')) order by id for update;
  cost_:=0;
  for item in select value from jsonb_array_elements(c->'items') order by value->>'quote_id' loop
    select * into q from public.project_reading_quotes where id=(item->>'quote_id')::uuid;
    if not found or (q.workspace_id,q.project_id,q.user_id) is distinct from (workspace_,project_,user_)
      or q.mode<>'full_v2' or not q.livemode or q.status<>'quoted' or q.expires_at<=now()+interval '30 minutes'
      or q.stripe_session_id is not null or q.payment_intent_id is not null or q.paid_at is not null or q.full_run_id is not null or q.purchase_order_id is not null
      or q.full_consent is not null or exists(select 1 from public.paid_full_payment_holds where quote_id=q.id)
      or q.file_id::text is distinct from item->>'file_id' or q.file_sha256 is distinct from item->>'file_sha256'
      or q.full_contract_hash is distinct from item->>'full_contract_hash'
      or coalesce(item->>'amount_cents','')!~'^[0-9]+$' then raise exception 'Full order child is unavailable or mismatched'; end if;
    if q.full_contract->>'executionPolicy' is distinct from c->>'executionPolicy' or q.currency<>'usd'
      or q.pricing_version is distinct from price->>'version' or q.membership is distinct from price->>'membership'
      or q.full_contract->'pricing'->'paymentFixedCents' is distinct from price->'paymentFixedCents'
      or q.full_contract->'pricing'->'paymentFeeBps' is distinct from price->'paymentFeeBps'
      or q.full_contract->'pricing'->'marginBps' is distinct from price->'marginBps' then raise exception 'Full order pricing policies differ'; end if;
    if first_contract is null then first_contract:=q.full_contract;
    elsif q.full_contract->>'version' is distinct from first_contract->>'version'
      or q.full_contract->>'policyId' is distinct from first_contract->>'policyId'
      or q.full_contract->'profile'->>'profileHash' is distinct from first_contract->'profile'->>'profileHash'
      or q.full_contract->'pricing'->'callReservationUsd' is distinct from first_contract->'pricing'->'callReservationUsd'
      or q.full_contract->'pricing'->'overheadBasePolicy' is distinct from first_contract->'pricing'->'overheadBasePolicy'
      or q.full_contract->'pricing'->'overheadBaseCents' is distinct from first_contract->'pricing'->'overheadBaseCents'
      or q.full_contract->'pricing'->'overheadPageCents' is distinct from first_contract->'pricing'->'overheadPageCents' then
      raise exception 'Full order processing policies differ';end if;
    cost_:=cost_+q.cost_cents; expiry_:=least(expiry_,q.expires_at);
  end loop;
  allocation_cost_:=cost_;
  if first_contract->>'version'='paid-full-v2' then
    if price->>'overheadBasePolicy' is distinct from 'purchase'
      or price->'overheadBaseCents' is distinct from first_contract->'pricing'->'overheadBaseCents'
      or price->'overheadPageCents' is distinct from first_contract->'pricing'->'overheadPageCents' then
      raise exception 'Full order overhead must apply once to this purchase';end if;
    cost_:=cost_-(count_-1)*(price->>'overheadBaseCents')::bigint;
  end if;
  membership_:=price->>'membership'; version_:=price->>'version';
  margin_:=case membership_ when 'standard' then 5000 when 'starter' then 4000 when 'pro' then 3500 when 'team' then 3000 when 'enterprise' then 2000 end;
  if price->>'currency' is distinct from 'usd' or coalesce(price->>'costCents','')!~'^[0-9]+$'
    or coalesce(price->>'amountCents','')!~'^[0-9]+$' or coalesce(price->>'paymentFixedCents','')!~'^[0-9]+$'
    or coalesce(price->>'paymentFeeBps','')!~'^[0-9]+$' or (price->>'marginBps')::integer is distinct from margin_
    or margin_ is null or cost_<>(price->>'costCents')::bigint then raise exception 'Invalid Full order pricing'; end if;
  fixed_:=(price->>'paymentFixedCents')::integer; fee_:=(price->>'paymentFeeBps')::integer;
  if fee_+margin_>=10000 then raise exception 'Invalid Full order fee'; end if;
  amount_:=ceil((cost_+fixed_)::numeric*10000/(10000-margin_-fee_));
  if amount_<>(price->>'amountCents')::bigint or amount_ not between 1 and 99999999 then raise exception 'Full order total does not match one payment fee'; end if;
  if exists(with weights as (
      select i.quote_id,i.amount_cents,child_quote.cost_cents,floor(amount_::numeric*child_quote.cost_cents/allocation_cost_) base,
        mod(amount_::numeric*child_quote.cost_cents,allocation_cost_) remainder
      from jsonb_to_recordset(c->'items') as i(quote_id uuid,amount_cents integer) join public.project_reading_quotes child_quote on child_quote.id=i.quote_id
    ), ranked as (select *,row_number() over(order by remainder desc,quote_id) position,amount_-sum(base) over() remaining from weights)
    select 1 from ranked where amount_cents is distinct from (base+case when position<=remaining then 1 else 0 end)::integer)
    then raise exception 'Full order allocation does not match deterministic largest remainders'; end if;
  select count(*) into used_ from public.takeoff_runs where requested_by=user_ and created_at>now()-interval '24 hours';
  select used_+count(*) into used_ from public.paid_full_payment_holds h join public.project_reading_quotes child_quote on child_quote.id=h.quote_id
    where child_quote.user_id=user_ and child_quote.full_run_id is null and h.released_at is null;
  if used_+count_>25 then raise exception 'Daily Full order capacity unavailable'; end if;
  insert into public.full_reading_orders(workspace_id,project_id,user_id,contract,contract_hash,amount_cents,cost_cents,membership,expires_at)
    values(workspace_,project_,user_,c,p_input->>'contract_hash',amount_,cost_,membership_,expiry_) returning * into o;
  insert into private.full_reading_order_write_guards values(txid_current(),pg_backend_pid(),o.id);
  insert into public.full_reading_order_items(order_id,quote_id,file_id,amount_cents,full_contract_hash,file_sha256)
    select o.id,i.quote_id,i.file_id,i.amount_cents,i.full_contract_hash,i.file_sha256
      from jsonb_to_recordset(c->'items') as i(quote_id uuid,file_id uuid,amount_cents integer,full_contract_hash text,file_sha256 text);
  update public.project_reading_quotes set purchase_order_id=o.id where id in(select quote_id from public.full_reading_order_items where order_id=o.id);
  perform private.check_full_reading_order_schedule(o.id);
  delete from private.full_reading_order_write_guards where transaction_id=txid_current() and backend_pid=pg_backend_pid() and order_id=o.id;
  return to_jsonb(o);
end $$;
