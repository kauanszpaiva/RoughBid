-- A paid Full purchase owns one durable execution. No funds, policy caps or
-- provider flags are seeded by this migration; quick purchases remain quick.
alter table public.project_reading_quotes
  add column mode text not null default 'quick' check(mode in ('quick','full_v2')),
  add column full_contract jsonb,
  add column full_contract_hash text check(full_contract_hash is null or full_contract_hash~'^[a-f0-9]{64}$'),
  add column full_consent jsonb,
  add column full_run_id uuid unique references public.takeoff_runs(id),
  add column payment_revision bigint not null default 0 check(payment_revision>=0),
  add constraint full_quote_contract check(mode='quick' or (jsonb_typeof(full_contract)='object' and full_contract_hash is not null and livemode));
alter table public.project_reading_quotes drop constraint project_reading_quotes_page_count_check;
alter table public.project_reading_quotes add constraint project_reading_quotes_page_count_check check(page_count between 1 and case when mode='full_v2' then 200 else 100 end);
alter table public.takeoff_runs
  add column payment_kind text not null default 'complimentary' check(payment_kind in ('complimentary','paid')),
  add column payment_quote_id uuid unique references public.project_reading_quotes(id),
  add column payment_revision bigint,
  add constraint full_run_payment_identity check((payment_kind='complimentary' and payment_quote_id is null and payment_revision is null)
    or (payment_kind='paid' and payment_quote_id is not null and payment_revision>0));

-- Preserve the old identity for complimentary runs. Paid runs are unique by
-- their purchase, so an existing free run cannot silently consume a purchase.
do $$ declare name_ text; begin
  select c.conname into name_ from pg_constraint c where c.conrelid='public.takeoff_runs'::regclass and c.contype='u'
    and pg_get_constraintdef(c.oid)='UNIQUE (workspace_id, project_id, file_id, file_sha256, mode, orchestrator_version)';
  if name_ is null then raise exception 'Expected Full Takeoff identity constraint is missing'; end if;
  execute format('alter table public.takeoff_runs drop constraint %I',name_);
end $$;
create unique index takeoff_complimentary_identity on public.takeoff_runs(workspace_id,project_id,file_id,file_sha256,mode,orchestrator_version)
  where payment_kind='complimentary';

create function private.protect_paid_full_contract() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if old.mode='full_v2' and (new.mode,new.full_contract,new.full_contract_hash,new.workspace_id,new.project_id,new.file_id,new.user_id,
      new.file_sha256,new.page_count,new.amount_cents,new.cost_cents,new.currency,new.pricing_version,new.membership,new.livemode)
    is distinct from (old.mode,old.full_contract,old.full_contract_hash,old.workspace_id,old.project_id,old.file_id,old.user_id,
      old.file_sha256,old.page_count,old.amount_cents,old.cost_cents,old.currency,old.pricing_version,old.membership,old.livemode)
    then raise exception 'Paid Full contract is immutable'; end if;
  if old.mode='quick' and new.mode<>'quick' then raise exception 'A quick purchase cannot become Full'; end if;
  if old.full_consent is not null and new.full_consent is distinct from old.full_consent then raise exception 'Paid Full consent is immutable'; end if;
  if old.full_run_id is not null and new.full_run_id is distinct from old.full_run_id then raise exception 'Paid Full run identity is immutable'; end if;
  return new;
end $$;
create trigger protect_paid_full_contract before update on public.project_reading_quotes for each row execute function private.protect_paid_full_contract();

create table public.paid_full_payment_holds (
  quote_id uuid primary key references public.project_reading_quotes(id),
  reserved_usd numeric(12,6) not null check(reserved_usd>0),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  release_reason text
);
alter table public.paid_full_payment_holds enable row level security;
revoke all on public.paid_full_payment_holds from public,anon,authenticated;
grant select on public.paid_full_payment_holds to service_role;
-- Unsent/uncertain Checkout attempts are retained until reconciliation. In
-- particular a local expiry clock cannot release an asynchronous payment hold.
create function private.paid_full_held_exposure(p_exclude_quote uuid default null) returns numeric
language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(sum(greatest(0,h.reserved_usd-coalesce((select sum(case when s.status='captured' and s.telemetry_known then s.estimated_cost_usd else s.reserved_usd end)
    from public.provider_spend_reservations s where s.takeoff_run_id=q.full_run_id),0))),0)
    from public.paid_full_payment_holds h join public.project_reading_quotes q on q.id=h.quote_id
    where h.released_at is null and (p_exclude_quote is null or h.quote_id<>p_exclude_quote);
$$;
create function public.paid_full_capacity_ready(p_reserve_usd numeric,p_call_reservation_usd numeric,p_quote_id uuid default null) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare policy public.provider_spend_policy; used numeric;
begin
  if p_reserve_usd is null or p_reserve_usd<=0 or p_reserve_usd>100000 then return false; end if;
  select * into policy from public.provider_spend_policy where singleton for share;
  if not found or not policy.enabled or policy.call_reservation_usd is distinct from p_call_reservation_usd then return false; end if;
  select coalesce(sum(case when status='captured' and telemetry_known then estimated_cost_usd else reserved_usd end),0)
    into used from public.provider_spend_reservations where created_at>now()-policy.rolling_window;
  select used+coalesce(sum(reserved_usd),0) into used from public.geometry_provider_spend_reservations where created_at>now()-policy.rolling_window;
  return used+private.paid_full_held_exposure(p_quote_id)+p_reserve_usd<=policy.spend_cap_usd;
end $$;

create function public.paid_full_daily_capacity_ready(p_user_id uuid,p_quote_id uuid default null) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare used integer;
begin
  perform 1 from public.profiles where id=p_user_id for share;
  if not found then return false; end if;
  select count(*)::integer into used from public.takeoff_runs where requested_by=p_user_id and created_at>now()-interval '24 hours';
  select used+count(*)::integer into used from public.paid_full_payment_holds h join public.project_reading_quotes q on q.id=h.quote_id
    where q.user_id=p_user_id and q.full_run_id is null and h.released_at is null and (p_quote_id is null or q.id<>p_quote_id);
  return used<25;
end $$;

create function public.create_paid_full_quote(p_input jsonb) returns jsonb
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
    or v.full_contract->>'executionPolicy' is distinct from 'one-durable-run-no-uncertain-replay'
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

create function public.accept_paid_full_quote(p_quote_id uuid,p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_contract_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.project_reading_quotes;
begin
  perform 1 from public.provider_spend_policy where singleton for update;
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
  insert into public.paid_full_payment_holds(quote_id,reserved_usd) values(q.id,(q.full_contract->'pricing'->>'operatingReserveUsd')::numeric)
    on conflict(quote_id) do nothing;
  if exists(select 1 from public.paid_full_payment_holds where quote_id=q.id and released_at is not null) then raise exception 'Paid Full payment hold was released'; end if;
  if q.full_consent is null then
    update public.project_reading_quotes set full_consent=jsonb_build_object('confirmed',true,'approvedBy',p_user_id,'approvedAt',now(),'contractHash',p_contract_hash)
      where id=q.id returning * into q;
  end if;
  return to_jsonb(q);
end $$;

-- Paid is an explicit type; it never falls back to complimentary owner access.
create function private.full_takeoff_authorized(p_run_id uuid,p_user_id uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.takeoff_runs r where r.id=p_run_id and r.mode='full' and r.orchestrator_version='takeoff-v2.2-durable'
    and exists(select 1 from public.workspace_members where workspace_id=r.workspace_id and user_id=p_user_id and role in ('admin','estimator'))
    and exists(select 1 from public.workspace_members where workspace_id=r.workspace_id and user_id=r.requested_by and role in ('admin','estimator'))
    and exists(select 1 from public.workspaces where id=r.workspace_id and ai_processing_consented_at is not null)
    and case when r.payment_kind='paid' then exists(select 1 from public.project_reading_quotes q where q.id=r.payment_quote_id and q.full_run_id=r.id
      and q.mode='full_v2' and q.livemode and q.paid_at is not null and q.status in ('paid','processing','complete','failed')
      and q.payment_revision=r.payment_revision and q.payment_revision>0 and q.user_id=r.requested_by
      and q.workspace_id=r.workspace_id and q.project_id=r.project_id and q.file_id=r.file_id and q.file_sha256=r.file_sha256
      and q.full_consent->>'approvedBy'=r.requested_by::text and q.full_consent->>'confirmed'='true'
      and q.full_consent->>'contractHash'=q.full_contract_hash
      and exists(select 1 from public.paid_full_payment_holds h where h.quote_id=q.id and (h.released_at is null or h.release_reason='completed'))
      and r.manifest->'paidAuthorization'->>'contractHash'=q.full_contract_hash
      and r.manifest->'paidAuthorization'->'contract'=q.full_contract)
    else exists(select 1 from public.profiles where id=r.requested_by and is_platform_admin=true)
      and exists(select 1 from public.profiles where id=p_user_id and is_platform_admin=true) end);
$$;
create function public.full_takeoff_run_access(p_run_id uuid,p_user_id uuid,p_workspace_id uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.takeoff_runs where id=p_run_id and workspace_id=p_workspace_id)
    and private.full_takeoff_authorized(p_run_id,p_user_id);
$$;

create function private.paid_full_dispatch_current(p_run_id uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce((select case when payment_kind='paid' then
    (manifest->'paidAuthorization'->'contract'->'pricing'->>'expiresAt')::timestamptz>now()
    else true end from public.takeoff_runs where id=p_run_id),false);
$$;

create function public.reserve_paid_full_takeoff_v2(p_quote_id uuid,p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_file_id uuid,p_contract_hash text,p_version text)
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
  if not public.paid_full_capacity_ready((q.full_contract->'pricing'->>'operatingReserveUsd')::numeric,
    (q.full_contract->'pricing'->>'operatingReserveUsd')::numeric/nullif((q.full_contract->>'maximumCalls')::integer,0),q.id)
    or not exists(select 1 from public.paid_full_payment_holds where quote_id=q.id and released_at is null)
    then raise exception 'Company capacity cannot cover this Full reading'; end if;
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


-- Preserve existing lifecycle and evidence logic; replace only its authorization boundary.

create or replace function public.reserve_full_takeoff_v2(p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_file_id uuid,p_manifest jsonb,p_version text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; sheet jsonb; pages integer; reused boolean:=false;
begin
  if p_version is distinct from 'takeoff-v2.2-durable' or jsonb_typeof(p_manifest) is distinct from 'object'
     or coalesce(p_manifest->>'fileSha256','')!~'^[a-f0-9]{64}$'
     or jsonb_typeof(p_manifest->'sheets') is distinct from 'array' then raise exception 'Invalid Full Takeoff manifest'; end if;
  if p_manifest ? 'paidAuthorization' then raise exception 'A complimentary run cannot carry paid authorization'; end if;
  pages:=(p_manifest->>'physicalPageCount')::integer;
  if pages is null or pages not between 1 and 200 or jsonb_array_length(p_manifest->'sheets')<>pages
     or (select count(distinct (s->>'physicalPageNumber')::integer) from jsonb_array_elements(p_manifest->'sheets') s)<>pages then raise exception 'Invalid Full Takeoff pages'; end if;
  for sheet in select value from jsonb_array_elements(p_manifest->'sheets') loop
    if coalesce((sheet->>'physicalPageNumber')::integer,0) not between 1 and pages or coalesce(sheet->>'pageSha256','')!~'^[a-f0-9]{64}$'
       or coalesce((sheet->>'widthPoints')::numeric,0)<=0 or coalesce((sheet->>'heightPoints')::numeric,0)<=0
       or coalesce((sheet->>'rotationDegrees')::integer,-1) not in (0,90,180,270)
       or coalesce(sheet->>'contentKind','') not in ('vector','raster','mixed','blank','unknown')
       or coalesce(sheet->>'textQuality','') not in ('good','partial','none','unreadable','unknown') then raise exception 'Invalid physical sheet'; end if;
  end loop;
  -- Serialize owner reservations and recheck all tenant and consent boundaries.
  perform 1 from public.profiles where id=p_user_id and is_platform_admin=true for update;
  if not found then raise exception 'Platform administrator access required'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator'))
     or not exists(select 1 from public.workspaces where id=p_workspace_id and ai_processing_consented_at is not null)
     or not exists(select 1 from public.projects where id=p_project_id and workspace_id=p_workspace_id)
     or not exists(select 1 from public.project_files where id=p_file_id and workspace_id=p_workspace_id and project_id=p_project_id and processing_status not in ('uploading','failed')
       and (page_count is null or page_count=0 or page_count=pages)) then raise exception 'Full Takeoff access denied'; end if;
  if not public.full_takeoff_v2_worker_available(p_version) then raise exception 'Full Takeoff worker unavailable'; end if;
  select * into r from public.takeoff_runs where workspace_id=p_workspace_id and project_id=p_project_id and file_id=p_file_id
    and file_sha256=p_manifest->>'fileSha256' and mode='full' and orchestrator_version=p_version and payment_kind='complimentary' for update;
  if found then
    reused:=true;
    if r.manifest<>p_manifest then raise exception 'Saved Full Takeoff manifest differs'; end if;
  else
    if not public.paid_full_daily_capacity_ready(p_user_id) then raise exception 'Daily Full Takeoff limit reached'; end if;
    insert into public.takeoff_runs(workspace_id,project_id,file_id,mode,status,file_sha256,orchestrator_version,requested_by,manifest,progress)
      values(p_workspace_id,p_project_id,p_file_id,'full','queued',p_manifest->>'fileSha256',p_version,p_user_id,p_manifest,jsonb_build_object('completed',0,'total',pages*10)) returning * into r;
    for sheet in select value from jsonb_array_elements(p_manifest->'sheets') loop
      insert into public.plan_sheets(takeoff_run_id,workspace_id,project_id,file_id,physical_page_number,page_sha256,width_points,height_points,rotation_degrees,content_kind,text_quality,status,status_reason)
        values(r.id,p_workspace_id,p_project_id,p_file_id,(sheet->>'physicalPageNumber')::integer,sheet->>'pageSha256',(sheet->>'widthPoints')::numeric,(sheet->>'heightPoints')::numeric,
          (sheet->>'rotationDegrees')::integer,sheet->>'contentKind',sheet->>'textQuality','review_required','Deterministic preflight; source evidence and human review required.');
    end loop;
  end if;
  -- Return only reviewable lifecycle data, never worker leases or source content.
  return jsonb_build_object('reused',reused,'run',jsonb_build_object('id',r.id,'status',r.status,'progress',r.progress,'output_summary',r.output_summary));
end $$;

create or replace function public.claim_full_takeoff_v2(p_run_id uuid,p_worker_id text,p_version text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; f public.project_files; lease uuid;
begin
  if p_version<>'takeoff-v2.2-durable' or length(coalesce(p_worker_id,'')) not between 1 and 160 then raise exception 'Invalid Full Takeoff worker'; end if;
  select * into r from public.takeoff_runs where id=p_run_id and mode='full' and orchestrator_version=p_version for update;
  if not found then raise exception 'Full Takeoff run unavailable'; end if;
  if r.status in ('needs_review','ready','failed','cancelled') then return jsonb_build_object('skip',true,'status',r.status); end if;
  if not private.full_takeoff_authorized(r.id,r.requested_by) or not private.paid_full_dispatch_current(r.id) then raise exception 'Full Takeoff authorization revoked'; end if;
  if r.status='processing' and r.worker_lease_expires_at>now() then raise exception 'Full Takeoff is already leased'; end if;
  if r.cancel_requested_at is not null then
    update public.takeoff_runs set status='cancelled',updated_at=now() where id=r.id;
    return jsonb_build_object('skip',true,'status','cancelled');
  end if;
  if exists(select 1 from public.takeoff_passes where takeoff_run_id=r.id and status in ('processing','failed')) then
    update public.takeoff_runs set status='failed',processing_error='An uncertain pass requires reconciliation before another provider call.',worker_lease_id=null,worker_lease_expires_at=null,updated_at=now() where id=r.id;
    return jsonb_build_object('skip',true,'status','failed','reconciliation_required',true);
  end if;
  select * into f from public.project_files where id=r.file_id and workspace_id=r.workspace_id and project_id=r.project_id and processing_status not in ('uploading','failed');
  if not found then raise exception 'Full Takeoff file unavailable'; end if;
  lease:=gen_random_uuid();
  update public.takeoff_runs set status='processing',started_at=coalesce(started_at,now()),worker_id=p_worker_id,worker_lease_id=lease,
    worker_lease_expires_at=now()+interval '90 seconds',worker_heartbeat_at=now(),updated_at=now() where id=r.id;
  return jsonb_build_object('skip',false,'lease_id',lease,'workspace_id',r.workspace_id,'project_id',r.project_id,'file_id',r.file_id,
    'requested_by',r.requested_by,'manifest',r.manifest,'storage_path',f.storage_path);
end $$;

create or replace function public.heartbeat_full_takeoff_v2(p_run_id uuid,p_lease_id uuid,p_worker_id text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.takeoff_runs set worker_heartbeat_at=now(),worker_lease_expires_at=now()+interval '90 seconds'
    where id=p_run_id and worker_lease_id=p_lease_id and worker_id=p_worker_id and status='processing'
      and cancel_requested_at is null and worker_lease_expires_at>now()
      and private.full_takeoff_authorized(takeoff_runs.id,takeoff_runs.requested_by) and private.paid_full_dispatch_current(takeoff_runs.id);
  return found;
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
    raise exception 'Full Takeoff pass requires reconciliation';
  end if;
  insert into public.takeoff_passes(takeoff_run_id,workspace_id,project_id,plan_sheet_id,pass_type,attempt,status,idempotency_key,started_at)
    values(r.id,r.workspace_id,r.project_id,s.id,p_pass_type,p_attempt,'processing',p_idempotency_key,now());
  update public.takeoff_runs set progress=progress||jsonb_build_object('currentPage',p_page_number,'currentPass',p_pass_type),updated_at=now() where id=r.id;
  return 'run';
end $$;

create or replace function public.checkpoint_full_takeoff_v2_pass(p_run_id uuid,p_lease_id uuid,p_page_number integer,p_pass_type text,p_attempt integer,p_idempotency_key text,p_result jsonb,p_failure jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; s public.plan_sheets; state text; complete_count integer;
begin
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing' and cancel_requested_at is null and worker_lease_expires_at>now() for update;
  if not found then raise exception 'Full Takeoff lease invalid'; end if;
  if not private.full_takeoff_authorized(r.id,r.requested_by) then raise exception 'Full Takeoff authorization revoked'; end if;
  select * into s from public.plan_sheets where takeoff_run_id=r.id and physical_page_number=p_page_number and workspace_id=r.workspace_id and project_id=r.project_id;
  if not found then raise exception 'Full Takeoff sheet unavailable'; end if;
  if p_failure is not null then
    if p_result is not null or p_failure->>'classification' not in ('invalid_output','provider_or_pipeline_failure') then raise exception 'Invalid Full Takeoff failure'; end if;
    state:='failed';
  else
    if jsonb_typeof(p_result)<>'object' or p_result->>'status' not in ('succeeded','blocked')
       or jsonb_typeof(p_result->'checkpoint')<>'object' or octet_length((p_result->'checkpoint')::text)>1000000 then raise exception 'Invalid Full Takeoff checkpoint'; end if;
    state:=p_result->>'status';
  end if;
  update public.takeoff_passes set status=state,checkpoint=case when p_failure is not null then jsonb_build_object('error','The pass requires reconciliation before another attempt.') else p_result->'checkpoint' end,
    provider=left(p_result->>'provider',160),model=left(p_result->>'model',160),input_tokens=(p_result->>'inputTokens')::bigint,output_tokens=(p_result->>'outputTokens')::bigint,
    failure_classification=p_failure->>'classification',completed_at=now()
    where takeoff_run_id=r.id and plan_sheet_id=s.id and pass_type=p_pass_type and attempt=p_attempt and idempotency_key=p_idempotency_key and status='processing';
  if not found then raise exception 'Full Takeoff pass no longer processing'; end if;
  select count(*) into complete_count from public.takeoff_passes where takeoff_run_id=r.id and status in ('succeeded','blocked');
  update public.takeoff_runs set progress=progress||jsonb_build_object('completed',complete_count),updated_at=now() where id=r.id;
  return true;
end $$;

create or replace function public.finish_full_takeoff_v2(p_run_id uuid,p_lease_id uuid,p_summary jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; state text; completed integer; blocked integer; expected integer;
begin
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing' and cancel_requested_at is null and worker_lease_expires_at>now() for update;
  if not found then raise exception 'Full Takeoff lease invalid'; end if;
  if not private.full_takeoff_authorized(r.id,r.requested_by) then raise exception 'Full Takeoff authorization revoked'; end if;
  select count(*) filter(where status in ('succeeded','blocked')),count(*) filter(where status in ('blocked','failed','processing')) into completed,blocked from public.takeoff_passes where takeoff_run_id=r.id;
  expected:=(r.manifest->>'physicalPageCount')::integer*10;
  state:=case when completed<>expected then 'failed' else 'needs_review' end;
  update public.takeoff_runs set status=state,completed_at=now(),worker_lease_id=null,worker_lease_expires_at=null,updated_at=now(),
    progress=progress||jsonb_build_object('completed',completed,'total',expected),
    output_summary=jsonb_build_object('takeoff_v2',jsonb_build_object('mode','full_v2','releaseStatus',case when completed=expected and blocked=0 then 'review_ready' else 'blocked' end,
      'budgetStatus','awaiting_measurement_and_price_evidence','humanReviewRequired',true,'summary',p_summary)) where id=r.id;
  if r.payment_kind='paid' then
    update public.project_reading_quotes set status=case when state='needs_review' then 'complete' else 'failed' end where id=r.payment_quote_id and status<>'revoked';
    if state='needs_review' then update public.paid_full_payment_holds set released_at=now(),release_reason='completed' where quote_id=r.payment_quote_id and released_at is null; end if;
  end if;
  return jsonb_build_object('id',r.id,'status',state,'releaseStatus',case when completed=expected and blocked=0 then 'review_ready' else 'blocked' end,'humanReviewRequired',true);
end $$;

create or replace function public.cancel_full_takeoff_v2(p_run_id uuid,p_user_id uuid,p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs;
begin
  if not private.full_takeoff_authorized(p_run_id,p_user_id) then raise exception 'Full Takeoff access denied'; end if;
  select * into r from public.takeoff_runs where id=p_run_id and workspace_id=p_workspace_id and orchestrator_version='takeoff-v2.2-durable' for update;
  if not found then raise exception 'Full Takeoff run unavailable'; end if;
  if r.status in ('queued','processing') then
    update public.takeoff_runs set cancel_requested_at=now(),status='cancelled',worker_lease_id=null,worker_lease_expires_at=null,updated_at=now() where id=r.id;
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
  if exists(select 1 from public.takeoff_passes where takeoff_run_id=r.id and status in ('processing','failed')) then raise exception 'Full Takeoff requires reconciliation'; end if;
  update public.takeoff_runs set status='queued',cancel_requested_at=null,processing_error=null,worker_id=null,worker_lease_id=null,worker_lease_expires_at=null,updated_at=now() where id=r.id;
  return jsonb_build_object('id',r.id,'status','queued','completedCheckpointsPreserved',true);
end $$;

create or replace function public.reserve_provider_spend_before_full_run_budget(p_event_id uuid,p_job_id uuid,p_workspace_id uuid,p_user_id uuid,p_provider text,p_model text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare policy public.provider_spend_policy; used numeric(12,6); reservation public.provider_spend_reservations; full_run boolean:=false; authorized_project uuid;
begin
  if exists(select 1 from public.takeoff_runs where id=p_job_id and payment_kind='paid')
    and (not private.full_takeoff_authorized(p_job_id,p_user_id) or not private.paid_full_dispatch_current(p_job_id)) then raise exception 'Paid Full authorization revoked'; end if;
  if p_provider not in ('gemini','deepseek','kimi','openai','claude') or btrim(coalesce(p_model,''))='' then raise exception 'Provider spend identity is invalid'; end if;
  select * into policy from public.provider_spend_policy where singleton for update;
  if not found or not policy.enabled then raise exception 'Company AI spend is disabled'; end if;
  select * into reservation from public.provider_spend_reservations where event_id=p_event_id;
  if found then
    if coalesce(reservation.job_id,reservation.takeoff_run_id) is distinct from p_job_id or reservation.workspace_id is distinct from p_workspace_id
       or reservation.user_id is distinct from p_user_id or reservation.provider is distinct from p_provider or reservation.model is distinct from p_model then raise exception 'Provider spend reservation identity mismatch'; end if;
    return to_jsonb(reservation);
  end if;
  select project_id into authorized_project from public.plan_reading_jobs where id=p_job_id and workspace_id=p_workspace_id and requested_by=p_user_id for share;
  if not found then
    select project_id into authorized_project from public.takeoff_runs where id=p_job_id and workspace_id=p_workspace_id and requested_by=p_user_id and mode='full'
      and orchestrator_version='takeoff-v2.2-durable' and status='processing' and cancel_requested_at is null and worker_lease_expires_at>now() for share;
    if not found then raise exception 'Provider spend job is not authorized'; end if;
    full_run:=true;
    if not private.full_takeoff_authorized(p_job_id,p_user_id) then raise exception 'Provider spend Full Takeoff access denied'; end if;
  end if;
  perform 1 from public.api_usage_events where id=p_event_id and workspace_id=p_workspace_id and project_id=authorized_project
    and user_id=p_user_id and provider=p_provider and model=p_model
    and (not full_run or operation like 'rb1:'||p_job_id::text||':generate:%') for share;
  if not found then raise exception 'Provider spend event is not authorized'; end if;
  select coalesce(sum(case when status='captured' and telemetry_known then estimated_cost_usd else reserved_usd end),0) into used
    from public.provider_spend_reservations where created_at>now()-policy.rolling_window;
  if used+policy.call_reservation_usd>policy.spend_cap_usd then raise exception 'Company AI spend limit reached'; end if;
  insert into public.provider_spend_reservations(event_id,job_id,takeoff_run_id,workspace_id,user_id,provider,model,reserved_usd)
    values(p_event_id,case when full_run then null else p_job_id end,case when full_run then p_job_id else null end,p_workspace_id,p_user_id,p_provider,p_model,policy.call_reservation_usd) returning * into reservation;
  return to_jsonb(reservation);
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
      and (p->>'maximumCalls')::integer=p_maximum_calls and p_approval_ref='paid-full-v1:'||r.payment_quote_id::text||':'||r.payment_revision::text)
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
    raise exception 'Uncertain regional dispatch requires reconciliation';
  end if;
  insert into public.takeoff_region_checkpoints(takeoff_run_id,workspace_id,project_id,plan_sheet_id,physical_page_number,page_sha256,
    pass_type,region_key,region,idempotency_key,status) values(r.id,r.workspace_id,r.project_id,s.id,p_page_number,p_page_sha256,p_pass_type,p_region_key,p_region,p_idempotency_key,'processing');
  update public.takeoff_runs set progress=progress||jsonb_build_object('currentRegion',p_region_key,'currentPage',p_page_number,
    'currentPass',p_pass_type,'regionsPerPass',cols*rows),updated_at=now() where id=r.id;
  return jsonb_build_object('disposition','run');
end $$;

create or replace function public.save_full_takeoff_region(p_run_id uuid,p_lease_id uuid,p_page_number integer,p_page_sha256 text,
  p_pass_type text,p_region_key text,p_region jsonb,p_idempotency_key text,p_result jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs;
begin
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing'
    and worker_lease_expires_at>now() and cancel_requested_at is null for update;
  if not found then raise exception 'Regional checkpoint lease is invalid'; end if;
  if not private.full_takeoff_authorized(r.id,r.requested_by) then raise exception 'Paid Full authorization revoked'; end if;
  if coalesce(jsonb_typeof(p_result),'null')<>'object' or coalesce(p_result->>'status','') not in ('succeeded','blocked')
    or coalesce(jsonb_typeof(p_result->'checkpoint'),'null')<>'object' or octet_length(p_result::text)>300000
    or not (p_result->'checkpoint') ?& array['physical_page_number','pass_type']
    or (p_result->'checkpoint'->>'physical_page_number')::integer<>p_page_number
    or p_result->'checkpoint'->>'pass_type'<>p_pass_type then raise exception 'Regional output identity is invalid'; end if;
  update public.takeoff_region_checkpoints set status=p_result->>'status',result=p_result,completed_at=now()
    where takeoff_run_id=r.id and workspace_id=r.workspace_id and project_id=r.project_id
    and physical_page_number=p_page_number and page_sha256=p_page_sha256 and pass_type=p_pass_type and region_key=p_region_key
    and region=p_region and idempotency_key=p_idempotency_key and status='processing';
  if not found then raise exception 'Regional checkpoint cannot be overwritten'; end if;
  return true;
end $$;

create or replace function public.record_takeoff_measurement_review(p_run_id uuid,p_workspace_id uuid,p_user_id uuid,p_review jsonb)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare r public.takeoff_runs;s public.plan_sheets;previous public.takeoff_measurement_reviews;saved public.takeoff_measurement_reviews;
  result jsonb;measurement_id uuid;page integer;expected integer;width_ numeric;height_ numeric;revision_ integer;state text;
begin
  if jsonb_typeof(p_review) is distinct from 'object' or octet_length(p_review::text)>50000 then raise exception 'Invalid bounded measurement review'; end if;
  if not private.full_takeoff_authorized(p_run_id,p_user_id) then raise exception 'Measurement review access denied'; end if;
  select * into r from public.takeoff_runs where id=p_run_id and workspace_id=p_workspace_id and mode='full' and orchestrator_version='takeoff-v2.2-durable' for share;
  if not found or p_review->>'fileSha256' is distinct from r.file_sha256 then raise exception 'Measurement file revision mismatch'; end if;
  measurement_id:=(p_review->>'measurementId')::uuid;page:=(p_review->>'physicalPageNumber')::integer;expected:=(p_review->>'expectedRevision')::integer;state:=p_review->>'decision';
  if measurement_id is null or page not between 1 and 200 or expected is null or expected<0 or state not in ('candidate','accepted','rejected','blocked')
    or coalesce(p_review->>'regionKey','')!~'^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$'
    or coalesce(p_review->>'canonicalElementKey','')!~'^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$'
    or coalesce(p_review->>'canonicalTrade','')!~'^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$'
    or length(coalesce(btrim(p_review->>'label'),'')) not between 1 and 240 or length(coalesce(btrim(p_review->>'sourceExcerpt'),'')) not between 1 and 1200
    or coalesce(p_review->>'sourceKind','') not in ('manual_trace','native_vector_candidate','manual_observed_count') then raise exception 'Invalid measurement review identity'; end if;
  if p_review->>'sourceKind'='native_vector_candidate' and (coalesce(p_review->>'sourceCandidateId','')!~'^[a-f0-9]{64}$'
     or p_review->'nativeCandidate'->>'id' is distinct from p_review->>'sourceCandidateId'
     or p_review->'nativeCandidate'->>'pageSha256' is distinct from p_review->>'pageSha256'
     or p_review->'nativeCandidate'->>'fileSha256' is distinct from r.file_sha256
     or p_review->'nativeCandidate'->>'physicalPageNumber' is distinct from p_review->>'physicalPageNumber'
     or p_review->'nativeCandidate'->>'source' is distinct from 'native_pdf_vector'
     or jsonb_typeof(p_review->'nativeCandidate'->'bbox') is distinct from 'array'
     or jsonb_array_length(p_review->'nativeCandidate'->'bbox')<>4
     or exists(select 1 from jsonb_array_elements(p_review->'nativeCandidate'->'bbox') coordinate where jsonb_typeof(coordinate)<>'number')) then raise exception 'Native candidate proof unavailable'; end if;
  select * into s from public.plan_sheets where takeoff_run_id=r.id and workspace_id=r.workspace_id and project_id=r.project_id and file_id=r.file_id and physical_page_number=page for share;
  if not found or p_review->>'pageSha256' is distinct from s.page_sha256 then raise exception 'Measurement physical page revision mismatch'; end if;
  width_:=case when s.rotation_degrees in (90,270) then s.height_points else s.width_points end;height_:=case when s.rotation_degrees in (90,270) then s.width_points else s.height_points end;
  result:=private.calculate_reviewed_measurement(p_review,width_,height_);
  select * into previous from public.takeoff_measurement_reviews where id=measurement_id for update;
  if found then
    if previous.takeoff_run_id<>r.id or previous.workspace_id<>p_workspace_id or previous.review_revision<>expected then raise exception 'Measurement review revision conflict'; end if;
    revision_:=previous.review_revision+1;
  else
    if expected<>0 then raise exception 'Measurement review revision conflict'; end if;
    revision_:=1;
  end if;
  insert into public.takeoff_measurement_reviews(id,takeoff_run_id,workspace_id,project_id,file_id,plan_sheet_id,file_sha256,physical_page_number,page_sha256,region_key,region_bounds,
    canonical_element_key,canonical_trade,label,geometry,geometry_fingerprint,source_kind,source_candidate_id,quantity,unit,calibration,proof,formula,method,uncertainty,review_status,review_revision,reviewed_by,reviewed_at)
  values(measurement_id,r.id,r.workspace_id,r.project_id,r.file_id,s.id,r.file_sha256,page,s.page_sha256,p_review->>'regionKey',p_review->'regionBounds',p_review->>'canonicalElementKey',p_review->>'canonicalTrade',btrim(p_review->>'label'),
    p_review->'geometry',private.measurement_geometry_fingerprint(p_review->'geometry'),p_review->>'sourceKind',p_review->>'sourceCandidateId',(result->>'quantity')::numeric,result->>'unit',result->'calibration',
    jsonb_build_object('version','measurement-review-v1','fileSha256',r.file_sha256,'pageSha256',s.page_sha256,'regionKey',p_review->>'regionKey','sourceExcerpt',p_review->>'sourceExcerpt',
      'geometryReviewed',p_review->'geometryReviewed','identityReviewed',p_review->'identityReviewed','duplicateReviewComplete',p_review->'duplicateReviewComplete','boundaryEvidence',p_review->'boundaryEvidence','calibrationEvidence',p_review->'calibrationEvidence','nativeCandidate',p_review->'nativeCandidate'),
    nullif(result->'formula','null'::jsonb),case when p_review->'geometry'->>'type' in ('point','count') then 'reviewed_visible_identity' else 'reviewed_geometry' end,p_review->'uncertainty',state,revision_,p_user_id,now())
  on conflict(id) do update set plan_sheet_id=excluded.plan_sheet_id,physical_page_number=excluded.physical_page_number,page_sha256=excluded.page_sha256,region_key=excluded.region_key,region_bounds=excluded.region_bounds,
    canonical_element_key=excluded.canonical_element_key,canonical_trade=excluded.canonical_trade,label=excluded.label,geometry=excluded.geometry,geometry_fingerprint=excluded.geometry_fingerprint,
    source_kind=excluded.source_kind,source_candidate_id=excluded.source_candidate_id,quantity=excluded.quantity,unit=excluded.unit,calibration=excluded.calibration,proof=excluded.proof,formula=excluded.formula,
    method=excluded.method,uncertainty=excluded.uncertainty,review_status=excluded.review_status,review_revision=excluded.review_revision,reviewed_by=excluded.reviewed_by,reviewed_at=now(),updated_at=now()
    where expected>0 and takeoff_measurement_reviews.review_revision=expected and takeoff_measurement_reviews.takeoff_run_id=r.id and takeoff_measurement_reviews.workspace_id=p_workspace_id returning * into saved;
  if not found then raise exception 'Measurement review revision conflict'; end if;
  insert into public.takeoff_measurement_review_events(measurement_id,workspace_id,project_id,reviewer_id,revision,snapshot)
    values(saved.id,saved.workspace_id,saved.project_id,p_user_id,saved.review_revision,to_jsonb(saved));
  return to_jsonb(saved);
end $$;

create or replace function public.confirm_project_reading_payment(p_event_id text, p_quote_id uuid, p_session_id text,
  p_payment_intent text, p_amount integer, p_currency text, p_livemode boolean)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.project_reading_quotes; begin
  select * into q from public.project_reading_quotes where id = p_quote_id for update;
  if not found then raise exception 'Quote not found'; end if;
  if q.mode='full_v2' and (not q.livemode or q.full_consent->>'confirmed' is distinct from 'true' or q.full_consent->>'approvedBy' is distinct from q.user_id::text or q.full_consent->>'contractHash' is distinct from q.full_contract_hash
    or not exists(select 1 from public.paid_full_payment_holds where quote_id=q.id)) then raise exception 'Paid Full consent is required'; end if;
  if q.amount_cents <> p_amount or q.currency <> p_currency or q.livemode <> p_livemode
    or p_session_id is null or p_payment_intent is null then raise exception 'Payment does not match quote'; end if;
  if q.stripe_session_id is not null and q.stripe_session_id <> p_session_id then raise exception 'Payment session mismatch'; end if;
  insert into public.project_payment_events(event_id, quote_id) values (p_event_id, q.id) on conflict do nothing;
  if not found then return false; end if;
  update public.project_reading_quotes set
    status = case when status = 'quoted' then 'paid' else status end,
    payment_revision=case when mode='full_v2' and status='quoted' then payment_revision+1 else payment_revision end,
    stripe_session_id = p_session_id, payment_intent_id = p_payment_intent, paid_at = coalesce(paid_at, now())
    where id = q.id;
  return true;
end $$;

create or replace function public.revoke_project_reading_payment(p_event_id text, p_quote_id uuid, p_payment_intent text, p_livemode boolean)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.project_reading_quotes; begin
  select * into q from public.project_reading_quotes where id=p_quote_id for update;
  if not found or q.livemode <> p_livemode or (q.payment_intent_id is not null and q.payment_intent_id <> p_payment_intent) then
    raise exception 'Payment does not match quote'; end if;
  insert into public.project_payment_events(event_id,quote_id) values(p_event_id,q.id) on conflict do nothing;
  if not found then return false; end if;
  update public.project_reading_quotes set status='revoked',payment_intent_id=p_payment_intent,
    payment_revision=case when mode='full_v2' and status<>'revoked' then payment_revision+1 else payment_revision end where id=q.id;
  if q.mode='full_v2' then update public.paid_full_payment_holds set released_at=now(),release_reason='revoked' where quote_id=q.id and released_at is null; end if;
  update public.plan_reading_jobs set status='failed',processing_error='Payment was refunded or disputed',completed_at=now()
    where id=q.job_id and status='processing';
  return true;
end $$;

create function public.fail_paid_full_payment(p_event_id text,p_quote_id uuid,p_session_id text,p_livemode boolean,p_release_reason text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.project_reading_quotes;
begin
  select * into q from public.project_reading_quotes where id=p_quote_id and mode='full_v2' for update;
  if not found or q.livemode is distinct from p_livemode or p_session_id is null or p_session_id='' or p_release_reason not in ('expired','failed')
    or (q.stripe_session_id is not null and q.stripe_session_id<>p_session_id) then raise exception 'Payment failure does not match quote'; end if;
  insert into public.project_payment_events(event_id,quote_id) values(p_event_id,q.id) on conflict do nothing;
  if not found then return false; end if;
  if q.paid_at is null and q.status='quoted' then
    update public.project_reading_quotes set status='revoked',stripe_session_id=p_session_id,payment_revision=payment_revision+1 where id=q.id;
    update public.paid_full_payment_holds set released_at=now(),release_reason=p_release_reason where quote_id=q.id and released_at is null;
  end if;
  return true;
end $$;

-- Applies to ALL providers without replacing the existing shared-cap wrapper
-- chain. A paid call consumes its own reserved exposure rather than counting
-- both its hold and the new call. Unknown costs remain reserved in the ledger.
create function private.check_paid_full_company_exposure() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare policy public.provider_spend_policy; used numeric; held numeric; own_remaining numeric:=0; quote_ uuid;
begin
  select * into policy from public.provider_spend_policy where singleton for update;
  if not found or not policy.enabled then raise exception 'Company AI spend is disabled'; end if;
  select coalesce(sum(case when status='captured' and telemetry_known then estimated_cost_usd else reserved_usd end),0)
    into used from public.provider_spend_reservations where created_at>now()-policy.rolling_window;
  select used+coalesce(sum(reserved_usd),0) into used from public.geometry_provider_spend_reservations where created_at>now()-policy.rolling_window;
  held:=private.paid_full_held_exposure();
  if tg_table_name='provider_spend_reservations' then
    if new.takeoff_run_id is not null then
      select payment_quote_id into quote_ from public.takeoff_runs where id=new.takeoff_run_id and payment_kind='paid';
      if quote_ is not null then
        if not private.full_takeoff_authorized(new.takeoff_run_id,new.user_id) then raise exception 'Paid Full authorization revoked'; end if;
        if not exists(select 1 from public.project_reading_quotes q where q.id=quote_
          and (q.full_contract->'pricing'->>'operatingReserveUsd')::numeric/nullif((q.full_contract->>'maximumCalls')::integer,0)=new.reserved_usd)
          then raise exception 'Paid Full call reservation differs from the purchased contract'; end if;
        own_remaining:=held-private.paid_full_held_exposure(quote_);
      end if;
    end if;
  end if;
  if used+held+greatest(0,new.reserved_usd-own_remaining)>policy.spend_cap_usd then raise exception 'Company AI spend limit includes pending paid readings'; end if;
  return new;
end $$;
create trigger paid_full_company_exposure before insert on public.provider_spend_reservations for each row execute function private.check_paid_full_company_exposure();
create trigger paid_full_geometry_exposure before insert on public.geometry_provider_spend_reservations for each row execute function private.check_paid_full_company_exposure();

create function private.protect_full_payment_identity() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if (new.payment_kind,new.payment_quote_id,new.payment_revision) is distinct from (old.payment_kind,old.payment_quote_id,old.payment_revision)
    or (old.payment_kind='paid' and new.manifest is distinct from old.manifest) then raise exception 'Full purchase identity is immutable'; end if;
  return new;
end $$;
create trigger protect_full_payment_identity before update on public.takeoff_runs for each row execute function private.protect_full_payment_identity();

create function private.sync_paid_full_lifecycle() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.payment_kind='paid' and new.status is distinct from old.status then
    update public.project_reading_quotes set status=case when new.status in ('needs_review','ready') then 'complete'
      when new.status in ('failed','cancelled') then 'failed' else 'processing' end
      where id=new.payment_quote_id and full_run_id=new.id and payment_revision=new.payment_revision and status<>'revoked';
  end if;
  return new;
end $$;
create trigger sync_paid_full_lifecycle after update of status on public.takeoff_runs for each row execute function private.sync_paid_full_lifecycle();

revoke all on function private.protect_paid_full_contract(),private.protect_full_payment_identity(),private.sync_paid_full_lifecycle(),private.check_paid_full_company_exposure(),
  private.paid_full_held_exposure(uuid),private.full_takeoff_authorized(uuid,uuid),private.paid_full_dispatch_current(uuid) from public,anon,authenticated;
revoke all on function public.paid_full_capacity_ready(numeric,numeric,uuid),public.paid_full_daily_capacity_ready(uuid,uuid),public.create_paid_full_quote(jsonb),
  public.accept_paid_full_quote(uuid,uuid,uuid,uuid,text),public.full_takeoff_run_access(uuid,uuid,uuid),
  public.reserve_paid_full_takeoff_v2(uuid,uuid,uuid,uuid,uuid,text,text),public.fail_paid_full_payment(text,uuid,text,boolean,text) from public,anon,authenticated;
grant execute on function public.paid_full_capacity_ready(numeric,numeric,uuid),public.paid_full_daily_capacity_ready(uuid,uuid),public.create_paid_full_quote(jsonb),
  public.accept_paid_full_quote(uuid,uuid,uuid,uuid,text),public.full_takeoff_run_access(uuid,uuid,uuid),
  public.reserve_paid_full_takeoff_v2(uuid,uuid,uuid,uuid,uuid,text,text),public.fail_paid_full_payment(text,uuid,text,boolean,text) to service_role;

-- A Full purchase never authorizes a quick reading.
create or replace function public.create_project_reading_quote(p_input jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.project_reading_quotes; v public.project_reading_quotes; begin
  v := jsonb_populate_record(null::public.project_reading_quotes,p_input);
  perform 1 from public.workspaces where id=v.workspace_id for update;
  if not exists(select 1 from public.workspace_members where workspace_id=v.workspace_id and user_id=v.user_id and role in ('admin','estimator')) then raise exception 'Workspace access denied'; end if;
  if not exists(select 1 from public.project_files where id=v.file_id and workspace_id=v.workspace_id and project_id=v.project_id) then raise exception 'File unavailable'; end if;
  select * into q from public.project_reading_quotes where mode='quick' and workspace_id=v.workspace_id and project_id=v.project_id
    and file_id=v.file_id and file_sha256=v.file_sha256 and scope=v.scope and trades=v.trades and livemode=v.livemode
    and status <> 'revoked' and (paid_at is not null or (expires_at > now() and stripe_session_id is not null)
      or (expires_at > now()+interval '31 minutes' and amount_cents=v.amount_cents and membership=v.membership and pricing_version=v.pricing_version))
    order by created_at desc limit 1;
  if found then return to_jsonb(q); end if;
  insert into public.project_reading_quotes(workspace_id,project_id,file_id,user_id,file_sha256,page_count,trades,scope,amount_cents,cost_cents,pricing_version,membership,livemode)
    values(v.workspace_id,v.project_id,v.file_id,v.user_id,v.file_sha256,v.page_count,v.trades,v.scope,v.amount_cents,v.cost_cents,v.pricing_version,v.membership,v.livemode) returning * into q;
  return to_jsonb(q);
end $$;

create or replace function public.reserve_project_reading(p_quote_id uuid, p_user_id uuid, p_workspace_id uuid,
  p_project_id uuid, p_file_id uuid, p_model text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.project_reading_quotes; j public.plan_reading_jobs; begin
  -- Workspace row serializes the daily cap across projects, not only one quote.
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not exists (select 1 from public.workspace_members where workspace_id = p_workspace_id and user_id = p_user_id and role in ('admin','estimator')) then
    raise exception 'Workspace access denied'; end if;
  if not exists (select 1 from public.workspaces where id = p_workspace_id and ai_processing_consented_at is not null) then
    raise exception 'AI processing consent required'; end if;
  select * into q from public.project_reading_quotes where mode='quick' and id = p_quote_id and workspace_id = p_workspace_id
    and project_id = p_project_id and file_id = p_file_id for update;
  if not found then raise exception 'Paid quote required'; end if;
  if not exists (select 1 from public.project_files where id = p_file_id and workspace_id = p_workspace_id
    and project_id = p_project_id and processing_status not in ('uploading','failed')) then raise exception 'File unavailable'; end if;
  if q.status = 'complete' then
    select * into j from public.plan_reading_jobs where id = q.job_id;
    return jsonb_build_object('reused', true, 'job', to_jsonb(j), 'quote', to_jsonb(q));
  end if;
  if q.status = 'processing' then raise exception 'This reading is already processing'; end if;
  if q.status not in ('paid','failed') or q.paid_at is null then raise exception 'Paid quote required'; end if;
  if q.attempts >= 2 then raise exception 'Attempt limit reached. Contact support for review or refund'; end if;
  if (select count(*) from public.plan_reading_jobs where workspace_id = p_workspace_id and created_at > now() - interval '24 hours') >= 25 then
    raise exception 'Daily reading limit reached'; end if;
  if q.job_id is null then
    insert into public.plan_reading_jobs(workspace_id, project_id, file_id, requested_by, status, mode, model, started_at, input_summary)
      values(p_workspace_id, p_project_id, p_file_id, p_user_id, 'processing', 'quick', p_model, now(),
      jsonb_build_object('quote_id',q.id,'requested_trades',q.trades,'requested_scope',q.scope,'human_review_required',true)) returning * into j;
  else
    update public.plan_reading_jobs set status='processing', processing_error=null, started_at=now(), completed_at=null
      where id=q.job_id returning * into j;
  end if;
  update public.project_reading_quotes set status='processing', attempts=attempts+1, job_id=j.id where id=q.id returning * into q;
  return jsonb_build_object('reused',false,'job',to_jsonb(j),'quote',to_jsonb(q));
end $$;

create or replace function public.reserve_project_reading_async(
  p_quote_id uuid, p_user_id uuid, p_workspace_id uuid, p_project_id uuid, p_file_id uuid, p_model text)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare q public.project_reading_quotes; j public.plan_reading_jobs; begin
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if not found then raise exception 'Workspace not found'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator')) then
    raise exception 'Workspace access denied'; end if;
  if not exists(select 1 from public.workspaces where id=p_workspace_id and ai_processing_consented_at is not null) then
    raise exception 'AI processing consent required'; end if;
  select * into q from public.project_reading_quotes where mode='quick' and id=p_quote_id and workspace_id=p_workspace_id
    and project_id=p_project_id and file_id=p_file_id for update;
  if not found then raise exception 'Paid quote required'; end if;
  if not exists(select 1 from public.project_files where id=p_file_id and workspace_id=p_workspace_id and project_id=p_project_id
    and processing_status not in ('uploading','failed')) then raise exception 'File unavailable'; end if;
  if q.status='complete' and q.job_id is not null then
    select * into j from public.plan_reading_jobs where id=q.job_id;
    return jsonb_build_object('reused',true,'job',to_jsonb(j),'quote',to_jsonb(q));
  end if;
  if q.status='processing' and q.job_id is not null then
    select * into j from public.plan_reading_jobs where id=q.job_id;
    if found and j.status in ('queued','processing','needs_review','ready') then
      return jsonb_build_object('reused',true,'job',to_jsonb(j),'quote',to_jsonb(q));
    end if;
  end if;
  if q.status not in ('paid','failed','processing') or q.paid_at is null then raise exception 'Paid quote required'; end if;
  if q.attempts >= 2 then raise exception 'Attempt limit reached. Contact support for review or refund'; end if;
  if (select count(*) from public.plan_reading_jobs where workspace_id=p_workspace_id and created_at > now()-interval '24 hours') >= 25 then
    raise exception 'Daily reading limit reached'; end if;

  if q.job_id is null then
    insert into public.plan_reading_jobs(workspace_id,project_id,file_id,requested_by,status,mode,model,input_summary)
    values(p_workspace_id,p_project_id,p_file_id,p_user_id,'queued','quick',p_model,
      jsonb_build_object('entitlement','paid','quote_id',q.id,'file_sha256',q.file_sha256,'page_count',q.page_count,
        'requested_trades',q.trades,'requested_scope',q.scope,'human_review_required',true))
    returning * into j;
  else
    update public.plan_reading_jobs set status='queued',processing_error=null,completed_at=null,cancel_requested_at=null,
      worker_id=null,worker_lease_id=null,worker_lease_expires_at=null,worker_heartbeat_at=null,
      input_summary=jsonb_build_object('entitlement','paid','quote_id',q.id,'file_sha256',q.file_sha256,'page_count',q.page_count,
        'requested_trades',q.trades,'requested_scope',q.scope,'human_review_required',true),
      processing_checkpoint='{}'::jsonb
      where id=q.job_id returning * into j;
  end if;
  update public.project_reading_quotes set status='processing',job_id=j.id where id=q.id returning * into q;
  return jsonb_build_object('reused',false,'job',to_jsonb(j),'quote',to_jsonb(q));
end $$;
