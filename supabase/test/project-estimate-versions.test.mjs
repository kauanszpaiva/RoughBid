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
  assert.match(migration, /before update on public\.project_estimate_versions/);
  assert.doesNotMatch(migration, /grant (insert|update|delete|all) on table public\.project_estimate_versions to authenticated/i);
});
