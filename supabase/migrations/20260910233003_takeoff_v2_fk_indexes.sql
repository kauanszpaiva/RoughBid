-- Cover every Takeoff V2 foreign-key access path. These are intentionally
-- separate from reporting indexes because FK checks require the referenced
-- column order to be the leading index prefix.
create index takeoff_runs_file_scope_idx on public.takeoff_runs(file_id, workspace_id, project_id);
create index takeoff_runs_project_scope_idx on public.takeoff_runs(project_id, workspace_id);
create index takeoff_runs_requested_by_idx on public.takeoff_runs(requested_by);

create index plan_sheets_run_scope_idx on public.plan_sheets(takeoff_run_id, workspace_id, project_id, file_id);
create index plan_sheets_workspace_idx on public.plan_sheets(workspace_id);

create index takeoff_passes_sheet_scope_idx on public.takeoff_passes(plan_sheet_id, workspace_id, project_id, takeoff_run_id);
create index takeoff_passes_run_scope_idx on public.takeoff_passes(takeoff_run_id, workspace_id, project_id);
create index takeoff_passes_workspace_idx on public.takeoff_passes(workspace_id);

create index scale_calibrations_sheet_scope_idx on public.scale_calibrations(plan_sheet_id, workspace_id, project_id, takeoff_run_id);
create index scale_calibrations_workspace_idx on public.scale_calibrations(workspace_id);

create index takeoff_items_sheet_scope_idx on public.takeoff_items(plan_sheet_id, workspace_id, project_id, takeoff_run_id);
create index takeoff_items_accepted_by_idx on public.takeoff_items(accepted_by);

create index takeoff_evidence_item_scope_idx on public.takeoff_evidence(takeoff_item_id, workspace_id, project_id, takeoff_run_id);
create index takeoff_evidence_plan_sheet_idx on public.takeoff_evidence(plan_sheet_id);
create index takeoff_evidence_workspace_idx on public.takeoff_evidence(workspace_id);

create index takeoff_geometry_item_scope_idx on public.takeoff_geometry(takeoff_item_id, workspace_id, project_id, takeoff_run_id);
create index takeoff_geometry_calibration_idx on public.takeoff_geometry(calibration_id);
create index takeoff_geometry_workspace_idx on public.takeoff_geometry(workspace_id);

create index assemblies_created_by_idx on public.assemblies(created_by);
create index assembly_versions_assembly_scope_idx on public.assembly_versions(assembly_id, workspace_id);
create index assembly_versions_created_by_idx on public.assembly_versions(created_by);
create index assembly_versions_workspace_idx on public.assembly_versions(workspace_id);
create index assembly_components_version_scope_idx on public.assembly_components(assembly_version_id, workspace_id);
create index assembly_components_workspace_idx on public.assembly_components(workspace_id);

create index price_sources_created_by_idx on public.price_sources(created_by);
create index price_sources_workspace_idx on public.price_sources(workspace_id);
create index price_snapshots_source_scope_idx on public.price_snapshots(price_source_id, workspace_id);

create index estimate_versions_v2_project_scope_idx on public.estimate_versions_v2(project_id, workspace_id);
create index estimate_versions_v2_takeoff_run_idx on public.estimate_versions_v2(takeoff_run_id);
create index estimate_versions_v2_created_by_idx on public.estimate_versions_v2(created_by);
create index estimate_versions_v2_finalized_by_idx on public.estimate_versions_v2(finalized_by);

create index estimate_line_items_v2_estimate_scope_idx on public.estimate_line_items_v2(estimate_id, workspace_id, project_id);
create index estimate_line_items_v2_takeoff_scope_idx on public.estimate_line_items_v2(takeoff_item_id, workspace_id, project_id);
create index estimate_line_items_v2_price_scope_idx on public.estimate_line_items_v2(price_snapshot_id, workspace_id);
create index estimate_line_items_v2_assembly_version_idx on public.estimate_line_items_v2(assembly_version_id);
create index estimate_line_items_v2_workspace_idx on public.estimate_line_items_v2(workspace_id);

create index estimate_adjustments_v2_estimate_scope_idx on public.estimate_adjustments_v2(estimate_id, workspace_id, project_id);
create index estimate_adjustments_v2_workspace_idx on public.estimate_adjustments_v2(workspace_id);

create index estimate_recommendations_v2_estimate_scope_idx on public.estimate_recommendations_v2(estimate_id, workspace_id, project_id);
create index estimate_recommendations_v2_accepted_by_idx on public.estimate_recommendations_v2(accepted_by);
create index estimate_recommendations_v2_workspace_idx on public.estimate_recommendations_v2(workspace_id);

create index estimate_rfis_v2_estimate_scope_idx on public.estimate_rfis_v2(estimate_id, workspace_id, project_id);
create index estimate_rfis_v2_resolved_by_idx on public.estimate_rfis_v2(resolved_by);
create index estimate_rfis_v2_workspace_idx on public.estimate_rfis_v2(workspace_id);
