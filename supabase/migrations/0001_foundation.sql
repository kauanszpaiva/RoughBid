create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  is_platform_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('class_pass', 'subscription', 'admin')),
  source text not null,
  external_ref text,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint entitlement_expiry_after_start check (expires_at is null or expires_at > starts_at),
  constraint class_pass_is_exactly_60_days check (
    kind <> 'class_pass' or expires_at = starts_at + interval '60 days'
  )
);

create index entitlements_user_window_idx
  on public.entitlements(user_id, starts_at, expires_at)
  where revoked_at is null;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 160),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  project_number text,
  address_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index projects_workspace_idx on public.projects(workspace_id, updated_at desc);

create table public.project_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  storage_path text not null unique,
  original_name text not null,
  mime_type text not null default 'application/pdf' check (mime_type = 'application/pdf'),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 52428800),
  created_at timestamptz not null default now()
);

create index project_files_project_idx on public.project_files(project_id, created_at desc);

create table public.estimates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  version integer not null default 1 check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'final')),
  material_cost numeric(14,2) not null default 0 check (material_cost >= 0),
  labor_cost numeric(14,2) not null default 0 check (labor_cost >= 0),
  equipment_cost numeric(14,2) not null default 0 check (equipment_cost >= 0),
  other_cost numeric(14,2) not null default 0 check (other_cost >= 0),
  overhead_percent numeric(7,3) not null default 0 check (overhead_percent >= 0),
  markup_percent numeric(7,3) not null default 0 check (markup_percent >= 0),
  direct_cost numeric(14,2) not null default 0 check (direct_cost >= 0),
  overhead_amount numeric(14,2) not null default 0 check (overhead_amount >= 0),
  final_price numeric(14,2) not null default 0 check (final_price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, version)
);

create index estimates_project_idx on public.estimates(project_id, version desc);

create table public.billing_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  stripe_price_id text,
  subscription_status text check (
    subscription_status is null or subscription_status in (
      'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due',
      'canceled', 'unpaid', 'paused'
    )
  ),
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create table public.stripe_events (
  event_id text primary key,
  event_type text not null,
  livemode boolean not null,
  processed_at timestamptz not null default now()
);

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created_roughbid
  after insert on auth.users
  for each row execute function public.handle_new_user_profile();

create or replace function public.add_workspace_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.created_by, 'owner');
  return new;
end;
$$;

create trigger on_workspace_created_add_owner
  after insert on public.workspaces
  for each row execute function public.add_workspace_owner_membership();

create or replace function public.has_workspace_access(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_owner(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id = auth.uid()
      and wm.role = 'owner'
  );
$$;

create or replace function public.has_product_access()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_platform_admin = true
    )
    or exists (
      select 1
      from public.entitlements e
      where e.user_id = auth.uid()
        and e.revoked_at is null
        and e.starts_at <= now()
        and (e.expires_at is null or e.expires_at > now())
        and e.kind in ('class_pass', 'subscription', 'admin')
    );
$$;

create or replace function public.can_access_plan_object(object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  workspace_segment text;
  workspace_uuid uuid;
begin
  workspace_segment := split_part(object_name, '/', 1);
  if workspace_segment !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  workspace_uuid := workspace_segment::uuid;
  return public.has_workspace_access(workspace_uuid) and public.has_product_access();
end;
$$;

revoke all on function public.has_workspace_access(uuid) from public;
revoke all on function public.is_workspace_owner(uuid) from public;
revoke all on function public.has_product_access() from public;
revoke all on function public.can_access_plan_object(text) from public;
grant execute on function public.has_workspace_access(uuid) to authenticated;
grant execute on function public.is_workspace_owner(uuid) to authenticated;
grant execute on function public.has_product_access() to authenticated;
grant execute on function public.can_access_plan_object(text) to authenticated;

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.entitlements enable row level security;
alter table public.projects enable row level security;
alter table public.project_files enable row level security;
alter table public.estimates enable row level security;
alter table public.billing_customers enable row level security;
alter table public.stripe_events enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid());
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy workspaces_select_member on public.workspaces
  for select to authenticated
  using (public.has_workspace_access(id));
create policy workspaces_insert_self on public.workspaces
  for insert to authenticated
  with check (created_by = auth.uid());
create policy workspaces_update_owner on public.workspaces
  for update to authenticated
  using (public.is_workspace_owner(id))
  with check (public.is_workspace_owner(id));
create policy workspaces_delete_owner on public.workspaces
  for delete to authenticated
  using (public.is_workspace_owner(id));

create policy workspace_members_select_member on public.workspace_members
  for select to authenticated
  using (public.has_workspace_access(workspace_id));
create policy workspace_members_insert_owner on public.workspace_members
  for insert to authenticated
  with check (public.is_workspace_owner(workspace_id));
create policy workspace_members_update_owner on public.workspace_members
  for update to authenticated
  using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));
create policy workspace_members_delete_owner on public.workspace_members
  for delete to authenticated
  using (public.is_workspace_owner(workspace_id));

create policy entitlements_select_own on public.entitlements
  for select to authenticated
  using (user_id = auth.uid());

create policy projects_select_access on public.projects
  for select to authenticated
  using (public.has_workspace_access(workspace_id) and public.has_product_access());
create policy projects_insert_access on public.projects
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.has_workspace_access(workspace_id)
    and public.has_product_access()
  );
create policy projects_update_access on public.projects
  for update to authenticated
  using (public.has_workspace_access(workspace_id) and public.has_product_access())
  with check (public.has_workspace_access(workspace_id) and public.has_product_access());
create policy projects_delete_access on public.projects
  for delete to authenticated
  using (public.has_workspace_access(workspace_id) and public.has_product_access());

create policy project_files_select_access on public.project_files
  for select to authenticated
  using (public.has_workspace_access(workspace_id) and public.has_product_access());
create policy project_files_insert_access on public.project_files
  for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and public.has_workspace_access(workspace_id)
    and public.has_product_access()
  );
create policy project_files_delete_access on public.project_files
  for delete to authenticated
  using (public.has_workspace_access(workspace_id) and public.has_product_access());

create policy estimates_select_access on public.estimates
  for select to authenticated
  using (public.has_workspace_access(workspace_id) and public.has_product_access());
create policy estimates_insert_access on public.estimates
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.has_workspace_access(workspace_id)
    and public.has_product_access()
  );
create policy estimates_update_access on public.estimates
  for update to authenticated
  using (public.has_workspace_access(workspace_id) and public.has_product_access())
  with check (public.has_workspace_access(workspace_id) and public.has_product_access());
create policy estimates_delete_access on public.estimates
  for delete to authenticated
  using (public.has_workspace_access(workspace_id) and public.has_product_access());

create policy billing_customers_select_own on public.billing_customers
  for select to authenticated
  using (user_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('plan-files', 'plan-files', false, 52428800, array['application/pdf'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy plan_files_storage_select on storage.objects
  for select to authenticated
  using (bucket_id = 'plan-files' and public.can_access_plan_object(name));
create policy plan_files_storage_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'plan-files' and public.can_access_plan_object(name));
create policy plan_files_storage_update on storage.objects
  for update to authenticated
  using (bucket_id = 'plan-files' and public.can_access_plan_object(name))
  with check (bucket_id = 'plan-files' and public.can_access_plan_object(name));
create policy plan_files_storage_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'plan-files' and public.can_access_plan_object(name));
