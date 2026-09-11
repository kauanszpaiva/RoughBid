-- Canonical jurisdiction inputs for DONE A. Existing projects remain readable
-- and must be completed in the UI before jurisdiction-dependent release.
alter table public.projects
  add column client_name text,
  add column project_type text,
  add column jurisdiction_state text,
  add column municipality text,
  add column postal_code text,
  add column permit_date date,
  add constraint projects_client_name_length check (client_name is null or char_length(client_name) between 1 and 160),
  add constraint projects_project_type_length check (project_type is null or char_length(project_type) between 1 and 120),
  add constraint projects_new_england_state check (jurisdiction_state is null or jurisdiction_state in ('CT','MA','ME','NH','RI','VT')),
  add constraint projects_municipality_length check (municipality is null or char_length(municipality) between 1 and 120),
  add constraint projects_postal_code check (postal_code is null or postal_code ~ '^\d{5}(-\d{4})?$');

create index projects_jurisdiction_idx
  on public.projects(jurisdiction_state, municipality, permit_date)
  where jurisdiction_state is not null;

comment on column public.projects.permit_date is
  'Permit filing date, or the confirmed pricing/code applicability date when no permit has been filed.';
