-- Keep the database lease well below the BullMQ worker lock (30s).
-- If a worker dies, BullMQ can re-deliver the stalled job after this database
-- lease is already reclaimable instead of burning a retry on a stale lease.

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
    worker_lease_expires_at=now()+interval '15 seconds',worker_heartbeat_at=now(),worker_attempt=worker_attempt+1,
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
  update public.plan_reading_jobs set worker_heartbeat_at=now(),worker_lease_expires_at=now()+interval '15 seconds'
    where id=p_job_id and worker_lease_id=p_lease_id and worker_id=p_worker_id and status='processing' and cancel_requested_at is null;
  return found;
end $$;

revoke all on function public.claim_ai_plan_reading(uuid,text) from public,anon,authenticated;
revoke all on function public.heartbeat_ai_plan_reading(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_ai_plan_reading(uuid,text) to service_role;
grant execute on function public.heartbeat_ai_plan_reading(uuid,uuid,text) to service_role;
