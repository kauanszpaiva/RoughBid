import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../migrations/20260911160000_project_estimate_versions.sql', import.meta.url), 'utf8');

test('estimate snapshots are immutable, tenant scoped, hash addressed and trigger generated', () => {
  assert.match(migration, /create table public\.project_estimate_versions/);
  assert.match(migration, /foreign key \(project_id, workspace_id\)/);
  assert.match(migration, /state_sha256 text not null/);
  assert.match(migration, /calculation-v1-fixed-6dp/);
  assert.match(migration, /unique \(workspace_id, project_id, revision\)/);
  assert.match(migration, /unique \(workspace_id, project_id, state_sha256\)/);
  assert.match(migration, /revoke all on table public\.project_estimate_versions from public, anon, authenticated/);
  assert.match(migration, /grant select on table public\.project_estimate_versions to authenticated/);
  assert.match(migration, /after insert or update of app_state on public\.projects/);
  assert.match(migration, /before update or delete on public\.project_estimate_versions/);
  assert.doesNotMatch(migration, /grant (insert|update|delete|all) on table public\.project_estimate_versions to authenticated/i);
});

test('estimate snapshot RLS uses hardened private helpers and requires active product access', () => {
  assert.match(migration, /private\.has_workspace_access\(workspace_id\)/);
  assert.match(migration, /private\.has_product_access\(\)/);
  assert.doesNotMatch(migration, /public\.has_workspace_access\(workspace_id\)/);
});

test('estimate history cannot be silently removed by deleting its project or workspace', () => {
  assert.match(migration, /workspace_id uuid not null references public\.workspaces\(id\) on delete restrict/);
  assert.match(migration, /references public\.projects\(id, workspace_id\) on delete restrict/);
  assert.doesNotMatch(migration, /references public\.projects\(id, workspace_id\) on delete cascade/);
});
