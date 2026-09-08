-- Platform administrator complimentary commercial access for plan reading.
--
-- This is deliberately NOT a fake payment. It creates no project_reading_quote,
-- Stripe session, payment intent, or subscription. The platform administrator
-- may exercise the real paid provider inside workspaces/projects they are
-- already authorized to operate, while every customer payment invariant remains
-- unchanged.

-- Keep the finding schema compatible with the real readers. This is additive to
-- 0017 and self-contained so the migration does not depend on 0020 being present
-- in a production database.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'plan_reading_findings_finding_type_check') then
    alter table public.plan_reading_findings drop constraint plan_reading_findings_finding_type_check;
  end if;
  alter table public.plan_reading_findings add constraint plan_reading_findings_finding_type_check
    check (finding_type in ('measurement','symbol','room','scope_note','risk','question','material','labor'));
end $$;

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

  -- Complimentary removes the checkout, not operational safety. Use the same
  -- 25-readings-per-workspace daily ceiling as the paid reservation path.
  if (
    select count(*) from public.plan_reading_jobs
    where workspace_id = p_workspace_id and created_at > now() - interval '24 hours'
  ) >= 25 then raise exception 'Daily reading limit reached'; end if;

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

create or replace function public.finish_platform_admin_reading(
  p_job_id uuid,
  p_user_id uuid,
  p_summary jsonb,
  p_findings jsonb,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  j public.plan_reading_jobs;
begin
  select * into j from public.plan_reading_jobs where id = p_job_id for update;
  if not found then raise exception 'Reading is not authorized'; end if;
  if j.status <> 'processing'
     or j.requested_by <> p_user_id
     or j.input_summary->>'entitlement' <> 'platform_admin_complimentary' then
    raise exception 'Reading is not authorized';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_user_id and is_platform_admin = true
  ) then raise exception 'Reading is not authorized'; end if;
  if not exists (
    select 1 from public.workspace_members
    where workspace_id = j.workspace_id and user_id = p_user_id and role in ('admin','estimator')
  ) then raise exception 'Reading is not authorized'; end if;

  if p_error is not null then
    update public.plan_reading_jobs
      set status='failed', processing_error=left(p_error,1000), completed_at=now()
      where id=p_job_id returning * into j;
    return to_jsonb(j);
  end if;

  if p_findings is null
    or jsonb_typeof(p_findings) is distinct from 'array'
    or jsonb_array_length(p_findings) is null
    or jsonb_array_length(p_findings) not between 1 and 200
    or coalesce((p_summary->>'synthetic')::boolean,false) then
    raise exception 'Real findings required';
  end if;

  insert into public.plan_reading_findings(
    job_id,workspace_id,project_id,file_id,page_number,finding_type,label,
    value_text,quantity,unit,confidence,geometry,source_excerpt
  )
    select p_job_id,j.workspace_id,j.project_id,j.file_id,
      f.page_number,f.finding_type,f.label,f.value_text,f.quantity,f.unit,
      f.confidence,coalesce(f.geometry,'{}'),f.source_excerpt
    from jsonb_to_recordset(p_findings) as f(
      page_number integer,finding_type text,label text,value_text text,
      quantity numeric,unit text,confidence numeric,geometry jsonb,source_excerpt text
    );

  update public.plan_reading_jobs
    set status='needs_review', output_summary=p_summary, completed_at=now(), processing_error=null
    where id=p_job_id returning * into j;

  return to_jsonb(j) || jsonb_build_object(
    'plan_reading_findings',
    (select jsonb_agg(to_jsonb(f)) from public.plan_reading_findings f where job_id=p_job_id)
  );
end;
$$;

-- Service-role only. Browser/authenticated callers cannot self-assert admin
-- status or manufacture complimentary jobs.
revoke all on function public.reserve_platform_admin_reading(uuid,uuid,uuid,uuid,text,text,text,text[],text) from public, anon, authenticated;
revoke all on function public.finish_platform_admin_reading(uuid,uuid,jsonb,jsonb,text) from public, anon, authenticated;
grant execute on function public.reserve_platform_admin_reading(uuid,uuid,uuid,uuid,text,text,text,text[],text) to service_role;
grant execute on function public.finish_platform_admin_reading(uuid,uuid,jsonb,jsonb,text) to service_role;
