drop policy if exists plan_files_storage_delete on storage.objects;
drop policy if exists plan_files_storage_update on storage.objects;
drop policy if exists plan_files_storage_insert on storage.objects;
drop policy if exists plan_files_storage_select on storage.objects;
delete from storage.buckets where id = 'plan-files';

drop table if exists public.stripe_events;
drop table if exists public.billing_customers;
drop table if exists public.estimates;
drop table if exists public.project_files;
drop table if exists public.projects;
drop table if exists public.entitlements;
drop table if exists public.workspace_members;
drop table if exists public.workspaces;
drop table if exists public.profiles;

drop function if exists public.can_access_plan_object(text);
drop function if exists public.has_product_access();
drop function if exists public.is_workspace_owner(uuid);
drop function if exists public.has_workspace_access(uuid);
drop function if exists public.add_workspace_owner_membership();
drop function if exists public.handle_new_user_profile();
