import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOKEN = 'a'.repeat(64);

test('workspace invite acceptance succeeds without output-column ambiguity', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create schema private;
      create schema storage;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid primary key, bucket_id text, name text);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
    `);

    const migration01 = (await readFile(new URL('../migrations/0001_foundation.sql', import.meta.url), 'utf8'))
      .replace('create extension if not exists pgcrypto with schema extensions;', '');
    const migration02 = await readFile(new URL('../migrations/0002_security_hardening.sql', import.meta.url), 'utf8');
    const migration04 = await readFile(new URL('../migrations/0004_auth_rbac_access_grants.sql', import.meta.url), 'utf8');
    const migration05 = await readFile(new URL('../migrations/0005_workspace_invites.sql', import.meta.url), 'utf8');

    await db.exec(migration01);
    await db.exec(migration02);
    await db.exec(migration04);
    await db.exec(migration05);

    const migrationNames = (await readdir(new URL('../migrations/', import.meta.url)))
      .filter((name) => name.includes('fix_accept_workspace_invite') && name.endsWith('.sql'))
      .sort();
    for (const name of migrationNames) {
      await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    }

    const adminId = id(1);
    const viewerId = id(2);
    const workspaceId = id(10);

    await db.exec(`
      insert into auth.users (id, email) values
        ('${adminId}', 'admin@example.com'),
        ('${viewerId}', 'viewer@example.com');
      insert into public.workspaces (id, name, created_by)
        values ('${workspaceId}', 'Invite Regression Workspace', '${adminId}');
      insert into public.workspace_invites
        (id, workspace_id, email, role, token_hash, created_by, created_at, expires_at)
        values ('${id(100)}', '${workspaceId}', 'viewer@example.com', 'viewer', '${TOKEN}', '${adminId}', now(), now() + interval '14 days');
      create or replace function auth.uid() returns uuid language sql as 'select ''${viewerId}''::uuid';
    `);

    const accepted = await db.query(`select * from public.accept_workspace_invite('${TOKEN}')`);
    assert.equal(accepted.rows.length, 1);
    assert.equal(accepted.rows[0].workspace_id, workspaceId);
    assert.equal(accepted.rows[0].role, 'viewer');

    const membership = await db.query(`
      select role from public.workspace_members
      where workspace_id = '${workspaceId}' and user_id = '${viewerId}'
    `);
    assert.equal(membership.rows[0]?.role, 'viewer');
  } finally {
    await db.close();
  }
});
