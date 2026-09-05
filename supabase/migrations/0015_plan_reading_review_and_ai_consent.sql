-- Two things needed to turn AI plan-reading findings into real, human-approved
-- estimate data:
--
-- 1. A workspace must explicitly accept AI data processing before any plan of
--    theirs can be sent to a model (docs/architecture/ai-plan-reading-pipeline.md
--    already documented this rule; nothing enforced it).
-- 2. An estimator needs a safe way to accept or reject a finding. Findings are
--    written by the worker's service-role connection; authenticated users have
--    no direct table privilege (see 0007's `revoke insert, update, delete ...
--    from authenticated, anon`), so review has to go through a narrow RPC that
--    only ever changes `status`, the same way public.sign_client_proposal only
--    ever changes a proposal's signature fields.

alter table public.workspaces
  add column ai_processing_consented_at timestamptz;

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
