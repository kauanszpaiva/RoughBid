import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const migrationUrl = new URL('../migrations/20260911170000_workspace_catalog_versions.sql', import.meta.url);
const migration = existsSync(migrationUrl) ? readFileSync(migrationUrl, 'utf8') : '';

test('workspace catalog migration exists and is tenant scoped', () => {
  assert.equal(existsSync(migrationUrl), true, 'workspace catalog migration must exist');
  assert.match(migration, /create table public\.workspace_catalog_versions/);
  assert.match(migration, /private\.has_workspace_access\(workspace_id\)/);
  assert.match(migration, /private\.has_product_access\(\)/);
  assert.doesNotMatch(migration, /grant (insert|update|delete|all) on table public\.workspace_catalog_versions to authenticated/i);
});

test('workspace catalog history is immutable and cannot disappear through parent deletion', () => {
  assert.match(migration, /workspace_id uuid not null references public\.workspaces\(id\) on delete restrict/);
  assert.match(migration, /before update or delete on public\.workspace_catalog_versions/);
  assert.doesNotMatch(migration, /references public\.workspaces\(id\) on delete cascade/);
});

test('restoring historical catalog content creates a new latest revision while identical current saves remain idempotent', () => {
  assert.doesNotMatch(migration, /unique \(workspace_id, content_sha256\)/);
  assert.match(migration, /current_content_sha256/);
  assert.match(migration, /if content_hash = current_content_sha256 then/);
  assert.match(migration, /current_revision \+ 1/);
});

test('direct catalog RPC rejects missing required strings, units and numeric fields', () => {
  assert.match(migration, /coalesce\(jsonb_typeof\(item -> 'id'\), ''\) <> 'string'/);
  assert.match(migration, /coalesce\(item ->> 'unit', ''\) not in \('SF','LF','EA','CY','SY','HR','LS'\)/);
  assert.match(migration, /not \(item \? 'unitCost' or item \? 'unitPrice'\)/);
  assert.match(migration, /materialCostPerUnit/);
  assert.match(migration, /laborCostPerUnit/);
  assert.match(migration, /equipmentCostPerUnit/);
});
