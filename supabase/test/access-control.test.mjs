import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('RBAC and access grant migration provisions isolated workspaces atomically', async () => {
  const sql = (await readFile(new URL('../migrations/0004_auth_rbac_access_grants.sql', import.meta.url), 'utf8')).toLowerCase();
  for (const required of [
    "role in ('admin', 'estimator', 'viewer')", 'create table public.access_grant_tokens',
    'token_hash text not null unique', 'for update', 'create or replace function public.redeem_access_grant',
    "insert into public.workspaces", "insert into public.entitlements", "'access_grant_token'",
    'private.has_workspace_role', 'private.can_write_plan_object', 'enable row level security',
  ]) assert.ok(sql.includes(required), `missing security primitive: ${required}`);
});

test('workspace invites are hashed, email-bound, and admin-created', async () => {
  const sql = (await readFile(new URL('../migrations/0005_workspace_invites.sql', import.meta.url), 'utf8')).toLowerCase();
  for (const required of [
    'create table public.workspace_invites',
    'token_hash text not null unique',
    "role text not null default 'estimator'",
    'enable row level security',
    'workspace_invites_insert_admin',
    'created_by = auth.uid()',
    'create or replace function public.accept_workspace_invite',
    'for update',
    'from auth.users',
    'signed_in_email <> invite.email',
    'on conflict (workspace_id, user_id) do update',
  ]) assert.ok(sql.includes(required), `missing invite security primitive: ${required}`);
});

test('legacy access migration removes class-specific grant contract', async () => {
  const sql = (await readFile(new URL('../migrations/0006_remove_class_pass_legacy.sql', import.meta.url), 'utf8')).toLowerCase();
  for (const required of [
    'rename to access_grant_tokens',
    "set kind = 'access_grant'",
    "source = case when source = 'class_pass_token' then 'access_grant_token'",
    'drop function if exists public.redeem_class_pass',
    'create or replace function public.redeem_access_grant',
    "check (kind in ('access_grant', 'subscription', 'admin'))",
  ]) assert.ok(sql.includes(required), `missing legacy cleanup primitive: ${required}`);
  const fixedWindowPattern = new RegExp(String.raw`interval\s+'` + '60' + String.raw`\s+days'`);
  assert.equal(fixedWindowPattern.test(sql), false);
});
