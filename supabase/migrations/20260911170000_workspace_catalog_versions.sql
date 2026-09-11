-- Workspace-owned estimating inputs replace device-only catalogs. Every save
-- is immutable and content-addressed so a project revision can be replayed
-- against an exact material/assembly dataset.
create table public.workspace_catalog_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  revision bigint not null check (revision > 0),
  materials jsonb not null check (jsonb_typeof(materials) = 'array' and jsonb_array_length(materials) <= 2000),
  assemblies jsonb not null check (jsonb_typeof(assemblies) = 'array' and jsonb_array_length(assemblies) <= 1000),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (workspace_id, revision),
  unique (workspace_id, content_sha256)
);

create index workspace_catalog_versions_latest_idx
  on public.workspace_catalog_versions(workspace_id, revision desc);

alter table public.workspace_catalog_versions enable row level security;
revoke all on table public.workspace_catalog_versions from public, anon, authenticated;
grant select on table public.workspace_catalog_versions to authenticated;
grant all on table public.workspace_catalog_versions to service_role;

create policy workspace_catalog_versions_select_member
  on public.workspace_catalog_versions for select to authenticated
  using (private.has_workspace_access(workspace_id) and private.has_product_access());

create or replace function public.reject_workspace_catalog_version_update()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'workspace catalog versions are immutable' using errcode = '55000';
end;
$$;

revoke all on function public.reject_workspace_catalog_version_update() from public, anon, authenticated;

create trigger workspace_catalog_versions_reject_update
before update on public.workspace_catalog_versions
for each row execute function public.reject_workspace_catalog_version_update();

create or replace function public.save_workspace_catalog_version(
  p_workspace_id uuid,
  p_materials jsonb,
  p_assemblies jsonb,
  p_expected_revision bigint
)
returns setof public.workspace_catalog_versions
language plpgsql
security definer
set search_path = public, private, extensions, pg_temp
as $$
declare
  current_revision bigint;
  content_hash text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.has_workspace_role(p_workspace_id, array['admin','estimator'])
     or not private.has_product_access() then
    raise exception 'catalog write is not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_materials) <> 'array' or jsonb_array_length(p_materials) > 2000
     or jsonb_typeof(p_assemblies) <> 'array' or jsonb_array_length(p_assemblies) > 1000 then
    raise exception 'invalid catalog arrays' using errcode = '22023';
  end if;
  if octet_length(jsonb_build_object('materials', p_materials, 'assemblies', p_assemblies)::text) > 2000000 then
    raise exception 'catalog payload is too large' using errcode = '54000';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_materials) item
    where jsonb_typeof(item) <> 'object'
      or jsonb_typeof(item -> 'id') <> 'string'
      or jsonb_typeof(item -> 'name') <> 'string'
      or jsonb_typeof(item -> 'category') <> 'string'
      or item ->> 'unit' not in ('SF','LF','EA','CY','SY','HR','LS')
      or (jsonb_typeof(item -> 'unitCost') <> 'number' and jsonb_typeof(item -> 'unitPrice') <> 'number')
      or coalesce((item ->> 'unitCost')::numeric, 0) < 0
      or coalesce((item ->> 'unitPrice')::numeric, 0) < 0
  ) or exists (
    select 1 from jsonb_array_elements(p_materials) item group by item ->> 'id' having count(*) > 1
  ) then
    raise exception 'invalid material catalog item' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_assemblies) item
    where jsonb_typeof(item) <> 'object'
      or jsonb_typeof(item -> 'id') <> 'string'
      or jsonb_typeof(item -> 'name') <> 'string'
      or jsonb_typeof(item -> 'category') <> 'string'
      or jsonb_typeof(item -> 'description') <> 'string'
      or item ->> 'unit' not in ('SF','LF','EA','CY','SY','HR','LS')
      or jsonb_typeof(item -> 'materialCostPerUnit') <> 'number'
      or jsonb_typeof(item -> 'laborCostPerUnit') <> 'number'
      or jsonb_typeof(item -> 'equipmentCostPerUnit') <> 'number'
      or (item ->> 'materialCostPerUnit')::numeric < 0
      or (item ->> 'laborCostPerUnit')::numeric < 0
      or (item ->> 'equipmentCostPerUnit')::numeric < 0
  ) or exists (
    select 1 from jsonb_array_elements(p_assemblies) item group by item ->> 'id' having count(*) > 1
  ) then
    raise exception 'invalid assembly catalog item' using errcode = '22023';
  end if;

  -- Lock the parent, making revision allocation and optimistic concurrency
  -- deterministic for simultaneous saves in one workspace.
  perform 1 from public.workspaces where id = p_workspace_id for update;
  select coalesce(max(revision), 0) into current_revision
  from public.workspace_catalog_versions where workspace_id = p_workspace_id;
  if p_expected_revision is null or p_expected_revision <> current_revision then
    raise exception 'catalog revision conflict: expected %, current %', p_expected_revision, current_revision using errcode = '40001';
  end if;

  content_hash := encode(digest(convert_to(jsonb_build_object(
    'materials', p_materials, 'assemblies', p_assemblies
  )::text, 'UTF8'), 'sha256'), 'hex');

  return query
    select v.* from public.workspace_catalog_versions v
    where v.workspace_id = p_workspace_id and v.content_sha256 = content_hash;
  if found then return; end if;

  return query
    insert into public.workspace_catalog_versions (
      workspace_id, revision, materials, assemblies, content_sha256, created_by
    ) values (
      p_workspace_id, current_revision + 1, p_materials, p_assemblies, content_hash, auth.uid()
    ) returning *;
end;
$$;

revoke all on function public.save_workspace_catalog_version(uuid, jsonb, jsonb, bigint) from public, anon;
grant execute on function public.save_workspace_catalog_version(uuid, jsonb, jsonb, bigint) to authenticated;

comment on table public.workspace_catalog_versions is
  'Immutable workspace material and assembly catalogs used for reproducible estimates.';
