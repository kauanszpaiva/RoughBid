-- Owner complimentary access keeps tenancy, consent and request deduplication.
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
begin
  if p_file_sha256 !~ '^[a-f0-9]{64}$' or p_request_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid plan reading request identity';
  end if;
  if p_model is null or btrim(p_model) = '' then raise exception 'Model is required'; end if;
  if p_requested_trades is null or cardinality(p_requested_trades) < 1 then raise exception 'At least one trade is required'; end if;

  -- The workspace lock serializes daily-cap and idempotency checks just as the
  -- paid reservation does. It is not an authorization shortcut.
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then raise exception 'Workspace access denied'; end if;

  if not exists (
    select 1 from public.profiles where id = p_user_id and is_platform_admin = true
  ) then raise exception 'Platform administrator access required'; end if;

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

  -- Identical no-charge requests re-use an existing successful/in-flight job.
  -- Scope, trades, model, mode and bytes are represented by the fingerprint.
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

  -- The authenticated platform owner has no commercial or daily reading quota.

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


