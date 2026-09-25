-- Exhaustive RB.AI plan scanning support.
--
-- 1) Platform-admin whole-plan readings may be queued on the existing paid
--    worker without manufacturing Stripe state.
-- 2) The worker claim/attempt state machine recognizes that complimentary
--    entitlement while preserving server-side admin + tenant checks.
-- 3) Dense plan sweeps may persist more than the historical 200 findings. The
--    application remains bounded at 10,000 findings per completed reading.

create or replace function public.reserve_platform_admin_reading_async(
  p_user_id uuid,
  p_workspace_id uuid,
  p_project_id uuid,
  p_file_id uuid,
  p_model text,
  p_file_sha256 text,
  p_request_fingerprint text,
  p_requested_trades text[],
  p_requested_scope text,
  p_page_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  j public.plan_reading_jobs;
  used integer;
  daily_limit constant integer := 25;
begin
  if p_file_sha256 !~ '^[a-f0-9]{64}$' or p_request_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid plan reading request identity';
  end if;
  if p_model is null or btrim(p_model) = '' then raise exception 'Model is required'; end if;
  if p_requested_trades is null or cardinality(p_requested_trades) < 1 then raise exception 'At least one trade is required'; end if;
  if p_page_count not between 1 and 200 then raise exception 'Invalid page count'; end if;
  if char_length(coalesce(p_requested_scope,'')) > 500 then raise exception 'Invalid requested scope'; end if;

  perform 1 from public.profiles
  where id = p_user_id and is_platform_admin = true
  for update;
  if not found then raise exception 'Platform administrator access required'; end if;

  if not exists (
    select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator')
  ) then raise exception 'Workspace access denied'; end if;
  if not exists (
    select 1 from public.workspaces
    where id=p_workspace_id and ai_processing_consented_at is not null
  ) then raise exception 'AI processing consent required'; end if;
  if not exists (
    select 1 from public.projects where id=p_project_id and workspace_id=p_workspace_id
  ) then raise exception 'Project not found'; end if;
  if not exists (
    select 1 from public.project_files
    where id=p_file_id and workspace_id=p_workspace_id and project_id=p_project_id
      and processing_status not in ('uploading','failed')
  ) then raise exception 'File unavailable'; end if;

  select * into j
  from public.plan_reading_jobs
  where workspace_id=p_workspace_id
    and project_id=p_project_id
    and file_id=p_file_id
    and requested_by=p_user_id
    and input_summary->>'entitlement'='platform_admin_complimentary'
    and input_summary->>'file_sha256'=p_file_sha256
    and input_summary->>'request_fingerprint'=p_request_fingerprint
    and status in ('queued','processing','needs_review','ready')
  order by created_at desc
  limit 1;
  if found then return jsonb_build_object('reused',true,'job',to_jsonb(j)); end if;

  select count(*) into used
  from public.plan_reading_jobs
  where requested_by=p_user_id
    and input_summary->>'entitlement'='platform_admin_complimentary'
    and created_at > now()-interval '24 hours';
  if used >= daily_limit then raise exception 'Platform owner daily AI reading limit reached'; end if;

  insert into public.plan_reading_jobs(
    workspace_id,project_id,file_id,requested_by,status,mode,model,input_summary
  ) values(
    p_workspace_id,p_project_id,p_file_id,p_user_id,'queued','detailed',p_model,
    jsonb_build_object(
      'entitlement','platform_admin_complimentary',
      'billed',false,
      'file_sha256',p_file_sha256,
      'request_fingerprint',p_request_fingerprint,
      'requested_trades',to_jsonb(p_requested_trades),
      'requested_scope',coalesce(p_requested_scope,''),
      'page_count',p_page_count,
      'human_review_required',true,
      'scan_strategy','whole-set-plus-overlapping-regions-v1'
    )
  ) returning * into j;
  return jsonb_build_object('reused',false,'job',to_jsonb(j));
end;
$$;

create or replace function public.claim_ai_plan_reading(p_job_id uuid, p_worker_id text)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  j public.plan_reading_jobs;
  q public.project_reading_quotes;
  f public.project_files;
  lease uuid;
  ent text;
  qid uuid;
begin
  select * into j from public.plan_reading_jobs where id=p_job_id for update;
  if not found then raise exception 'AI plan job not found'; end if;
  if j.status in ('needs_review','ready','failed') then return jsonb_build_object('skip',true,'status',j.status); end if;
  if j.cancel_requested_at is not null then
    update public.plan_reading_jobs set status='failed',processing_error='Canceled by user',completed_at=now() where id=j.id returning * into j;
    return jsonb_build_object('skip',true,'status','failed');
  end if;
  if j.status='processing' and j.worker_lease_expires_at is not null and j.worker_lease_expires_at > now() then
    raise exception 'AI plan job is already leased';
  end if;

  ent := j.input_summary->>'entitlement';
  if ent='paid' then
    qid := (j.input_summary->>'quote_id')::uuid;
    select * into q from public.project_reading_quotes where id=qid and job_id=j.id for update;
    if not found or q.paid_at is null or q.status <> 'processing'
      or q.workspace_id<>j.workspace_id or q.project_id<>j.project_id or q.file_id<>j.file_id then
      raise exception 'Paid reading authorization is no longer valid';
    end if;
  elsif ent='owner_free' then
    if not exists(select 1 from private.free_owner_workspaces where workspace_id=j.workspace_id)
      or not exists(select 1 from public.workspaces where id=j.workspace_id and created_by=j.requested_by and ai_processing_consented_at is not null)
      or not exists(select 1 from public.workspace_members where workspace_id=j.workspace_id and user_id=j.requested_by and role in ('admin','estimator')) then
      raise exception 'Owner-free reading authorization is no longer valid';
    end if;
  elsif ent='platform_admin_complimentary' then
    if not exists(select 1 from public.profiles where id=j.requested_by and is_platform_admin=true)
      or not exists(select 1 from public.workspaces where id=j.workspace_id and ai_processing_consented_at is not null)
      or not exists(select 1 from public.workspace_members where workspace_id=j.workspace_id and user_id=j.requested_by and role in ('admin','estimator')) then
      raise exception 'Platform administrator reading authorization is no longer valid';
    end if;
  else
    raise exception 'Unknown AI plan entitlement';
  end if;

  select * into f from public.project_files
  where id=j.file_id and workspace_id=j.workspace_id and project_id=j.project_id
    and processing_status not in ('uploading','failed');
  if not found then raise exception 'Plan file is unavailable'; end if;

  lease := gen_random_uuid();
  update public.plan_reading_jobs
  set status='processing',
      worker_id=trim(p_worker_id),
      worker_lease_id=lease,
      worker_lease_expires_at=now()+interval '15 seconds',
      worker_heartbeat_at=now(),
      worker_attempt=worker_attempt+1,
      started_at=coalesce(started_at,now()),
      processing_error=null
  where id=j.id
  returning * into j;

  return jsonb_build_object(
    'skip',false,
    'lease_id',lease,
    'entitlement',ent,
    'quote_id',qid,
    'requested_by',j.requested_by,
    'workspace_id',j.workspace_id,
    'project_id',j.project_id,
    'file_id',j.file_id,
    'model',j.model,
    'mode',j.mode,
    'storage_path',f.storage_path,
    'original_name',f.original_name,
    'checkpoint',j.processing_checkpoint,
    'file_sha256',case when ent='paid' then q.file_sha256 else j.input_summary->>'file_sha256' end,
    'page_count',case when ent='paid' then q.page_count else (j.input_summary->>'page_count')::integer end,
    'requested_trades',case when ent='paid' then q.trades else j.input_summary->'requested_trades' end,
    'requested_scope',case when ent='paid' then q.scope else j.input_summary->>'requested_scope' end
  );
end;
$$;

create or replace function public.begin_ai_plan_provider_attempt(p_job_id uuid, p_lease_id uuid)
returns boolean language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  j public.plan_reading_jobs;
  q public.project_reading_quotes;
  qid uuid;
  ent text;
begin
  select * into j
  from public.plan_reading_jobs
  where id=p_job_id and worker_lease_id=p_lease_id and status='processing' and cancel_requested_at is null
  for update;
  if not found then raise exception 'AI plan worker lease is invalid'; end if;
  if j.processing_checkpoint ? 'provider_result' then return false; end if;

  ent := j.input_summary->>'entitlement';
  if ent='paid' then
    qid := (j.input_summary->>'quote_id')::uuid;
    select * into q from public.project_reading_quotes
    where id=qid and job_id=j.id and status='processing' and paid_at is not null
    for update;
    if not found then raise exception 'Paid reading authorization is no longer valid'; end if;
    if q.attempts >= 2 then raise exception 'Provider attempt limit reached'; end if;
    update public.project_reading_quotes set attempts=attempts+1 where id=q.id;
  elsif ent in ('owner_free','platform_admin_complimentary') then
    if j.provider_attempts >= 1 then raise exception 'Provider attempt limit reached'; end if;
  else
    raise exception 'Unknown AI plan entitlement';
  end if;

  update public.plan_reading_jobs set provider_attempts=provider_attempts+1 where id=j.id;
  return true;
end;
$$;

create or replace function public.checkpoint_ai_plan_reading(
  p_job_id uuid, p_lease_id uuid, p_result jsonb
)
returns boolean language plpgsql security definer set search_path = public, private, pg_temp as $$
begin
  if p_result is null
    or jsonb_typeof(p_result) <> 'object'
    or jsonb_typeof(p_result->'findings') <> 'array'
    or jsonb_array_length(p_result->'findings') not between 1 and 10000
    or coalesce((p_result->'summary'->>'synthetic')::boolean,false) then
    raise exception 'Real provider result required';
  end if;

  update public.plan_reading_jobs
  set processing_checkpoint=jsonb_build_object('provider_result',p_result,'checkpointed_at',now())
  where id=p_job_id and worker_lease_id=p_lease_id and status='processing' and cancel_requested_at is null;
  if not found then raise exception 'AI plan worker lease is invalid'; end if;
  return true;
end;
$$;

create or replace function public.finish_project_reading(
  p_quote_id uuid, p_job_id uuid, p_summary jsonb, p_findings jsonb, p_error text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q public.project_reading_quotes;
  j public.plan_reading_jobs;
begin
  select * into q from public.project_reading_quotes where id=p_quote_id and job_id=p_job_id for update;
  if not found or q.status <> 'processing' or q.paid_at is null then raise exception 'Reading is not authorized'; end if;
  if p_error is not null then
    update public.plan_reading_jobs set status='failed',processing_error=left(p_error,1000),completed_at=now() where id=p_job_id returning * into j;
    update public.project_reading_quotes set status='failed' where id=q.id;
    return to_jsonb(j);
  end if;
  if p_findings is null
    or jsonb_typeof(p_findings) is distinct from 'array'
    or jsonb_array_length(p_findings) is null
    or jsonb_array_length(p_findings) not between 1 and 10000
    or coalesce((p_summary->>'synthetic')::boolean,false) then raise exception 'Real findings required'; end if;

  insert into public.plan_reading_findings(
    job_id,workspace_id,project_id,file_id,page_number,finding_type,label,value_text,quantity,unit,confidence,geometry,source_excerpt
  )
  select p_job_id,q.workspace_id,q.project_id,q.file_id,
    f.page_number,f.finding_type,f.label,f.value_text,f.quantity,f.unit,f.confidence,coalesce(f.geometry,'{}'),f.source_excerpt
  from jsonb_to_recordset(p_findings) as f(
    page_number integer,finding_type text,label text,value_text text,quantity numeric,unit text,
    confidence numeric,geometry jsonb,source_excerpt text
  );

  update public.plan_reading_jobs
  set status='needs_review',output_summary=p_summary,completed_at=now(),processing_error=null
  where id=p_job_id returning * into j;
  update public.project_reading_quotes set status='complete' where id=q.id;
  return to_jsonb(j) || jsonb_build_object(
    'plan_reading_findings',
    (select jsonb_agg(to_jsonb(f)) from public.plan_reading_findings f where job_id=p_job_id)
  );
end;
$$;

create or replace function public.finish_owner_free_reading(
  p_job_id uuid, p_user_id uuid, p_summary jsonb, p_findings jsonb, p_error text
)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  j public.plan_reading_jobs;
begin
  select * into j from public.plan_reading_jobs where id=p_job_id for update;
  if not found or j.status <> 'processing' then raise exception 'Reading is not authorized'; end if;
  if not exists(select 1 from private.free_owner_workspaces where workspace_id=j.workspace_id)
     or j.requested_by<>p_user_id then raise exception 'Reading is not authorized'; end if;

  if p_error is not null then
    update public.plan_reading_jobs set status='failed',processing_error=left(p_error,1000),completed_at=now()
    where id=p_job_id returning * into j;
    return to_jsonb(j);
  end if;

  if p_findings is null
    or jsonb_typeof(p_findings) is distinct from 'array'
    or jsonb_array_length(p_findings) is null
    or jsonb_array_length(p_findings) not between 1 and 10000
    or coalesce((p_summary->>'synthetic')::boolean,false) then raise exception 'Real findings required'; end if;

  insert into public.plan_reading_findings(
    job_id,workspace_id,project_id,file_id,page_number,finding_type,label,value_text,quantity,unit,confidence,geometry,source_excerpt
  )
  select p_job_id,j.workspace_id,j.project_id,j.file_id,
    f.page_number,f.finding_type,f.label,f.value_text,f.quantity,f.unit,f.confidence,coalesce(f.geometry,'{}'),f.source_excerpt
  from jsonb_to_recordset(p_findings) as f(
    page_number integer,finding_type text,label text,value_text text,quantity numeric,unit text,
    confidence numeric,geometry jsonb,source_excerpt text
  );

  update public.plan_reading_jobs
  set status='needs_review',output_summary=p_summary,completed_at=now(),processing_error=null
  where id=p_job_id returning * into j;
  return to_jsonb(j) || jsonb_build_object(
    'plan_reading_findings',
    (select jsonb_agg(to_jsonb(f)) from public.plan_reading_findings f where job_id=p_job_id)
  );
end;
$$;

create or replace function public.finish_platform_admin_reading(
  p_job_id uuid, p_user_id uuid, p_summary jsonb, p_findings jsonb, p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  j public.plan_reading_jobs;
begin
  select * into j from public.plan_reading_jobs where id=p_job_id for update;
  if not found
    or j.status <> 'processing'
    or j.requested_by<>p_user_id
    or j.input_summary->>'entitlement'<>'platform_admin_complimentary' then
    raise exception 'Reading is not authorized';
  end if;
  if not exists(select 1 from public.profiles where id=p_user_id and is_platform_admin=true) then
    raise exception 'Reading is not authorized';
  end if;
  if not exists(
    select 1 from public.workspace_members
    where workspace_id=j.workspace_id and user_id=p_user_id and role in ('admin','estimator')
  ) then raise exception 'Reading is not authorized'; end if;

  if p_error is not null then
    update public.plan_reading_jobs
    set status='failed',processing_error=left(p_error,1000),completed_at=now()
    where id=p_job_id returning * into j;
    return to_jsonb(j);
  end if;

  if p_findings is null
    or jsonb_typeof(p_findings) is distinct from 'array'
    or jsonb_array_length(p_findings) is null
    or jsonb_array_length(p_findings) not between 1 and 10000
    or coalesce((p_summary->>'synthetic')::boolean,false) then raise exception 'Real findings required'; end if;

  insert into public.plan_reading_findings(
    job_id,workspace_id,project_id,file_id,page_number,finding_type,label,value_text,quantity,unit,confidence,geometry,source_excerpt
  )
  select p_job_id,j.workspace_id,j.project_id,j.file_id,
    f.page_number,f.finding_type,f.label,f.value_text,f.quantity,f.unit,f.confidence,coalesce(f.geometry,'{}'),f.source_excerpt
  from jsonb_to_recordset(p_findings) as f(
    page_number integer,finding_type text,label text,value_text text,quantity numeric,unit text,
    confidence numeric,geometry jsonb,source_excerpt text
  );

  update public.plan_reading_jobs
  set status='needs_review',output_summary=p_summary,completed_at=now(),processing_error=null
  where id=p_job_id returning * into j;
  return to_jsonb(j) || jsonb_build_object(
    'plan_reading_findings',
    (select jsonb_agg(to_jsonb(f)) from public.plan_reading_findings f where job_id=p_job_id)
  );
end;
$$;

revoke all on function public.reserve_platform_admin_reading_async(uuid,uuid,uuid,uuid,text,text,text,text[],text,integer) from public,anon,authenticated;
revoke all on function public.claim_ai_plan_reading(uuid,text) from public,anon,authenticated;
revoke all on function public.begin_ai_plan_provider_attempt(uuid,uuid) from public,anon,authenticated;
revoke all on function public.checkpoint_ai_plan_reading(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.finish_project_reading(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function public.finish_owner_free_reading(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function public.finish_platform_admin_reading(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;

grant execute on function public.reserve_platform_admin_reading_async(uuid,uuid,uuid,uuid,text,text,text,text[],text,integer) to service_role;
grant execute on function public.claim_ai_plan_reading(uuid,text) to service_role;
grant execute on function public.begin_ai_plan_provider_attempt(uuid,uuid) to service_role;
grant execute on function public.checkpoint_ai_plan_reading(uuid,uuid,jsonb) to service_role;
grant execute on function public.finish_project_reading(uuid,uuid,jsonb,jsonb,text) to service_role;
grant execute on function public.finish_owner_free_reading(uuid,uuid,jsonb,jsonb,text) to service_role;
grant execute on function public.finish_platform_admin_reading(uuid,uuid,jsonb,jsonb,text) to service_role;
