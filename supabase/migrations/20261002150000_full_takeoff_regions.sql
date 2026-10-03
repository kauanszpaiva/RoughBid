-- Additive durable regional evidence; no provider enablement or budget is seeded.
create table public.takeoff_region_checkpoints (
  takeoff_run_id uuid not null,
  workspace_id uuid not null,
  project_id uuid not null,
  plan_sheet_id uuid not null references public.plan_sheets(id) on delete restrict,
  physical_page_number integer not null check(physical_page_number>0),
  page_sha256 text not null check(page_sha256~'^[a-f0-9]{64}$'),
  pass_type text not null check(pass_type in ('discipline','conflict_detection','completeness')),
  region_key text not null check(region_key~'^r[1-3]c[1-3]g[23]$'),
  region jsonb not null check(jsonb_typeof(region)='object'),
  idempotency_key text not null check(idempotency_key~'^[a-f0-9]{64}$'),
  status text not null check(status in ('processing','succeeded','blocked')),
  result jsonb check(result is null or (jsonb_typeof(result)='object' and octet_length(result::text)<=300000)),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(takeoff_run_id,physical_page_number,pass_type,region_key),
  foreign key(takeoff_run_id,workspace_id,project_id) references public.takeoff_runs(id,workspace_id,project_id) on delete restrict
);
alter table public.takeoff_region_checkpoints enable row level security;
create policy takeoff_regions_read on public.takeoff_region_checkpoints for select to authenticated
  using(private.has_product_access() and private.has_workspace_role(workspace_id,array['admin','estimator','viewer']));
revoke all on public.takeoff_region_checkpoints from anon,authenticated;
grant select on public.takeoff_region_checkpoints to authenticated;
revoke all on public.takeoff_region_checkpoints from service_role;
grant select on public.takeoff_region_checkpoints to service_role;

create function public.begin_full_takeoff_region(p_run_id uuid,p_lease_id uuid,p_page_number integer,p_page_sha256 text,
  p_pass_type text,p_region_key text,p_region jsonb,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; s public.plan_sheets; saved public.takeoff_region_checkpoints; cols integer; rows integer;
begin
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing'
    and worker_lease_expires_at>now() and cancel_requested_at is null for update;
  if not found then raise exception 'Regional worker lease is invalid'; end if;
  select * into s from public.plan_sheets where takeoff_run_id=r.id and physical_page_number=p_page_number
    and workspace_id=r.workspace_id and project_id=r.project_id and page_sha256=p_page_sha256;
  if not found then raise exception 'Regional sheet identity is invalid'; end if;
  perform 1 from public.takeoff_passes where takeoff_run_id=r.id and plan_sheet_id=s.id and pass_type=p_pass_type and attempt=1 and status='processing';
  if not found then raise exception 'Regional parent pass is not processing'; end if;
  if p_pass_type not in ('discipline','conflict_detection','completeness') or p_region_key!~'^r[1-3]c[1-3]g[23]$'
    or p_idempotency_key!~'^[a-f0-9]{64}$' or coalesce(jsonb_typeof(p_region),'null')<>'object'
    or not p_region ?& array['columns','rows','column','row','x','y','width','height']
    or exists(select 1 from jsonb_each(p_region) f where f.key in ('columns','rows','column','row','x','y','width','height')
      and jsonb_typeof(f.value)<>'number') then raise exception 'Regional identity is invalid'; end if;
  cols:=(p_region->>'columns')::integer; rows:=(p_region->>'rows')::integer;
  if cols not in (2,3) or rows<>cols or (p_region->>'column')::integer not between 1 and cols
    or (p_region->>'row')::integer not between 1 and rows
    or p_region_key<>('r'||(p_region->>'row')||'c'||(p_region->>'column')||'g'||cols)
    or (p_region->>'x')::numeric<0 or (p_region->>'y')::numeric<0
    or (p_region->>'width')::numeric<=0 or (p_region->>'height')::numeric<=0
    or (p_region->>'x')::numeric+(p_region->>'width')::numeric>s.width_points
    or (p_region->>'y')::numeric+(p_region->>'height')::numeric>s.height_points
    then raise exception 'Regional rectangle is invalid'; end if;
  select * into saved from public.takeoff_region_checkpoints where takeoff_run_id=r.id and physical_page_number=p_page_number
    and pass_type=p_pass_type and region_key=p_region_key;
  if found then
    if saved.idempotency_key<>p_idempotency_key or saved.region<>p_region or saved.page_sha256<>p_page_sha256 then raise exception 'Regional identity changed'; end if;
    if saved.status in ('succeeded','blocked') and saved.result is not null then return jsonb_build_object('disposition','saved','result',saved.result); end if;
    raise exception 'Uncertain regional dispatch requires reconciliation';
  end if;
  insert into public.takeoff_region_checkpoints(takeoff_run_id,workspace_id,project_id,plan_sheet_id,physical_page_number,page_sha256,
    pass_type,region_key,region,idempotency_key,status) values(r.id,r.workspace_id,r.project_id,s.id,p_page_number,p_page_sha256,p_pass_type,p_region_key,p_region,p_idempotency_key,'processing');
  update public.takeoff_runs set progress=progress||jsonb_build_object('currentRegion',p_region_key,'currentPage',p_page_number,
    'currentPass',p_pass_type,'regionsPerPass',cols*rows),updated_at=now() where id=r.id;
  return jsonb_build_object('disposition','run');
end $$;

create function public.save_full_takeoff_region(p_run_id uuid,p_lease_id uuid,p_page_number integer,p_page_sha256 text,
  p_pass_type text,p_region_key text,p_region jsonb,p_idempotency_key text,p_result jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs;
begin
  select * into r from public.takeoff_runs where id=p_run_id and worker_lease_id=p_lease_id and status='processing'
    and worker_lease_expires_at>now() and cancel_requested_at is null for update;
  if not found then raise exception 'Regional checkpoint lease is invalid'; end if;
  if coalesce(jsonb_typeof(p_result),'null')<>'object' or coalesce(p_result->>'status','') not in ('succeeded','blocked')
    or coalesce(jsonb_typeof(p_result->'checkpoint'),'null')<>'object' or octet_length(p_result::text)>300000
    or not (p_result->'checkpoint') ?& array['physical_page_number','pass_type']
    or (p_result->'checkpoint'->>'physical_page_number')::integer<>p_page_number
    or p_result->'checkpoint'->>'pass_type'<>p_pass_type then raise exception 'Regional output identity is invalid'; end if;
  update public.takeoff_region_checkpoints set status=p_result->>'status',result=p_result,completed_at=now()
    where takeoff_run_id=r.id and workspace_id=r.workspace_id and project_id=r.project_id
    and physical_page_number=p_page_number and page_sha256=p_page_sha256 and pass_type=p_pass_type and region_key=p_region_key
    and region=p_region and idempotency_key=p_idempotency_key and status='processing';
  if not found then raise exception 'Regional checkpoint cannot be overwritten'; end if;
  return true;
end $$;
revoke all on function public.begin_full_takeoff_region(uuid,uuid,integer,text,text,text,jsonb,text) from public,anon,authenticated;
revoke all on function public.save_full_takeoff_region(uuid,uuid,integer,text,text,text,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.begin_full_takeoff_region(uuid,uuid,integer,text,text,text,jsonb,text),
  public.save_full_takeoff_region(uuid,uuid,integer,text,text,text,jsonb,text,jsonb) to service_role;
