alter table public.projects
  add column if not exists app_state jsonb not null default '{}'::jsonb,
  add constraint projects_app_state_is_object check (jsonb_typeof(app_state) = 'object');

comment on column public.projects.app_state is
  'Full RoughBid estimator UI state for the project, scoped by workspace RLS while normalized project tables are widened.';
