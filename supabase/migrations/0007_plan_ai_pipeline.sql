create table public.plan_reading_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  file_id uuid not null references public.project_files(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete restrict,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'needs_review', 'ready', 'failed')),
  mode text not null default 'quick' check (mode in ('quick', 'detailed')),
  model text not null,
  confidence numeric(5, 4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  input_summary jsonb not null default '{}'::jsonb,
  output_summary jsonb not null default '{}'::jsonb,
  processing_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index plan_reading_jobs_workspace_idx
  on public.plan_reading_jobs(workspace_id, created_at desc);
create index plan_reading_jobs_project_idx
  on public.plan_reading_jobs(project_id, created_at desc);
create index plan_reading_jobs_file_idx
  on public.plan_reading_jobs(file_id, created_at desc);

create table public.plan_reading_findings (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.plan_reading_jobs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  file_id uuid not null references public.project_files(id) on delete cascade,
  page_number integer check (page_number is null or page_number > 0),
  finding_type text not null
    check (finding_type in ('measurement', 'symbol', 'room', 'scope_note', 'risk', 'question', 'material')),
  label text not null check (char_length(label) between 1 and 160),
  value_text text,
  quantity numeric(14, 4),
  unit text check (unit is null or char_length(unit) <= 40),
  confidence numeric(5, 4) not null check (confidence >= 0 and confidence <= 1),
  geometry jsonb not null default '{}'::jsonb,
  source_excerpt text,
  status text not null default 'needs_review'
    check (status in ('needs_review', 'accepted', 'rejected')),
  created_at timestamptz not null default now()
);

create index plan_reading_findings_job_idx
  on public.plan_reading_findings(job_id, finding_type, confidence desc);

alter table public.plan_reading_jobs enable row level security;
alter table public.plan_reading_findings enable row level security;

create policy plan_reading_jobs_select_workspace on public.plan_reading_jobs
  for select to authenticated
  using (private.has_workspace_access(workspace_id) and private.has_product_access());

create policy plan_reading_jobs_insert_workspace on public.plan_reading_jobs
  for insert to authenticated
  with check (
    requested_by = auth.uid()
    and private.has_workspace_role(workspace_id, array['admin', 'estimator'])
    and private.has_product_access()
  );

create policy plan_reading_jobs_update_workspace on public.plan_reading_jobs
  for update to authenticated
  using (private.has_workspace_role(workspace_id, array['admin', 'estimator']) and private.has_product_access())
  with check (private.has_workspace_role(workspace_id, array['admin', 'estimator']) and private.has_product_access());

create policy plan_reading_findings_select_workspace on public.plan_reading_findings
  for select to authenticated
  using (private.has_workspace_access(workspace_id) and private.has_product_access());

revoke insert, update, delete on public.plan_reading_findings from authenticated, anon;
