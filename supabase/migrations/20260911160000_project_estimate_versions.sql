-- Immutable, hash-addressed snapshots of the active estimator state. This
-- creates a replay contract while normalized Takeoff V2 tables are integrated
-- into the production UI.
create table public.project_estimate_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  project_id uuid not null,
  revision bigint not null check (revision > 0),
  state jsonb not null check (
    jsonb_typeof(state) = 'object'
    and jsonb_typeof(state -> 'quantities') = 'array'
    and jsonb_typeof(state -> 'estimateItems') = 'array'
    and jsonb_typeof(state -> 'revisions') = 'array'
  ),
  state_sha256 text not null check (state_sha256 ~ '^[0-9a-f]{64}$'),
  calculation_version text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint project_estimate_versions_project_scope_fkey
    foreign key (project_id, workspace_id) references public.projects(id, workspace_id) on delete restrict,
  unique (workspace_id, project_id, revision),
  unique (workspace_id, project_id, state_sha256)
);

create index project_estimate_versions_project_idx
  on public.project_estimate_versions(workspace_id, project_id, revision desc);

alter table public.project_estimate_versions enable row level security;
revoke all on table public.project_estimate_versions from public, anon, authenticated;
grant select on table public.project_estimate_versions to authenticated;
grant all on table public.project_estimate_versions to service_role;

create policy project_estimate_versions_select_member
  on public.project_estimate_versions for select to authenticated
  using (
    private.has_workspace_access(workspace_id)
    and private.has_product_access()
  );

create or replace function public.reject_project_estimate_version_update()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'project estimate versions are immutable' using errcode = '55000';
end;
$$;

revoke all on function public.reject_project_estimate_version_update() from public, anon, authenticated;

create trigger project_estimate_versions_reject_update
before update on public.project_estimate_versions
for each row execute function public.reject_project_estimate_version_update();

create or replace function public.snapshot_project_estimate_state()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  next_revision bigint;
  content_hash text;
begin
  -- Empty/legacy partial app state remains readable but is not represented as a
  -- reproducible estimate. The UI writes all three arrays for active projects.
  if jsonb_typeof(new.app_state -> 'quantities') <> 'array'
     or jsonb_typeof(new.app_state -> 'estimateItems') <> 'array'
     or jsonb_typeof(new.app_state -> 'revisions') <> 'array' then
    return new;
  end if;

  content_hash := encode(digest(convert_to(new.app_state::text, 'UTF8'), 'sha256'), 'hex');
  if exists (
    select 1 from public.project_estimate_versions
    where workspace_id = new.workspace_id and project_id = new.id and state_sha256 = content_hash
  ) then
    return new;
  end if;

  -- INSERT/UPDATE holds the project row lock through transaction completion,
  -- serializing revision allocation for concurrent saves of the same project.
  select coalesce(max(revision), 0) + 1 into next_revision
  from public.project_estimate_versions
  where workspace_id = new.workspace_id and project_id = new.id;

  insert into public.project_estimate_versions (
    workspace_id, project_id, revision, state, state_sha256,
    calculation_version, created_by
  ) values (
    new.workspace_id, new.id, next_revision, new.app_state, content_hash,
    'calculation-v1-fixed-6dp', coalesce(auth.uid(), new.created_by)
  );
  return new;
end;
$$;

revoke all on function public.snapshot_project_estimate_state() from public, anon, authenticated;

create trigger snapshot_project_estimate_state_after_write
after insert or update of app_state on public.projects
for each row execute function public.snapshot_project_estimate_state();

comment on table public.project_estimate_versions is
  'Immutable estimator-state revisions for deterministic replay and cross-user comparison. Project/workspace deletion is intentionally restricted once history exists; retention-approved removal requires a separately reviewed migration.';
