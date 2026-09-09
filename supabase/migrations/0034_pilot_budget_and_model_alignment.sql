-- Align the controlled pilot with the approved KSP operating envelope:
-- * aggregate founding cohort API reserve ceiling: $100 / 60 days
-- * provider model: Gemini 3.8 Flash, already verified in RoughBid production
--
-- The reservation remains deliberately conservative at $0.25 per analysis.
-- This migration is fail-closed: it refuses to lower a cohort below money that
-- has already been reserved.

do $$
begin
  if exists (
    select 1
    from public.pilot_cohorts
    where reserved_cents > 10000
  ) then
    raise exception 'Cannot lower pilot budget: existing reservations exceed the approved $100 ceiling';
  end if;
end;
$$;

update public.pilot_cohorts
set budget_cents = 10000
where budget_cents > 10000;

alter table public.pilot_cohorts
  alter column budget_cents set default 10000;

alter table public.pilot_cohorts
  drop constraint if exists pilot_cohorts_budget_cents_check;

alter table public.pilot_cohorts
  add constraint pilot_cohorts_budget_cents_check
  check (budget_cents between 0 and 10000);

create or replace function public.reserve_pilot_reading(
  p_user_id uuid,
  p_workspace_id uuid,
  p_project_id uuid,
  p_file_id uuid,
  p_model text,
  p_file_sha256 text,
  p_request_fingerprint text,
  p_requested_trades text[],
  p_scope text,
  p_page_count integer,
  p_byte_size bigint
)
returns jsonb
language plpgsql
security definer
set search_path=public,private,pg_temp
as $$
declare
  e public.pilot_enrollments;
  c public.pilot_cohorts;
  r public.pilot_reading_reservations;
  j public.plan_reading_jobs;
begin
  if p_file_sha256 is null or p_file_sha256 !~ '^[a-f0-9]{64}$'
     or p_request_fingerprint is null or p_request_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid plan request identity';
  end if;

  -- One production-verified model only. A fallback cannot spend outside the
  -- reservation because the application makes exactly one provider attempt.
  if p_model is distinct from 'gemini-3.8-flash' then
    raise exception 'Pilot model is not authorized';
  end if;

  if p_page_count is null or p_page_count not between 1 and 10
     or p_byte_size is null or p_byte_size not between 1 and 10485760 then
    raise exception 'Pilot PDF must have at most 10 pages and 10 MiB';
  end if;

  if p_requested_trades is null or cardinality(p_requested_trades) not between 1 and 7
     or char_length(coalesce(p_scope,'')) > 500 then
    raise exception 'Invalid reading scope';
  end if;

  select * into e
  from public.pilot_enrollments
  where user_id=p_user_id;
  if not found then raise exception 'Active pilot enrollment required'; end if;

  select * into c
  from public.pilot_cohorts
  where id=e.cohort_id
  for update;

  select * into e
  from public.pilot_enrollments
  where user_id=p_user_id
  for update;

  if not c.enabled or e.revoked_at is not null or e.starts_at>now() or e.expires_at<=now() then
    raise exception 'Active pilot enrollment required';
  end if;

  if e.workspace_id<>p_workspace_id
     or not exists(
       select 1 from public.workspace_members
       where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator')
     ) then
    raise exception 'Pilot workspace access denied';
  end if;

  if not exists(
    select 1 from public.workspaces
    where id=p_workspace_id and ai_processing_consented_at is not null
  ) then
    raise exception 'AI processing consent required';
  end if;

  if not exists(
    select 1 from public.projects
    where id=p_project_id and workspace_id=p_workspace_id and created_by=p_user_id
  ) then
    raise exception 'Pilot project not found';
  end if;

  if not exists(
    select 1 from public.pilot_project_creations
    where project_id=p_project_id and user_id=p_user_id
  ) then
    raise exception 'Project was not created under this pilot';
  end if;

  if not exists(
    select 1 from public.project_files
    where id=p_file_id and workspace_id=p_workspace_id and project_id=p_project_id
      and processing_status not in ('uploading','failed')
  ) then
    raise exception 'File unavailable';
  end if;

  if not exists(
    select 1 from public.pilot_file_creations
    where project_id=p_project_id and file_id=p_file_id and user_id=p_user_id
  ) then
    raise exception 'File was not created under this pilot';
  end if;

  select * into r
  from public.pilot_reading_reservations
  where project_id=p_project_id;

  if found then
    select * into j from public.plan_reading_jobs where id=r.job_id;
    if r.user_id=p_user_id
       and r.file_id=p_file_id
       and r.request_fingerprint=p_request_fingerprint
       and j.status in ('processing','needs_review','ready') then
      return jsonb_build_object('reused',true,'job',to_jsonb(j));
    end if;
    raise exception 'Pilot allows one AI attempt per project; failed attempts remain counted';
  end if;

  if e.reserved_cents+25>500 or c.reserved_cents+25>c.budget_cents then
    raise exception 'Pilot API budget exhausted';
  end if;

  insert into public.plan_reading_jobs(
    workspace_id,project_id,file_id,requested_by,status,mode,model,started_at,input_summary
  ) values (
    p_workspace_id,p_project_id,p_file_id,p_user_id,'processing','quick',p_model,now(),
    jsonb_build_object(
      'entitlement','limited_pilot',
      'billed',false,
      'reserved_cents',25,
      'file_sha256',p_file_sha256,
      'request_fingerprint',p_request_fingerprint,
      'requested_trades',to_jsonb(p_requested_trades),
      'requested_scope',coalesce(p_scope,''),
      'page_count',p_page_count,
      'byte_size',p_byte_size,
      'human_review_required',true
    )
  ) returning * into j;

  insert into public.pilot_reading_reservations(
    project_id,user_id,cohort_id,job_id,file_id,request_fingerprint
  ) values (
    p_project_id,p_user_id,c.id,j.id,p_file_id,p_request_fingerprint
  );

  update public.pilot_enrollments
  set reserved_cents=reserved_cents+25
  where user_id=p_user_id;

  update public.pilot_cohorts
  set reserved_cents=reserved_cents+25
  where id=c.id;

  return jsonb_build_object('reused',false,'job',to_jsonb(j));
end;
$$;

revoke all on function public.reserve_pilot_reading(uuid,uuid,uuid,uuid,text,text,text,text[],text,integer,bigint)
  from public,anon,authenticated;
grant execute on function public.reserve_pilot_reading(uuid,uuid,uuid,uuid,text,text,text,text[],text,integer,bigint)
  to service_role;

-- add_workspace_owner_membership is a trigger function, not an API surface.
-- Trigger execution does not require direct RPC EXECUTE privileges, so remove
-- inherited public grants and leave it unavailable to anon/authenticated roles.
revoke execute on function public.add_workspace_owner_membership()
  from public,anon,authenticated;
