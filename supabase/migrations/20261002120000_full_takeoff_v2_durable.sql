-- REVIEW ONLY: apply after the V2 foundation, provider-spend and PR98 migrations.
-- No deployment script applies this file automatically. Completed evidence is
-- retained; an uncertain provider call is never retried by lease expiry alone.
alter table public.takeoff_runs
  add column manifest jsonb not null default '{}'::jsonb check (jsonb_typeof(manifest)='object'),
  add column progress jsonb not null default '{}'::jsonb check (jsonb_typeof(progress)='object'),
  add column output_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(output_summary)='object'),
  add column worker_id text,
  add column worker_lease_id uuid,
  add column worker_lease_expires_at timestamptz,
  add column worker_heartbeat_at timestamptz,
  add column cancel_requested_at timestamptz,
  add column processing_error text;

create table public.full_takeoff_v2_workers (
  worker_id text primary key check (length(worker_id) between 1 and 160),
  version text not null,
  heartbeat_at timestamptz not null default now()
);
alter table public.full_takeoff_v2_workers enable row level security;
revoke all on public.full_takeoff_v2_workers from public, anon, authenticated;
grant select, insert, update, delete on public.full_takeoff_v2_workers to service_role;

create or replace function public.touch_full_takeoff_v2_worker(p_worker_id text,p_version text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if length(coalesce(p_worker_id,'')) not between 1 and 160 or p_version<>'takeoff-v2.2-durable' then raise exception 'Invalid Full Takeoff worker'; end if;
  insert into public.full_takeoff_v2_workers(worker_id,version) values(p_worker_id,p_version)
    on conflict(worker_id) do update set version=excluded.version,heartbeat_at=now();
  return true;
end $$;

create or replace function public.full_takeoff_v2_worker_available(p_version text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select p_version='takeoff-v2.2-durable' and exists(select 1 from public.full_takeoff_v2_workers where version=p_version and heartbeat_at>now()-interval '90 seconds')
$$;

create or replace function public.reserve_full_takeoff_v2(p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_file_id uuid,p_manifest jsonb,p_version text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; sheet jsonb; pages integer; reused boolean:=false;
begin
  if p_version is distinct from 'takeoff-v2.2-durable' or jsonb_typeof(p_manifest) is distinct from 'object'
     or coalesce(p_manifest->>'fileSha256','')!~'^[a-f0-9]{64}$'
     or jsonb_typeof(p_manifest->'sheets') is distinct from 'array' then raise exception 'Invalid Full Takeoff manifest'; end if;
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
    and file_sha256=p_manifest->>'fileSha256' and mode='full' and orchestrator_version=p_version for update;
  if found then
    reused:=true;
    if r.manifest<>p_manifest then raise exception 'Saved Full Takeoff manifest differs'; end if;
  else
    if (select count(*) from public.takeoff_runs where requested_by=p_user_id and created_at>now()-interval '24 hours')>=25 then raise exception 'Daily Full Takeoff limit reached'; end if;
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
  if not exists(select 1 from public.profiles where id=r.requested_by and is_platform_admin=true)
     or not exists(select 1 from public.workspace_members where workspace_id=r.workspace_id and user_id=r.requested_by and role in ('admin','estimator'))
     or not exists(select 1 from public.workspaces where id=r.workspace_id and ai_processing_consented_at is not null) then raise exception 'Full Takeoff authorization revoked'; end if;
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
      and exists(select 1 from public.profiles where id=takeoff_runs.requested_by and is_platform_admin=true)
      and exists(select 1 from public.workspace_members where workspace_id=takeoff_runs.workspace_id and user_id=takeoff_runs.requested_by and role in ('admin','estimator'))
      and exists(select 1 from public.workspaces where id=takeoff_runs.workspace_id and ai_processing_consented_at is not null);
  return found;
end $$;

create or replace function public.begin_full_takeoff_v2_pass(p_run_id uuid,p_lease_id uuid,p_page_number integer,p_pass_type text,p_attempt integer,p_idempotency_key text)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; s public.plan_sheets; saved public.takeoff_passes;
begin
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing' and cancel_requested_at is null and worker_lease_expires_at>now() for update;
  if not found then raise exception 'Full Takeoff lease invalid'; end if;
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
  select count(*) filter(where status in ('succeeded','blocked')),count(*) filter(where status in ('blocked','failed','processing')) into completed,blocked from public.takeoff_passes where takeoff_run_id=r.id;
  expected:=(r.manifest->>'physicalPageCount')::integer*10;
  state:=case when completed<>expected then 'failed' else 'needs_review' end;
  update public.takeoff_runs set status=state,completed_at=now(),worker_lease_id=null,worker_lease_expires_at=null,updated_at=now(),
    progress=progress||jsonb_build_object('completed',completed,'total',expected),
    output_summary=jsonb_build_object('takeoff_v2',jsonb_build_object('mode','full_v2','releaseStatus',case when completed=expected and blocked=0 then 'review_ready' else 'blocked' end,
      'budgetStatus','awaiting_measurement_and_price_evidence','humanReviewRequired',true,'summary',p_summary)) where id=r.id;
  return jsonb_build_object('id',r.id,'status',state,'releaseStatus',case when completed=expected and blocked=0 then 'review_ready' else 'blocked' end,'humanReviewRequired',true);
end $$;

create or replace function public.release_full_takeoff_v2(p_run_id uuid,p_lease_id uuid,p_allow_retry boolean)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; uncertain boolean;
begin
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing' for update;
  if not found then return false; end if;
  select exists(select 1 from public.takeoff_passes where takeoff_run_id=r.id and status in ('processing','failed')) into uncertain;
  update public.takeoff_runs set status=case when cancel_requested_at is not null then 'cancelled' when p_allow_retry and not uncertain then 'queued' else 'failed' end,
    worker_lease_id=null,worker_lease_expires_at=null,worker_heartbeat_at=null,worker_id=null,updated_at=now(),
    processing_error=case when uncertain then 'An uncertain pass requires reconciliation before another provider call.' else 'Full Takeoff execution stopped before completion.' end where id=r.id;
  return true;
end $$;

create or replace function public.cancel_full_takeoff_v2(p_run_id uuid,p_user_id uuid,p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs;
begin
  if not exists(select 1 from public.profiles where id=p_user_id and is_platform_admin=true)
     or not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator')) then raise exception 'Full Takeoff access denied'; end if;
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
  if not exists(select 1 from public.profiles where id=p_user_id and is_platform_admin=true)
     or not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator'))
     or not exists(select 1 from public.workspaces where id=p_workspace_id and ai_processing_consented_at is not null) then raise exception 'Full Takeoff access denied'; end if;
  select * into r from public.takeoff_runs where id=p_run_id and workspace_id=p_workspace_id and requested_by=p_user_id and orchestrator_version='takeoff-v2.2-durable' for update;
  if not found or r.status not in ('failed','cancelled','queued') then raise exception 'Full Takeoff cannot restart'; end if;
  if exists(select 1 from public.takeoff_passes where takeoff_run_id=r.id and status in ('processing','failed')) then raise exception 'Full Takeoff requires reconciliation'; end if;
  update public.takeoff_runs set status='queued',cancel_requested_at=null,processing_error=null,worker_id=null,worker_lease_id=null,worker_lease_expires_at=null,updated_at=now() where id=r.id;
  return jsonb_build_object('id',r.id,'status','queued','completedCheckpointsPreserved',true);
end $$;

-- Preserve the existing legacy FK and audit trail while adding a separate V2 FK.
alter table public.takeoff_runs add constraint takeoff_runs_workspace_scope_unique unique(id,workspace_id);
alter table public.provider_spend_reservations alter column job_id drop not null;
alter table public.provider_spend_reservations add column takeoff_run_id uuid;
alter table public.provider_spend_reservations add constraint provider_spend_takeoff_scope_fkey
  foreign key(takeoff_run_id,workspace_id) references public.takeoff_runs(id,workspace_id) on delete restrict;
alter table public.provider_spend_reservations add constraint provider_spend_one_run_check check ((job_id is null)<>(takeoff_run_id is null));
create index provider_spend_takeoff_run_idx on public.provider_spend_reservations(takeoff_run_id,workspace_id) where takeoff_run_id is not null;

create or replace function public.reserve_provider_spend(p_event_id uuid,p_job_id uuid,p_workspace_id uuid,p_user_id uuid,p_provider text,p_model text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare policy public.provider_spend_policy; used numeric(12,6); reservation public.provider_spend_reservations; full_run boolean:=false; authorized_project uuid;
begin
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
    if not exists(select 1 from public.profiles where id=p_user_id and is_platform_admin=true)
       or not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator'))
       or not exists(select 1 from public.workspaces where id=p_workspace_id and ai_processing_consented_at is not null) then raise exception 'Provider spend Full Takeoff access denied'; end if;
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

revoke all on function public.touch_full_takeoff_v2_worker(text,text) from public,anon,authenticated;
revoke all on function public.full_takeoff_v2_worker_available(text) from public,anon,authenticated;
revoke all on function public.reserve_full_takeoff_v2(uuid,uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
revoke all on function public.claim_full_takeoff_v2(uuid,text,text) from public,anon,authenticated;
revoke all on function public.heartbeat_full_takeoff_v2(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.begin_full_takeoff_v2_pass(uuid,uuid,integer,text,integer,text) from public,anon,authenticated;
revoke all on function public.checkpoint_full_takeoff_v2_pass(uuid,uuid,integer,text,integer,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.finish_full_takeoff_v2(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.release_full_takeoff_v2(uuid,uuid,boolean) from public,anon,authenticated;
revoke all on function public.cancel_full_takeoff_v2(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.restart_full_takeoff_v2(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.touch_full_takeoff_v2_worker(text,text),public.full_takeoff_v2_worker_available(text),public.reserve_full_takeoff_v2(uuid,uuid,uuid,uuid,jsonb,text),
  public.claim_full_takeoff_v2(uuid,text,text),public.heartbeat_full_takeoff_v2(uuid,uuid,text),public.begin_full_takeoff_v2_pass(uuid,uuid,integer,text,integer,text),
  public.checkpoint_full_takeoff_v2_pass(uuid,uuid,integer,text,integer,text,jsonb,jsonb),public.finish_full_takeoff_v2(uuid,uuid,jsonb),public.release_full_takeoff_v2(uuid,uuid,boolean),
  public.cancel_full_takeoff_v2(uuid,uuid,uuid),public.restart_full_takeoff_v2(uuid,uuid,uuid),public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text) to service_role;
