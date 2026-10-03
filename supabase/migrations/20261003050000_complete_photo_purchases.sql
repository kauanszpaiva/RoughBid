-- Complete photo batches remain separate from PDF contracts. No model, tariff,
-- company cap, provider credential or product enablement is seeded here.
create table public.photo_reading_quotes (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),project_id uuid not null,
 user_id uuid not null references auth.users(id),contract jsonb not null,contract_hash text not null check(contract_hash~'^[a-f0-9]{64}$'),
 amount_cents integer not null check(amount_cents between 1 and 99999999),cost_cents integer not null check(cost_cents>0),currency text not null default 'usd' check(currency='usd'),
 status text not null default 'quoted' check(status in ('quoted','paid','processing','complete','failed','revoked')),livemode boolean not null default true check(livemode),
 expires_at timestamptz not null default now()+interval '1 hour',consent jsonb,paid_at timestamptz,payment_revision bigint not null default 0,
 stripe_session_id text unique,stripe_payment_intent text unique,run_id uuid unique references public.photo_takeoff_runs(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),foreign key(project_id,workspace_id) references public.projects(id,workspace_id)
);
create index photo_reading_quotes_scope on public.photo_reading_quotes(workspace_id,project_id,user_id,created_at);
create table public.photo_reading_payment_events(event_id text primary key,quote_id uuid not null references public.photo_reading_quotes(id),
 kind text not null check(kind in ('paid','expired','failed','refund','dispute')),session_id text not null,intent text,amount_cents integer,currency text,created_at timestamptz not null default now());
alter table public.photo_takeoff_runs add column photo_quote_id uuid unique references public.photo_reading_quotes(id),add column payment_revision bigint,
 add column not_before timestamptz,add column budget_wait_started_at timestamptz;
alter table public.photo_takeoff_runs drop constraint photo_takeoff_runs_status_check;
alter table public.photo_takeoff_runs add constraint photo_takeoff_runs_status_check check(status in ('queued','processing','waiting_budget','needs_review','blocked','cancelled'));
create table public.photo_stage_checkpoints(run_id uuid not null references public.photo_takeoff_runs(id),operation_key text not null,
 stage text not null check(stage in ('observation','reconciliation','risk_review')),asset_ids uuid[] not null,
 status text not null default 'pending' check(status in ('pending','admitted','processing','completed')),event_id uuid unique references public.api_usage_events(id),
 result jsonb,started_at timestamptz,completed_at timestamptz,primary key(run_id,operation_key));
alter table public.provider_spend_reservations add column photo_stage_key text;
alter table public.provider_spend_reservations add constraint photo_stage_reservation foreign key(photo_run_id,photo_stage_key) references public.photo_stage_checkpoints(run_id,operation_key);
create table public.complete_photo_provider_budgets(run_id uuid not null references public.photo_takeoff_runs(id),provider text not null,
 approved_usd numeric(12,6) not null check(approved_usd>0),maximum_calls integer not null check(maximum_calls>0),primary key(run_id,provider));
alter table public.photo_reading_quotes enable row level security;
alter table public.photo_reading_payment_events enable row level security;
alter table public.photo_stage_checkpoints enable row level security;
alter table public.complete_photo_provider_budgets enable row level security;
revoke all on public.photo_reading_quotes,public.photo_reading_payment_events,public.photo_stage_checkpoints,public.complete_photo_provider_budgets from public,anon,authenticated,service_role;
grant select on public.photo_reading_quotes,public.photo_reading_payment_events,public.photo_stage_checkpoints,public.complete_photo_provider_budgets to service_role;

create function private.photo_member(p_user uuid,p_workspace uuid,p_project uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.workspace_members where workspace_id=p_workspace and user_id=p_user and role in ('admin','estimator'))
 and exists(select 1 from public.projects where id=p_project and workspace_id=p_workspace)
 and exists(select 1 from public.workspaces where id=p_workspace and ai_processing_consented_at is not null);
$$;
create function private.complete_photo_authorized(p_run_id uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.photo_takeoff_runs r where r.id=p_run_id and private.photo_member(r.requested_by,r.workspace_id,r.project_id)
 and r.manifest->>'completeVersion'='photo-complete-v1' and ((r.photo_quote_id is null and exists(select 1 from public.profiles where id=r.requested_by and is_platform_admin)
 and r.manifest->'includedAuthorization'->>'confirmed'='true') or exists(select 1 from public.photo_reading_quotes q where q.id=r.photo_quote_id
 and q.run_id=r.id and q.workspace_id=r.workspace_id and q.project_id=r.project_id and q.user_id=r.requested_by and q.livemode
 and q.paid_at is not null and q.status in ('paid','processing','complete','failed') and q.payment_revision=r.payment_revision
 and q.consent->>'confirmed'='true' and q.consent->>'approvedBy'=r.requested_by::text and q.consent->>'contractHash'=q.contract_hash
 and r.manifest->>'purchaseContractHash'=q.contract_hash)));
$$;
create function private.validate_complete_photo_manifest(p_manifest jsonb,p_workspace uuid,p_project uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb;op jsonb;n integer;keys_ text[];ids_ uuid[];pair_count integer;expected_key text;
begin
 if p_manifest->>'completeVersion' is distinct from 'photo-complete-v1' or p_manifest->>'executionPolicy' is distinct from 'one-durable-photo-run-budget-wait-no-uncertain-replay'
 or jsonb_typeof(p_manifest->'assets') is distinct from 'array' or jsonb_array_length(p_manifest->'assets') not between 1 and 8
 or jsonb_typeof(p_manifest->'operations') is distinct from 'array' or jsonb_typeof(p_manifest->'profile') is distinct from 'object'
 or coalesce(p_manifest->'profile'->>'profileHash','')!~'^[a-f0-9]{64}$' or (p_manifest->>'expiresAt')::timestamptz<=now() then raise exception 'Complete photo manifest invalid';end if;
 n:=jsonb_array_length(p_manifest->'assets');pair_count:=greatest(1,n*(n-1)/2);
 if jsonb_array_length(p_manifest->'operations')<>2*n+pair_count or (p_manifest->>'maximumCalls')::integer<>2*n+pair_count
 or (select count(distinct value->>'id') from jsonb_array_elements(p_manifest->'assets'))<>n
 or (select count(distinct value->>'sha256') from jsonb_array_elements(p_manifest->'assets'))<>n then raise exception 'Complete photo coverage invalid';end if;
 select array_agg((value->>'id')::uuid order by value->>'id') into ids_ from jsonb_array_elements(p_manifest->'assets');
 for a in select value from jsonb_array_elements(p_manifest->'assets') loop
  if not exists(select 1 from public.photo_assets where id=(a->>'id')::uuid and workspace_id=p_workspace and project_id=p_project and status='ready'
   and sha256=a->>'sha256' and sha256=a->>'revision' and mime_type=a->>'mimeType' and byte_size=(a->>'byteSize')::bigint
   and width_pixels=(a->>'widthPixels')::integer and height_pixels=(a->>'heightPixels')::integer
   and a->>'workspaceId'=p_workspace::text and a->>'projectId'=p_project::text and a->'storageVerified'='true'::jsonb)then raise exception 'Photo source not verified';end if;
 end loop;
 if (select sum((value->>'byteSize')::bigint) from jsonb_array_elements(p_manifest->'assets'))>41943040 then raise exception 'Photo batch exceeds size bound';end if;
 keys_:='{}';
 for op in select value from jsonb_array_elements(p_manifest->'operations') loop
  if op->>'stage' not in ('observation','reconciliation','risk_review') or jsonb_typeof(op->'assetIds') is distinct from 'array'
    or jsonb_array_length(op->'assetIds')<>(case when op->>'stage'='reconciliation' and n>1 then 2 else 1 end)
    or exists(select 1 from jsonb_array_elements_text(op->'assetIds') x where not x::uuid=any(ids_))then raise exception 'Photo operation scope invalid';end if;
  select (op->>'stage')||':'||string_agg(value,':' order by value) into expected_key from jsonb_array_elements_text(op->'assetIds');
  if op->>'key' is distinct from expected_key or expected_key=any(keys_)
   or (select count(distinct value) from jsonb_array_elements_text(op->'assetIds'))<>jsonb_array_length(op->'assetIds') then raise exception 'Photo operation identity invalid';end if;
  keys_:=array_append(keys_,expected_key);
 end loop;
 if (select count(*) from jsonb_array_elements(p_manifest->'operations') where value->>'stage'='observation')<>n
 or (select count(*) from jsonb_array_elements(p_manifest->'operations') where value->>'stage'='risk_review')<>n then raise exception 'Photo stage coverage invalid';end if;
end $$;
create function private.photo_quote_manifest(p_contract jsonb) returns jsonb language sql immutable set search_path=public,pg_temp as $$
 select jsonb_build_object('completeVersion','photo-complete-v1','assets',p_contract->'assets','references','[]'::jsonb,'operations',p_contract->'operations',
 'profile',p_contract->'profile','executionPolicy',p_contract->'executionPolicy','maximumCalls',p_contract->'maximumCalls','providers',p_contract->'providers',
 'callReservationUsd',p_contract->'pricing'->'callReservationUsd','expiresAt',p_contract->'pricing'->'expiresAt');
$$;
create function private.check_photo_schedule(p_manifest jsonb)returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.provider_spend_policy;available_ numeric;capacity_ numeric;windows_ integer:=0;op jsonb;reserve_ numeric;
begin
 select * into p from public.provider_spend_policy where singleton for update;
 if not found or not p.enabled or p.call_reservation_usd is distinct from (p_manifest->>'callReservationUsd')::numeric
 or p.call_reservation_usd<=0 or p.spend_cap_usd<p.call_reservation_usd then raise exception 'Photo processing capacity unavailable';end if;
 capacity_:=coalesce((public.paid_full_capacity_policy()->>'window_capacity_usd')::numeric,p.spend_cap_usd);
 available_:=greatest(0,least(capacity_,coalesce((public.paid_full_capacity_policy()->>'available_usd')::numeric,0)));
 for op in select value from jsonb_array_elements(p_manifest->'operations')loop
 reserve_:=(op->>'reservationUsd')::numeric;
 if reserve_ is null or reserve_::text in('NaN','Infinity','-Infinity')or reserve_*1000000<>trunc(reserve_*1000000)
 or reserve_<>greatest(p.call_reservation_usd,(p_manifest->'profile'->'routes'->(op->>'stage')->>'maximumCallCostUsd')::numeric)or reserve_>capacity_ then raise exception 'Photo operation reservation exceeds reviewed capacity';end if;
 if available_<reserve_ then windows_:=windows_+1;available_:=capacity_;end if;available_:=available_-reserve_;
 end loop;
 if now()+windows_*p.rolling_window>=(p_manifest->>'expiresAt')::timestamptz then raise exception 'Photo schedule exceeds reviewed tariff validity';end if;
end $$;
create function private.photo_daily_capacity(p_user uuid,p_quote uuid default null)returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select (select count(*)from public.photo_takeoff_runs where requested_by=p_user and created_at>now()-interval '24 hours')
 +(select count(*)from public.takeoff_runs where requested_by=p_user and created_at>now()-interval '24 hours')
 +(select count(*)from public.plan_reading_jobs where requested_by=p_user and created_at>now()-interval '24 hours')
 +(select count(*)from public.photo_reading_quotes where user_id=p_user and status<>'revoked'and consent is not null and run_id is null and(p_quote is null or id<>p_quote))
 +(select count(*)from public.paid_full_payment_holds h join public.project_reading_quotes q on q.id=h.quote_id where q.user_id=p_user and q.full_run_id is null and h.released_at is null)<25;
$$;
create function public.create_photo_reading_quote(p_input jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c jsonb:=p_input->'contract';m jsonb;q public.photo_reading_quotes;u uuid;w uuid;p uuid;price jsonb;margin_ integer;amount_ numeric;cost_ numeric;reserve_ numeric;
begin
 u:=(c->>'userId')::uuid;w:=(c->>'workspaceId')::uuid;p:=(c->>'projectId')::uuid;price:=c->'pricing';
 if not private.photo_member(u,w,p)then raise exception 'Photo purchase access denied';end if;
 if c->>'version' is distinct from 'paid-photo-v1' or coalesce(p_input->>'contract_hash','')!~'^[a-f0-9]{64}$'then raise exception 'Photo purchase contract invalid';end if;
 m:=private.photo_quote_manifest(c);perform private.validate_complete_photo_manifest(m,w,p);perform private.check_photo_schedule(m);
 perform 1 from public.profiles where id=u for update;
 select * into q from public.photo_reading_quotes where workspace_id=w and project_id=p and user_id=u and contract_hash=p_input->>'contract_hash'
 and contract=c and status<>'revoked' and (paid_at is not null or expires_at>now()+interval '31 minutes' or consent is not null) order by created_at desc limit 1;
 if found then return to_jsonb(q);end if;
 if exists(select 1 from public.photo_reading_quotes old where old.workspace_id=w and old.project_id=p and old.user_id=u and old.status<>'revoked'
 and (old.paid_at is not null or old.consent is not null) and exists(select 1 from jsonb_array_elements(old.contract->'assets') a
 join jsonb_array_elements(c->'assets') b on a->>'sha256'=b->>'sha256'))then raise exception 'Photo already belongs to an accepted or paid purchase';end if;
 if not private.photo_daily_capacity(u)then raise exception 'Daily AI reading limit reached before checkout';end if;
 margin_:=case price->>'membership' when 'standard' then 5000 when 'starter' then 4000 when 'pro' then 3500 when 'team' then 3000 when 'enterprise' then 2000 end;
 if margin_ is null or (price->>'marginBps')::integer is distinct from margin_ or price->>'currency' is distinct from 'usd'
 or (price->>'costCents')::integer<=0 or (price->>'paymentFixedCents')::integer<0 or (price->>'paymentFeeBps')::integer<0
 or margin_+(price->>'paymentFeeBps')::integer>=10000 then raise exception 'Photo purchase price invalid';end if;
 select sum((c->'profile'->'routes'->(op->>'stage')->>'maximumCallCostUsd')::numeric),sum((op->>'reservationUsd')::numeric)
 into cost_,reserve_ from jsonb_array_elements(c->'operations')op;
 if jsonb_typeof(price->'overheadBatchCents')is distinct from'number'or jsonb_typeof(price->'overheadAssetCents')is distinct from'number'
 or (price->>'overheadBatchCents')::numeric not between 0 and 1000000 or (price->>'overheadAssetCents')::numeric not between 0 and 1000000
 or (price->>'overheadBatchCents')::numeric<>trunc((price->>'overheadBatchCents')::numeric)or (price->>'overheadAssetCents')::numeric<>trunc((price->>'overheadAssetCents')::numeric)
 or cost_ is distinct from(price->>'providerCostUpperBoundUsd')::numeric or reserve_ is distinct from(price->>'operatingReserveUsd')::numeric
 or ceil(cost_*100)+(price->>'overheadBatchCents')::numeric+jsonb_array_length(c->'assets')*(price->>'overheadAssetCents')::numeric is distinct from(price->>'costCents')::numeric then raise exception 'Photo purchase cost snapshot mismatch';end if;
 amount_:=ceil(((price->>'costCents')::numeric+(price->>'paymentFixedCents')::numeric)*10000/(10000-margin_-(price->>'paymentFeeBps')::numeric));
 if amount_ is distinct from (price->>'amountCents')::numeric then raise exception 'Photo purchase amount mismatch';end if;
 insert into public.photo_reading_quotes(workspace_id,project_id,user_id,contract,contract_hash,amount_cents,cost_cents)
 values(w,p,u,c,p_input->>'contract_hash',amount_,(price->>'costCents')::integer) returning * into q;return to_jsonb(q);
end $$;
create function public.accept_photo_reading_quote(p_quote_id uuid,p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_contract_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.photo_reading_quotes;
begin
 perform 1 from public.provider_spend_policy where singleton for update;perform 1 from public.profiles where id=p_user_id for update;
 select * into q from public.photo_reading_quotes where id=p_quote_id and user_id=p_user_id and workspace_id=p_workspace_id and project_id=p_project_id for update;
 if not found or not private.photo_member(p_user_id,p_workspace_id,p_project_id) or q.status<>'quoted' or q.contract_hash is distinct from p_contract_hash
 or q.expires_at<=now() or q.stripe_session_id is null and(q.expires_at<now()+interval '30 minutes' or q.expires_at>now()+interval '24 hours') then raise exception 'Current photo purchase consent required';end if;
 perform private.validate_complete_photo_manifest(private.photo_quote_manifest(q.contract),q.workspace_id,q.project_id);perform private.check_photo_schedule(private.photo_quote_manifest(q.contract));
 if not private.photo_daily_capacity(p_user_id,q.id)then raise exception 'Daily AI reading limit reached before checkout';end if;
 if exists(select 1 from public.photo_reading_quotes old where old.id<>q.id and old.workspace_id=q.workspace_id and old.project_id=q.project_id and old.user_id=q.user_id
 and old.status<>'revoked' and(old.paid_at is not null or old.consent is not null) and exists(select 1 from jsonb_array_elements(old.contract->'assets') a
 join jsonb_array_elements(q.contract->'assets') b on a->>'sha256'=b->>'sha256'))then raise exception 'Photo already belongs to an accepted or paid purchase';end if;
 update public.photo_reading_quotes set consent=coalesce(consent,jsonb_build_object('confirmed',true,'approvedBy',p_user_id,'contractHash',p_contract_hash,'approvedAt',now())),updated_at=now()where id=q.id returning * into q;return to_jsonb(q);
end $$;
create function public.save_photo_reading_session(p_quote_id uuid,p_session_id text)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.photo_reading_quotes;begin
 select * into q from public.photo_reading_quotes where id=p_quote_id for update;
 if not found or q.status<>'quoted' or q.consent->>'confirmed' is distinct from 'true' or q.consent->>'contractHash' is distinct from q.contract_hash
 or coalesce(p_session_id,'')!~'^cs_[A-Za-z0-9_]+$' or q.stripe_session_id is not null and q.stripe_session_id<>p_session_id then raise exception 'Photo checkout session mismatch';end if;
 update public.photo_reading_quotes set stripe_session_id=p_session_id,updated_at=now()where id=q.id returning * into q;return to_jsonb(q);end $$;
create function private.photo_payment_event(p_event text,p_quote uuid,p_kind text,p_session text,p_intent text,p_amount integer,p_currency text)returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.photo_reading_payment_events;begin
 if coalesce(p_event,'')!~'^evt_[A-Za-z0-9_]+$'then raise exception 'Photo payment event invalid';end if;
 insert into public.photo_reading_payment_events(event_id,quote_id,kind,session_id,intent,amount_cents,currency)values(p_event,p_quote,p_kind,p_session,p_intent,p_amount,p_currency)on conflict do nothing;
 if found then return true;end if;
 select * into e from public.photo_reading_payment_events where event_id=p_event;
 if(e.quote_id,e.kind,e.session_id,e.intent,e.amount_cents,e.currency)is distinct from(p_quote,p_kind,p_session,p_intent,p_amount,p_currency)then raise exception 'Photo payment event identity conflict';end if;return false;end $$;
create function public.confirm_photo_reading_payment(p_event_id text,p_quote_id uuid,p_session_id text,p_payment_intent text,p_amount integer,p_currency text,p_livemode boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.photo_reading_quotes;begin
 perform 1 from public.provider_spend_policy where singleton for update;select * into q from public.photo_reading_quotes where id=p_quote_id for update;
 if not found or p_livemode is distinct from true or q.stripe_session_id is distinct from p_session_id or coalesce(p_payment_intent,'')!~'^pi_[A-Za-z0-9_]+$'
 or q.stripe_payment_intent is not null and q.stripe_payment_intent<>p_payment_intent or q.amount_cents is distinct from p_amount or q.currency is distinct from lower(trim(p_currency))
 or q.consent->>'confirmed' is distinct from 'true' or q.consent->>'contractHash' is distinct from q.contract_hash or q.consent->>'approvedBy' is distinct from q.user_id::text then raise exception 'Photo payment mismatch';end if;
 perform private.photo_payment_event(p_event_id,q.id,'paid',p_session_id,p_payment_intent,p_amount,q.currency);
 if q.status='revoked' or q.paid_at is not null then return to_jsonb(q);end if;
 update public.photo_reading_quotes set status='paid',paid_at=now(),payment_revision=payment_revision+1,stripe_payment_intent=p_payment_intent,updated_at=now()where id=q.id returning * into q;return to_jsonb(q);end $$;
create function public.close_photo_reading_payment(p_event_id text,p_quote_id uuid,p_session_id text,p_payment_intent text,p_livemode boolean,p_reason text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.photo_reading_quotes;run_ uuid;begin
 perform 1 from public.provider_spend_policy where singleton for update;
 select run_id into run_ from public.photo_reading_quotes where id=p_quote_id;perform 1 from public.photo_takeoff_runs where id=run_ for update;
 select * into q from public.photo_reading_quotes where id=p_quote_id for update;
 if not found or p_livemode is distinct from true or p_reason not in ('expired','failed','refund','dispute') or q.stripe_session_id is null or q.stripe_session_id is distinct from p_session_id
 or q.stripe_payment_intent is not null and p_payment_intent is not null and q.stripe_payment_intent<>p_payment_intent
 or p_reason in('refund','dispute')and coalesce(p_payment_intent,'')!~'^pi_[A-Za-z0-9_]+$'then raise exception 'Photo closing event mismatch';end if;
 if not private.photo_payment_event(p_event_id,q.id,p_reason,p_session_id,p_payment_intent,null,null)then return false;end if;
 if q.status='revoked' or p_reason in('expired','failed')and q.paid_at is not null then return false;end if;
 update public.photo_reading_quotes set status='revoked',payment_revision=payment_revision+1,stripe_payment_intent=coalesce(stripe_payment_intent,p_payment_intent),updated_at=now()where id=q.id;
 update public.photo_takeoff_runs set status='cancelled',cancel_requested_at=coalesce(cancel_requested_at,now()),lease_id=null,lease_expires_at=null,not_before=null,updated_at=now()
 where id=q.run_id and status in('queued','processing','waiting_budget','blocked');return true;end $$;

create function private.create_complete_photo_run(p_user uuid,p_workspace uuid,p_project uuid,p_request uuid,p_manifest jsonb,p_quote uuid default null,p_revision bigint default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;op jsonb;provider_ jsonb;ids_ uuid[];profile_ jsonb;reserve_ numeric;count_ integer;provider_reserve_ numeric;
begin
 if not private.photo_member(p_user,p_workspace,p_project) then raise exception 'Photo access denied';end if;
 profile_:=p_manifest->'profile';reserve_:=(p_manifest->>'callReservationUsd')::numeric;
 perform 1 from public.profiles where id=p_user for update;
 select * into r from public.photo_takeoff_runs where workspace_id=p_workspace and project_id=p_project and request_key=p_request for update;
 if found then
  if r.requested_by<>p_user or r.manifest<>p_manifest or r.photo_quote_id is distinct from p_quote or r.payment_revision is distinct from p_revision then raise exception 'Photo run identity mismatch';end if;
  return jsonb_build_object('run',to_jsonb(r),'reused',true);
 end if;
 perform private.validate_complete_photo_manifest(p_manifest,p_workspace,p_project);perform private.check_photo_schedule(p_manifest);
 if not public.photo_takeoff_worker_available(profile_->>'profileHash')then raise exception 'Complete photo worker unavailable';end if;
 if p_quote is null and not private.photo_daily_capacity(p_user)then raise exception 'Daily AI reading limit reached';end if;
 select array_agg((value->>'id')::uuid order by value->>'id') into ids_ from jsonb_array_elements(p_manifest->'assets');
 if jsonb_typeof(p_manifest->'providers') is distinct from 'array' then raise exception 'Photo provider budgets unavailable';end if;
 for provider_ in select value from jsonb_array_elements(p_manifest->'providers') loop
  select count(*) into count_ from jsonb_array_elements(p_manifest->'operations')x where profile_->'routes'->(x->>'stage')->>'provider'=provider_->>'provider';
  select sum((x->>'reservationUsd')::numeric)into provider_reserve_ from jsonb_array_elements(p_manifest->'operations')x where profile_->'routes'->(x->>'stage')->>'provider'=provider_->>'provider';
  if count_<=0 or count_ is distinct from(provider_->>'maximumCalls')::integer or (provider_->>'approvedUsd')::numeric is distinct from provider_reserve_ then raise exception 'Photo provider budget mismatch';end if;
 end loop;
 if(select sum((value->>'maximumCalls')::integer)from jsonb_array_elements(p_manifest->'providers'))is distinct from(p_manifest->>'maximumCalls')::integer then raise exception 'Photo provider coverage invalid';end if;
 insert into public.photo_takeoff_runs(workspace_id,project_id,requested_by,request_key,profile_hash,provider,model,manifest,asset_ids,progress,photo_quote_id,payment_revision)
 values(p_workspace,p_project,p_user,p_request,profile_->>'profileHash',profile_->'routes'->'observation'->>'provider',profile_->'routes'->'observation'->>'model',p_manifest,ids_,
 jsonb_build_object('completed',0,'total',cardinality(ids_),'completedStages',0,'totalStages',(p_manifest->>'maximumCalls')::integer),p_quote,p_revision) returning * into r;
 insert into public.photo_takeoff_steps(run_id,workspace_id,project_id,photo_asset_id)select r.id,p_workspace,p_project,unnest(ids_);
 for op in select value from jsonb_array_elements(p_manifest->'operations')loop
  insert into public.photo_stage_checkpoints(run_id,operation_key,stage,asset_ids)values(r.id,op->>'key',op->>'stage',array(select value::uuid from jsonb_array_elements_text(op->'assetIds')));
 end loop;
 insert into public.complete_photo_provider_budgets(run_id,provider,approved_usd,maximum_calls)
 select r.id,value->>'provider',(value->>'approvedUsd')::numeric,(value->>'maximumCalls')::integer from jsonb_array_elements(p_manifest->'providers');
 return jsonb_build_object('run',to_jsonb(r),'reused',false);
end $$;
create function public.reserve_paid_photo_takeoff(p_quote_id uuid)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.photo_reading_quotes;m jsonb;saved jsonb;
begin
 perform 1 from public.provider_spend_policy where singleton for update;
 select * into q from public.photo_reading_quotes where id=p_quote_id for update;
 if not found or q.paid_at is null or q.status not in('paid','processing','complete','failed')or q.consent->>'confirmed' is distinct from 'true'
 or q.consent->>'approvedBy' is distinct from q.user_id::text or q.consent->>'contractHash' is distinct from q.contract_hash or not private.photo_member(q.user_id,q.workspace_id,q.project_id)
 then raise exception 'Paid photo authorization unavailable';end if;
 if q.run_id is not null then return jsonb_build_object('run',(select to_jsonb(r)from public.photo_takeoff_runs r where id=q.run_id),'reused',true);end if;
 m:=private.photo_quote_manifest(q.contract)||jsonb_build_object('purchaseContractHash',q.contract_hash);
 saved:=private.create_complete_photo_run(q.user_id,q.workspace_id,q.project_id,q.id,m,q.id,q.payment_revision);
 update public.photo_reading_quotes set run_id=(saved->'run'->>'id')::uuid,status='processing',updated_at=now()where id=q.id;return saved;
end $$;
create function public.reserve_included_complete_photo(p_input jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare m jsonb:=p_input->'manifest';u uuid:=(p_input->>'user_id')::uuid;
begin
 perform 1 from public.provider_spend_policy where singleton for update;
 if not exists(select 1 from public.profiles where id=u and is_platform_admin) or m->'includedAuthorization'->>'confirmed' is distinct from 'true'
 or m->'includedAuthorization'->>'approvedBy' is distinct from u::text
 or coalesce(m->'includedAuthorization'->>'approvalRef','')!~'^[A-Za-z0-9][A-Za-z0-9_.:/-]{1,119}$'
 or (m->'includedAuthorization'->>'approvedUsd')::numeric is null or (m->'includedAuthorization'->>'approvedUsd')::numeric not between 0.000001 and 100000
 or (m->'includedAuthorization'->>'approvedUsd')::numeric<(select sum((value->>'reservationUsd')::numeric)from jsonb_array_elements(m->'operations')) then raise exception 'Included photo authorization required';end if;
 return private.create_complete_photo_run(u,(p_input->>'workspace_id')::uuid,(p_input->>'project_id')::uuid,(p_input->>'request_key')::uuid,m);
end $$;
create function public.claim_complete_photo_takeoff(p_run_id uuid,p_worker_id text,p_profile_hash text)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;lease uuid;
begin
 select * into r from public.photo_takeoff_runs where id=p_run_id and profile_hash=p_profile_hash for update;
 if not found or not private.complete_photo_authorized(r.id)then raise exception 'Complete photo authorization unavailable';end if;
 if r.status in('needs_review','blocked','cancelled')or r.status='waiting_budget'and r.not_before>now()then return jsonb_build_object('skip',true,'status',r.status);end if;
 if r.status='processing'and r.lease_expires_at>now()then raise exception 'Photo run already leased';end if;
 if r.cancel_requested_at is not null or (r.manifest->>'expiresAt')::timestamptz<=now()then
 update public.photo_takeoff_runs set status=case when cancel_requested_at is not null then 'cancelled'else'blocked'end,error_code='processing_review_required',not_before=null,updated_at=now()where id=r.id;
 return jsonb_build_object('skip',true,'status','blocked');end if;
 if exists(select 1 from public.photo_stage_checkpoints where run_id=r.id and status in('admitted','processing'))then
 update public.photo_takeoff_runs set status='blocked',error_code='unknown_provider_outcome',lease_id=null,lease_expires_at=null,updated_at=now()where id=r.id;
 return jsonb_build_object('skip',true,'status','blocked');end if;
 lease:=gen_random_uuid();update public.photo_takeoff_runs set status='processing',worker_id=p_worker_id,lease_id=lease,lease_expires_at=now()+interval '90 seconds',heartbeat_at=now(),
 started_at=coalesce(started_at,now()),not_before=null,error_code=null,updated_at=now()where id=r.id;
 return jsonb_build_object('skip',false,'lease_id',lease,'workspace_id',r.workspace_id,'project_id',r.project_id,'requested_by',r.requested_by,'manifest',r.manifest);
end $$;
create function public.heartbeat_complete_photo_takeoff(p_run_id uuid,p_lease_id uuid,p_worker_id text)returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin update public.photo_takeoff_runs set heartbeat_at=now(),lease_expires_at=now()+interval '90 seconds' where id=p_run_id and lease_id=p_lease_id and worker_id=p_worker_id and status='processing'
 and lease_expires_at>now()and cancel_requested_at is null and private.complete_photo_authorized(id)and(manifest->>'expiresAt')::timestamptz>now();return found;end $$;
create function public.reserve_complete_photo_spend(p_event_id uuid,p_run_id uuid,p_lease_id uuid,p_operation_key text,p_workspace_id uuid,p_user_id uuid,p_provider text,p_model text,p_required_reservation_usd numeric default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.provider_spend_policy;r public.photo_takeoff_runs;s public.photo_stage_checkpoints;b public.complete_photo_provider_budgets;v public.provider_spend_reservations;used_ numeric;count_ integer;route jsonb;hold_ numeric;op jsonb;
begin
 select * into p from public.provider_spend_policy where singleton for update;
 if not found or not p.enabled then raise exception 'Photo processing disabled';end if;
 select * into r from public.photo_takeoff_runs where id=p_run_id and workspace_id=p_workspace_id and requested_by=p_user_id and lease_id=p_lease_id and status='processing'and lease_expires_at>now()and cancel_requested_at is null for share;
 if not found or not private.complete_photo_authorized(r.id)or(r.manifest->>'expiresAt')::timestamptz<=now()then raise exception 'Photo dispatch authorization unavailable';end if;
 select * into s from public.photo_stage_checkpoints where run_id=r.id and operation_key=p_operation_key for update;
 if not found then raise exception 'Photo stage unavailable';end if;
 route:=r.manifest->'profile'->'routes'->s.stage;
 select value into op from jsonb_array_elements(r.manifest->'operations')where value->>'key'=s.operation_key;
 hold_:=(op->>'reservationUsd')::numeric;
 if route->>'provider' is distinct from p_provider or route->>'model' is distinct from p_model or p.call_reservation_usd is distinct from(r.manifest->>'callReservationUsd')::numeric
 or p_required_reservation_usd is distinct from(route->>'maximumCallCostUsd')::numeric or hold_ is distinct from greatest(p.call_reservation_usd,p_required_reservation_usd)or hold_>p.spend_cap_usd then raise exception 'Photo stage tariff changed';end if;
 if not exists(select 1 from public.api_usage_events where id=p_event_id and user_id=p_user_id and workspace_id=p_workspace_id and project_id=r.project_id and provider=p_provider and model=p_model and operation='rb1:'||r.id::text||':generate:pending')then raise exception 'Photo spend event mismatch';end if;
 select * into v from public.provider_spend_reservations where event_id=p_event_id;
 if found then if v.photo_run_id is distinct from r.id or v.photo_stage_key is distinct from s.operation_key then raise exception 'Photo reservation identity mismatch';end if;return to_jsonb(v);end if;
 if s.status<>'pending' then raise exception 'Photo stage cannot replay';end if;
 if s.stage<>'observation'and exists(select 1 from public.photo_stage_checkpoints where run_id=r.id and stage='observation'and status<>'completed')
 or s.stage='risk_review'and exists(select 1 from public.photo_stage_checkpoints where run_id=r.id and stage='reconciliation'and status<>'completed')then raise exception 'Photo stage prerequisites pending';end if;
 used_:=p.spend_cap_usd-(public.paid_full_capacity_policy()->>'available_usd')::numeric;
 if used_+hold_>p.spend_cap_usd then raise exception 'Company AI spend limit reached';end if;
 select * into b from public.complete_photo_provider_budgets where run_id=r.id and provider=p_provider for update;
 select coalesce(sum(case when status='captured'and telemetry_known then estimated_cost_usd else reserved_usd end),0),count(*) into used_,count_ from public.provider_spend_reservations where photo_run_id=r.id and provider=p_provider;
 if b.run_id is null or count_>=b.maximum_calls or used_+hold_>b.approved_usd then raise exception 'Provider run spend limit reached';end if;
 insert into public.provider_spend_reservations(event_id,photo_run_id,photo_asset_id,photo_stage_key,workspace_id,user_id,provider,model,reserved_usd)
 values(p_event_id,r.id,s.asset_ids[1],s.operation_key,r.workspace_id,r.requested_by,p_provider,p_model,hold_)returning * into v;
 update public.photo_stage_checkpoints set status='admitted',event_id=p_event_id where run_id=r.id and operation_key=s.operation_key;return to_jsonb(v);
end $$;
create function public.begin_complete_photo_stage(p_run_id uuid,p_lease_id uuid,p_operation_key text,p_event_id uuid)returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;
begin
 select * into r from public.photo_takeoff_runs where id=p_run_id and lease_id=p_lease_id and status='processing'and lease_expires_at>now()and cancel_requested_at is null for update;
 if not found or not private.complete_photo_authorized(r.id)or(r.manifest->>'expiresAt')::timestamptz<=now()then raise exception 'Photo lease authorization unavailable';end if;
 if exists(select 1 from public.photo_stage_checkpoints where run_id=r.id and status='processing')then raise exception 'Photo stage already dispatching';end if;
 update public.photo_stage_checkpoints set status='processing',started_at=now()where run_id=r.id and operation_key=p_operation_key and status='admitted'and event_id=p_event_id;
 if not found then raise exception 'Photo admission receipt missing';end if;return true;end $$;
create function public.checkpoint_complete_photo_stage(p_run_id uuid,p_lease_id uuid,p_operation_key text,p_result jsonb)returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;s public.photo_stage_checkpoints;
begin
 select * into r from public.photo_takeoff_runs where id=p_run_id and lease_id=p_lease_id and status='processing'and lease_expires_at>now()and cancel_requested_at is null for update;
 if not found or not private.complete_photo_authorized(r.id)then raise exception 'Photo result authorization unavailable';end if;
 select * into s from public.photo_stage_checkpoints where run_id=r.id and operation_key=p_operation_key and status='processing'for update;
 if not found or jsonb_typeof(p_result)is distinct from 'object'or octet_length(p_result::text)>1000000 then raise exception 'Photo checkpoint invalid';end if;
 if s.stage='observation'and jsonb_typeof(p_result->'observations')is distinct from 'array'or s.stage<>'observation'and p_result->>'stage'is distinct from s.stage then raise exception 'Photo stage result mismatch';end if;
 update public.photo_stage_checkpoints set status='completed',result=p_result,completed_at=now()where run_id=r.id and operation_key=s.operation_key;
 if s.stage='observation'then update public.photo_takeoff_steps set status='completed',result=p_result,completed_at=now()where run_id=r.id and photo_asset_id=s.asset_ids[1];end if;
 update public.photo_takeoff_runs set progress=progress||jsonb_build_object('completedStages',(select count(*)from public.photo_stage_checkpoints where run_id=r.id and status='completed'),
 'completed',(select count(*)from public.photo_takeoff_steps where run_id=r.id and status='completed')),updated_at=now()where id=r.id;return true;
end $$;
create function public.wait_complete_photo_budget(p_run_id uuid,p_lease_id uuid,p_event_id uuid)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;p public.provider_spend_policy;next_ timestamptz;
begin
 select * into p from public.provider_spend_policy where singleton for update;
 select * into r from public.photo_takeoff_runs where id=p_run_id and lease_id=p_lease_id and status='processing'for update;
 if not found or not private.complete_photo_authorized(r.id)or exists(select 1 from public.photo_stage_checkpoints where run_id=r.id and status in('admitted','processing'))
 or not exists(select 1 from public.api_usage_events where id=p_event_id and user_id=r.requested_by and workspace_id=r.workspace_id and project_id=r.project_id and operation='rb1:'||r.id::text||':generate:blocked_spend_limit')
 or exists(select 1 from public.provider_spend_reservations where event_id=p_event_id)then raise exception 'Photo unsent budget receipt unavailable';end if;
 select min(created_at)+p.rolling_window+interval '1 second' into next_ from(
 select created_at from public.provider_spend_reservations where created_at>now()-p.rolling_window union all select created_at from public.geometry_provider_spend_reservations where created_at>now()-p.rolling_window)x;
 next_:=greatest(now()+interval '15 seconds',coalesce(next_,now()+interval '30 seconds'));
 update public.photo_takeoff_runs set status=case when next_>=(manifest->>'expiresAt')::timestamptz then 'blocked'else'waiting_budget'end,
 error_code=case when next_>=(manifest->>'expiresAt')::timestamptz then 'processing_review_required'else'company_spend_limit'end,
 not_before=next_,budget_wait_started_at=coalesce(budget_wait_started_at,now()),lease_id=null,lease_expires_at=null,updated_at=now()where id=r.id returning * into r;
 return jsonb_build_object('id',r.id,'status',r.status,'not_before',r.not_before);
end $$;
create function public.block_complete_photo_takeoff(p_run_id uuid,p_lease_id uuid,p_code text)returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin if p_code not in('unknown_provider_outcome','photo_source_or_persistence_blocked','run_provider_spend_limit','processing_review_required')then raise exception 'Photo block code invalid';end if;
 update public.photo_takeoff_runs set status='blocked',error_code=p_code,lease_id=null,lease_expires_at=null,updated_at=now()where id=p_run_id and lease_id=p_lease_id and status='processing';return found;end $$;
create function public.finish_complete_photo_takeoff(p_run_id uuid,p_lease_id uuid,p_result jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;begin
 select * into r from public.photo_takeoff_runs where id=p_run_id and lease_id=p_lease_id and status='processing'and lease_expires_at>now()and cancel_requested_at is null for update;
 if not found or not private.complete_photo_authorized(r.id)then raise exception 'Photo finish authorization unavailable';end if;
 if exists(select 1 from public.photo_stage_checkpoints where run_id=r.id and status<>'completed')or(select count(*)from public.photo_stage_checkpoints where run_id=r.id)<>(r.manifest->>'maximumCalls')::integer then raise exception 'Complete photo coverage pending';end if;
 if p_result->>'independentReview'is distinct from 'completed'or p_result->'stageStatus'is distinct from '{"observation":"completed","reconciliation":"completed","risk_review":"completed"}'::jsonb
 or p_result->'humanReviewRequired'is distinct from 'true'::jsonb or p_result->'estimate'is distinct from 'null'::jsonb or p_result->>'pricingStatus'is distinct from 'missing_price'
 or octet_length(p_result::text)>5000000 then raise exception 'Complete photo result invalid';end if;
 update public.photo_takeoff_runs set status='needs_review',result=p_result,completed_at=now(),lease_id=null,lease_expires_at=null,not_before=null,updated_at=now()where id=r.id returning * into r;
 update public.photo_reading_quotes set status='complete',updated_at=now()where id=r.photo_quote_id and status<>'revoked';return jsonb_build_object('id',r.id,'status',r.status,'progress',r.progress,'result',r.result);end $$;
create function public.due_complete_photo_runs(p_profile_hash text)returns jsonb language sql security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id)),'[]'::jsonb)from(select id from public.photo_takeoff_runs where profile_hash=p_profile_hash
 and manifest->>'completeVersion'='photo-complete-v1'and(status='queued'or status='waiting_budget'and not_before<=now()or status='processing'and lease_expires_at<=now())and cancel_requested_at is null
 and private.complete_photo_authorized(id)order by budget_wait_started_at nulls last,created_at limit 20)x;
$$;

create function public.cancel_complete_photo_takeoff(p_run_id uuid,p_workspace_id uuid,p_user_id uuid)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;begin
 select * into r from public.photo_takeoff_runs where id=p_run_id and workspace_id=p_workspace_id for update;
 if not found or r.requested_by<>p_user_id or r.manifest->>'completeVersion' is distinct from 'photo-complete-v1'
 or not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in('admin','estimator'))then raise exception 'Photo cancellation access denied';end if;
 if r.status not in('needs_review','cancelled')then update public.photo_takeoff_runs set status='cancelled',cancel_requested_at=now(),not_before=null,lease_id=null,lease_expires_at=null,updated_at=now()where id=r.id;end if;
 return jsonb_build_object('id',r.id,'cancel_requested',true);end $$;
create function public.resume_complete_photo_takeoff(p_run_id uuid,p_workspace_id uuid,p_user_id uuid,p_profile_hash text)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;begin
 select * into r from public.photo_takeoff_runs where id=p_run_id and workspace_id=p_workspace_id for update;
 if not found or r.requested_by<>p_user_id or r.profile_hash<>p_profile_hash or not private.complete_photo_authorized(r.id)or not public.photo_takeoff_worker_available(p_profile_hash)then raise exception 'Photo resume access denied';end if;
 if r.status='needs_review'or r.status='waiting_budget'and r.not_before>now()then return jsonb_build_object('id',r.id,'status',r.status,'not_before',r.not_before);end if;
 if (r.manifest->>'expiresAt')::timestamptz<=now()then raise exception 'Photo processing review required';end if;
 if r.status='processing'and r.lease_expires_at>now()then raise exception 'Photo worker is still active';end if;
 if exists(select 1 from public.photo_stage_checkpoints where run_id=r.id and status in('admitted','processing'))then raise exception 'Photo provider reconciliation required';end if;
 update public.photo_takeoff_runs set status='queued',cancel_requested_at=null,not_before=null,error_code=null,lease_id=null,lease_expires_at=null,updated_at=now()where id=r.id;
 return jsonb_build_object('id',r.id,'status','queued','completed_checkpoints_preserved',true);end $$;
create function public.save_complete_photo_review(p_run_id uuid,p_workspace_id uuid,p_project_id uuid,p_user_id uuid,p_request_key uuid,p_request_sha256 text,p_expected_revision integer,p_result jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;receipt public.photo_takeoff_reviews;revision_ integer;begin
 if not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in('admin','estimator'))then raise exception 'Photo review access denied';end if;
 select * into r from public.photo_takeoff_runs where id=p_run_id and workspace_id=p_workspace_id and project_id=p_project_id for update;
 if not found or r.status<>'needs_review'or r.manifest->>'completeVersion' is distinct from 'photo-complete-v1'then raise exception 'Complete photo review unavailable';end if;
 if p_request_key is null or coalesce(p_request_sha256,'')!~'^[a-f0-9]{64}$'or p_expected_revision is null or p_expected_revision<0 then raise exception 'Photo review identity invalid';end if;
 select * into receipt from public.photo_takeoff_reviews where run_id=r.id and request_key=p_request_key;
 if found then if receipt.request_sha256<>p_request_sha256 or receipt.reviewer_id<>p_user_id then raise exception 'Photo review request mismatch';end if;
 return jsonb_build_object('review',receipt.result,'reviewRevision',receipt.review_revision,'reused',true);end if;
 if r.review_revision<>p_expected_revision then raise exception 'Photo review revision conflicted';end if;
 if p_result->>'reviewed_by'is distinct from p_user_id::text or p_result->>'independentReview'is distinct from 'completed'
 or p_result->'observations'is distinct from r.result->'observations' or p_result->'stageReviews'is distinct from r.result->'stageReviews'
 or p_result->'stageStatus'is distinct from r.result->'stageStatus'or p_result->'photoQuality'is distinct from r.result->'photoQuality'
 or p_result->>'releaseStatus'is distinct from 'blocked'or p_result->>'pricingStatus'is distinct from 'missing_price'or p_result->'estimate'is distinct from 'null'::jsonb
 or p_result->'humanReviewRequired'is distinct from 'true'::jsonb or jsonb_typeof(p_result->'approvedMeasurements')is distinct from 'array'
 or jsonb_typeof(p_result->'references')is distinct from 'array'or jsonb_typeof(p_result->'decisions')is distinct from 'array'or octet_length(p_result::text)>5000000 then raise exception 'Complete photo review invalid';end if;
 revision_:=r.review_revision+1;
 insert into public.photo_takeoff_reviews(run_id,workspace_id,project_id,request_key,request_sha256,reviewer_id,expected_revision,review_revision,result)
 values(r.id,r.workspace_id,r.project_id,p_request_key,p_request_sha256,p_user_id,p_expected_revision,revision_,p_result);
 update public.photo_takeoff_runs set result=p_result,review_revision=revision_,updated_at=now()where id=r.id;
 return jsonb_build_object('review',p_result,'reviewRevision',revision_,'reused',false);end $$;
create function private.guard_complete_photo_identity()returns trigger language plpgsql set search_path=public,pg_temp as $$begin
 if old.manifest->>'completeVersion'='photo-complete-v1'and(new.manifest is distinct from old.manifest or new.profile_hash is distinct from old.profile_hash
 or new.requested_by is distinct from old.requested_by or new.workspace_id is distinct from old.workspace_id or new.project_id is distinct from old.project_id
 or new.request_key is distinct from old.request_key or new.asset_ids is distinct from old.asset_ids or new.photo_quote_id is distinct from old.photo_quote_id
 or new.payment_revision is distinct from old.payment_revision)then raise exception 'Complete photo identity is immutable';end if;return new;end $$;
create trigger guard_complete_photo_identity before update on public.photo_takeoff_runs for each row execute function private.guard_complete_photo_identity();
create function private.sync_complete_photo_lifecycle()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$begin
 if new.photo_quote_id is not null and new.status is distinct from old.status then
 update public.photo_reading_quotes set status=case when new.status='needs_review'then'complete'when new.status in('blocked','cancelled')then'failed'else'processing'end,updated_at=now()
 where id=new.photo_quote_id and status<>'revoked'and paid_at is not null;end if;return new;end $$;
create trigger sync_complete_photo_lifecycle after update of status on public.photo_takeoff_runs for each row execute function private.sync_complete_photo_lifecycle();
-- Storage and result access remain tenant-scoped; payment only authorizes model
-- dispatch. Upload/review do not impersonate a paid PDF or platform owner.
create policy complete_photo_assets_read on public.photo_assets for select to authenticated using(private.has_workspace_role(workspace_id,array['admin','estimator','viewer']));
create policy complete_photo_runs_read on public.photo_takeoff_runs for select to authenticated using(manifest->>'completeVersion'='photo-complete-v1'and private.has_workspace_role(workspace_id,array['admin','estimator','viewer']));
create policy complete_photo_steps_read on public.photo_takeoff_steps for select to authenticated using(exists(select 1 from public.photo_takeoff_runs r where r.id=run_id and r.manifest->>'completeVersion'='photo-complete-v1')and private.has_workspace_role(workspace_id,array['admin','estimator','viewer']));
grant select(not_before,budget_wait_started_at)on public.photo_takeoff_runs to authenticated;
create or replace function public.guard_photo_asset_intake()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status<>'uploading'or not private.photo_member(new.uploaded_by,new.workspace_id,new.project_id)
 or new.storage_path<>(new.workspace_id::text||'/'||new.project_id::text||'/photos/'||new.id::text||'/source.'||case new.mime_type when'image/jpeg'then'jpg'when'image/png'then'png'else'webp'end)then raise exception 'Photo upload access denied';end if;
 perform 1 from public.projects where id=new.project_id and workspace_id=new.workspace_id for update;
 if(select count(*)from public.photo_assets where project_id=new.project_id and workspace_id=new.workspace_id)>=256 then raise exception 'Photo storage intake limit reached';end if;return new;end $$;

do $$declare item record;begin
 for item in select p.oid::regprocedure identity from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private'and p.proname in
 ('photo_daily_capacity','guard_complete_photo_identity','sync_complete_photo_lifecycle','photo_member','complete_photo_authorized','validate_complete_photo_manifest','photo_quote_manifest','check_photo_schedule','photo_payment_event','create_complete_photo_run')loop
 execute 'revoke all on function '||item.identity||' from public,anon,authenticated,service_role';end loop;
 for item in select p.oid::regprocedure identity from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname in
 ('create_photo_reading_quote','accept_photo_reading_quote','save_photo_reading_session','confirm_photo_reading_payment','close_photo_reading_payment','reserve_paid_photo_takeoff',
 'reserve_included_complete_photo','claim_complete_photo_takeoff','heartbeat_complete_photo_takeoff','reserve_complete_photo_spend','begin_complete_photo_stage','checkpoint_complete_photo_stage',
 'cancel_complete_photo_takeoff','resume_complete_photo_takeoff','save_complete_photo_review','wait_complete_photo_budget','block_complete_photo_takeoff','finish_complete_photo_takeoff','due_complete_photo_runs')loop
 execute 'revoke all on function '||item.identity||' from public,anon,authenticated';execute 'grant execute on function '||item.identity||' to service_role';end loop;
end $$;
