create schema if not exists private;

alter function public.handle_new_user_profile() set schema private;
alter function public.add_workspace_owner_membership() set schema private;
alter function public.has_workspace_access(uuid) set schema private;
alter function public.is_workspace_owner(uuid) set schema private;
alter function public.has_product_access() set schema private;
alter function public.can_access_plan_object(text) set schema private;

revoke all on function private.handle_new_user_profile() from public, anon, authenticated;
revoke all on function private.add_workspace_owner_membership() from public, anon, authenticated;

revoke all on function private.has_workspace_access(uuid) from public, anon, authenticated;
revoke all on function private.is_workspace_owner(uuid) from public, anon, authenticated;
revoke all on function private.has_product_access() from public, anon, authenticated;
revoke all on function private.can_access_plan_object(text) from public, anon, authenticated;

grant usage on schema private to authenticated;
grant execute on function private.has_workspace_access(uuid) to authenticated;
grant execute on function private.is_workspace_owner(uuid) to authenticated;
grant execute on function private.has_product_access() to authenticated;
grant execute on function private.can_access_plan_object(text) to authenticated;

create policy stripe_events_explicit_deny on public.stripe_events
  for all to authenticated
  using (false)
  with check (false);
