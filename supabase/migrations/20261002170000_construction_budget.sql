-- Immutable, tenant-scoped documented quotes and partial construction budgets.
-- This migration creates no SaaS products, payments or supplier API access.
create table public.construction_supplier_quotes (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete restrict,
  project_id uuid not null,quote_key text not null check(length(quote_key) between 1 and 160),
  quote jsonb not null check(jsonb_typeof(quote)='object' and octet_length(quote::text)<=50000),
  imported_by uuid not null references auth.users(id),created_at timestamptz not null default now(),
  foreign key(project_id,workspace_id) references public.projects(id,workspace_id) on delete restrict,
  unique(workspace_id,project_id,quote_key)
);
create table public.construction_budget_snapshots (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete restrict,
  project_id uuid not null,source_kind text not null check(source_kind in ('plan','photo')),source_run_id uuid not null,
  plan_run_id uuid,photo_run_id uuid,selection_count integer not null check(selection_count between 1 and 100),
  request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),inputs jsonb not null,result jsonb not null,location jsonb,
  created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),
  foreign key(project_id,workspace_id) references public.projects(id,workspace_id) on delete restrict,
  foreign key(plan_run_id,workspace_id,project_id) references public.takeoff_runs(id,workspace_id,project_id) on delete restrict,
  foreign key(photo_run_id,workspace_id,project_id) references public.photo_takeoff_runs(id,workspace_id,project_id) on delete restrict,
  check((source_kind='plan' and plan_run_id=source_run_id and photo_run_id is null) or (source_kind='photo' and photo_run_id=source_run_id and plan_run_id is null)),
  check(jsonb_typeof(inputs)='object' and octet_length(inputs::text)<=1000000),
  check(jsonb_typeof(result)='object' and octet_length(result::text)<=1000000),
  unique(workspace_id,project_id,request_hash)
);
alter table public.construction_supplier_quotes enable row level security;
alter table public.construction_budget_snapshots enable row level security;
create policy construction_quotes_read on public.construction_supplier_quotes for select to authenticated
  using(private.has_product_access() and private.has_workspace_role(workspace_id,array['admin','estimator','viewer']));
create policy construction_budgets_read on public.construction_budget_snapshots for select to authenticated
  using(private.has_product_access() and private.has_workspace_role(workspace_id,array['admin','estimator','viewer']));
revoke all on public.construction_supplier_quotes,public.construction_budget_snapshots from public,anon,authenticated,service_role;
grant select on public.construction_supplier_quotes,public.construction_budget_snapshots to authenticated;
grant select on public.construction_supplier_quotes,public.construction_budget_snapshots to service_role;
create index construction_quotes_project_idx on public.construction_supplier_quotes(workspace_id,project_id,created_at desc);
create index construction_budgets_project_idx on public.construction_budget_snapshots(workspace_id,project_id,created_at desc);

create function public.save_construction_supplier_quotes(p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_quotes jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare q jsonb;saved public.construction_supplier_quotes;
begin
  if not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator'))
    or not exists(select 1 from public.projects where id=p_project_id and workspace_id=p_workspace_id) then raise exception 'Construction quote access denied'; end if;
  if coalesce(jsonb_typeof(p_quotes),'null')<>'array' or jsonb_array_length(p_quotes) not between 1 and 100 or octet_length(p_quotes::text)>1000000 then raise exception 'Invalid documented quote batch'; end if;
  for q in select value from jsonb_array_elements(p_quotes) loop
    if coalesce(jsonb_typeof(q),'null')<>'object' or q->>'schema' is distinct from 'roughbid-supplier-quote-v1'
      or coalesce(q->>'id','')!~'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      or coalesce(q->>'origin','') not in ('supplier_quote','manual_quote','cache')
      or q->>'reviewedBy' is distinct from p_user_id::text then raise exception 'Quote source/reviewer identity is invalid'; end if;
    select * into saved from public.construction_supplier_quotes where workspace_id=p_workspace_id and project_id=p_project_id and quote_key=q->>'id' for update;
    if found then
      if (saved.quote-'importedAt'-'reviewedAt'-'reviewedBy')<>(q-'importedAt'-'reviewedAt'-'reviewedBy') then raise exception 'Existing quote evidence cannot be silently replaced; use a new quote identity'; end if;
    else
      insert into public.construction_supplier_quotes(workspace_id,project_id,quote_key,quote,imported_by)values(p_workspace_id,p_project_id,q->>'id',q,p_user_id);
    end if;
  end loop;
  return true;
end $$;
create function public.save_construction_budget_snapshot(p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_source_kind text,p_source_run_id uuid,
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
    insert into public.construction_budget_snapshots(workspace_id,project_id,source_kind,source_run_id,plan_run_id,photo_run_id,selection_count,
      request_hash,inputs,result,location,created_by) values(p_workspace_id,p_project_id,p_source_kind,p_source_run_id,
      case when p_source_kind='plan' then p_source_run_id end,case when p_source_kind='photo' then p_source_run_id end,
      p_selection_count,p_request_hash,p_inputs,p_result,p_location,p_user_id) returning * into saved;
  end if;
  return jsonb_build_object('id',saved.id,'createdAt',saved.created_at);
end $$;
revoke all on function public.save_construction_supplier_quotes(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.save_construction_budget_snapshot(uuid,uuid,uuid,text,uuid,integer,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.save_construction_supplier_quotes(uuid,uuid,uuid,jsonb),
  public.save_construction_budget_snapshot(uuid,uuid,uuid,text,uuid,integer,text,jsonb,jsonb,jsonb) to service_role;
