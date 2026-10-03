-- One checkout purchases several immutable PDF contracts. Provider dispatch
-- remains governed by each child's existing paid authorization and budgets.
create table public.full_reading_orders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  project_id uuid not null,
  user_id uuid not null references auth.users(id),
  contract jsonb not null check(jsonb_typeof(contract)='object'),
  contract_hash text not null unique check(contract_hash~'^[a-f0-9]{64}$'),
  amount_cents integer not null check(amount_cents between 1 and 99999999),
  cost_cents integer not null check(cost_cents>0),
  currency text not null default 'usd' check(currency='usd'),
  membership text not null check(membership in ('standard','starter','pro','team','enterprise')),
  status text not null default 'quoted' check(status in ('quoted','paid','revoked')),
  livemode boolean not null default true check(livemode),
  expires_at timestamptz not null,
  consent jsonb,
  paid_at timestamptz,
  payment_revision bigint not null default 0 check(payment_revision>=0),
  stripe_session_id text unique,
  stripe_payment_intent text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(project_id,workspace_id) references public.projects(id,workspace_id)
);
alter table public.project_reading_quotes add column purchase_order_id uuid references public.full_reading_orders(id);
create table public.full_reading_order_items (
  order_id uuid not null references public.full_reading_orders(id),
  quote_id uuid not null unique references public.project_reading_quotes(id),
  file_id uuid not null references public.project_files(id),
  amount_cents integer not null check(amount_cents>0),
  full_contract_hash text not null check(full_contract_hash~'^[a-f0-9]{64}$'),
  file_sha256 text not null check(file_sha256~'^[a-f0-9]{64}$'),
  primary key(order_id,quote_id), unique(order_id,file_id), unique(order_id,file_sha256)
);
create table public.full_reading_order_events (
  event_id text primary key,
  order_id uuid not null references public.full_reading_orders(id),
  event_kind text not null check(event_kind in ('paid','expired','failed','refund','dispute')),
  session_id text not null,
  payment_intent text,
  amount_cents integer,
  currency text,
  livemode boolean not null check(livemode),
  created_at timestamptz not null default now()
);
alter table public.full_reading_orders enable row level security;
alter table public.full_reading_order_items enable row level security;
alter table public.full_reading_order_events enable row level security;
revoke all on public.full_reading_orders,public.full_reading_order_items,public.full_reading_order_events from public,anon,authenticated,service_role;
grant select on public.full_reading_orders,public.full_reading_order_items,public.full_reading_order_events to service_role;

-- A private, transaction-scoped capability. A caller-controlled GUC cannot
-- authorize child payment writes, and the capability is removed before return.
create table private.full_reading_order_write_guards (
  transaction_id bigint not null, backend_pid integer not null,
  order_id uuid not null references public.full_reading_orders(id),
  primary key(transaction_id,backend_pid,order_id)
);
revoke all on private.full_reading_order_write_guards from public,anon,authenticated,service_role;
create function private.protect_ordered_full_child() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare order_ uuid;
begin
  order_:=coalesce(old.purchase_order_id,new.purchase_order_id);
  if order_ is null then return new; end if;
  if new.mode<>'full_v2' or new.stripe_session_id is not null or new.payment_intent_id is not null then
    raise exception 'Ordered Full payment belongs to its order'; end if;
  if old.purchase_order_id is not null and new.purchase_order_id is distinct from old.purchase_order_id then
    raise exception 'Full order membership is immutable'; end if;
  if (new.purchase_order_id,new.full_consent,new.paid_at,new.payment_revision) is distinct from
      (old.purchase_order_id,old.full_consent,old.paid_at,old.payment_revision)
    or new.status is distinct from old.status and (new.status in ('paid','revoked') or old.status in ('quoted','revoked')) then
    if not exists(select 1 from private.full_reading_order_write_guards where transaction_id=txid_current()
      and backend_pid=pg_backend_pid() and order_id=order_) then raise exception 'Ordered Full payment requires its order operation'; end if;
  end if;
  return new;
end $$;
create trigger protect_ordered_full_child before update on public.project_reading_quotes for each row execute function private.protect_ordered_full_child();

create function private.full_source_has_purchase(p_workspace_id uuid,p_project_id uuid,p_user_id uuid,p_sha text,p_exclude_quote uuid default null)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.project_reading_quotes source_quote
    left join public.full_reading_orders source_order on source_order.id=source_quote.purchase_order_id
    where source_quote.workspace_id=p_workspace_id and source_quote.project_id=p_project_id and source_quote.user_id=p_user_id
      and source_quote.mode='full_v2' and source_quote.livemode and source_quote.file_sha256=p_sha
      and source_quote.status<>'revoked' and (p_exclude_quote is null or source_quote.id<>p_exclude_quote)
      and (source_quote.paid_at is not null or source_quote.full_consent is not null or source_quote.stripe_session_id is not null
        or source_quote.payment_intent_id is not null or source_order.consent is not null or source_order.stripe_session_id is not null
        or source_order.paid_at is not null or exists(select 1 from public.paid_full_payment_holds where quote_id=source_quote.id)));
$$;

alter function public.accept_paid_full_quote(uuid,uuid,uuid,uuid,text) rename to accept_paid_full_quote_before_orders;
revoke all on function public.accept_paid_full_quote_before_orders(uuid,uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.accept_paid_full_quote(p_quote_id uuid,p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_contract_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.project_reading_quotes;
begin
  perform 1 from public.provider_spend_policy where singleton for update;
  select * into q from public.project_reading_quotes where id=p_quote_id;
  if q.purchase_order_id is not null and not exists(select 1 from private.full_reading_order_write_guards where transaction_id=txid_current()
      and backend_pid=pg_backend_pid() and order_id=q.purchase_order_id) then raise exception 'Accept the combined Full order before paying'; end if;
  if private.full_source_has_purchase(p_workspace_id,p_project_id,p_user_id,q.file_sha256,q.id) then
    raise exception 'PDF already belongs to an accepted or paid purchase'; end if;
  return public.accept_paid_full_quote_before_orders(p_quote_id,p_user_id,p_workspace_id,p_project_id,p_contract_hash);
end $$;
revoke all on function public.accept_paid_full_quote(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.accept_paid_full_quote(uuid,uuid,uuid,uuid,text) to service_role;

-- A changed selection may use fresh children from an unaccepted quote. An
-- accepted, uncertain or paid checkout is never implicitly purchased twice.
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
  if new_child and private.full_source_has_purchase(v.workspace_id,v.project_id,v.user_id,v.file_sha256) then
    raise exception 'PDF already belongs to an accepted or paid purchase'; end if;
  if not public.paid_full_capacity_ready((v.full_contract->'pricing'->>'operatingReserveUsd')::numeric,
    (v.full_contract->'pricing'->>'operatingReserveUsd')::numeric/nullif((v.full_contract->>'maximumCalls')::integer,0)) then raise exception 'Company capacity cannot cover this Full reading'; end if;
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

create function private.check_full_reading_order_schedule(p_order_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare policy jsonb; cap numeric; reserve_ numeric; window_ numeric; available_ numeric; calls_ numeric; expiry_ timestamptz; windows_ numeric;
begin
  policy:=public.paid_full_capacity_policy(); cap:=(policy->>'spend_cap_usd')::numeric;
  reserve_:=(policy->>'call_reservation_usd')::numeric; window_:=(policy->>'rolling_window_seconds')::numeric;
  available_:=(policy->>'available_usd')::numeric;
  if policy->>'enabled' is distinct from 'true' or cap is null or reserve_ is null or window_ is null or reserve_<=0 or cap<reserve_ or window_<=0 then
    raise exception 'Full order processing capacity unavailable'; end if;
  select sum((q.full_contract->>'maximumCalls')::numeric),min((q.full_contract->'pricing'->>'expiresAt')::timestamptz)
    into calls_,expiry_ from public.full_reading_order_items i join public.project_reading_quotes q on q.id=i.quote_id where i.order_id=p_order_id;
  if calls_ is null or calls_<=0 or expiry_ is null or exists(select 1 from public.full_reading_order_items i join public.project_reading_quotes q on q.id=i.quote_id
      where i.order_id=p_order_id and (q.full_contract->'pricing'->>'operatingReserveUsd')::numeric/nullif((q.full_contract->>'maximumCalls')::numeric,0) is distinct from reserve_)
    then raise exception 'Full order reservation profile changed'; end if;
  windows_:=ceil(calls_/floor(cap/reserve_));
  if now()+(windows_-1+case when available_ is null or available_<reserve_ then 1 else 0 end)*window_*interval '1 second'>=expiry_ then
    raise exception 'Full order schedule exceeds the reviewed price validity'; end if;
end $$;

create function public.create_full_reading_order(p_input jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.full_reading_orders; c jsonb; price jsonb; item jsonb; q public.project_reading_quotes;
  workspace_ uuid; project_ uuid; user_ uuid; count_ integer; cost_ bigint; amount_ bigint; fixed_ integer; fee_ integer; margin_ integer;
  membership_ text; version_ text; expiry_ timestamptz; used_ integer;
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
    cost_:=cost_+q.cost_cents; expiry_:=least(expiry_,q.expires_at);
  end loop;
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
      select i.quote_id,i.amount_cents,child_quote.cost_cents,floor(amount_::numeric*child_quote.cost_cents/cost_) base,
        mod(amount_::numeric*child_quote.cost_cents,cost_) remainder
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

create function public.accept_full_reading_order(p_order_id uuid,p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_contract_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.full_reading_orders; item record;
begin
  perform 1 from public.provider_spend_policy where singleton for update;
  perform 1 from public.profiles where id=p_user_id for update;
  select * into o from public.full_reading_orders where id=p_order_id and user_id=p_user_id and workspace_id=p_workspace_id and project_id=p_project_id for update;
  if not found or o.status<>'quoted' or not o.livemode or o.contract_hash is distinct from p_contract_hash or o.expires_at<=now()
    or o.stripe_session_id is null and (o.expires_at<now()+interval '30 minutes' or o.expires_at>now()+interval '24 hours')
    then raise exception 'Current Full order consent is required'; end if;
  perform private.check_full_reading_order_schedule(o.id);
  insert into private.full_reading_order_write_guards values(txid_current(),pg_backend_pid(),o.id);
  for item in select q.id,q.full_contract_hash from public.full_reading_order_items i join public.project_reading_quotes q on q.id=i.quote_id
    where i.order_id=o.id order by q.id for update of q loop
    perform public.accept_paid_full_quote(item.id,p_user_id,p_workspace_id,p_project_id,item.full_contract_hash);
  end loop;
  if o.consent is null then
    update public.full_reading_orders set consent=jsonb_build_object('confirmed',true,'approvedBy',p_user_id,'approvedAt',now(),'contractHash',p_contract_hash),updated_at=now()
      where id=o.id returning * into o;
  end if;
  delete from private.full_reading_order_write_guards where transaction_id=txid_current() and backend_pid=pg_backend_pid() and order_id=o.id;
  return to_jsonb(o);
end $$;

create function public.save_full_reading_order_session(p_order_id uuid,p_session_id text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.full_reading_orders;
begin
  select * into o from public.full_reading_orders where id=p_order_id for update;
  if not found or o.status<>'quoted' or o.consent->>'confirmed' is distinct from 'true'
    or o.consent->>'contractHash' is distinct from o.contract_hash or coalesce(p_session_id,'')!~'^cs_[A-Za-z0-9_]+$'
    or o.stripe_session_id is not null and o.stripe_session_id<>p_session_id then raise exception 'Full order session mismatch'; end if;
  update public.full_reading_orders set stripe_session_id=p_session_id,updated_at=now() where id=o.id returning * into o;
  return to_jsonb(o);
end $$;

create function private.record_full_reading_order_event(p_event_id text,p_order_id uuid,p_kind text,p_session_id text,p_intent text,p_amount integer,p_currency text,p_livemode boolean)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare previous public.full_reading_order_events;
begin
  if coalesce(p_event_id,'')!~'^evt_[A-Za-z0-9_]+$' then raise exception 'Invalid Full order event'; end if;
  insert into public.full_reading_order_events(event_id,order_id,event_kind,session_id,payment_intent,amount_cents,currency,livemode)
    values(p_event_id,p_order_id,p_kind,p_session_id,p_intent,p_amount,p_currency,p_livemode) on conflict do nothing;
  if found then return true; end if;
  select * into previous from public.full_reading_order_events where event_id=p_event_id;
  if (previous.order_id,previous.event_kind,previous.session_id,previous.payment_intent,previous.amount_cents,previous.currency,previous.livemode)
    is distinct from (p_order_id,p_kind,p_session_id,p_intent,p_amount,p_currency,p_livemode) then raise exception 'Full order event identity conflict'; end if;
  return false;
end $$;

create function public.confirm_full_reading_order_payment(p_event_id text,p_order_id uuid,p_session_id text,p_payment_intent text,p_amount integer,p_currency text,p_livemode boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.full_reading_orders;
begin
  perform 1 from public.provider_spend_policy where singleton for update;
  select * into o from public.full_reading_orders where id=p_order_id for update;
  if not found or not o.livemode or p_livemode is distinct from true or o.stripe_session_id is distinct from p_session_id
    or coalesce(p_payment_intent,'')!~'^pi_[A-Za-z0-9_]+$' or p_amount is distinct from o.amount_cents or lower(btrim(p_currency)) is distinct from o.currency
    or o.stripe_payment_intent is not null and o.stripe_payment_intent<>p_payment_intent
    or o.consent->>'confirmed' is distinct from 'true' or o.consent->>'contractHash' is distinct from o.contract_hash
    or o.consent->>'approvedBy' is distinct from o.user_id::text then raise exception 'Full order payment mismatch'; end if;
  if not private.record_full_reading_order_event(p_event_id,o.id,'paid',p_session_id,p_payment_intent,p_amount,o.currency,true) then return to_jsonb(o); end if;
  if o.status='revoked' or o.paid_at is not null then return to_jsonb(o); end if;
  perform 1 from public.project_reading_quotes q join public.full_reading_order_items i on i.quote_id=q.id where i.order_id=o.id order by q.id for update of q;
  if exists(select 1 from public.full_reading_order_items i join public.project_reading_quotes q on q.id=i.quote_id where i.order_id=o.id
    and (q.purchase_order_id is distinct from o.id or q.status<>'quoted' or q.paid_at is not null or q.full_consent->>'confirmed' is distinct from 'true'
      or q.full_consent->>'contractHash' is distinct from q.full_contract_hash or q.full_consent->>'approvedBy' is distinct from o.user_id::text
      or not exists(select 1 from public.paid_full_payment_holds where quote_id=q.id and released_at is null))) then raise exception 'Full order child authorization changed'; end if;
  insert into private.full_reading_order_write_guards values(txid_current(),pg_backend_pid(),o.id);
  update public.full_reading_orders set status='paid',paid_at=now(),payment_revision=payment_revision+1,stripe_payment_intent=p_payment_intent,updated_at=now() where id=o.id returning * into o;
  update public.project_reading_quotes set status='paid',paid_at=now(),payment_revision=payment_revision+1 where purchase_order_id=o.id;
  delete from private.full_reading_order_write_guards where transaction_id=txid_current() and backend_pid=pg_backend_pid() and order_id=o.id;
  return to_jsonb(o);
end $$;

create function public.close_full_reading_order_payment(p_event_id text,p_order_id uuid,p_session_id text,p_payment_intent text,p_livemode boolean,p_reason text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.full_reading_orders;
begin
  perform 1 from public.provider_spend_policy where singleton for update;
  select * into o from public.full_reading_orders where id=p_order_id for update;
  if not found or p_reason not in ('expired','failed','refund','dispute') or p_livemode is distinct from true
    or (p_session_id is not null and o.stripe_session_id is distinct from p_session_id)
    or (p_session_id is null and (p_reason not in ('refund','dispute') or o.stripe_payment_intent is null or o.stripe_payment_intent is distinct from p_payment_intent))
    or o.stripe_session_id is null
    or o.stripe_payment_intent is not null and p_payment_intent is not null and o.stripe_payment_intent<>p_payment_intent
    or p_reason in ('refund','dispute') and (coalesce(p_payment_intent,'')!~'^pi_[A-Za-z0-9_]+$'
      or o.stripe_payment_intent is not null and o.stripe_payment_intent<>p_payment_intent) then raise exception 'Full order closing event mismatch'; end if;
  if not private.record_full_reading_order_event(p_event_id,o.id,p_reason,o.stripe_session_id,p_payment_intent,null,null,true) then return false; end if;
  if o.status='revoked' or p_reason in ('expired','failed') and o.paid_at is not null then return false; end if;
  -- Lifecycle writers lock run then quote. Keep that order while fencing all
  -- siblings, so a completion/refund race cannot invert those row locks.
  perform 1 from public.takeoff_runs where payment_quote_id in
    (select quote_id from public.full_reading_order_items where order_id=o.id) order by id for update;
  perform 1 from public.project_reading_quotes q where purchase_order_id=o.id order by id for update;
  insert into private.full_reading_order_write_guards values(txid_current(),pg_backend_pid(),o.id);
  update public.full_reading_orders set status='revoked',payment_revision=payment_revision+1,
    stripe_payment_intent=coalesce(stripe_payment_intent,p_payment_intent),updated_at=now() where id=o.id;
  update public.project_reading_quotes set status='revoked',payment_revision=payment_revision+1 where purchase_order_id=o.id;
  update public.paid_full_payment_holds set released_at=coalesce(released_at,now()),release_reason=p_reason
    where quote_id in(select quote_id from public.full_reading_order_items where order_id=o.id);
  update public.takeoff_runs set cancel_requested_at=coalesce(cancel_requested_at,now()),status='cancelled',worker_lease_id=null,worker_lease_expires_at=null,
    waiting_reason=null,not_before=null,updated_at=now() where payment_quote_id in(select quote_id from public.full_reading_order_items where order_id=o.id)
    and status in ('queued','processing','waiting_budget','failed');
  delete from private.full_reading_order_write_guards where transaction_id=txid_current() and backend_pid=pg_backend_pid() and order_id=o.id;
  return true;
end $$;

revoke all on function private.protect_ordered_full_child(),private.full_source_has_purchase(uuid,uuid,uuid,text,uuid),private.check_full_reading_order_schedule(uuid),
  private.record_full_reading_order_event(text,uuid,text,text,text,integer,text,boolean) from public,anon,authenticated,service_role;
revoke all on function public.create_full_reading_order(jsonb),public.accept_full_reading_order(uuid,uuid,uuid,uuid,text),
  public.save_full_reading_order_session(uuid,text),public.confirm_full_reading_order_payment(text,uuid,text,text,integer,text,boolean),
  public.close_full_reading_order_payment(text,uuid,text,text,boolean,text) from public,anon,authenticated;
grant execute on function public.create_full_reading_order(jsonb),public.accept_full_reading_order(uuid,uuid,uuid,uuid,text),
  public.save_full_reading_order_session(uuid,text),public.confirm_full_reading_order_payment(text,uuid,text,text,integer,text,boolean),
  public.close_full_reading_order_payment(text,uuid,text,text,boolean,text) to service_role;
