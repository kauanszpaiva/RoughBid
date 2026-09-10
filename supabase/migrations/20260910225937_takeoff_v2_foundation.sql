-- Takeoff V2 is additive. Legacy plan readings, app_state projects, and estimates
-- remain readable while the feature-flagged full workflow is introduced.

create table public.takeoff_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  file_id uuid not null,
  mode text not null check (mode in ('deep','full')),
  status text not null default 'queued' check (status in ('queued','processing','needs_review','ready','failed','cancelled')),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  orchestrator_version text not null,
  requested_by uuid not null references auth.users(id) on delete restrict,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint takeoff_runs_project_scope_fkey foreign key (project_id, workspace_id)
    references public.projects(id, workspace_id) on delete cascade,
  constraint takeoff_runs_file_scope_fkey foreign key (file_id, workspace_id, project_id)
    references public.project_files(id, workspace_id, project_id) on delete cascade,
  unique (workspace_id, project_id, file_id, file_sha256, mode, orchestrator_version)
);

alter table public.takeoff_runs add constraint takeoff_runs_scope_unique unique (id, workspace_id, project_id, file_id);
alter table public.takeoff_runs add constraint takeoff_runs_project_scope_unique unique (id, workspace_id, project_id);

create table public.plan_sheets (
  id uuid primary key default gen_random_uuid(),
  takeoff_run_id uuid not null references public.takeoff_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  file_id uuid not null,
  physical_page_number integer not null check (physical_page_number > 0),
  page_sha256 text not null check (page_sha256 ~ '^[0-9a-f]{64}$'),
  width_points numeric(14,6) not null check (width_points > 0),
  height_points numeric(14,6) not null check (height_points > 0),
  rotation_degrees integer not null default 0 check (rotation_degrees in (0,90,180,270)),
  content_kind text not null check (content_kind in ('vector','raster','mixed','blank','unknown')),
  text_quality text not null check (text_quality in ('good','partial','none','unreadable','unknown')),
  sheet_number text,
  sheet_title text,
  discipline text,
  issue_date date,
  revision_number text,
  revision_date date,
  status text not null default 'review_required' check (status in ('reviewed','non_takeoff_informational','superseded','duplicate','unreadable','blocked','review_required')),
  status_reason text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plan_sheets_run_scope_fkey foreign key (takeoff_run_id, workspace_id, project_id, file_id)
    references public.takeoff_runs(id, workspace_id, project_id, file_id) on delete cascade,
  unique (takeoff_run_id, physical_page_number),
  unique (id, workspace_id, project_id, takeoff_run_id)
);

create table public.takeoff_passes (
  id uuid primary key default gen_random_uuid(),
  takeoff_run_id uuid not null references public.takeoff_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  plan_sheet_id uuid references public.plan_sheets(id) on delete cascade,
  pass_type text not null check (pass_type in ('classification','legends_schedules','geometry','discipline','reconciliation','conflict_detection','completeness','arithmetic_qa','pricing_assemblies','risk_review')),
  attempt integer not null default 1 check (attempt > 0 and attempt <= 10),
  status text not null default 'queued' check (status in ('queued','processing','succeeded','failed','blocked')),
  idempotency_key text not null,
  provider text,
  model text,
  prompt_version text,
  input_tokens bigint check (input_tokens is null or input_tokens >= 0),
  output_tokens bigint check (output_tokens is null or output_tokens >= 0),
  provider_cost_microusd bigint check (provider_cost_microusd is null or provider_cost_microusd >= 0),
  failure_classification text,
  checkpoint jsonb not null default '{}'::jsonb check (jsonb_typeof(checkpoint) = 'object'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint takeoff_passes_run_scope_fkey foreign key (takeoff_run_id, workspace_id, project_id)
    references public.takeoff_runs(id, workspace_id, project_id),
  constraint takeoff_passes_sheet_scope_fkey foreign key (plan_sheet_id, workspace_id, project_id, takeoff_run_id)
    references public.plan_sheets(id, workspace_id, project_id, takeoff_run_id),
  unique (takeoff_run_id, plan_sheet_id, pass_type, attempt),
  unique (takeoff_run_id, idempotency_key)
);

create table public.scale_calibrations (
  id uuid primary key default gen_random_uuid(),
  plan_sheet_id uuid not null references public.plan_sheets(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  takeoff_run_id uuid not null,
  viewport_key text not null default 'full_page',
  source_type text not null check (source_type in ('printed_scale','graphic_scale','explicit_dimension','known_reference','vector_coordinates')),
  drawing_units_per_point numeric(24,12) not null check (drawing_units_per_point > 0),
  transform jsonb not null check (jsonb_typeof(transform) = 'object'),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  verification_status text not null check (verification_status in ('unverified','single_source','verified','conflicting','nts','blocked')),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) > 0),
  created_at timestamptz not null default now(),
  constraint scale_calibrations_sheet_scope_fkey foreign key (plan_sheet_id, workspace_id, project_id, takeoff_run_id)
    references public.plan_sheets(id, workspace_id, project_id, takeoff_run_id),
  unique (plan_sheet_id, viewport_key)
);

create table public.takeoff_items (
  id uuid primary key default gen_random_uuid(),
  takeoff_run_id uuid not null references public.takeoff_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  plan_sheet_id uuid not null references public.plan_sheets(id) on delete cascade,
  canonical_trade text not null,
  csi_division text,
  cost_code text,
  item_type text not null check (item_type in ('material','labor','equipment','subcontract','assembly','allowance','other')),
  description text not null check (length(btrim(description)) > 0),
  raw_quantity numeric(24,6) check (raw_quantity is null or raw_quantity >= 0),
  unit text check (unit is null or unit in ('SF','LF','EA','CY','SY','HR','LS','SQ','TON','LB','GAL','SHEET','BAG','BOX','ROLL','PAIR','SET','MBF','CF','CFM','GPM','KW','AMP','DAY','WK','MO')),
  calculation_formula jsonb check (calculation_formula is null or jsonb_typeof(calculation_formula) = 'object'),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  evidence_type text not null check (evidence_type in ('observed_text','observed_schedule','observed_symbol','measured_geometry','computed','assumed')),
  quantity_status text not null check (quantity_status in ('observed','computed','assumed','unresolved')),
  review_status text not null default 'needs_review' check (review_status in ('needs_review','accepted','rejected','blocked')),
  scope_status text not null check (scope_status in ('visible','referenced_missing','owner_supplied','by_others','allowance','alternate','excluded','unresolved')),
  revision_source text,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint takeoff_items_sheet_scope_fkey foreign key (plan_sheet_id, workspace_id, project_id, takeoff_run_id)
    references public.plan_sheets(id, workspace_id, project_id, takeoff_run_id),
  constraint takeoff_items_acceptance_pair check ((accepted_by is null and accepted_at is null) or (accepted_by is not null and accepted_at is not null)),
  constraint takeoff_items_quantity_unit_pair check ((raw_quantity is null and unit is null) or (raw_quantity is not null and unit is not null)),
  unique (id, workspace_id, project_id, takeoff_run_id),
  unique (id, workspace_id, project_id)
);

create table public.takeoff_evidence (
  id uuid primary key default gen_random_uuid(),
  takeoff_item_id uuid not null references public.takeoff_items(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  takeoff_run_id uuid not null,
  plan_sheet_id uuid not null references public.plan_sheets(id) on delete cascade,
  source_excerpt text,
  callout text,
  region jsonb not null check (jsonb_typeof(region) = 'object'),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint takeoff_evidence_item_scope_fkey foreign key (takeoff_item_id, workspace_id, project_id, takeoff_run_id)
    references public.takeoff_items(id, workspace_id, project_id, takeoff_run_id),
  constraint takeoff_evidence_has_content check (nullif(btrim(source_excerpt), '') is not null or nullif(btrim(callout), '') is not null)
);

create table public.takeoff_geometry (
  id uuid primary key default gen_random_uuid(),
  takeoff_item_id uuid not null references public.takeoff_items(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  takeoff_run_id uuid not null,
  calibration_id uuid references public.scale_calibrations(id) on delete restrict,
  geometry_type text not null check (geometry_type in ('point','count','line','polyline','polygon','rectangle','opening','volume')),
  geometry jsonb not null check (jsonb_typeof(geometry) = 'object'),
  coordinate_space text not null check (coordinate_space in ('pdf_points','normalized','drawing_units')),
  created_at timestamptz not null default now(),
  constraint takeoff_geometry_item_scope_fkey foreign key (takeoff_item_id, workspace_id, project_id, takeoff_run_id)
    references public.takeoff_items(id, workspace_id, project_id, takeoff_run_id)
);

create table public.assemblies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  canonical_trade text not null,
  csi_division text,
  created_by uuid not null references auth.users(id) on delete restrict,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name),
  unique (id, workspace_id)
);

create table public.assembly_versions (
  id uuid primary key default gen_random_uuid(),
  assembly_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  version integer not null check (version > 0),
  input_unit text not null check (input_unit in ('SF','LF','EA','CY','SY','HR','LS','SQ','TON','LB','GAL','SHEET','BAG','BOX','ROLL','PAIR','SET','MBF','CF','CFM','GPM','KW','AMP','DAY','WK','MO')),
  status text not null default 'draft' check (status in ('draft','active','retired')),
  specification_basis text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint assembly_versions_assembly_scope_fkey foreign key (assembly_id, workspace_id)
    references public.assemblies(id, workspace_id) on delete cascade,
  unique (assembly_id, version),
  unique (id, workspace_id)
);

create table public.assembly_components (
  id uuid primary key default gen_random_uuid(),
  assembly_version_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  component_type text not null check (component_type in ('material','labor','equipment','consumable','fastener','accessory','subcontract')),
  description text not null,
  output_unit text not null check (output_unit in ('SF','LF','EA','CY','SY','HR','LS','SQ','TON','LB','GAL','SHEET','BAG','BOX','ROLL','PAIR','SET','MBF','CF','CFM','GPM','KW','AMP','DAY','WK','MO')),
  quantity_per_input numeric(24,6) not null check (quantity_per_input >= 0),
  support_status text not null check (support_status in ('specified','observed','inferred_review_required')),
  created_at timestamptz not null default now(),
  constraint assembly_components_version_scope_fkey foreign key (assembly_version_id, workspace_id)
    references public.assembly_versions(id, workspace_id) on delete cascade
);

create table public.price_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_type text not null check (source_type in ('project_quote','workspace_price_book','job_cost_actual','vendor_catalog','licensed_database','regional_benchmark','provisional_assumption')),
  source_name text not null,
  vendor text,
  geography text,
  license_reference text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, workspace_id)
);

create table public.price_snapshots (
  id uuid primary key default gen_random_uuid(),
  price_source_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  description text not null,
  sku text,
  unit text not null check (unit in ('SF','LF','EA','CY','SY','HR','LS','SQ','TON','LB','GAL','SHEET','BAG','BOX','ROLL','PAIR','SET','MBF','CF','CFM','GPM','KW','AMP','DAY','WK','MO')),
  package_size numeric(24,6) not null default 1 check (package_size > 0),
  base_price numeric(20,6) not null check (base_price >= 0),
  freight numeric(20,6) not null default 0 check (freight >= 0),
  tax_treatment text not null check (tax_treatment in ('taxable_material','exempt_documented','not_applicable','review_required')),
  escalation_percent numeric(9,6) not null default 0 check (escalation_percent >= 0),
  currency char(3) not null default 'USD',
  effective_date date not null,
  expires_at date,
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  created_at timestamptz not null default now(),
  constraint price_snapshots_source_scope_fkey foreign key (price_source_id, workspace_id)
    references public.price_sources(id, workspace_id) on delete cascade,
  unique (id, workspace_id)
);

create table public.estimate_versions_v2 (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  takeoff_run_id uuid not null references public.takeoff_runs(id) on delete restrict,
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft','needs_review','estimate_ready','final')),
  calculation_version text not null,
  totals jsonb not null default '{}'::jsonb check (jsonb_typeof(totals) = 'object'),
  created_by uuid not null references auth.users(id) on delete restrict,
  finalized_by uuid references auth.users(id) on delete restrict,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint estimate_versions_v2_project_scope_fkey foreign key (project_id, workspace_id)
    references public.projects(id, workspace_id) on delete cascade,
  unique (workspace_id, project_id, version),
  unique (id, workspace_id, project_id)
);

create table public.estimate_line_items_v2 (
  id uuid primary key default gen_random_uuid(),
  estimate_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  takeoff_item_id uuid references public.takeoff_items(id) on delete restrict,
  assembly_version_id uuid references public.assembly_versions(id) on delete restrict,
  description text not null,
  unit text not null,
  raw_quantity numeric(24,6) not null check (raw_quantity >= 0),
  waste_percent numeric(9,6) not null default 0 check (waste_percent between 0 and 100),
  waste_quantity numeric(24,6) not null check (waste_quantity >= 0),
  purchasing_quantity numeric(24,6) not null check (purchasing_quantity >= raw_quantity + waste_quantity),
  package_size numeric(24,6) not null default 1 check (package_size > 0),
  rounding_rule text not null check (rounding_rule in ('none','round_up_package')),
  price_snapshot_id uuid,
  material_rate numeric(20,6) not null default 0,
  material_freight numeric(20,6) not null default 0,
  material_tax numeric(20,6) not null default 0,
  material_total numeric(20,6) not null default 0,
  labor_hours numeric(24,6) not null default 0,
  labor_hourly_cost numeric(20,6) not null default 0,
  labor_total numeric(20,6) not null default 0,
  equipment_total numeric(20,6) not null default 0,
  subcontract_total numeric(20,6) not null default 0,
  other_direct_total numeric(20,6) not null default 0,
  direct_total numeric(20,6) not null default 0,
  pricing_status text not null check (pricing_status in ('priced','unpriced','provisional','expired','review_required')),
  created_at timestamptz not null default now(),
  constraint estimate_line_items_v2_estimate_scope_fkey foreign key (estimate_id, workspace_id, project_id)
    references public.estimate_versions_v2(id, workspace_id, project_id) on delete cascade,
  constraint estimate_line_items_v2_takeoff_scope_fkey foreign key (takeoff_item_id, workspace_id, project_id)
    references public.takeoff_items(id, workspace_id, project_id) on delete restrict,
  constraint estimate_line_items_v2_price_scope_fkey foreign key (price_snapshot_id, workspace_id)
    references public.price_snapshots(id, workspace_id) on delete restrict
);

create table public.estimate_adjustments_v2 (
  id uuid primary key default gen_random_uuid(),
  estimate_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  adjustment_type text not null check (adjustment_type in ('general_conditions','overhead','design_contingency','scope_contingency','market_escalation','schedule_contingency','profit_markup','profit_margin','allowance')),
  label text not null,
  percent numeric(9,6),
  amount numeric(20,6) not null check (amount >= 0),
  basis jsonb not null check (jsonb_typeof(basis) = 'object'),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint estimate_adjustments_v2_estimate_scope_fkey foreign key (estimate_id, workspace_id, project_id)
    references public.estimate_versions_v2(id, workspace_id, project_id) on delete cascade
);

create table public.estimate_recommendations_v2 (
  id uuid primary key default gen_random_uuid(),
  estimate_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  recommendation_type text not null check (recommendation_type in ('waste','crew_productivity','labor_adjustment','general_conditions','overhead','contingency','markup','target_margin','escalation','allowance')),
  suggested_low numeric(20,6),
  suggested_value numeric(20,6) not null,
  suggested_high numeric(20,6),
  reason text not null,
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array'),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  method_version text not null,
  status text not null default 'suggested' check (status in ('suggested','accepted','rejected','overridden')),
  accepted_value numeric(20,6),
  accepted_by uuid references auth.users(id) on delete restrict,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint estimate_recommendations_v2_estimate_scope_fkey foreign key (estimate_id, workspace_id, project_id)
    references public.estimate_versions_v2(id, workspace_id, project_id) on delete cascade
);

create table public.estimate_rfis_v2 (
  id uuid primary key default gen_random_uuid(),
  estimate_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  severity text not null check (severity in ('informational','warning','blocking')),
  category text not null,
  question text not null,
  status text not null default 'open' check (status in ('open','answered','accepted_risk','closed')),
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  resolved_by uuid references auth.users(id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint estimate_rfis_v2_estimate_scope_fkey foreign key (estimate_id, workspace_id, project_id)
    references public.estimate_versions_v2(id, workspace_id, project_id) on delete cascade
);

create index takeoff_runs_workspace_project_idx on public.takeoff_runs(workspace_id, project_id, created_at desc);
create index plan_sheets_run_status_idx on public.plan_sheets(takeoff_run_id, status, physical_page_number);
create index takeoff_passes_run_status_idx on public.takeoff_passes(takeoff_run_id, status, pass_type);
create index takeoff_items_run_trade_status_idx on public.takeoff_items(takeoff_run_id, canonical_trade, review_status);
create index takeoff_items_project_idx on public.takeoff_items(workspace_id, project_id, created_at desc);
create index takeoff_evidence_item_idx on public.takeoff_evidence(takeoff_item_id);
create index takeoff_geometry_item_idx on public.takeoff_geometry(takeoff_item_id);
create index assemblies_workspace_idx on public.assemblies(workspace_id, archived_at, name);
create index price_snapshots_workspace_unit_date_idx on public.price_snapshots(workspace_id, unit, effective_date desc);
create index estimate_line_items_v2_estimate_idx on public.estimate_line_items_v2(estimate_id, pricing_status);
create index estimate_rfis_v2_blockers_idx on public.estimate_rfis_v2(estimate_id, status) where severity = 'blocking';

alter table public.takeoff_runs enable row level security;
alter table public.plan_sheets enable row level security;
alter table public.takeoff_passes enable row level security;
alter table public.scale_calibrations enable row level security;
alter table public.takeoff_items enable row level security;
alter table public.takeoff_evidence enable row level security;
alter table public.takeoff_geometry enable row level security;
alter table public.assemblies enable row level security;
alter table public.assembly_versions enable row level security;
alter table public.assembly_components enable row level security;
alter table public.price_sources enable row level security;
alter table public.price_snapshots enable row level security;
alter table public.estimate_versions_v2 enable row level security;
alter table public.estimate_line_items_v2 enable row level security;
alter table public.estimate_adjustments_v2 enable row level security;
alter table public.estimate_recommendations_v2 enable row level security;
alter table public.estimate_rfis_v2 enable row level security;

revoke all on table public.takeoff_runs, public.plan_sheets, public.takeoff_passes, public.scale_calibrations,
  public.takeoff_items, public.takeoff_evidence, public.takeoff_geometry, public.assemblies,
  public.assembly_versions, public.assembly_components, public.price_sources, public.price_snapshots,
  public.estimate_versions_v2, public.estimate_line_items_v2, public.estimate_adjustments_v2,
  public.estimate_recommendations_v2, public.estimate_rfis_v2 from public, anon, authenticated;

grant select on table public.takeoff_runs, public.plan_sheets, public.takeoff_passes, public.scale_calibrations,
  public.takeoff_items, public.takeoff_evidence, public.takeoff_geometry, public.assemblies,
  public.assembly_versions, public.assembly_components, public.price_sources, public.price_snapshots,
  public.estimate_versions_v2, public.estimate_line_items_v2, public.estimate_adjustments_v2,
  public.estimate_recommendations_v2, public.estimate_rfis_v2 to authenticated;

grant all on table public.takeoff_runs, public.plan_sheets, public.takeoff_passes, public.scale_calibrations,
  public.takeoff_items, public.takeoff_evidence, public.takeoff_geometry, public.assemblies,
  public.assembly_versions, public.assembly_components, public.price_sources, public.price_snapshots,
  public.estimate_versions_v2, public.estimate_line_items_v2, public.estimate_adjustments_v2,
  public.estimate_recommendations_v2, public.estimate_rfis_v2 to service_role;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'takeoff_runs','plan_sheets','takeoff_passes','scale_calibrations','takeoff_items','takeoff_evidence','takeoff_geometry',
    'assemblies','assembly_versions','assembly_components','price_sources','price_snapshots','estimate_versions_v2',
    'estimate_line_items_v2','estimate_adjustments_v2','estimate_recommendations_v2','estimate_rfis_v2'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (private.has_workspace_role(workspace_id, array[''admin'',''estimator'',''viewer'']) and private.has_product_access())',
      table_name || '_select_member', table_name
    );
  end loop;
end $$;

create or replace function private.enforce_takeoff_item_acceptance()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.review_status = 'accepted' and (tg_op = 'INSERT' or old.review_status is distinct from 'accepted') then
    if new.raw_quantity is null or new.unit is null or new.quantity_status = 'unresolved' then
      raise exception 'Accepted takeoff items require a resolved quantity and canonical unit';
    end if;
    if new.calculation_formula is null then
      raise exception 'Accepted takeoff items require a reproducible calculation formula';
    end if;
    if not exists (select 1 from public.takeoff_evidence e where e.takeoff_item_id = new.id) then
      raise exception 'Accepted takeoff items require source evidence';
    end if;
    if new.evidence_type in ('measured_geometry','computed') and not exists (
      select 1 from public.takeoff_geometry g
      left join public.scale_calibrations c on c.id = g.calibration_id
      where g.takeoff_item_id = new.id and c.verification_status = 'verified'
    ) then
      raise exception 'Measured takeoff items require verified calibration and geometry';
    end if;
    new.accepted_by := coalesce(new.accepted_by, (select auth.uid()));
    new.accepted_at := coalesce(new.accepted_at, now());
  end if;
  return new;
end;
$$;

create trigger takeoff_items_acceptance_gate
before insert or update of review_status on public.takeoff_items
for each row execute function private.enforce_takeoff_item_acceptance();

create or replace function public.set_takeoff_item_review_status(p_takeoff_item_id uuid, p_status text)
returns public.takeoff_items
language plpgsql
security definer
set search_path = ''
as $$
declare item public.takeoff_items%rowtype;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_status not in ('accepted','rejected','blocked','needs_review') then raise exception 'Invalid review status'; end if;
  select * into item from public.takeoff_items where id = p_takeoff_item_id for update;
  if not found then raise exception 'Takeoff item not found'; end if;
  if not private.has_workspace_role(item.workspace_id, array['admin','estimator']) or not private.has_product_access() then
    raise exception 'Not authorized to review this takeoff item' using errcode = '42501';
  end if;
  update public.takeoff_items set review_status = p_status,
    accepted_by = case when p_status = 'accepted' then (select auth.uid()) else null end,
    accepted_at = case when p_status = 'accepted' then now() else null end,
    updated_at = now()
  where id = p_takeoff_item_id returning * into item;
  return item;
end;
$$;

revoke all on function public.set_takeoff_item_review_status(uuid, text) from public, anon;
grant execute on function public.set_takeoff_item_review_status(uuid, text) to authenticated;

create or replace function private.enforce_estimate_v2_release()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status in ('estimate_ready','final') and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    if exists (select 1 from public.estimate_line_items_v2 l where l.estimate_id = new.id and l.pricing_status <> 'priced') then
      raise exception 'Estimate has unpriced, provisional, expired, or review-required line items';
    end if;
    if exists (select 1 from public.estimate_rfis_v2 r where r.estimate_id = new.id and r.severity = 'blocking' and r.status = 'open') then
      raise exception 'Estimate has unresolved blocking RFIs';
    end if;
    if exists (select 1 from public.takeoff_items t where t.takeoff_run_id = new.takeoff_run_id and t.review_status in ('needs_review','blocked')) then
      raise exception 'Estimate has unresolved takeoff review items';
    end if;
  end if;
  return new;
end;
$$;

create trigger estimate_versions_v2_release_gate
before insert or update of status on public.estimate_versions_v2
for each row execute function private.enforce_estimate_v2_release();
