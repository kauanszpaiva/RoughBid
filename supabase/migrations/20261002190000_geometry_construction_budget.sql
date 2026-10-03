-- Add the real geometry-provider parent to immutable construction snapshots.
-- Depends on reviewed geometry_provider_jobs schema 20261002180000.
alter table public.construction_budget_snapshots add column geometry_run_id uuid;
alter table public.construction_budget_snapshots add constraint construction_budget_geometry_parent_fk
  foreign key(geometry_run_id,workspace_id,project_id) references public.geometry_provider_jobs(id,workspace_id,project_id) on delete restrict;
alter table public.construction_budget_snapshots drop constraint construction_budget_snapshots_source_kind_check;
alter table public.construction_budget_snapshots add constraint construction_budget_snapshots_source_kind_check
  check(source_kind in ('plan','photo','geometry'));
do $$ declare c record; begin
  for c in select conname from pg_constraint where conrelid='public.construction_budget_snapshots'::regclass and contype='c'
    and pg_get_constraintdef(oid) like '%plan_run_id%' and pg_get_constraintdef(oid) like '%photo_run_id%'
  loop execute format('alter table public.construction_budget_snapshots drop constraint %I',c.conname); end loop;
end $$;
alter table public.construction_budget_snapshots add constraint construction_budget_single_source_parent_check check(
  (source_kind='plan' and plan_run_id is not null and plan_run_id=source_run_id and photo_run_id is null and geometry_run_id is null)
  or(source_kind='photo' and photo_run_id is not null and photo_run_id=source_run_id and plan_run_id is null and geometry_run_id is null)
  or(source_kind='geometry' and geometry_run_id is not null and geometry_run_id=source_run_id and plan_run_id is null and photo_run_id is null));

create or replace function public.save_construction_budget_snapshot(p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_source_kind text,p_source_run_id uuid,
  p_selection_count integer,p_request_hash text,p_inputs jsonb,p_result jsonb,p_location jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare saved public.construction_budget_snapshots;
begin
  if not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator'))
    or not exists(select 1 from public.projects where id=p_project_id and workspace_id=p_workspace_id) then raise exception 'Construction budget access denied'; end if;
  if p_source_kind='plan' then
    if not exists(select 1 from public.takeoff_runs where id=p_source_run_id and workspace_id=p_workspace_id and project_id=p_project_id) then raise exception 'Budget source plan scope denied'; end if;
  elsif p_source_kind='photo' then
    if not exists(select 1 from public.photo_takeoff_runs where id=p_source_run_id and workspace_id=p_workspace_id and project_id=p_project_id) then raise exception 'Budget source photo scope denied'; end if;
  elsif p_source_kind='geometry' then
    if not exists(select 1 from public.geometry_provider_jobs where id=p_source_run_id and workspace_id=p_workspace_id and project_id=p_project_id)
      then raise exception 'Budget source automatic geometry scope denied'; end if;
  else raise exception 'Construction budget source kind is invalid'; end if;
  if p_request_hash!~'^[a-f0-9]{64}$' or p_selection_count not between 1 and 100
    or coalesce(jsonb_typeof(p_inputs),'null')<>'object' or coalesce(jsonb_typeof(p_result),'null')<>'object'
    or p_result->>'coverage' is distinct from 'partial' or p_result->'humanReviewRequired' is distinct from 'true'::jsonb
    or not p_result ? 'totalUsd' or p_result->'totalUsd'<>'null'::jsonb then raise exception 'Partial budget result or review gate is invalid'; end if;
  select * into saved from public.construction_budget_snapshots where workspace_id=p_workspace_id and project_id=p_project_id and request_hash=p_request_hash for update;
  if found then
    if saved.source_kind<>p_source_kind or saved.source_run_id<>p_source_run_id or saved.inputs<>p_inputs or saved.result<>p_result
      or saved.location is distinct from p_location then raise exception 'Snapshot identity changed'; end if;
  else
    insert into public.construction_budget_snapshots(workspace_id,project_id,source_kind,source_run_id,plan_run_id,photo_run_id,geometry_run_id,selection_count,
      request_hash,inputs,result,location,created_by) values(p_workspace_id,p_project_id,p_source_kind,p_source_run_id,
      case when p_source_kind='plan' then p_source_run_id end,case when p_source_kind='photo' then p_source_run_id end,
      case when p_source_kind='geometry' then p_source_run_id end,p_selection_count,p_request_hash,p_inputs,p_result,p_location,p_user_id) returning * into saved;
  end if;
  return jsonb_build_object('id',saved.id,'createdAt',saved.created_at);
end $$;
revoke all on function public.save_construction_budget_snapshot(uuid,uuid,uuid,text,uuid,integer,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.save_construction_budget_snapshot(uuid,uuid,uuid,text,uuid,integer,text,jsonb,jsonb,jsonb) to service_role;
