-- The entitlement migration renamed class_pass but left this predicate stale.
-- Keep the existing authorization boundary, revocation and expiration checks.
create or replace function private.has_product_access()
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_platform_admin = true
  ) or exists (
    select 1 from public.entitlements e
    where e.user_id = auth.uid()
      and e.revoked_at is null
      and e.starts_at <= now()
      and (e.expires_at is null or e.expires_at > now())
      and e.kind in ('access_grant', 'subscription', 'admin')
  );
$$;
revoke all on function private.has_product_access() from public, anon;
grant execute on function private.has_product_access() to authenticated, service_role;
