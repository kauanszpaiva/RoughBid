alter table public.projects
  add constraint projects_id_workspace_unique unique (id, workspace_id);

alter table public.project_files
  drop constraint project_files_project_id_fkey,
  add constraint project_files_project_workspace_fkey
    foreign key (project_id, workspace_id)
    references public.projects(id, workspace_id)
    on delete cascade;

create or replace function private.can_access_plan_object(object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  workspace_uuid uuid;
  project_uuid uuid;
begin
  if object_name !~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.pdf$' then return false; end if;
  begin
    workspace_uuid := split_part(object_name, '/', 1)::uuid;
    project_uuid := split_part(object_name, '/', 2)::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return private.has_workspace_access(workspace_uuid)
    and private.has_product_access()
    and exists (select 1 from public.projects p where p.id = project_uuid and p.workspace_id = workspace_uuid);
end;
$$;

revoke all on function private.can_access_plan_object(text) from public, anon;
grant execute on function private.can_access_plan_object(text) to authenticated;
