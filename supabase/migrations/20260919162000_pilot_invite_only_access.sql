-- Final limited-pilot access boundary.
-- New accounts require a valid invitation, pilot workspaces become read-only
-- after expiry/revocation, and limited-pilot users cannot create extra workspaces.

create or replace function public.authorize_roughbid_magic_link(
  p_email text,
  p_pilot_token_digest text default null,
  p_workspace_token_digest text default null
)
returns boolean
language sql
stable
security definer
set search_path = public,auth,pg_temp
as $$
  select
    exists (
      select 1
      from auth.users u
      where lower(u.email) = lower(btrim(p_email))
        and u.email_confirmed_at is not null
    )
    or exists (
      select 1
      from public.pilot_invitations i
      join public.pilot_cohorts c on c.id = i.cohort_id
      where i.email = lower(btrim(p_email))
        and i.token_hash = p_pilot_token_digest
        and i.accepted_at is null
        and i.revoked_at is null
        and i.expires_at > now()
        and c.enabled
    )
    or exists (
      select 1
      from public.workspace_invites i
      where lower(i.email) = lower(btrim(p_email))
        and i.token_hash = p_workspace_token_digest
        and i.accepted_at is null
        and i.revoked_at is null
        and i.expires_at > now()
    );
$$;

revoke all on function public.authorize_roughbid_magic_link(text,text,text)
  from public,anon,authenticated;
grant execute on function public.authorize_roughbid_magic_link(text,text,text)
  to service_role;

create or replace function private.pilot_workspace_write_allowed(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public,pg_temp
as $$
  select not exists (
    select 1
    from public.pilot_enrollments e
    join public.pilot_cohorts c on c.id = e.cohort_id
    where e.workspace_id = target_workspace
      and (
        e.revoked_at is not null
        or not c.enabled
        or e.starts_at > now()
        or e.expires_at <= now()
      )
  );
$$;

create or replace function private.can_create_workspace()
returns boolean
language sql
stable
security definer
set search_path = public,pg_temp
as $$
  select
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_platform_admin
    )
    or (
      not exists (
        select 1 from public.pilot_enrollments pe
        where pe.user_id = auth.uid()
      )
      and exists (
        select 1 from public.entitlements e
        where e.user_id = auth.uid()
          and e.source <> 'limited_pilot'
          and e.revoked_at is null
          and e.starts_at <= now()
          and (e.expires_at is null or e.expires_at > now())
      )
    );
$$;

create or replace function private.has_workspace_role(
  target_workspace uuid,
  allowed_roles text[]
)
returns boolean
language sql
stable
security definer
set search_path = public,pg_temp
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id = auth.uid()
      and wm.role = any(allowed_roles)
      and (
        'viewer' = any(allowed_roles)
        or private.pilot_workspace_write_allowed(target_workspace)
      )
  );
$$;

drop policy if exists workspaces_insert_self on public.workspaces;
create policy workspaces_insert_self
  on public.workspaces
  for insert
  to authenticated
  with check (
    created_by = auth.uid()
    and private.can_create_workspace()
  );

revoke all on function private.pilot_workspace_write_allowed(uuid) from public,anon;
revoke all on function private.can_create_workspace() from public,anon;
grant execute on function private.pilot_workspace_write_allowed(uuid) to authenticated,service_role;
grant execute on function private.can_create_workspace() to authenticated,service_role;
