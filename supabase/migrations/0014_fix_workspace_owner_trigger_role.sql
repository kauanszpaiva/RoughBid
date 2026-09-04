-- Keep workspace creation compatible with the RBAC role set introduced in 0004.
-- Production still had the original trigger name from 0001, which inserted
-- role='owner' after the role check changed to admin/estimator/viewer.
create or replace function public.add_workspace_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.created_by, 'admin')
  on conflict (workspace_id, user_id) do update set
    role = case
      when public.workspace_members.role = 'admin' then 'admin'
      else excluded.role
    end;
  return new;
end;
$$;

drop trigger if exists on_workspace_created_add_owner on public.workspaces;
create trigger on_workspace_created_add_owner
  after insert on public.workspaces
  for each row execute function public.add_workspace_owner_membership();
