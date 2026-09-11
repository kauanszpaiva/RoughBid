import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../migrations/20260911170000_workspace_catalog_versions.sql', import.meta.url), 'utf8');

test('workspace catalog history is immutable and browser roles only receive SELECT', () => {
  assert.match(sql, /before update on public\.workspace_catalog_versions/i);
  assert.match(sql, /grant select on table public\.workspace_catalog_versions to authenticated/i);
  assert.doesNotMatch(sql, /grant (insert|update|delete|all) on table public\.workspace_catalog_versions to authenticated/i);
});

test('catalog writes require an estimator role and product access', () => {
  assert.match(sql, /private\.has_workspace_role\(p_workspace_id, array\['admin','estimator'\]\)/i);
  assert.match(sql, /private\.has_product_access\(\)/i);
  assert.match(sql, /grant execute on function public\.save_workspace_catalog_version[^;]+to authenticated/i);
});

test('catalog saves are serialized, hash-addressed, and conflict checked', () => {
  assert.match(sql, /from public\.workspaces where id = p_workspace_id for update/i);
  assert.match(sql, /p_expected_revision <> current_revision/i);
  assert.match(sql, /errcode = '40001'/i);
  assert.match(sql, /digest\(/i);
  assert.match(sql, /unique \(workspace_id, content_sha256\)/i);
});
