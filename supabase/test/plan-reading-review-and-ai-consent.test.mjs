import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('workspaces gain an explicit AI processing consent column', async () => {
  const sql = (await readFile(new URL('../migrations/0015_plan_reading_review_and_ai_consent.sql', import.meta.url), 'utf8')).toLowerCase();
  assert.match(sql, /alter table public\.workspaces\s+add column ai_processing_consented_at timestamptz/);
});

test('finding review RPC only ever changes status, checked against workspace role and product access', async () => {
  const sql = (await readFile(new URL('../migrations/0015_plan_reading_review_and_ai_consent.sql', import.meta.url), 'utf8')).toLowerCase();
  assert.match(sql, /create or replace function public\.set_plan_reading_finding_status/);
  assert.match(sql, /security definer/);
  assert.match(sql, /private\.has_workspace_role\(target_workspace, array\['admin', 'estimator'\]\)/);
  assert.match(sql, /private\.has_product_access\(\)/);
  assert.match(sql, /new_status not in \('needs_review', 'accepted', 'rejected'\)/);
  assert.match(sql, /revoke all on function public\.set_plan_reading_finding_status\(uuid, text\) from public, anon/);
  assert.match(sql, /grant execute on function public\.set_plan_reading_finding_status\(uuid, text\) to authenticated/);
});
