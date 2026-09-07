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

  return query
    update public.plan_reading_findings
    set status = new_status
    where id = finding_id
    returning *;
end;
$$;

revoke all on function public.set_plan_reading_finding_status(uuid, text) from public, anon;
grant execute on function public.set_plan_reading_finding_status(uuid, text) to authenticated;
