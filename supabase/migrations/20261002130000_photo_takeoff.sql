-- REVIEW ONLY. Requires 20261002120000_full_takeoff_v2_durable.sql and the
-- existing company spend/capture migrations. No policy, price or budget is seeded.
-- Photo jobs have their own parent and cannot impersonate a PDF reading job.
create table public.photo_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  storage_path text not null,
  original_name text not null check(length(original_name) between 1 and 255),
  mime_type text not null check(mime_type in ('image/jpeg','image/png','image/webp')),
  byte_size bigint not null check(byte_size between 1 and 20971520),
  status text not null default 'uploading' check(status in ('uploading','ready')),
  sha256 text,
  width_pixels integer,
  height_pixels integer,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check(status<>'ready' or (sha256 is not null and sha256~'^[a-f0-9]{64}$' and width_pixels is not null and height_pixels is not null and width_pixels>0 and height_pixels>0 and width_pixels::bigint*height_pixels<=64000000 and completed_at is not null)),
  foreign key(project_id,workspace_id) references public.projects(id,workspace_id) on delete cascade,
  unique(id,workspace_id), unique(id,workspace_id,project_id), unique(storage_path)
);
create index photo_assets_project_idx on public.photo_assets(workspace_id,project_id,created_at);
create table public.photo_takeoff_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  requested_by uuid not null references auth.users(id) on delete restrict,
  request_key uuid not null,
  version text not null default 'photo-takeoff-v1' check(version='photo-takeoff-v1'),
  profile_hash text not null check(profile_hash~'^[a-f0-9]{64}$'),
  provider text not null check(provider in ('openai','claude','gemini')),
  model text not null,
  manifest jsonb not null check(jsonb_typeof(manifest)='object'),
  asset_ids uuid[] not null,
  status text not null default 'queued' check(status in ('queued','processing','needs_review','blocked','cancelled')),
  progress jsonb not null default '{}'::jsonb check(jsonb_typeof(progress)='object'),
  result jsonb,
  review_revision integer not null default 0 check(review_revision>=0),
  error_code text,
  worker_id text,
  lease_id uuid,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  cancel_requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(project_id,workspace_id) references public.projects(id,workspace_id) on delete cascade,
  unique(workspace_id,project_id,request_key), unique(id,workspace_id), unique(id,workspace_id,project_id)
);
create index photo_takeoff_runs_project_idx on public.photo_takeoff_runs(workspace_id,project_id,created_at);
-- Each acknowledged human review is immutable. Retrying a request after an
-- unknown HTTP outcome returns this exact receipt, rather than writing again.
create table public.photo_takeoff_reviews (
  run_id uuid not null,
  workspace_id uuid not null,
  project_id uuid not null,
  request_key uuid not null,
  request_sha256 text not null check(request_sha256~'^[a-f0-9]{64}$'),
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  expected_revision integer not null check(expected_revision>=0),
  review_revision integer not null check(review_revision>0),
  result jsonb not null check(jsonb_typeof(result)='object' and octet_length(result::text)<=3500000),
  created_at timestamptz not null default now(),
  primary key(run_id,request_key),
  unique(run_id,review_revision),
  foreign key(run_id,workspace_id,project_id) references public.photo_takeoff_runs(id,workspace_id,project_id) on delete restrict
);
create table public.photo_takeoff_steps (
  run_id uuid not null,
  workspace_id uuid not null,
  project_id uuid not null,
  photo_asset_id uuid not null,
  status text not null default 'pending' check(status in ('pending','processing','completed')),
  result jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(run_id,photo_asset_id),
  foreign key(run_id,workspace_id,project_id) references public.photo_takeoff_runs(id,workspace_id,project_id) on delete cascade,
  foreign key(photo_asset_id,workspace_id,project_id) references public.photo_assets(id,workspace_id,project_id) on delete restrict
);
create index photo_takeoff_steps_asset_idx on public.photo_takeoff_steps(photo_asset_id,workspace_id,project_id);
create table public.photo_provider_run_budgets (
  run_id uuid primary key,
  workspace_id uuid not null,
  provider text not null,
  model text not null,
  approved_usd numeric(12,6) not null check(approved_usd>0),
  approval_ref text not null check(approval_ref~'^[A-Za-z0-9][A-Za-z0-9_.:/-]{1,119}$'),
  created_at timestamptz not null default now(),
  foreign key(run_id,workspace_id) references public.photo_takeoff_runs(id,workspace_id) on delete restrict
);
create table public.photo_takeoff_workers (
  worker_id text primary key check(length(worker_id) between 1 and 160),
  profile_hash text not null check(profile_hash~'^[a-f0-9]{64}$'),
  version text not null check(version='photo-takeoff-v1'),
  heartbeat_at timestamptz not null default now()
);

alter table public.photo_assets enable row level security;
alter table public.photo_takeoff_runs enable row level security;
alter table public.photo_takeoff_steps enable row level security;
alter table public.photo_takeoff_workers enable row level security;
alter table public.photo_provider_run_budgets enable row level security;
alter table public.photo_takeoff_reviews enable row level security;
create policy photo_assets_read on public.photo_assets for select to authenticated using (
  private.has_workspace_role(workspace_id,array['admin','estimator','viewer']) and exists(select 1 from public.profiles where id=auth.uid() and is_platform_admin=true));
create policy photo_runs_read on public.photo_takeoff_runs for select to authenticated using (
  private.has_workspace_role(workspace_id,array['admin','estimator','viewer']) and exists(select 1 from public.profiles where id=auth.uid() and is_platform_admin=true));
create policy photo_steps_read on public.photo_takeoff_steps for select to authenticated using (
  private.has_workspace_role(workspace_id,array['admin','estimator','viewer']) and exists(select 1 from public.profiles where id=auth.uid() and is_platform_admin=true));
revoke all on public.photo_assets,public.photo_takeoff_runs,public.photo_takeoff_steps,public.photo_takeoff_workers,public.photo_provider_run_budgets,public.photo_takeoff_reviews from public,anon,authenticated;
grant select on public.photo_assets,public.photo_takeoff_steps to authenticated;
-- Browser clients can read safe lifecycle data; a service lease is never exposed.
grant select(id,workspace_id,project_id,requested_by,request_key,version,profile_hash,provider,model,manifest,asset_ids,status,progress,result,review_revision,error_code,cancel_requested_at,started_at,completed_at,created_at,updated_at) on public.photo_takeoff_runs to authenticated;
grant select,insert,update,delete on public.photo_assets,public.photo_takeoff_runs,public.photo_takeoff_steps,public.photo_takeoff_workers to service_role;
grant select,insert on public.photo_provider_run_budgets to service_role;
grant select on public.photo_takeoff_reviews to service_role;

create function public.photo_takeoff_authorized(p_user_id uuid,p_workspace_id uuid,p_project_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.profiles where id=p_user_id and is_platform_admin=true)
    and exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator'))
    and exists(select 1 from public.workspaces where id=p_workspace_id and ai_processing_consented_at is not null)
    and exists(select 1 from public.projects where id=p_project_id and workspace_id=p_workspace_id)
$$;
create function public.guard_photo_asset_intake() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.status<>'uploading' or not public.photo_takeoff_authorized(new.uploaded_by,new.workspace_id,new.project_id)
    or new.storage_path<>(new.workspace_id::text||'/'||new.project_id::text||'/photos/'||new.id::text||'/source.'||
      case new.mime_type when 'image/jpeg' then 'jpg' when 'image/png' then 'png' else 'webp' end) then raise exception 'Photo upload access denied'; end if;
  -- Bounded private storage intake. This technical safeguard creates no product plan.
  perform 1 from public.projects where id=new.project_id and workspace_id=new.workspace_id for update;
  if (select count(*) from public.photo_assets where project_id=new.project_id and workspace_id=new.workspace_id)>=256 then raise exception 'Photo storage intake limit reached'; end if;
  return new;
end $$;
create trigger guard_photo_asset_intake before insert on public.photo_assets for each row execute function public.guard_photo_asset_intake();

create function public.touch_photo_takeoff_worker(p_worker_id text,p_profile_hash text,p_version text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if length(coalesce(p_worker_id,'')) not between 1 and 160 or coalesce(p_profile_hash,'')!~'^[a-f0-9]{64}$' or p_version is distinct from 'photo-takeoff-v1' then raise exception 'Photo worker identity invalid'; end if;
  insert into public.photo_takeoff_workers(worker_id,profile_hash,version) values(p_worker_id,p_profile_hash,p_version)
    on conflict(worker_id) do update set profile_hash=excluded.profile_hash,version=excluded.version,heartbeat_at=now();
  return true;
end $$;
create function public.photo_takeoff_worker_available(p_profile_hash text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.photo_takeoff_workers where profile_hash=p_profile_hash and version='photo-takeoff-v1' and heartbeat_at>now()-interval '90 seconds')
$$;
create function public.reserve_photo_takeoff(p_workspace_id uuid,p_project_id uuid,p_user_id uuid,p_request_key uuid,
  p_assets jsonb,p_references jsonb,p_profile_hash text,p_provider text,p_model text,p_approved_budget_usd numeric,p_budget_approval_ref text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs; a jsonb; total_bytes bigint:=0; reused boolean:=false;
begin
  if not public.photo_takeoff_authorized(p_user_id,p_workspace_id,p_project_id) then raise exception 'Photo takeoff access denied'; end if;
  if p_request_key is null or coalesce(p_profile_hash,'')!~'^[a-f0-9]{64}$'
    or not ((p_provider='openai' and p_model='gpt-6-astra') or (p_provider='claude' and p_model='claude-opus-5-5') or (p_provider='gemini' and p_model='gemini-3.1-pro-preview'))
    or jsonb_typeof(p_assets) is distinct from 'array' or jsonb_array_length(p_assets) not between 1 and 8
    or jsonb_typeof(p_references) is distinct from 'array' or jsonb_array_length(p_references)>100
    or octet_length(p_references::text)>200000 or p_approved_budget_usd is null or p_approved_budget_usd<=0 or p_approved_budget_usd>100000
    or coalesce(p_budget_approval_ref,'')!~'^[A-Za-z0-9][A-Za-z0-9_.:/-]{1,119}$' then raise exception 'Photo run input invalid'; end if;
  if (select count(distinct value->>'id') from jsonb_array_elements(p_assets))<>jsonb_array_length(p_assets)
    or (select count(distinct value->>'sha256') from jsonb_array_elements(p_assets))<>jsonb_array_length(p_assets) then raise exception 'Duplicate photo source'; end if;
  for a in select value from jsonb_array_elements(p_assets) loop
    if not exists(select 1 from public.photo_assets where id=(a->>'id')::uuid and workspace_id=p_workspace_id and project_id=p_project_id and status='ready'
      and sha256=a->>'sha256' and sha256=a->>'revision' and mime_type=a->>'mimeType' and byte_size=(a->>'byteSize')::bigint
      and width_pixels=(a->>'widthPixels')::integer and height_pixels=(a->>'heightPixels')::integer
      and a->>'workspaceId'=p_workspace_id::text and a->>'projectId'=p_project_id::text and a->'storageVerified'='true'::jsonb) then raise exception 'Photo source not verified'; end if;
    total_bytes:=total_bytes+(a->>'byteSize')::bigint;
  end loop;
  if total_bytes>41943040 then raise exception 'Photo batch exceeds size bound'; end if;
  perform 1 from public.profiles where id=p_user_id and is_platform_admin=true for update;
  select * into r from public.photo_takeoff_runs where workspace_id=p_workspace_id and project_id=p_project_id and request_key=p_request_key for update;
  if found then
    if r.requested_by<>p_user_id or r.profile_hash<>p_profile_hash or r.provider<>p_provider or r.model<>p_model
      or r.manifest<>jsonb_build_object('assets',p_assets,'references',p_references)
      or not exists(select 1 from public.photo_provider_run_budgets where run_id=r.id and approved_usd=p_approved_budget_usd and approval_ref=p_budget_approval_ref) then raise exception 'Photo request identity mismatch'; end if;
    reused:=true;
  else
    if not public.photo_takeoff_worker_available(p_profile_hash) then raise exception 'Photo worker unavailable'; end if;
    -- Keep the existing founder daily allowance across photo and plan readings.
    if (select count(*) from public.photo_takeoff_runs where requested_by=p_user_id and created_at>now()-interval '24 hours')
      +(select count(*) from public.takeoff_runs where requested_by=p_user_id and created_at>now()-interval '24 hours')
      +(select count(*) from public.plan_reading_jobs where requested_by=p_user_id and created_at>now()-interval '24 hours')>=25 then raise exception 'Daily AI reading limit reached'; end if;
    insert into public.photo_takeoff_runs(workspace_id,project_id,requested_by,request_key,profile_hash,provider,model,manifest,asset_ids,progress)
      values(p_workspace_id,p_project_id,p_user_id,p_request_key,p_profile_hash,p_provider,p_model,
        jsonb_build_object('assets',p_assets,'references',p_references),(select array_agg((value->>'id')::uuid) from jsonb_array_elements(p_assets)),
        jsonb_build_object('completed',0,'total',jsonb_array_length(p_assets))) returning * into r;
    insert into public.photo_provider_run_budgets(run_id,workspace_id,provider,model,approved_usd,approval_ref)
      values(r.id,r.workspace_id,r.provider,r.model,p_approved_budget_usd,p_budget_approval_ref);
    for a in select value from jsonb_array_elements(p_assets) loop
      insert into public.photo_takeoff_steps(run_id,workspace_id,project_id,photo_asset_id) values(r.id,r.workspace_id,r.project_id,(a->>'id')::uuid);
    end loop;
  end if;
  return jsonb_build_object('reused',reused,'run',jsonb_build_object('id',r.id,'status',r.status,'request_key',r.request_key,'progress',r.progress,'error_code',r.error_code));
end $$;

create function public.claim_photo_takeoff(p_run_id uuid,p_worker_id text,p_profile_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs; lease uuid;
begin
  select * into r from public.photo_takeoff_runs where id=p_run_id and profile_hash=p_profile_hash for update;
  if not found or length(coalesce(p_worker_id,'')) not between 1 and 160 then raise exception 'Photo run unavailable'; end if;
  if r.status in ('needs_review','blocked','cancelled') then return jsonb_build_object('skip',true,'status',r.status); end if;
  if not public.photo_takeoff_authorized(r.requested_by,r.workspace_id,r.project_id) then raise exception 'Photo authorization revoked'; end if;
  if r.cancel_requested_at is not null then
    update public.photo_takeoff_runs set status='cancelled',updated_at=now() where id=r.id;
    return jsonb_build_object('skip',true,'status','cancelled');
  end if;
  if r.status='processing' and r.lease_expires_at>now() then raise exception 'Photo run already leased'; end if;
  if exists(select 1 from public.photo_takeoff_steps where run_id=r.id and status='processing') then
    update public.photo_takeoff_runs set status='blocked',error_code='unknown_provider_outcome',lease_id=null,lease_expires_at=null,updated_at=now() where id=r.id;
    return jsonb_build_object('skip',true,'status','blocked','reconciliation_required',true);
  end if;
  lease:=gen_random_uuid();
  update public.photo_takeoff_runs set status='processing',started_at=coalesce(started_at,now()),worker_id=p_worker_id,
    lease_id=lease,lease_expires_at=now()+interval '90 seconds',heartbeat_at=now(),error_code=null,updated_at=now() where id=r.id;
  return jsonb_build_object('skip',false,'lease_id',lease,'workspace_id',r.workspace_id,'project_id',r.project_id,'requested_by',r.requested_by,'manifest',r.manifest);
end $$;
create function public.heartbeat_photo_takeoff(p_run_id uuid,p_lease_id uuid,p_worker_id text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.photo_takeoff_runs set lease_expires_at=now()+interval '90 seconds',heartbeat_at=now()
    where id=p_run_id and lease_id=p_lease_id and worker_id=p_worker_id and status='processing' and lease_expires_at>now()
      and cancel_requested_at is null and public.photo_takeoff_authorized(requested_by,workspace_id,project_id);
  return found;
end $$;
create function public.begin_photo_takeoff_step(p_run_id uuid,p_lease_id uuid,p_asset_id uuid)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs; s public.photo_takeoff_steps;
begin
  select * into r from public.photo_takeoff_runs where id=p_run_id and lease_id=p_lease_id and status='processing' and lease_expires_at>now()
    and cancel_requested_at is null and public.photo_takeoff_authorized(requested_by,workspace_id,project_id) for update;
  if not found then raise exception 'Photo lease invalid'; end if;
  select * into s from public.photo_takeoff_steps where run_id=r.id and photo_asset_id=p_asset_id and workspace_id=r.workspace_id and project_id=r.project_id for update;
  if not found then raise exception 'Photo step unavailable'; end if;
  if s.status='completed' then return 'completed'; elsif s.status<>'pending' then raise exception 'Photo step reconciliation required'; end if;
  if exists(select 1 from public.photo_takeoff_steps where run_id=r.id and status='processing') then raise exception 'Another photo step is processing'; end if;
  update public.photo_takeoff_steps set status='processing',started_at=now() where run_id=r.id and photo_asset_id=p_asset_id;
  update public.photo_takeoff_runs set progress=progress||jsonb_build_object('currentAssetId',p_asset_id),updated_at=now() where id=r.id;
  return 'run';
end $$;
create function public.checkpoint_photo_takeoff_step(p_run_id uuid,p_lease_id uuid,p_asset_id uuid,p_result jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs; completed integer;
begin
  select * into r from public.photo_takeoff_runs where id=p_run_id and lease_id=p_lease_id and status='processing' and lease_expires_at>now()
    and cancel_requested_at is null and public.photo_takeoff_authorized(requested_by,workspace_id,project_id) for update;
  if not found then raise exception 'Photo lease invalid'; end if;
  if jsonb_typeof(p_result) is distinct from 'object' or jsonb_typeof(p_result->'observations') is distinct from 'array'
    or jsonb_array_length(p_result->'observations')>100 or p_result->>'independentReview' is distinct from 'pending'
    or octet_length(p_result::text)>500000 then raise exception 'Photo checkpoint invalid'; end if;
  update public.photo_takeoff_steps set status='completed',result=p_result,completed_at=now()
    where run_id=r.id and photo_asset_id=p_asset_id and workspace_id=r.workspace_id and project_id=r.project_id and status='processing';
  if not found then raise exception 'Photo step is not processing'; end if;
  select count(*) into completed from public.photo_takeoff_steps where run_id=r.id and status='completed';
  update public.photo_takeoff_runs set progress=progress||jsonb_build_object('completed',completed),updated_at=now() where id=r.id;
  return true;
end $$;
create function public.finish_photo_takeoff(p_run_id uuid,p_lease_id uuid,p_result jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;
begin
  select * into r from public.photo_takeoff_runs where id=p_run_id and lease_id=p_lease_id and status='processing' and lease_expires_at>now()
    and cancel_requested_at is null and public.photo_takeoff_authorized(requested_by,workspace_id,project_id) for update;
  if not found then raise exception 'Photo lease invalid'; end if;
  if exists(select 1 from public.photo_takeoff_steps where run_id=r.id and status<>'completed')
    or (select count(*) from public.photo_takeoff_steps where run_id=r.id)<>jsonb_array_length(r.manifest->'assets') then raise exception 'Photo coverage incomplete'; end if;
  if jsonb_typeof(p_result) is distinct from 'object' or p_result->>'pricingStatus' is distinct from 'missing_price'
    or p_result->'estimate' is distinct from 'null'::jsonb or p_result->'humanReviewRequired' is distinct from 'true'::jsonb
    or p_result->>'independentReview' is distinct from 'pending' or octet_length(p_result::text)>3500000 then raise exception 'Photo review state invalid'; end if;
  update public.photo_takeoff_runs set status='needs_review',result=p_result,completed_at=now(),lease_id=null,lease_expires_at=null,updated_at=now() where id=r.id;
  return jsonb_build_object('id',r.id,'status','needs_review','progress',r.progress,'result',p_result);
end $$;
create function public.block_photo_takeoff(p_run_id uuid,p_lease_id uuid,p_code text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;
begin
  if p_code not in ('unknown_provider_outcome','photo_source_or_persistence_blocked','company_spend_limit','run_provider_spend_limit') then raise exception 'Photo block classification invalid'; end if;
  select * into r from public.photo_takeoff_runs where id=p_run_id and lease_id=p_lease_id and status='processing' for update;
  if not found then return false; end if;
  if p_code in ('company_spend_limit','run_provider_spend_limit') then
    -- The meter settles a denied reservation before this transition. No vendor
    -- dispatch occurred, so the current checkpoint can safely remain pending.
    if not exists(select 1 from public.api_usage_events where workspace_id=r.workspace_id and project_id=r.project_id and user_id=r.requested_by
      and provider=r.provider and model=r.model and operation='rb1:'||r.id::text||':generate:blocked_spend_limit') then raise exception 'Photo spend pause evidence unavailable'; end if;
    update public.photo_takeoff_steps set status='pending',started_at=null where run_id=r.id and status='processing';
  end if;
  update public.photo_takeoff_runs set status=case when cancel_requested_at is null then 'blocked' else 'cancelled' end,
    error_code=p_code,lease_id=null,lease_expires_at=null,updated_at=now() where id=p_run_id and lease_id=p_lease_id and status='processing';
  return found;
end $$;
create function public.save_photo_takeoff_review(p_run_id uuid,p_workspace_id uuid,p_project_id uuid,p_user_id uuid,
  p_request_key uuid,p_request_sha256 text,p_expected_revision integer,p_result jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs; receipt public.photo_takeoff_reviews; next_revision integer;
begin
  -- Reading/reviewing saved evidence remains possible with provider flags off.
  -- A verified owner identity, writable role and exact tenant/project remain required.
  if not exists(select 1 from public.profiles where id=p_user_id and is_platform_admin=true)
    or not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator'))
    or not exists(select 1 from public.projects where id=p_project_id and workspace_id=p_workspace_id) then raise exception 'Photo review access denied'; end if;
  if p_request_key is null or coalesce(p_request_sha256,'')!~'^[a-f0-9]{64}$' or p_expected_revision is null or p_expected_revision<0 then raise exception 'Photo review identity invalid'; end if;
  select * into r from public.photo_takeoff_runs where id=p_run_id and workspace_id=p_workspace_id and project_id=p_project_id for update;
  if not found or r.status<>'needs_review' then raise exception 'Photo review state unavailable'; end if;
  select * into receipt from public.photo_takeoff_reviews where run_id=r.id and request_key=p_request_key;
  if found then
    if receipt.request_sha256<>p_request_sha256 or receipt.reviewer_id<>p_user_id then raise exception 'Photo review request identity mismatch'; end if;
    return jsonb_build_object('review',receipt.result,'reviewRevision',receipt.review_revision,'reused',true);
  end if;
  if r.review_revision<>p_expected_revision then raise exception 'Photo review revision conflicted'; end if;
  if jsonb_typeof(p_result) is distinct from 'object' or jsonb_typeof(p_result->'observations') is distinct from 'array'
    or jsonb_typeof(p_result->'approvedMeasurements') is distinct from 'array' or jsonb_typeof(p_result->'references') is distinct from 'array'
    or jsonb_typeof(p_result->'decisions') is distinct from 'array' or p_result->>'reviewed_by' is distinct from p_user_id::text
    or p_result->>'releaseStatus' is distinct from 'blocked' or p_result->>'pricingStatus' is distinct from 'missing_price'
    or p_result->'estimate' is distinct from 'null'::jsonb or p_result->'humanReviewRequired' is distinct from 'true'::jsonb
    or p_result->>'independentReview' is distinct from 'pending' or octet_length(p_result::text)>3500000 then raise exception 'Photo human review invalid'; end if;
  next_revision:=r.review_revision+1;
  insert into public.photo_takeoff_reviews(run_id,workspace_id,project_id,request_key,request_sha256,reviewer_id,expected_revision,review_revision,result)
    values(r.id,r.workspace_id,r.project_id,p_request_key,p_request_sha256,p_user_id,p_expected_revision,next_revision,p_result);
  update public.photo_takeoff_runs set result=p_result,review_revision=next_revision,updated_at=now() where id=r.id;
  return jsonb_build_object('review',p_result,'reviewRevision',next_revision,'reused',false);
end $$;
create function public.cancel_photo_takeoff(p_run_id uuid,p_workspace_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;
begin
  select * into r from public.photo_takeoff_runs where id=p_run_id and workspace_id=p_workspace_id for update;
  if not found or r.requested_by<>p_user_id or not exists(select 1 from public.profiles where id=p_user_id and is_platform_admin=true)
    or not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator')) then raise exception 'Photo cancellation access denied'; end if;
  if r.status not in ('needs_review','cancelled') then
    update public.photo_takeoff_runs set cancel_requested_at=now(),status=case when status='processing' then status else 'cancelled' end,updated_at=now() where id=r.id;
  end if;
  return jsonb_build_object('id',r.id,'cancel_requested',true);
end $$;
create function public.resume_photo_takeoff(p_run_id uuid,p_workspace_id uuid,p_user_id uuid,p_profile_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_takeoff_runs;
begin
  select * into r from public.photo_takeoff_runs where id=p_run_id and workspace_id=p_workspace_id for update;
  if not found or r.requested_by<>p_user_id or r.profile_hash<>p_profile_hash or not public.photo_takeoff_authorized(p_user_id,p_workspace_id,r.project_id)
    or not public.photo_takeoff_worker_available(p_profile_hash) then raise exception 'Photo resume access denied'; end if;
  if r.status='needs_review' then return jsonb_build_object('id',r.id,'status',r.status); end if;
  if r.status='processing' and r.lease_expires_at>now() then raise exception 'Photo worker is still active'; end if;
  if exists(select 1 from public.photo_takeoff_steps where run_id=r.id and status='processing') then raise exception 'Photo provider reconciliation required'; end if;
  update public.photo_takeoff_runs set status='queued',cancel_requested_at=null,error_code=null,lease_id=null,lease_expires_at=null,updated_at=now() where id=r.id;
  return jsonb_build_object('id',r.id,'status','queued','completed_checkpoints_preserved',true);
end $$;

alter table public.provider_spend_reservations add column photo_run_id uuid,add column photo_asset_id uuid;
alter table public.provider_spend_reservations drop constraint provider_spend_one_run_check;
alter table public.provider_spend_reservations add constraint provider_spend_one_run_check check(num_nonnulls(job_id,takeoff_run_id,photo_run_id)=1);
alter table public.provider_spend_reservations add constraint provider_spend_photo_identity_check check((photo_run_id is null)=(photo_asset_id is null));
alter table public.provider_spend_reservations add constraint provider_spend_photo_run_fkey foreign key(photo_run_id,workspace_id) references public.photo_takeoff_runs(id,workspace_id) on delete restrict;
alter table public.provider_spend_reservations add constraint provider_spend_photo_asset_fkey foreign key(photo_asset_id,workspace_id) references public.photo_assets(id,workspace_id) on delete restrict;
create index provider_spend_photo_run_idx on public.provider_spend_reservations(photo_run_id,workspace_id) where photo_run_id is not null;
create index provider_spend_photo_asset_idx on public.provider_spend_reservations(photo_asset_id,workspace_id) where photo_asset_id is not null;

create function public.reserve_photo_provider_spend(p_event_id uuid,p_run_id uuid,p_lease_id uuid,p_asset_id uuid,
  p_workspace_id uuid,p_user_id uuid,p_provider text,p_model text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare policy public.provider_spend_policy; used numeric(12,6); run_used numeric(12,6); budget public.photo_provider_run_budgets;
  reservation public.provider_spend_reservations; r public.photo_takeoff_runs;
begin
  select * into policy from public.provider_spend_policy where singleton for update;
  if not found or not policy.enabled then raise exception 'Company AI spend is disabled'; end if;
  select * into r from public.photo_takeoff_runs where id=p_run_id and workspace_id=p_workspace_id and requested_by=p_user_id
    and provider=p_provider and model=p_model and lease_id=p_lease_id and status='processing' and lease_expires_at>now() and cancel_requested_at is null for share;
  if not found or not public.photo_takeoff_authorized(p_user_id,p_workspace_id,r.project_id)
    or not exists(select 1 from public.photo_takeoff_steps where run_id=r.id and photo_asset_id=p_asset_id and workspace_id=p_workspace_id and status='processing') then raise exception 'Photo provider spend access denied'; end if;
  perform 1 from public.api_usage_events where id=p_event_id and workspace_id=p_workspace_id and project_id=r.project_id and user_id=p_user_id
    and provider=p_provider and model=p_model and operation='rb1:'||r.id::text||':generate:pending' for share;
  if not found then raise exception 'Photo provider spend event not authorized'; end if;
  select * into reservation from public.provider_spend_reservations where event_id=p_event_id;
  if found then
    if reservation.photo_run_id is distinct from p_run_id or reservation.photo_asset_id is distinct from p_asset_id
      or reservation.workspace_id is distinct from p_workspace_id or reservation.user_id is distinct from p_user_id
      or reservation.provider is distinct from p_provider or reservation.model is distinct from p_model then raise exception 'Photo spend identity mismatch'; end if;
    return to_jsonb(reservation);
  end if;
  -- The same global rolling breaker counts legacy, Full V2 and photo exposure.
  -- Unknown tariff/telemetry conservatively retains the existing reservation.
  select coalesce(sum(case when status='captured' and telemetry_known then estimated_cost_usd else reserved_usd end),0) into used
    from public.provider_spend_reservations where created_at>now()-policy.rolling_window;
  if used+policy.call_reservation_usd>policy.spend_cap_usd then raise exception 'Company AI spend limit reached'; end if;
  select * into budget from public.photo_provider_run_budgets where run_id=r.id and workspace_id=p_workspace_id and provider=p_provider and model=p_model for update;
  if not found then raise exception 'Photo run/provider approved budget is unavailable'; end if;
  select coalesce(sum(case when status='captured' and telemetry_known then estimated_cost_usd else reserved_usd end),0) into run_used
    from public.provider_spend_reservations where photo_run_id=r.id and provider=p_provider;
  if run_used+policy.call_reservation_usd>budget.approved_usd then raise exception 'Photo run/provider approved spend limit reached'; end if;
  insert into public.provider_spend_reservations(event_id,photo_run_id,photo_asset_id,workspace_id,user_id,provider,model,reserved_usd)
    values(p_event_id,p_run_id,p_asset_id,p_workspace_id,p_user_id,p_provider,p_model,policy.call_reservation_usd) returning * into reservation;
  return to_jsonb(reservation);
end $$;

revoke all on function public.photo_takeoff_authorized(uuid,uuid,uuid),public.guard_photo_asset_intake(),
  public.touch_photo_takeoff_worker(text,text,text),public.photo_takeoff_worker_available(text),
  public.reserve_photo_takeoff(uuid,uuid,uuid,uuid,jsonb,jsonb,text,text,text,numeric,text),public.claim_photo_takeoff(uuid,text,text),
  public.heartbeat_photo_takeoff(uuid,uuid,text),public.begin_photo_takeoff_step(uuid,uuid,uuid),
  public.checkpoint_photo_takeoff_step(uuid,uuid,uuid,jsonb),public.finish_photo_takeoff(uuid,uuid,jsonb),public.block_photo_takeoff(uuid,uuid,text),
  public.cancel_photo_takeoff(uuid,uuid,uuid),public.resume_photo_takeoff(uuid,uuid,uuid,text),
  public.save_photo_takeoff_review(uuid,uuid,uuid,uuid,uuid,text,integer,jsonb),
  public.reserve_photo_provider_spend(uuid,uuid,uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.photo_takeoff_authorized(uuid,uuid,uuid),public.guard_photo_asset_intake(),
  public.touch_photo_takeoff_worker(text,text,text),public.photo_takeoff_worker_available(text),
  public.reserve_photo_takeoff(uuid,uuid,uuid,uuid,jsonb,jsonb,text,text,text,numeric,text),public.claim_photo_takeoff(uuid,text,text),
  public.heartbeat_photo_takeoff(uuid,uuid,text),public.begin_photo_takeoff_step(uuid,uuid,uuid),
  public.checkpoint_photo_takeoff_step(uuid,uuid,uuid,jsonb),public.finish_photo_takeoff(uuid,uuid,jsonb),public.block_photo_takeoff(uuid,uuid,text),
  public.cancel_photo_takeoff(uuid,uuid,uuid),public.resume_photo_takeoff(uuid,uuid,uuid,text),
  public.save_photo_takeoff_review(uuid,uuid,uuid,uuid,uuid,text,integer,jsonb),
  public.reserve_photo_provider_spend(uuid,uuid,uuid,uuid,uuid,uuid,text,text) to service_role;
