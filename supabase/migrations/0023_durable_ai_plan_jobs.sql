-- Durable AI plan execution. The HTTP request may reserve + enqueue only;
-- provider work is claimed by a long-lived worker. All functions below are
-- service-role only and re-check the paid or owner-free authorization at claim.

alter table public.plan_reading_jobs
  add column if not exists worker_id text,
  add column if not exists worker_lease_id uuid,
  add column if not exists worker_lease_expires_at timestamptz,
  add column if not exists worker_heartbeat_at timestamptz,
  add column if not exists worker_attempt integer not null default 0 check (worker_attempt >= 0),
  add column if not exists provider_attempts integer not null default 0 check (provider_attempts >= 0),
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists processing_checkpoint jsonb not null default '{}'::jsonb;

create table if not exists private.ai_plan_worker_heartbeats (
  worker_id text primary key check (char_length(worker_id) between 1 and 160),
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now()
);
alter table private.ai_plan_worker_heartbeats enable row level security;
revoke all on private.ai_plan_worker_heartbeats from public, anon, authenticated;
grant all on private.ai_plan_worker_heartbeats to service_role;

create or replace function public.touch_ai_plan_worker(p_worker_id text)
returns boolean language plpgsql security definer set search_path = public, private, pg_temp as $$
begin
  if p_worker_id is null or char_length(trim(p_worker_id)) not between 1 and 160 then
    raise exception 'Invalid worker id';
  end if;
  insert into private.ai_plan_worker_heartbeats(worker_id, heartbeat_at)
    values(trim(p_worker_id), now())
    on conflict (worker_id) do update set heartbeat_at=excluded.heartbeat_at;
  return true;
end $$;

create or replace function public.ai_plan_worker_available()
returns boolean language sql stable security definer set search_path = public, private, pg_temp as $$
  select exists (
    select 1 from private.ai_plan_worker_heartbeats
    where heartbeat_at >= now() - interval '90 seconds'
  );
$$;

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
  select * into q from public.project_reading_quotes where id=p_quote_id and workspace_id=p_workspace_id
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

create or replace function public.reserve_owner_free_reading_async(
  p_user_id uuid, p_workspace_id uuid, p_project_id uuid, p_file_id uuid, p_model text,
  p_file_sha256 text, p_request_fingerprint text, p_requested_trades jsonb, p_requested_scope text,
  p_mode text, p_page_count integer)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare j public.plan_reading_jobs; begin
  if p_file_sha256 !~ '^[a-f0-9]{64}$' or p_request_fingerprint !~ '^[a-f0-9]{64}$' then raise exception 'Invalid plan reading request identity'; end if;
  if jsonb_typeof(p_requested_trades) <> 'array' or jsonb_array_length(p_requested_trades) not between 1 and 7 then raise exception 'Invalid requested trades'; end if;
  if p_mode not in ('quick','detailed') or p_page_count not between 1 and 100 or char_length(coalesce(p_requested_scope,'')) > 500 then raise exception 'Invalid plan reading request'; end if;
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if not exists(select 1 from private.free_owner_workspaces where workspace_id=p_workspace_id) then raise exception 'Free reading is not enabled for this workspace'; end if;
  if not exists(select 1 from public.workspaces where id=p_workspace_id and created_by=p_user_id) then raise exception 'Free reading is restricted to the workspace owner'; end if;
  if not exists(select 1 from public.workspaces where id=p_workspace_id and ai_processing_consented_at is not null) then raise exception 'AI processing consent required'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator')) then raise exception 'Workspace access denied'; end if;
  if not exists(select 1 from public.project_files where id=p_file_id and workspace_id=p_workspace_id and project_id=p_project_id
    and processing_status not in ('uploading','failed')) then raise exception 'File unavailable'; end if;

  select * into j from public.plan_reading_jobs
    where workspace_id=p_workspace_id and project_id=p_project_id and file_id=p_file_id
      and input_summary->>'entitlement'='owner_free'
      and input_summary->>'file_sha256'=p_file_sha256
      and input_summary->>'request_fingerprint'=p_request_fingerprint
      and status in ('queued','processing','needs_review','ready')
    order by created_at desc limit 1;
  if found then return jsonb_build_object('reused',true,'job',to_jsonb(j)); end if;

  if (select count(*) from public.plan_reading_jobs where workspace_id=p_workspace_id
      and input_summary->>'entitlement'='owner_free' and created_at >= now()-interval '24 hours')
      >= coalesce(nullif(current_setting('roughbid.free_daily_cap',true),'')::int,20) then
    raise exception 'Free daily reading limit reached for this workspace';
  end if;

  insert into public.plan_reading_jobs(workspace_id,project_id,file_id,requested_by,status,mode,model,input_summary)
  values(p_workspace_id,p_project_id,p_file_id,p_user_id,'queued',p_mode,p_model,
    jsonb_build_object('entitlement','owner_free','billed',false,'file_sha256',p_file_sha256,
      'request_fingerprint',p_request_fingerprint,'requested_trades',p_requested_trades,
      'requested_scope',p_requested_scope,'page_count',p_page_count,'human_review_required',true))
  returning * into j;
  return jsonb_build_object('reused',false,'job',to_jsonb(j));
end $$;

create or replace function public.rollback_ai_plan_enqueue(p_job_id uuid, p_user_id uuid)
returns boolean language plpgsql security definer set search_path = public, private, pg_temp as $$
declare j public.plan_reading_jobs; qid uuid; begin
  select * into j from public.plan_reading_jobs where id=p_job_id for update;
  if not found then return true; end if;
  if j.requested_by <> p_user_id or j.status <> 'queued' or j.provider_attempts <> 0 then raise exception 'Queue reservation cannot be released'; end if;
  if j.input_summary->>'entitlement'='paid' then
    qid := (j.input_summary->>'quote_id')::uuid;
    update public.project_reading_quotes set status='paid',job_id=null where id=qid and job_id=j.id and paid_at is not null and status='processing';
  end if;
  delete from public.plan_reading_jobs where id=j.id;
  return true;
end $$;

create or replace function public.claim_ai_plan_reading(p_job_id uuid, p_worker_id text)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare j public.plan_reading_jobs; q public.project_reading_quotes; f public.project_files; lease uuid; ent text; qid uuid; begin
  select * into j from public.plan_reading_jobs where id=p_job_id for update;
  if not found then raise exception 'AI plan job not found'; end if;
  if j.status in ('needs_review','ready','failed') then return jsonb_build_object('skip',true,'status',j.status); end if;
  if j.cancel_requested_at is not null then
    update public.plan_reading_jobs set status='failed',processing_error='Canceled by user',completed_at=now() where id=j.id returning * into j;
    return jsonb_build_object('skip',true,'status','failed');
  end if;
  if j.status='processing' and j.worker_lease_expires_at is not null and j.worker_lease_expires_at > now() then raise exception 'AI plan job is already leased'; end if;
  ent := j.input_summary->>'entitlement';
  if ent='paid' then
    qid := (j.input_summary->>'quote_id')::uuid;
    select * into q from public.project_reading_quotes where id=qid and job_id=j.id for update;
    if not found or q.paid_at is null or q.status <> 'processing' or q.workspace_id<>j.workspace_id or q.project_id<>j.project_id or q.file_id<>j.file_id then
      raise exception 'Paid reading authorization is no longer valid'; end if;
  elsif ent='owner_free' then
    if not exists(select 1 from private.free_owner_workspaces where workspace_id=j.workspace_id)
      or not exists(select 1 from public.workspaces where id=j.workspace_id and created_by=j.requested_by and ai_processing_consented_at is not null)
      or not exists(select 1 from public.workspace_members where workspace_id=j.workspace_id and user_id=j.requested_by and role in ('admin','estimator')) then
      raise exception 'Owner-free reading authorization is no longer valid'; end if;
  else raise exception 'Unknown AI plan entitlement'; end if;

  select * into f from public.project_files where id=j.file_id and workspace_id=j.workspace_id and project_id=j.project_id
    and processing_status not in ('uploading','failed');
  if not found then raise exception 'Plan file is unavailable'; end if;

  lease := gen_random_uuid();
  update public.plan_reading_jobs set status='processing',worker_id=trim(p_worker_id),worker_lease_id=lease,
    worker_lease_expires_at=now()+interval '60 seconds',worker_heartbeat_at=now(),worker_attempt=worker_attempt+1,
    started_at=coalesce(started_at,now()),processing_error=null
    where id=j.id returning * into j;

  return jsonb_build_object(
    'skip',false,'lease_id',lease,'entitlement',ent,'quote_id',qid,'requested_by',j.requested_by,
    'workspace_id',j.workspace_id,'project_id',j.project_id,'file_id',j.file_id,'model',j.model,
    'storage_path',f.storage_path,'original_name',f.original_name,'checkpoint',j.processing_checkpoint,
    'file_sha256',case when ent='paid' then q.file_sha256 else j.input_summary->>'file_sha256' end,
    'page_count',case when ent='paid' then q.page_count else (j.input_summary->>'page_count')::integer end,
    'requested_trades',case when ent='paid' then q.trades else j.input_summary->'requested_trades' end,
    'requested_scope',case when ent='paid' then q.scope else j.input_summary->>'requested_scope' end
  );
end $$;

create or replace function public.heartbeat_ai_plan_reading(p_job_id uuid, p_lease_id uuid, p_worker_id text)
returns boolean language plpgsql security definer set search_path = public, private, pg_temp as $$
begin
  update public.plan_reading_jobs set worker_heartbeat_at=now(),worker_lease_expires_at=now()+interval '60 seconds'
    where id=p_job_id and worker_lease_id=p_lease_id and worker_id=p_worker_id and status='processing' and cancel_requested_at is null;
  return found;
end $$;

create or replace function public.begin_ai_plan_provider_attempt(p_job_id uuid, p_lease_id uuid)
returns boolean language plpgsql security definer set search_path = public, private, pg_temp as $$
declare j public.plan_reading_jobs; q public.project_reading_quotes; qid uuid; ent text; begin
  select * into j from public.plan_reading_jobs where id=p_job_id and worker_lease_id=p_lease_id and status='processing' and cancel_requested_at is null for update;
  if not found then raise exception 'AI plan worker lease is invalid'; end if;
  if j.processing_checkpoint ? 'provider_result' then return false; end if;
  ent := j.input_summary->>'entitlement';
  if ent='paid' then
    qid := (j.input_summary->>'quote_id')::uuid;
    select * into q from public.project_reading_quotes where id=qid and job_id=j.id and status='processing' and paid_at is not null for update;
    if not found then raise exception 'Paid reading authorization is no longer valid'; end if;
    if q.attempts >= 2 then raise exception 'Provider attempt limit reached'; end if;
    update public.project_reading_quotes set attempts=attempts+1 where id=q.id;
  elsif ent='owner_free' then
    if j.provider_attempts >= 1 then raise exception 'Free provider attempt limit reached'; end if;
  else raise exception 'Unknown AI plan entitlement'; end if;
  update public.plan_reading_jobs set provider_attempts=provider_attempts+1 where id=j.id;
  return true;
end $$;

create or replace function public.checkpoint_ai_plan_reading(p_job_id uuid, p_lease_id uuid, p_result jsonb)
returns boolean language plpgsql security definer set search_path = public, private, pg_temp as $$
begin
  if p_result is null or jsonb_typeof(p_result) <> 'object'
    or jsonb_typeof(p_result->'findings') <> 'array'
    or jsonb_array_length(p_result->'findings') not between 1 and 200
    or coalesce((p_result->'summary'->>'synthetic')::boolean,false) then raise exception 'Real provider result required'; end if;
  update public.plan_reading_jobs set processing_checkpoint=jsonb_build_object('provider_result',p_result,'checkpointed_at',now())
    where id=p_job_id and worker_lease_id=p_lease_id and status='processing' and cancel_requested_at is null;
  if not found then raise exception 'AI plan worker lease is invalid'; end if;
  return true;
end $$;

create or replace function public.release_ai_plan_reading_retry(p_job_id uuid, p_lease_id uuid, p_error text)
returns boolean language plpgsql security definer set search_path = public, private, pg_temp as $$
begin
  update public.plan_reading_jobs set status='queued',processing_error=left(p_error,1000),worker_id=null,worker_lease_id=null,
    worker_lease_expires_at=null,worker_heartbeat_at=null
    where id=p_job_id and worker_lease_id=p_lease_id and status='processing' and cancel_requested_at is null;
  return found;
end $$;

create or replace function public.request_ai_plan_cancel(p_job_id uuid, p_user_id uuid, p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare j public.plan_reading_jobs; begin
  if not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator')) then
    raise exception 'Workspace access denied'; end if;
  select * into j from public.plan_reading_jobs where id=p_job_id and workspace_id=p_workspace_id for update;
  if not found then raise exception 'AI plan job not found'; end if;
  if j.status in ('needs_review','ready','failed') then return to_jsonb(j); end if;
  update public.plan_reading_jobs set cancel_requested_at=now(),
    status=case when status='queued' then 'failed' else status end,
    processing_error=case when status='queued' then 'Canceled by user' else processing_error end,
    completed_at=case when status='queued' then now() else completed_at end
    where id=j.id returning * into j;
  return to_jsonb(j);
end $$;

revoke all on function public.touch_ai_plan_worker(text) from public,anon,authenticated;
revoke all on function public.ai_plan_worker_available() from public,anon,authenticated;
revoke all on function public.reserve_project_reading_async(uuid,uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.reserve_owner_free_reading_async(uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,integer) from public,anon,authenticated;
revoke all on function public.rollback_ai_plan_enqueue(uuid,uuid) from public,anon,authenticated;
revoke all on function public.claim_ai_plan_reading(uuid,text) from public,anon,authenticated;
revoke all on function public.heartbeat_ai_plan_reading(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.begin_ai_plan_provider_attempt(uuid,uuid) from public,anon,authenticated;
revoke all on function public.checkpoint_ai_plan_reading(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.release_ai_plan_reading_retry(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.request_ai_plan_cancel(uuid,uuid,uuid) from public,anon,authenticated;

grant execute on function public.touch_ai_plan_worker(text) to service_role;
grant execute on function public.ai_plan_worker_available() to service_role;
grant execute on function public.reserve_project_reading_async(uuid,uuid,uuid,uuid,uuid,text) to service_role;
grant execute on function public.reserve_owner_free_reading_async(uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,integer) to service_role;
grant execute on function public.rollback_ai_plan_enqueue(uuid,uuid) to service_role;
grant execute on function public.claim_ai_plan_reading(uuid,text) to service_role;
grant execute on function public.heartbeat_ai_plan_reading(uuid,uuid,text) to service_role;
grant execute on function public.begin_ai_plan_provider_attempt(uuid,uuid) to service_role;
grant execute on function public.checkpoint_ai_plan_reading(uuid,uuid,jsonb) to service_role;
grant execute on function public.release_ai_plan_reading_retry(uuid,uuid,text) to service_role;
grant execute on function public.request_ai_plan_cancel(uuid,uuid,uuid) to service_role;
