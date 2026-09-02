import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('RBAC and Class Pass migration provisions isolated workspaces atomically', async () => {
  const sql = (await readFile(new URL('../migrations/0004_auth_rbac_class_pass.sql', import.meta.url), 'utf8')).toLowerCase();
  for (const required of [
    "role in ('admin', 'estimator', 'viewer')", 'create table public.class_pass_tokens',
    'token_hash text not null unique', 'for update', 'create or replace function public.redeem_class_pass',
    "insert into public.workspaces", "insert into public.entitlements", "'class_pass_token'",
    'private.has_workspace_role', 'private.can_write_plan_object', 'enable row level security',
  ]) assert.ok(sql.includes(required), `missing security primitive: ${required}`);
});
