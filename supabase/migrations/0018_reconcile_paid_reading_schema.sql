-- Forward-only repair for environments where 0017 paid_project_readings was
-- applied without the 0014 labor-finding and 0015 AI-consent semantics.
--
-- This migration is intentionally idempotent so it can be reviewed/applied
-- safely whether the earlier migrations were applied or skipped.

alter table public.workspaces
  add column if not exists ai_processing_consented_at timestamptz;

alter table public.plan_reading_findings
  drop constraint if exists plan_reading_findings_finding_type_check;

alter table public.plan_reading_findings
  add constraint plan_reading_findings_finding_type_check
  check (finding_type in (
    'measurement',
    'symbol',
    'room',
    'scope_note',
    'risk',
    'question',
    'material',
    'labor'
  ));

create or replace function public.set_plan_reading_finding_status(finding_id uuid, new_status text)
returns setof public.plan_reading_findings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_workspace uuid;
begin
  if new_status not in ('needs_review', 'accepted', 'rejected') then
    raise exception 'new_status must be needs_review, accepted, or rejected';
  end if;

  select workspace_id into target_workspace
  from public.plan_reading_findings
  where id = finding_id;

  if target_workspace is null then
    raise exception 'Finding not found';
  end if;
  if not private.has_workspace_role(target_workspace, array['admin', 'estimator']) then
    raise exception 'Insufficient workspace role to review plan reading findings';
  end if;
  if not private.has_product_access() then
    raise exception 'An active RoughBid entitlement is required';
  end if;

  -- Preserve 0017's historical-output guard when repairing the review RPC.
  -- Authorize the workspace first so another tenant cannot probe job metadata.
  if exists (
    select 1
    from public.plan_reading_findings f
    join public.plan_reading_jobs j on j.id = f.job_id
    where f.id = finding_id and j.output_summary ->> 'synthetic' = 'true'
  ) then
    raise exception 'Simulated findings cannot be accepted. Request a real plan reading';
  end if;

  return query
    update public.plan_reading_findings
    set status = new_status
    where id = finding_id
    returning *;
end;
$$;

revoke all on function public.set_plan_reading_finding_status(uuid, text) from public, anon;
grant execute on function public.set_plan_reading_finding_status(uuid, text) to authenticated;

-- Reconcile 0017's completion gate too: SQL NULL must not turn a paid quote
-- into a completed reading without persisted findings (three-valued SQL logic).
create or replace function public.finish_project_reading(p_quote_id uuid, p_job_id uuid,
  p_summary jsonb, p_findings jsonb, p_error text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.project_reading_quotes; j public.plan_reading_jobs;
begin
  select * into q from public.project_reading_quotes where id=p_quote_id and job_id=p_job_id for update;
  if not found or q.status <> 'processing' or q.paid_at is null then raise exception 'Reading is not authorized'; end if;
  if p_error is not null then
    update public.plan_reading_jobs set status='failed',processing_error=left(p_error,1000),completed_at=now()
      where id=p_job_id returning * into j;
    update public.project_reading_quotes set status='failed' where id=q.id;
    return to_jsonb(j);
  end if;
  if jsonb_typeof(p_findings) is distinct from 'array' then
    raise exception 'Real findings required';
  end if;
  if coalesce((p_summary->>'synthetic')::boolean,false)
    or jsonb_array_length(p_findings) not between 1 and 200 then
    raise exception 'Real findings required';
  end if;
  insert into public.plan_reading_findings(job_id,workspace_id,project_id,file_id,page_number,finding_type,label,value_text,quantity,unit,confidence,geometry,source_excerpt)
    select p_job_id,q.workspace_id,q.project_id,q.file_id,f.page_number,f.finding_type,f.label,f.value_text,f.quantity,f.unit,f.confidence,coalesce(f.geometry,'{}'),f.source_excerpt
    from jsonb_to_recordset(p_findings) as f(page_number integer,finding_type text,label text,value_text text,quantity numeric,unit text,confidence numeric,geometry jsonb,source_excerpt text);
  update public.plan_reading_jobs set status='needs_review',output_summary=p_summary,completed_at=now(),processing_error=null
    where id=p_job_id returning * into j;
  update public.project_reading_quotes set status='complete' where id=q.id;
  return to_jsonb(j) || jsonb_build_object('plan_reading_findings',
    (select jsonb_agg(to_jsonb(f)) from public.plan_reading_findings f where job_id=p_job_id));
end $$;

revoke all on function public.finish_project_reading(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.finish_project_reading(uuid,uuid,jsonb,jsonb,text) to service_role;
