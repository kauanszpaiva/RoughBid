-- Authentication is provided by Supabase Auth. Magic-link and configured OAuth/SAML
-- identities all resolve to auth.users; authorization remains database-enforced.

alter table public.workspace_members drop constraint workspace_members_role_check;
update public.workspace_members set role = case role when 'owner' then 'admin' else 'estimator' end;
alter table public.workspace_members
  add constraint workspace_members_role_check check (role in ('admin', 'estimator', 'viewer'));
alter table public.workspace_members alter column role set default 'viewer';

create table public.class_pass_tokens (
  id uuid primary key default gen_random_uuid(),
  -- The plaintext token is returned once and never stored.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  label text not null check (char_length(label) between 1 and 120),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_by uuid references auth.users(id) on delete restrict,
  workspace_id uuid references public.workspaces(id) on delete restrict,
  constraint class_pass_token_expiry check (expires_at = starts_at + interval '60 days'),
  constraint class_pass_redemption_complete check (
    (redeemed_at is null and redeemed_by is null and workspace_id is null)
    or (redeemed_at is not null and redeemed_by is not null and workspace_id is not null)
  )
);

alter table public.class_pass_tokens enable row level security;
-- No policies by design: token administration uses a server-only service-role client.

-- Users may edit their display name, but cannot promote themselves to platform admin.
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

create or replace function private.has_workspace_role(target_workspace uuid, allowed_roles text[])
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = target_workspace and wm.user_id = auth.uid()
      and wm.role = any(allowed_roles)
  );
$$;

create or replace function private.is_workspace_owner(target_workspace uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select private.has_workspace_role(target_workspace, array['admin']); $$;

create or replace function private.add_workspace_owner_membership()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.created_by, 'admin');
  return new;
end;
$$;

-- Atomically consumes a token and provisions a workspace, administrator membership,
-- and matching entitlement. Row locking prevents replay under concurrent requests.
create or replace function public.redeem_class_pass(token_digest text, workspace_name text default 'My Class Workspace')
returns table (workspace_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare
  pass public.class_pass_tokens%rowtype;
  new_workspace_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if token_digest !~ '^[0-9a-f]{64}$' then raise exception 'Invalid Class Pass token'; end if;
  if char_length(trim(workspace_name)) not between 1 and 120 then raise exception 'Invalid workspace name'; end if;

  select * into pass from public.class_pass_tokens
    where token_hash = token_digest for update;
  if not found or pass.redeemed_at is not null or pass.starts_at > now() or pass.expires_at <= now() then
    raise exception 'Class Pass is invalid, expired, or already redeemed';
  end if;

  insert into public.workspaces (name, created_by)
    values (trim(workspace_name), auth.uid()) returning id into new_workspace_id;
  insert into public.entitlements (user_id, kind, source, external_ref, starts_at, expires_at)
    values (auth.uid(), 'class_pass', 'class_pass_token', pass.id::text,
            pass.starts_at, pass.expires_at);
  update public.class_pass_tokens set redeemed_at = now(), redeemed_by = auth.uid(),
    workspace_id = new_workspace_id where id = pass.id;
  return query select new_workspace_id, pass.expires_at;
end;
$$;

revoke all on function public.redeem_class_pass(text, text) from public, anon;
grant execute on function public.redeem_class_pass(text, text) to authenticated;
revoke all on function private.has_workspace_role(uuid, text[]) from public, anon;
grant execute on function private.has_workspace_role(uuid, text[]) to authenticated;

-- Replace broad write policies with role-specific RBAC. Admin manages the workspace
-- and roster; estimators create/edit project data; viewers are read-only.
drop policy if exists projects_insert_access on public.projects;
drop policy if exists projects_update_access on public.projects;
drop policy if exists projects_delete_access on public.projects;
create policy projects_insert_estimator on public.projects for insert to authenticated
  with check (created_by = auth.uid() and private.has_workspace_role(workspace_id, array['admin','estimator']) and private.has_product_access());
create policy projects_update_estimator on public.projects for update to authenticated
  using (private.has_workspace_role(workspace_id, array['admin','estimator']) and private.has_product_access())
  with check (private.has_workspace_role(workspace_id, array['admin','estimator']) and private.has_product_access());
create policy projects_delete_admin on public.projects for delete to authenticated
  using (private.has_workspace_role(workspace_id, array['admin']) and private.has_product_access());

drop policy if exists estimates_insert_access on public.estimates;
drop policy if exists estimates_update_access on public.estimates;
drop policy if exists estimates_delete_access on public.estimates;
create policy estimates_insert_estimator on public.estimates for insert to authenticated
  with check (created_by = auth.uid() and private.has_workspace_role(workspace_id, array['admin','estimator']) and private.has_product_access());
create policy estimates_update_estimator on public.estimates for update to authenticated
  using (private.has_workspace_role(workspace_id, array['admin','estimator']) and private.has_product_access())
  with check (private.has_workspace_role(workspace_id, array['admin','estimator']) and private.has_product_access());
create policy estimates_delete_admin on public.estimates for delete to authenticated
  using (private.has_workspace_role(workspace_id, array['admin']) and private.has_product_access());

drop policy if exists project_files_insert_access on public.project_files;
drop policy if exists project_files_delete_access on public.project_files;
create policy project_files_insert_estimator on public.project_files for insert to authenticated
  with check (uploaded_by = auth.uid() and private.has_workspace_role(workspace_id, array['admin','estimator']) and private.has_product_access());
create policy project_files_delete_admin on public.project_files for delete to authenticated
  using (private.has_workspace_role(workspace_id, array['admin']) and private.has_product_access());

create or replace function private.can_write_plan_object(object_name text)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare target_workspace uuid;
begin
  if split_part(object_name, '/', 1) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  target_workspace := split_part(object_name, '/', 1)::uuid;
  return private.has_workspace_role(target_workspace, array['admin','estimator']) and private.has_product_access();
end;
$$;
revoke all on function private.can_write_plan_object(text) from public, anon;
grant execute on function private.can_write_plan_object(text) to authenticated;
drop policy if exists plan_files_storage_insert on storage.objects;
drop policy if exists plan_files_storage_update on storage.objects;
drop policy if exists plan_files_storage_delete on storage.objects;
create policy plan_files_storage_insert_rbac on storage.objects for insert to authenticated
  with check (bucket_id = 'plan-files' and private.can_write_plan_object(name));
create policy plan_files_storage_update_rbac on storage.objects for update to authenticated
  using (bucket_id = 'plan-files' and private.can_write_plan_object(name))
  with check (bucket_id = 'plan-files' and private.can_write_plan_object(name));
create policy plan_files_storage_delete_rbac on storage.objects for delete to authenticated
  using (bucket_id = 'plan-files' and private.can_write_plan_object(name));
