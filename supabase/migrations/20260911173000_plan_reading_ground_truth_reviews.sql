-- Human review is the bridge between RB.AI predictions and measurable ground truth.
-- This ledger is intentionally QA/evaluation-only. Recording a review does not
-- grant model-training rights for a customer's drawings or derived data.
create table public.plan_reading_finding_reviews (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.plan_reading_findings(id) on delete cascade,
  job_id uuid not null references public.plan_reading_jobs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  file_id uuid not null references public.project_files(id) on delete cascade,
  reviewed_by uuid not null references auth.users(id) on delete restrict,
  action text not null check (action in ('accepted', 'rejected', 'corrected')),
  original_prediction jsonb not null check (jsonb_typeof(original_prediction) = 'object'),
  canonical_target jsonb check (canonical_target is null or jsonb_typeof(canonical_target) = 'object'),
  model text not null check (char_length(btrim(model)) between 1 and 200),
  training_eligible boolean not null default false check (training_eligible = false),
  created_at timestamptz not null default now(),
  check (
    (action = 'rejected' and canonical_target is null)
    or (action in ('accepted', 'corrected') and canonical_target is not null)
  )
);

create index plan_reading_finding_reviews_finding_idx
  on public.plan_reading_finding_reviews(finding_id, created_at desc);
create index plan_reading_finding_reviews_workspace_idx
  on public.plan_reading_finding_reviews(workspace_id, created_at desc);
create index plan_reading_finding_reviews_job_idx
  on public.plan_reading_finding_reviews(job_id, created_at desc);

alter table public.plan_reading_finding_reviews enable row level security;
revoke all on table public.plan_reading_finding_reviews from public, anon, authenticated;
grant select on table public.plan_reading_finding_reviews to authenticated;
grant all on table public.plan_reading_finding_reviews to service_role;

create policy plan_reading_finding_reviews_select_workspace
  on public.plan_reading_finding_reviews for select to authenticated
  using (private.has_workspace_access(workspace_id) and private.has_product_access());

create or replace function public.review_plan_reading_finding(
  p_finding_id uuid,
  p_action text,
  p_correction jsonb default null
)
returns setof public.plan_reading_finding_reviews
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  target_finding public.plan_reading_findings%rowtype;
  target_workspace uuid;
  target_model text;
  original_prediction jsonb;
  base_target jsonb;
  canonical_target jsonb;
  review_id uuid;
  normalized_correction jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_action not in ('accepted', 'rejected', 'corrected') then
    raise exception 'action must be accepted, rejected, or corrected' using errcode = '22023';
  end if;

  select f.*
    into target_finding
  from public.plan_reading_findings f
  where f.id = p_finding_id
  for update;

  if not found then
    raise exception 'finding not found' using errcode = 'P0002';
  end if;
  target_workspace := target_finding.workspace_id;

  if not private.has_workspace_role(target_workspace, array['admin', 'estimator']) then
    raise exception 'insufficient workspace role to review plan reading findings' using errcode = '42501';
  end if;
  if not private.has_product_access() then
    raise exception 'an active RoughBid entitlement is required' using errcode = '42501';
  end if;

  select j.model
    into target_model
  from public.plan_reading_jobs j
  where j.id = target_finding.job_id;

  if target_model is null or btrim(target_model) = '' then
    raise exception 'plan reading job model provenance is missing' using errcode = '22023';
  end if;

  original_prediction := jsonb_build_object(
    'finding_type', target_finding.finding_type,
    'label', target_finding.label,
    'value_text', target_finding.value_text,
    'quantity', target_finding.quantity,
    'unit', target_finding.unit,
    'geometry', target_finding.geometry,
    'confidence', target_finding.confidence,
    'page_number', target_finding.page_number,
    'source_excerpt', target_finding.source_excerpt
  );
  base_target := jsonb_build_object(
    'finding_type', target_finding.finding_type,
    'label', target_finding.label,
    'value_text', target_finding.value_text,
    'quantity', target_finding.quantity,
    'unit', target_finding.unit,
    'geometry', target_finding.geometry
  );

  if p_action = 'corrected' then
    if coalesce(jsonb_typeof(p_correction), '') <> 'object' or p_correction = '{}'::jsonb then
      raise exception 'corrected review requires at least one correction field' using errcode = '22023';
    end if;
    if exists (
      select 1
      from jsonb_object_keys(p_correction) as key_name
      where not (key_name = any(array['finding_type','label','value_text','quantity','unit','geometry']))
    ) then
      raise exception 'correction contains unsupported fields' using errcode = '22023';
    end if;

    if p_correction ? 'finding_type' and (
      coalesce(jsonb_typeof(p_correction -> 'finding_type'), '') <> 'string'
      or coalesce(p_correction ->> 'finding_type', '') not in ('measurement', 'symbol', 'room', 'scope_note', 'risk', 'question', 'material')
    ) then
      raise exception 'finding_type must be a supported value' using errcode = '22023';
    end if;
    if p_correction ? 'label' and (
      coalesce(jsonb_typeof(p_correction -> 'label'), '') <> 'string'
      or char_length(btrim(coalesce(p_correction ->> 'label', ''))) not between 1 and 160
    ) then
      raise exception 'label must be a non-empty string up to 160 characters' using errcode = '22023';
    end if;
    if p_correction ? 'value_text'
      and p_correction -> 'value_text' <> 'null'::jsonb
      and coalesce(jsonb_typeof(p_correction -> 'value_text'), '') <> 'string' then
      raise exception 'value_text must be a string or null' using errcode = '22023';
    end if;
    if p_correction ? 'quantity'
      and p_correction -> 'quantity' <> 'null'::jsonb
      and coalesce(jsonb_typeof(p_correction -> 'quantity'), '') <> 'number' then
      raise exception 'quantity must be numeric or null' using errcode = '22023';
    end if;
    if p_correction ? 'quantity'
      and p_correction -> 'quantity' <> 'null'::jsonb
      and (p_correction ->> 'quantity')::numeric < 0 then
      raise exception 'quantity must be non-negative' using errcode = '22023';
    end if;
    if p_correction ? 'unit' and (
      p_correction -> 'unit' <> 'null'::jsonb
      and (
        coalesce(jsonb_typeof(p_correction -> 'unit'), '') <> 'string'
        or char_length(coalesce(p_correction ->> 'unit', '')) > 40
      )
    ) then
      raise exception 'unit must be a string up to 40 characters or null' using errcode = '22023';
    end if;
    if p_correction ? 'geometry'
      and coalesce(jsonb_typeof(p_correction -> 'geometry'), '') <> 'object' then
      raise exception 'geometry must be an object' using errcode = '22023';
    end if;

    normalized_correction := p_correction;
    canonical_target := base_target || normalized_correction;
  elsif p_action = 'accepted' then
    if p_correction is not null and p_correction <> 'null'::jsonb then
      raise exception 'accepted review must not include a correction' using errcode = '22023';
    end if;
    canonical_target := base_target;
  else
    if p_correction is not null and p_correction <> 'null'::jsonb then
      raise exception 'rejected review must not include a correction' using errcode = '22023';
    end if;
    canonical_target := null;
  end if;

  insert into public.plan_reading_finding_reviews (
    finding_id,
    job_id,
    workspace_id,
    project_id,
    file_id,
    reviewed_by,
    action,
    original_prediction,
    canonical_target,
    model,
    training_eligible
  ) values (
    target_finding.id,
    target_finding.job_id,
    target_finding.workspace_id,
    target_finding.project_id,
    target_finding.file_id,
    auth.uid(),
    p_action,
    original_prediction,
    canonical_target,
    target_model,
    false
  ) returning id into review_id;

  update public.plan_reading_findings
  set status = case
    when p_action = 'rejected' then 'rejected'
    else 'accepted'
  end
  where id = target_finding.id;

  return query
    select r.*
    from public.plan_reading_finding_reviews r
    where r.id = review_id;
end;
$$;

revoke all on function public.review_plan_reading_finding(uuid, text, jsonb) from public, anon;
grant execute on function public.review_plan_reading_finding(uuid, text, jsonb) to authenticated;

comment on table public.plan_reading_finding_reviews is
  'Immutable-by-application human review ledger for RB.AI QA and evaluation. A review records model output and canonical corrections but does not grant model-training rights; training_eligible remains false until a separately reviewed rights/consent policy exists.';

-- Preserve the existing application contract while making every accepted or
-- rejected finding produce an immutable review event. Returning a finding to
-- needs_review is workflow state only and is not itself a ground-truth label.
create or replace function public.set_plan_reading_finding_status(finding_id uuid, new_status text)
returns setof public.plan_reading_findings
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  target_workspace uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if new_status not in ('needs_review', 'accepted', 'rejected') then
    raise exception 'new_status must be needs_review, accepted, or rejected' using errcode = '22023';
  end if;

  if new_status in ('accepted', 'rejected') then
    perform public.review_plan_reading_finding(finding_id, new_status, null);
    return query
      select f.* from public.plan_reading_findings f where f.id = finding_id;
    return;
  end if;

  select workspace_id into target_workspace
  from public.plan_reading_findings
  where id = finding_id
  for update;

  if target_workspace is null then
    raise exception 'finding not found' using errcode = 'P0002';
  end if;
  if not private.has_workspace_role(target_workspace, array['admin', 'estimator']) then
    raise exception 'insufficient workspace role to review plan reading findings' using errcode = '42501';
  end if;
  if not private.has_product_access() then
    raise exception 'an active RoughBid entitlement is required' using errcode = '42501';
  end if;

  return query
    update public.plan_reading_findings
    set status = 'needs_review'
    where id = finding_id
    returning *;
end;
$$;

revoke all on function public.set_plan_reading_finding_status(uuid, text) from public, anon;
grant execute on function public.set_plan_reading_finding_status(uuid, text) to authenticated;
