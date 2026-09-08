-- Migration 0021: Platform Owner / ADM GOD Entitlement & Free Owner Workspace Seeding
--
-- Adds explicit server-side seating for the verified owner identity
-- user: c6453b85-f0e2-4af0-aad7-dcecb6fbb487
-- workspace: 60d9e2bc-06f6-4f2b-a648-aee6bdf4fb72
--
-- Customer workspaces and standard customer billing are untouched.
-- No fake quotes or synthetic findings are introduced.

do $$
begin
  -- Seed the owner workspace into private.free_owner_workspaces if the workspace row exists
  if exists (select 1 from public.workspaces where id = '60d9e2bc-06f6-4f2b-a648-aee6bdf4fb72') then
    insert into private.free_owner_workspaces (workspace_id, note)
    values ('60d9e2bc-06f6-4f2b-a648-aee6bdf4fb72', 'Platform Owner ADM GOD workspace')
    on conflict (workspace_id) do update set note = EXCLUDED.note;
  end if;

  -- Ensure profile for owner has is_platform_admin set to true if profile exists
  if exists (select 1 from public.profiles where id = 'c6453b85-f0e2-4af0-aad7-dcecb6fbb487') then
    update public.profiles
    set is_platform_admin = true
    where id = 'c6453b85-f0e2-4af0-aad7-dcecb6fbb487';
  end if;
end $$;

-- SQL helper function to check if a user is the platform owner (ADM GOD)
create or replace function public.is_platform_owner_god(p_user_id uuid)
returns boolean language sql stable security definer set search_path = public, private, pg_temp as $$
  select p_user_id = 'c6453b85-f0e2-4af0-aad7-dcecb6fbb487'::uuid;
$$;

revoke all on function public.is_platform_owner_god(uuid) from public, anon, authenticated;
grant execute on function public.is_platform_owner_god(uuid) to service_role;
