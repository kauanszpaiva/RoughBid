# Tenant, project, and user isolation

RoughBid is a multi-tenant SaaS. The security boundary is the Supabase user plus
workspace membership. Frontend state is never the authorization boundary.

## Identity model

- User identity comes from Supabase Auth.
- A user can belong to many workspaces.
- A workspace is the tenant boundary for organizations.
- Every project belongs to exactly one workspace.
- Project files, estimates, plan-reading jobs, plan-reading findings, proposal
  links, and proposal events must carry the same `workspace_id` as their parent
  project.

## Role model

| Role | Intended access |
| --- | --- |
| `admin` | Manage workspace, members, invites, projects, estimates, files, and proposals |
| `estimator` | Create and edit projects, estimates, files, AI readings, and proposals |
| `viewer` | Read workspace project data only |

Workspace invites can only create `estimator` or `viewer` memberships. Admin
promotion must happen through an existing admin session.

## Database enforcement

RLS controls who can access a workspace. Composite foreign keys control whether
the submitted IDs actually belong together:

- `projects(id, workspace_id)` is the parent identity for project records.
- `estimates(id, workspace_id, project_id)` is the parent identity for pricing
  and audit records.
- `project_files(id, workspace_id, project_id)` is the parent identity for plan
  file and plan-reading records.
- `client_proposals(id, workspace_id)` is the parent identity for public proposal
  events.

This means a request cannot use a valid `x-workspace-id` from one organization
with a `project_id`, `estimate_id`, or `file_id` from another organization.

## API rules

- Authenticated API routes use the caller's Supabase token with the publishable
  key, so RLS stays active.
- Service-role access is restricted to billing webhooks, grant issuance, and
  background worker tasks that cannot safely run as an end user.
- Routes accepting `x-workspace-id` must still include project/file/estimate IDs
  in database filters or rely on composite constraints for writes.
- Public proposal links are token based. Plain tokens are never stored; the
  database stores only SHA-256 hashes.
- Public proposal RPCs return a client-safe snapshot, not internal estimate cost
  data.

## Sensitive data rules

- Do not log invite tokens, proposal tokens, Supabase JWTs, Stripe payload
  secrets, Resend keys, OpenAI keys, object-storage keys, signed file URLs, or
  raw construction-plan contents.
- Keep plan PDFs in private object storage.
- Use short-lived signed download URLs.
- Store public proposal snapshots separately from internal estimating inputs.
- Hash signature IP metadata before persistence when IP capture is enabled.

## Operational checks before launch

- Confirm Supabase RLS is enabled on every application table.
- Confirm no browser bundle receives service-role keys or secret API keys.
- Confirm every table with `workspace_id` and a parent `project_id` has a
  same-workspace constraint.
- Confirm invite acceptance requires the signed-in e-mail to match the invite.
- Confirm viewers cannot mutate project data.
- Confirm cross-workspace project/file/estimate IDs fail at the database layer,
  even if the API payload is forged.
