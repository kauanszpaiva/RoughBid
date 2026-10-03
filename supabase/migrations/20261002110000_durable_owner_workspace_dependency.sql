-- Dependency of legacy durable owner_free branches, missing on the audited
-- commercial baseline. This does not enable free processing for any workspace.
-- Deliberately fail on an unexpected pre-existing relation (preflight drift).
create table private.free_owner_workspaces (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  note text,
  created_at timestamptz not null default now()
);
alter table private.free_owner_workspaces enable row level security;
revoke all on private.free_owner_workspaces from public, anon, authenticated;
grant all on private.free_owner_workspaces to service_role;
-- No allowlist rows, RPC replacement, findings CHECK changes, or credentials.
