-- Tenant integrity hardening.
-- RLS answers "who can access this workspace"; these foreign keys answer
-- "do all referenced records actually belong to that same workspace/project?"

alter table public.estimates
  add constraint estimates_id_workspace_project_unique
  unique (id, workspace_id, project_id);

alter table public.project_files
  add constraint project_files_id_workspace_project_unique
  unique (id, workspace_id, project_id);

alter table public.plan_reading_jobs
  add constraint plan_reading_jobs_id_workspace_project_file_unique
  unique (id, workspace_id, project_id, file_id);

alter table public.estimates
  add constraint estimates_project_workspace_fkey
  foreign key (project_id, workspace_id)
  references public.projects(id, workspace_id)
  on delete cascade;

alter table public.estimate_audit_log
  add constraint estimate_audit_log_estimate_workspace_project_fkey
  foreign key (estimate_id, workspace_id, project_id)
  references public.estimates(id, workspace_id, project_id)
  on delete restrict;

alter table public.plan_reading_jobs
  add constraint plan_reading_jobs_project_workspace_fkey
  foreign key (project_id, workspace_id)
  references public.projects(id, workspace_id)
  on delete cascade,
  add constraint plan_reading_jobs_file_workspace_project_fkey
  foreign key (file_id, workspace_id, project_id)
  references public.project_files(id, workspace_id, project_id)
  on delete cascade;

alter table public.plan_reading_findings
  add constraint plan_reading_findings_job_workspace_project_file_fkey
  foreign key (job_id, workspace_id, project_id, file_id)
  references public.plan_reading_jobs(id, workspace_id, project_id, file_id)
  on delete cascade,
  add constraint plan_reading_findings_file_workspace_project_fkey
  foreign key (file_id, workspace_id, project_id)
  references public.project_files(id, workspace_id, project_id)
  on delete cascade;

alter table public.client_proposals
  add constraint client_proposals_project_workspace_fkey
  foreign key (project_id, workspace_id)
  references public.projects(id, workspace_id)
  on delete cascade,
  add constraint client_proposals_estimate_workspace_project_fkey
  foreign key (estimate_id, workspace_id, project_id)
  references public.estimates(id, workspace_id, project_id)
  on delete restrict;

alter table public.client_proposals
  add constraint client_proposals_id_workspace_unique
  unique (id, workspace_id);

alter table public.client_proposal_events
  add constraint client_proposal_events_proposal_workspace_fkey
  foreign key (proposal_id, workspace_id)
  references public.client_proposals(id, workspace_id)
  on delete cascade;

comment on constraint estimates_project_workspace_fkey on public.estimates is
  'Prevents an estimate from pointing at a project outside its workspace.';
comment on constraint client_proposals_estimate_workspace_project_fkey on public.client_proposals is
  'Prevents a public proposal from mixing tenant/project identity with an estimate from another tenant.';
