-- Bound platform-owner provider spend without changing complimentary product access.
-- The profile row lock serializes the global per-owner count across workspaces.
create or replace function public.reserve_platform_admin_reading(
  p_user_id uuid,
  p_workspace_id uuid,
  p_project_id uuid,
  p_file_id uuid,
  p_model text,
  p_file_sha256 text,
  p_request_fingerprint text,
  p_requested_trades text[],
  p_scope text
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

  -- A single owner profile lock makes the quota atomic across every workspace.
  perform 1 from public.profiles
  where id = p_user_id and is_platform_admin = true
  for update;
  if not found then raise exception 'Platform administrator access required'; end if;

  if not exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = p_user_id and role in ('admin','estimator')
  ) then raise exception 'Workspace access denied'; end if;

  if not exists (
    select 1 from public.workspaces
    where id = p_workspace_id and ai_processing_consented_at is not null
  ) then raise exception 'AI processing consent required'; end if;

  if not exists (
    select 1 from public.projects
    where id = p_project_id and workspace_id = p_workspace_id
  ) then raise exception 'Project not found'; end if;

  if not exists (
    select 1 from public.project_files
    where id = p_file_id and workspace_id = p_workspace_id and project_id = p_project_id
      and processing_status not in ('uploading','failed')
  ) then raise exception 'File unavailable'; end if;

  select * into j
  from public.plan_reading_jobs
  where workspace_id = p_workspace_id
    and project_id = p_project_id
    and file_id = p_file_id
    and requested_by = p_user_id
    and input_summary->>'entitlement' = 'platform_admin_complimentary'
    and input_summary->>'file_sha256' = p_file_sha256
    and input_summary->>'request_fingerprint' = p_request_fingerprint
    and status in ('processing','needs_review','ready')
  order by created_at desc
  limit 1;
  if found then return jsonb_build_object('reused', true, 'job', to_jsonb(j)); end if;

  -- Every distinct attempt counts, including failed work. The profile lock above
  -- prevents concurrent requests in different workspaces from exceeding the cap.
  select count(*) into used
  from public.plan_reading_jobs
  where requested_by = p_user_id
    and input_summary->>'entitlement' = 'platform_admin_complimentary'
    and created_at > now() - interval '24 hours';
  if used >= daily_limit then
    raise exception 'Platform owner daily AI reading limit reached';
  end if;

  insert into public.plan_reading_jobs(
    workspace_id, project_id, file_id, requested_by, status, mode, model,
    started_at, input_summary
  ) values (
    p_workspace_id, p_project_id, p_file_id, p_user_id, 'processing', 'quick',
    p_model, now(),
    jsonb_build_object(
      'entitlement','platform_admin_complimentary',
      'billed',false,
      'file_sha256',p_file_sha256,
      'request_fingerprint',p_request_fingerprint,
      'requested_trades',to_jsonb(p_requested_trades),
      'requested_scope',coalesce(p_scope,''),
      'human_review_required',true
    )
  ) returning * into j;

  return jsonb_build_object('reused', false, 'job', to_jsonb(j));
end;
$$;

revoke all on function public.reserve_platform_admin_reading(uuid,uuid,uuid,uuid,text,text,text,text[],text) from public, anon, authenticated;
grant execute on function public.reserve_platform_admin_reading(uuid,uuid,uuid,uuid,text,text,text,text[],text) to service_role;
