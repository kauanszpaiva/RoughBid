-- REVIEW ONLY. Geometry/OEM authorization and budgets are never seeded here.
create table public.geometry_provider_jobs (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),project_id uuid not null,
  file_id uuid,parent_takeoff_run_id uuid,provider text not null check(provider in ('kamai','aps')),file_sha256 text not null check(file_sha256~'^[a-f0-9]{64}$'),
  physical_page_number integer,expected_pages integer not null check(expected_pages>0),source_format text,source_object_id text,source_version text,source_binding_proof_ref text,
  requested_by uuid not null references auth.users(id),request_key uuid not null,profile_hash text not null check(profile_hash~'^[a-f0-9]{64}$'),
  status text not null default 'queued' check(status in ('queued','processing','waiting','needs_review','blocked','cancelled')),
  checkpoint jsonb,artifact jsonb,error_code text,worker_id text,lease_id uuid,lease_expires_at timestamptz,cancel_requested_at timestamptz,
  approved_budget_usd numeric not null check(approved_budget_usd>0),maximum_call_cost_usd numeric not null check(maximum_call_cost_usd>0),
  maximum_calls integer not null check(maximum_calls between 1 and 100000),approval_ref text not null check(length(approval_ref) between 3 and 200),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  foreign key(project_id,workspace_id) references public.projects(id,workspace_id),
  foreign key(file_id,workspace_id,project_id) references public.project_files(id,workspace_id,project_id),
  foreign key(parent_takeoff_run_id,workspace_id,project_id) references public.takeoff_runs(id,workspace_id,project_id),
  check((provider='kamai' and file_id is not null and physical_page_number between 1 and expected_pages) or
    (provider='aps' and file_id is null and physical_page_number is null and source_format is not null and source_object_id is not null and source_version is not null and length(source_binding_proof_ref)>=3)),
  check(checkpoint is null or octet_length(checkpoint::text)<=5000000),check(artifact is null or octet_length(artifact::text)<=5000000),
  unique(id,workspace_id,project_id),unique(workspace_id,project_id,request_key)
);
create unique index geometry_provider_page_identity on public.geometry_provider_jobs(workspace_id,project_id,file_id,file_sha256,physical_page_number,provider,profile_hash,
  coalesce(parent_takeoff_run_id,'00000000-0000-0000-0000-000000000000'::uuid)) where file_id is not null;
create table public.geometry_provider_candidates (
  id text not null check(id~'^[a-f0-9]{64}$'),run_id uuid not null,workspace_id uuid not null,project_id uuid not null,candidate jsonb not null,
  status text not null check(status in ('candidate','blocked','accepted','rejected')),review_revision integer not null default 0,
  reviewed_by uuid references auth.users(id),reviewed_at timestamptz,
  primary key(run_id,id),foreign key(run_id,workspace_id,project_id) references public.geometry_provider_jobs(id,workspace_id,project_id),
  check(jsonb_typeof(candidate)='object' and octet_length(candidate::text)<=100000)
);
create table public.geometry_provider_review_receipts (
  run_id uuid not null,candidate_id text not null,request_key uuid not null,request jsonb not null,result jsonb not null,reviewer_id uuid not null references auth.users(id),
  primary key(run_id,candidate_id,request_key),foreign key(run_id,candidate_id) references public.geometry_provider_candidates(run_id,id)
);
create table public.geometry_provider_spend_reservations (
  id uuid primary key default gen_random_uuid(),run_id uuid not null references public.geometry_provider_jobs(id),provider text not null check(provider in ('kamai','aps')),
  operation text not null,reserved_usd numeric not null check(reserved_usd>0),telemetry_known boolean not null default false,estimated_cost_usd numeric,
  created_at timestamptz not null default now()
);
create table public.geometry_provider_workers(worker_id text primary key,profile_hash text not null,last_seen_at timestamptz not null default now());
alter table public.geometry_provider_jobs enable row level security;
alter table public.geometry_provider_candidates enable row level security;
alter table public.geometry_provider_review_receipts enable row level security;
alter table public.geometry_provider_spend_reservations enable row level security;
alter table public.geometry_provider_workers enable row level security;
create policy geometry_jobs_read on public.geometry_provider_jobs for select to authenticated using(private.has_product_access() and private.has_workspace_role(workspace_id,array['admin','estimator','viewer']));
create policy geometry_candidates_read on public.geometry_provider_candidates for select to authenticated using(private.has_product_access() and private.has_workspace_role(workspace_id,array['admin','estimator','viewer']));
revoke all on public.geometry_provider_jobs,public.geometry_provider_candidates,public.geometry_provider_review_receipts,public.geometry_provider_spend_reservations,public.geometry_provider_workers from public,anon,authenticated,service_role;
grant select on public.geometry_provider_jobs,public.geometry_provider_candidates to authenticated;
grant select on public.geometry_provider_jobs,public.geometry_provider_candidates,public.geometry_provider_review_receipts,public.geometry_provider_spend_reservations,public.geometry_provider_workers to service_role;

create function private.geometry_role_actor(p_user uuid,p_workspace uuid,p_project uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from profiles where id=p_user and is_platform_admin=true)
    and exists(select 1 from workspace_members where workspace_id=p_workspace and user_id=p_user and role in ('admin','estimator'))
    and exists(select 1 from projects where id=p_project and workspace_id=p_workspace);
$$;
create function private.geometry_actor(p_user uuid,p_workspace uuid,p_project uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select private.geometry_role_actor(p_user,p_workspace,p_project)
    and exists(select 1 from workspaces where id=p_workspace and ai_processing_consented_at is not null);
$$;
create function public.touch_geometry_provider_worker(p_worker_id text,p_profile_hash text) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if length(p_worker_id) not between 3 and 200 or p_profile_hash!~'^[a-f0-9]{64}$' then raise exception 'Invalid geometry worker';end if;
  insert into geometry_provider_workers values(p_worker_id,p_profile_hash,now()) on conflict(worker_id) do update set profile_hash=excluded.profile_hash,last_seen_at=now();return true;
end $$;
create function public.geometry_provider_worker_available(p_profile_hash text) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
select exists(select 1 from geometry_provider_workers where profile_hash=p_profile_hash and last_seen_at>now()-interval '60 seconds');$$;
create function public.recoverable_geometry_provider_jobs(p_profile_hash text) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',j.id,'updated_at',j.updated_at)),'[]'::jsonb) from (
    select r.id,r.updated_at from geometry_provider_jobs r where r.profile_hash=p_profile_hash and r.cancel_requested_at is null
      and private.geometry_actor(r.requested_by,r.workspace_id,r.project_id)
      and (r.parent_takeoff_run_id is null or exists(select 1 from takeoff_runs p where p.id=r.parent_takeoff_run_id and p.cancel_requested_at is null and p.status<>'cancelled'))
      and (r.status='queued' or r.status='waiting' and coalesce((r.checkpoint->>'nextPollAt')::timestamptz,now())<=now()
        or r.status='processing' and r.lease_expires_at<=now()) order by r.updated_at limit 50
  ) j;
$$;
create function public.reserve_geometry_provider_job(p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_request_key uuid,p_profile_hash text,p_input jsonb,p_budget jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r geometry_provider_jobs;f project_files;
begin
  if not private.geometry_actor(p_user_id,p_workspace_id,p_project_id) then raise exception 'Geometry access denied';end if;
  if p_profile_hash!~'^[a-f0-9]{64}$' or not geometry_provider_worker_available(p_profile_hash) then raise exception 'Geometry worker unavailable';end if;
  if p_input->>'provider'='kamai' then
    select * into f from project_files where id=(p_input->>'fileId')::uuid and workspace_id=p_workspace_id and project_id=p_project_id for share;
    if not found or f.processing_status not in ('ready','completed','processed') or f.page_count is null or (p_input->>'physicalPageNumber')::integer not between 1 and f.page_count then raise exception 'Geometry PDF source unavailable';end if;
    if p_input->>'parentRunId' is not null and not exists(select 1 from takeoff_runs where id=(p_input->>'parentRunId')::uuid and workspace_id=p_workspace_id
      and project_id=p_project_id and file_id=f.id and file_sha256=p_input->>'fileSha256' and cancel_requested_at is null and status<>'cancelled') then raise exception 'Geometry parent analysis unavailable';end if;
  elsif p_input->>'provider'<>'aps' then raise exception 'Geometry provider invalid';end if;
  select * into r from geometry_provider_jobs where workspace_id=p_workspace_id and project_id=p_project_id and request_key=p_request_key;
  if found then
    if r.provider<>p_input->>'provider' or r.file_sha256<>p_input->>'fileSha256' or r.file_id is distinct from (p_input->>'fileId')::uuid
      or r.physical_page_number is distinct from (p_input->>'physicalPageNumber')::integer or r.source_format is distinct from p_input->>'sourceFormat'
      or r.source_version is distinct from p_input->>'sourceVersion' or r.source_object_id is distinct from p_input->>'objectId'
      or r.source_binding_proof_ref is distinct from p_input->>'sourceBindingProofRef' or r.parent_takeoff_run_id is distinct from (p_input->>'parentRunId')::uuid
      or r.profile_hash<>p_profile_hash then raise exception 'Geometry request identity conflict';end if;
    return jsonb_build_object('run',to_jsonb(r),'replayed',true);
  end if;
  if p_input->>'provider'='kamai' then
    select * into r from geometry_provider_jobs where workspace_id=p_workspace_id and project_id=p_project_id and file_id=f.id and file_sha256=p_input->>'fileSha256'
      and physical_page_number=(p_input->>'physicalPageNumber')::integer and provider='kamai' and profile_hash=p_profile_hash
      and parent_takeoff_run_id is not distinct from (p_input->>'parentRunId')::uuid;
    if found then return jsonb_build_object('run',to_jsonb(r),'replayed',true);end if;
    if exists(select 1 from geometry_provider_jobs where workspace_id=p_workspace_id and project_id=p_project_id and file_id=f.id and file_sha256=p_input->>'fileSha256'
      and physical_page_number=(p_input->>'physicalPageNumber')::integer and provider='kamai' and profile_hash=p_profile_hash
      and parent_takeoff_run_id is distinct from (p_input->>'parentRunId')::uuid) then raise exception 'An existing geometry page belongs to another analysis; review its saved result instead of reuploading';end if;
  end if;
  insert into geometry_provider_jobs(workspace_id,project_id,file_id,parent_takeoff_run_id,provider,file_sha256,physical_page_number,expected_pages,source_format,source_object_id,source_version,source_binding_proof_ref,
    requested_by,request_key,profile_hash,approved_budget_usd,maximum_call_cost_usd,maximum_calls,approval_ref)
  values(p_workspace_id,p_project_id,(p_input->>'fileId')::uuid,(p_input->>'parentRunId')::uuid,p_input->>'provider',p_input->>'fileSha256',(p_input->>'physicalPageNumber')::integer,
    coalesce(f.page_count,1),p_input->>'sourceFormat',p_input->>'objectId',p_input->>'sourceVersion',p_input->>'sourceBindingProofRef',p_user_id,p_request_key,p_profile_hash,
    (p_budget->>'approvedRunBudgetUsd')::numeric,(p_budget->>'maximumCallCostUsd')::numeric,(p_budget->>'maximumCalls')::integer,p_budget->>'approvalRef') returning * into r;
  -- A newly pinned revision invalidates prior approvals; immutable saved budgets remain historical.
  update geometry_provider_candidates c set status='blocked',review_revision=review_revision+1,
    candidate=candidate||jsonb_build_object('status','blocked','reviewRevision',review_revision+1,'reviewReasons',jsonb_build_array('source_revision_superseded'))
    from geometry_provider_jobs previous where c.run_id=previous.id and previous.workspace_id=r.workspace_id and previous.project_id=r.project_id and previous.provider=r.provider
      and previous.id<>r.id and (r.file_id is not null and previous.file_id=r.file_id and previous.physical_page_number=r.physical_page_number and previous.file_sha256<>r.file_sha256
        or r.file_id is null and previous.source_object_id=r.source_object_id and (previous.source_version<>r.source_version or previous.file_sha256<>r.file_sha256));
  return jsonb_build_object('run',to_jsonb(r),'replayed',false);
end $$;
create function public.claim_geometry_provider_job(p_run_id uuid,p_worker_id text,p_profile_hash text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r geometry_provider_jobs;l uuid:=gen_random_uuid();begin
  select * into r from geometry_provider_jobs where id=p_run_id for update;
  if not found or r.profile_hash<>p_profile_hash or r.cancel_requested_at is not null or r.status in ('cancelled','needs_review','blocked') or r.lease_expires_at>now() then return jsonb_build_object('skip',true);end if;
  if r.parent_takeoff_run_id is not null and not exists(select 1 from takeoff_runs where id=r.parent_takeoff_run_id and cancel_requested_at is null and status<>'cancelled') then return jsonb_build_object('skip',true);end if;
  if not private.geometry_actor(r.requested_by,r.workspace_id,r.project_id) then raise exception 'Geometry access revoked';end if;
  update geometry_provider_jobs set status='processing',worker_id=p_worker_id,lease_id=l,lease_expires_at=now()+interval '90 seconds',updated_at=now() where id=r.id returning * into r;
  return jsonb_build_object('skip',false,'run',to_jsonb(r));end $$;
create function public.heartbeat_geometry_provider_job(p_run_id uuid,p_lease_id uuid) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r geometry_provider_jobs;begin
  select * into r from geometry_provider_jobs where id=p_run_id and lease_id=p_lease_id and status='processing' and lease_expires_at>now() and cancel_requested_at is null for update;
  if not found or not private.geometry_actor(r.requested_by,r.workspace_id,r.project_id) then return false;end if;
  if r.parent_takeoff_run_id is not null and not exists(select 1 from takeoff_runs where id=r.parent_takeoff_run_id and cancel_requested_at is null and status<>'cancelled') then return false;end if;
  update geometry_provider_jobs set lease_expires_at=now()+interval '90 seconds',updated_at=now() where id=r.id;return true;end $$;
create function public.save_geometry_provider_checkpoint(p_run_id uuid,p_lease_id uuid,p_checkpoint jsonb,p_initial boolean default false) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r geometry_provider_jobs;begin
  select * into r from geometry_provider_jobs where id=p_run_id and lease_id=p_lease_id and status='processing' and lease_expires_at>now() and cancel_requested_at is null for update;
  if not found then raise exception 'Geometry lease unavailable';end if;
  if p_initial and r.checkpoint is not null then return false;end if;
  if p_checkpoint->>'runId'<>r.id::text then raise exception 'Geometry checkpoint identity conflict';end if;
  update geometry_provider_jobs set checkpoint=p_checkpoint,updated_at=now() where id=r.id;return true;end $$;
create function public.reserve_geometry_provider_spend(p_run_id uuid,p_lease_id uuid,p_operation text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r geometry_provider_jobs;policy provider_spend_policy;used numeric;calls integer;company_used numeric;receipt geometry_provider_spend_reservations;begin
  select * into policy from provider_spend_policy where singleton for update;
  if not found or not policy.enabled then raise exception 'Company AI spend is disabled';end if;
  select * into r from geometry_provider_jobs where id=p_run_id and lease_id=p_lease_id and status='processing' and lease_expires_at>now() and cancel_requested_at is null for update;
  if not found or not private.geometry_actor(r.requested_by,r.workspace_id,r.project_id) then raise exception 'Geometry spend access denied';end if;
  if r.parent_takeoff_run_id is not null and not exists(select 1 from takeoff_runs where id=r.parent_takeoff_run_id and cancel_requested_at is null and status<>'cancelled') then raise exception 'Geometry parent analysis cancelled';end if;
  -- One approved DOCUMENT/provider budget covers all its isolated physical pages.
  select coalesce(sum(s.reserved_usd),0),count(*) into used,calls from geometry_provider_spend_reservations s join geometry_provider_jobs j on j.id=s.run_id
    where j.workspace_id=r.workspace_id and j.project_id=r.project_id and j.provider=r.provider and j.file_sha256=r.file_sha256
      and (r.file_id is not null and j.file_id=r.file_id or r.file_id is null and j.id=r.id);
  if used+r.maximum_call_cost_usd>r.approved_budget_usd or calls>=r.maximum_calls then raise exception 'Geometry run spend limit reached';end if;
  select coalesce(sum(case when status='captured' and telemetry_known then estimated_cost_usd else reserved_usd end),0) into company_used from provider_spend_reservations where created_at>now()-policy.rolling_window;
  select company_used+coalesce(sum(reserved_usd),0) into company_used from geometry_provider_spend_reservations where created_at>now()-policy.rolling_window;
  if company_used+r.maximum_call_cost_usd>policy.spend_cap_usd then raise exception 'Company AI spend limit reached';end if;
  if length(p_operation) not between 3 and 200 then raise exception 'Geometry operation invalid';end if;
  insert into geometry_provider_spend_reservations(run_id,provider,operation,reserved_usd) values(r.id,r.provider,p_operation,r.maximum_call_cost_usd) returning * into receipt;
  return to_jsonb(receipt);end $$;
-- Existing LLM/photo reservations also see geometry exposure under the SAME company lock.
alter function public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text) rename to reserve_provider_spend_before_geometry;
revoke all on function public.reserve_provider_spend_before_geometry(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.reserve_provider_spend(p_event_id uuid,p_job_id uuid,p_workspace_id uuid,p_user_id uuid,p_provider text,p_model text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare policy provider_spend_policy;used numeric;begin
  select * into policy from provider_spend_policy where singleton for update;
  if not found or not policy.enabled then raise exception 'Company AI spend is disabled';end if;
  if not exists(select 1 from provider_spend_reservations where event_id=p_event_id) then
    select coalesce(sum(case when status='captured' and telemetry_known then estimated_cost_usd else reserved_usd end),0) into used from provider_spend_reservations where created_at>now()-policy.rolling_window;
    select used+coalesce(sum(reserved_usd),0) into used from geometry_provider_spend_reservations where created_at>now()-policy.rolling_window;
    if used+policy.call_reservation_usd>policy.spend_cap_usd then raise exception 'Company AI spend limit reached';end if;
  end if;
  return reserve_provider_spend_before_geometry(p_event_id,p_job_id,p_workspace_id,p_user_id,p_provider,p_model);end $$;
alter function public.reserve_photo_provider_spend(uuid,uuid,uuid,uuid,uuid,uuid,text,text) rename to reserve_photo_provider_spend_before_geometry;
revoke all on function public.reserve_photo_provider_spend_before_geometry(uuid,uuid,uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.reserve_photo_provider_spend(p_event_id uuid,p_run_id uuid,p_lease_id uuid,p_asset_id uuid,p_workspace_id uuid,p_user_id uuid,p_provider text,p_model text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare policy provider_spend_policy;used numeric;begin
  select * into policy from provider_spend_policy where singleton for update;
  if not found or not policy.enabled then raise exception 'Company AI spend is disabled';end if;
  if not exists(select 1 from provider_spend_reservations where event_id=p_event_id) then
    select coalesce(sum(case when status='captured' and telemetry_known then estimated_cost_usd else reserved_usd end),0) into used from provider_spend_reservations where created_at>now()-policy.rolling_window;
    select used+coalesce(sum(reserved_usd),0) into used from geometry_provider_spend_reservations where created_at>now()-policy.rolling_window;
    if used+policy.call_reservation_usd>policy.spend_cap_usd then raise exception 'Company AI spend limit reached';end if;
  end if;
  return reserve_photo_provider_spend_before_geometry(p_event_id,p_run_id,p_lease_id,p_asset_id,p_workspace_id,p_user_id,p_provider,p_model);end $$;
create function public.finish_geometry_provider_tick(p_run_id uuid,p_lease_id uuid,p_status text,p_error_code text,p_artifact jsonb,p_candidates jsonb) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r geometry_provider_jobs;c jsonb;begin
  select * into r from geometry_provider_jobs where id=p_run_id and lease_id=p_lease_id and status='processing' and lease_expires_at>now() and cancel_requested_at is null for update;
  if not found then raise exception 'Geometry lease unavailable';end if;
  if p_status not in ('waiting','needs_review','blocked') or jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates)>3000 then raise exception 'Geometry tick invalid';end if;
  for c in select value from jsonb_array_elements(p_candidates) loop
    if c->>'fileSha256'<>r.file_sha256 or c->'source'->>'geometryRunId'<>r.id::text or c->>'status' not in ('candidate','blocked')
      or c->>'unit' not in ('m2','m','EA') or (c->>'quantity')::numeric<0 then raise exception 'Geometry candidate source invalid';end if;
    insert into geometry_provider_candidates(id,run_id,workspace_id,project_id,candidate,status) values(c->>'id',r.id,r.workspace_id,r.project_id,c,c->>'status') on conflict(run_id,id) do nothing;
  end loop;
  update geometry_provider_jobs set status=p_status,error_code=p_error_code,artifact=p_artifact,lease_id=null,lease_expires_at=null,updated_at=now() where id=r.id;return true;end $$;
create function public.control_geometry_provider_job(p_run_id uuid,p_user_id uuid,p_workspace_id uuid,p_action text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r geometry_provider_jobs;begin
  select * into r from geometry_provider_jobs where id=p_run_id and workspace_id=p_workspace_id for update;
  if not found or not private.geometry_role_actor(p_user_id,p_workspace_id,r.project_id) or p_action<>'cancel' and not private.geometry_actor(p_user_id,p_workspace_id,r.project_id) then raise exception 'Geometry access denied';end if;
  if p_action='cancel' then update geometry_provider_jobs set status='cancelled',cancel_requested_at=now(),lease_id=null,lease_expires_at=null where id=r.id returning * into r;
  elsif p_action='resume' then
    if r.checkpoint->>'state' in ('submitting','upload_uncertain','submission_uncertain') then raise exception 'Provider outcome unknown; reconciliation required';end if;
    if r.status='needs_review' then return to_jsonb(r);end if;
    update geometry_provider_jobs set status='queued',cancel_requested_at=null,lease_id=null,lease_expires_at=null,error_code=null where id=r.id returning * into r;
  else raise exception 'Geometry control invalid';end if;return to_jsonb(r);end $$;
-- Full cancel cascades even when the geometry feature flag/queue is currently off.
alter function public.cancel_full_takeoff_v2(uuid,uuid,uuid) rename to cancel_full_takeoff_v2_before_geometry;
revoke all on function public.cancel_full_takeoff_v2_before_geometry(uuid,uuid,uuid) from public,anon,authenticated,service_role;
create function public.cancel_full_takeoff_v2(p_run_id uuid,p_user_id uuid,p_workspace_id uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;cancelled integer;begin
  result:=cancel_full_takeoff_v2_before_geometry(p_run_id,p_user_id,p_workspace_id);
  update geometry_provider_jobs set status='cancelled',cancel_requested_at=now(),lease_id=null,lease_expires_at=null,updated_at=now()
    where parent_takeoff_run_id=p_run_id and workspace_id=p_workspace_id and status in ('queued','processing','waiting','blocked');
  get diagnostics cancelled=row_count;return result||jsonb_build_object('geometryJobsCancelled',cancelled);end $$;
create function public.review_geometry_provider_candidate(p_run_id uuid,p_candidate_id text,p_user_id uuid,p_workspace_id uuid,p_request_key uuid,p_review jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r geometry_provider_jobs;c geometry_provider_candidates;receipt geometry_provider_review_receipts;result jsonb;begin
  select * into r from geometry_provider_jobs where id=p_run_id and workspace_id=p_workspace_id;
  if not found or not private.geometry_actor(p_user_id,p_workspace_id,r.project_id) then raise exception 'Geometry review access denied';end if;
  select * into receipt from geometry_provider_review_receipts where run_id=p_run_id and candidate_id=p_candidate_id and request_key=p_request_key;
  if found then if receipt.reviewer_id<>p_user_id or receipt.request<>p_review then raise exception 'Geometry review replay conflict';end if;return receipt.result||jsonb_build_object('replayed',true);end if;
  select * into c from geometry_provider_candidates where run_id=p_run_id and id=p_candidate_id for update;
  if not found or p_review->>'expectedRevision' is null or c.review_revision<>(p_review->>'expectedRevision')::integer then raise exception 'Geometry candidate changed';end if;
  if p_review->>'decision' not in ('accepted','rejected') then raise exception 'Geometry decision invalid';end if;
  if p_review->>'decision'='accepted' and (c.status='blocked' or c.candidate->>'quantity' is null
    or coalesce((p_review->>'identityReviewed')::boolean,false) is not true or coalesce((p_review->>'geometryReviewed')::boolean,false) is not true
    or coalesce((p_review->>'duplicateReviewComplete')::boolean,false) is not true or jsonb_array_length(c.candidate->'reviewReasons')>0
    or r.status<>'needs_review') then raise exception 'Geometry evidence requires correction before acceptance';end if;
  update geometry_provider_candidates set status=p_review->>'decision',review_revision=review_revision+1,reviewed_by=p_user_id,reviewed_at=now(),
    candidate=candidate||jsonb_build_object('status',p_review->>'decision','reviewRevision',review_revision+1) where run_id=c.run_id and id=c.id returning * into c;
  result:=jsonb_build_object('candidate',c.candidate,'replayed',false);
  insert into geometry_provider_review_receipts values(c.run_id,c.id,p_request_key,p_review,result,p_user_id);return result;end $$;
revoke all on function private.geometry_actor(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function private.geometry_role_actor(uuid,uuid,uuid) from public,anon,authenticated,service_role;
do $$ declare f record;begin for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and p.proname in ('touch_geometry_provider_worker','geometry_provider_worker_available','recoverable_geometry_provider_jobs','reserve_geometry_provider_job','claim_geometry_provider_job','heartbeat_geometry_provider_job',
    'save_geometry_provider_checkpoint','reserve_geometry_provider_spend','finish_geometry_provider_tick','control_geometry_provider_job','review_geometry_provider_candidate','reserve_provider_spend','reserve_photo_provider_spend','cancel_full_takeoff_v2') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);end loop;end $$;
