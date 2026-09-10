import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

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

test('real SQL: accept_workspace_invite resolves workspace_id ambiguity without error and enforces security semantics', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema private; create schema storage;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid primary key, bucket_id text, name text);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
    `);

    // Load 0001_foundation, 0002_security_hardening, 0004_auth_rbac, 0005_workspace_invites, and 0022_fix_accept_workspace_invite
    const migration01 = (await readFile(new URL('../migrations/0001_foundation.sql', import.meta.url), 'utf8'))
      .replace('create extension if not exists pgcrypto with schema extensions;', '');
    const migration02 = await readFile(new URL('../migrations/0002_security_hardening.sql', import.meta.url), 'utf8');
    const migration04 = await readFile(new URL('../migrations/0004_auth_rbac_access_grants.sql', import.meta.url), 'utf8');
    const migration05 = await readFile(new URL('../migrations/0005_workspace_invites.sql', import.meta.url), 'utf8');
    const migration22 = await readFile(new URL('../migrations/0022_fix_accept_workspace_invite.sql', import.meta.url), 'utf8');

    await db.exec(migration01);
    await db.exec(migration02);
    await db.exec(migration04);
    await db.exec(migration05);

    const userAdmin = id(1);
    const userViewer = id(2);
    const userWrong = id(3);
    const workspaceId = id(10);

    await db.exec(`
      insert into auth.users (id, email) values
        ('${userAdmin}', 'admin@example.com'),
        ('${userViewer}', 'viewer@example.com'),
        ('${userWrong}', 'wrong@example.com');

      insert into public.workspaces (id, name, created_by) values ('${workspaceId}', 'QA Workspace', '${userAdmin}');
    `);

    // Create invites
    await db.exec(`
      insert into public.workspace_invites (id, workspace_id, email, role, token_hash, created_by, created_at, expires_at)
      values
        ('${id(100)}', '${workspaceId}', 'viewer@example.com', 'viewer', '${SHA_A}', '${userAdmin}', now(), now() + interval '14 days'),
        ('${id(101)}', '${workspaceId}', 'viewer@example.com', 'viewer', '${SHA_B}', '${userAdmin}', now() - interval '20 days', now() - interval '6 days'),
        ('${id(102)}', '${workspaceId}', 'viewer@example.com', 'estimator', '${SHA_C}', '${userAdmin}', now(), now() + interval '14 days'),
        ('${id(103)}', '${workspaceId}', 'viewer@example.com', 'viewer', '${SHA_D}', '${userAdmin}', now(), now() + interval '14 days');

      update public.workspace_invites set revoked_at = now() where id = '${id(102)}';
    `);

    // Test 1: Verify 0005 function directly in a rollback transaction failed with ambiguity
    await db.exec(`create or replace function auth.uid() returns uuid language sql as 'select ''${userViewer}''::uuid';`);
    let oldFailedWithError = false;
    await db.exec('BEGIN;');
    try {
      await db.query(`select * from public.accept_workspace_invite('${SHA_A}')`);
    } catch (err) {
      if (err instanceof Error && err.message.includes('ambiguous')) {
        oldFailedWithError = true;
      }
    } finally {
      await db.exec('ROLLBACK;');
    }
    assert.equal(oldFailedWithError, true, 'Old 0005 migration function failed with ambiguous workspace_id error');

    // Apply migration 0022 fix
    await db.exec(migration22);

    // Test 2: Mismatched email rejected
    await db.exec(`create or replace function auth.uid() returns uuid language sql as 'select ''${userWrong}''::uuid';`);
    await assert.rejects(
      () => db.query(`select * from public.accept_workspace_invite('${SHA_A}')`),
      /Invite email does not match the signed-in user/
    );

    // Test 3: Expired invite rejected
    await db.exec(`create or replace function auth.uid() returns uuid language sql as 'select ''${userViewer}''::uuid';`);
    await assert.rejects(
      () => db.query(`select * from public.accept_workspace_invite('${SHA_B}')`),
      /Invite is invalid, expired, or already used/
    );

    // Test 4: Revoked invite rejected
    await assert.rejects(
      () => db.query(`select * from public.accept_workspace_invite('${SHA_C}')`),
      /Invite is invalid, expired, or already used/
    );

    // Test 5: Call accept_workspace_invite as userViewer successfully
    const res = await db.query(`select * from public.accept_workspace_invite('${SHA_A}')`);
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].workspace_id, workspaceId);
    assert.equal(res.rows[0].role, 'viewer');

    // Verify membership was created
    const memberRes = await db.query(`select * from public.workspace_members where workspace_id = '${workspaceId}' and user_id = '${userViewer}'`);
    assert.equal(memberRes.rows.length, 1);
    assert.equal(memberRes.rows[0].role, 'viewer');

    // Test 6: Replay behavior / already accepted
    await assert.rejects(
      () => db.query(`select * from public.accept_workspace_invite('${SHA_A}')`),
      /Invite is invalid, expired, or already used/
    );

    // Test 7: Admin role protection (no downgrade on re-invite accept)
    // Promote userViewer to admin
    await db.exec(`update public.workspace_members set role = 'admin' where workspace_id = '${workspaceId}' and user_id = '${userViewer}';`);
    // Accept viewer invite SHA_D
    await db.query(`select * from public.accept_workspace_invite('${SHA_D}')`);
    const adminCheckRes = await db.query(`select role from public.workspace_members where workspace_id = '${workspaceId}' and user_id = '${userViewer}'`);
    assert.equal(adminCheckRes.rows[0].role, 'admin', 'Admin role preserved upon accepting viewer invite');

  } finally {
    await db.close();
  }
});
