import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const token = (char) => char.repeat(64);

async function setUid(db, userId) {
  await db.exec(`create or replace function auth.uid() returns uuid language sql as 'select ''${userId}''::uuid';`);
}

async function setup() {
  const db = new PGlite();
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
  for (const name of ['0002_security_hardening.sql', '0004_auth_rbac_access_grants.sql', '0005_workspace_invites.sql', '0036_fix_accept_workspace_invite.sql']) {
    if (name === '0002_security_hardening.sql') await db.exec(migration01);
    await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  return db;
}

test('workspace invite acceptance is bound, single-use, scoped, and preserves admin', async () => {
  const db = await setup();
  try {
    const admin = id(1), invited = id(2), other = id(3);
    const wsA = id(10), wsB = id(11);
    await db.exec(`
      insert into auth.users (id,email) values
        ('${admin}','admin@example.com'),('${invited}','viewer@example.com'),('${other}','other@example.com');
      insert into public.workspaces (id,name,created_by) values
        ('${wsA}','Workspace A','${admin}'),('${wsB}','Workspace B','${admin}');
      insert into public.workspace_members (workspace_id,user_id,role) values ('${wsB}','${invited}','admin');

      insert into public.workspace_invites (id,workspace_id,email,role,token_hash,created_by,created_at,expires_at)
      values
        ('${id(100)}','${wsA}','viewer@example.com','viewer','${token('a')}','${admin}',now(),now()+interval '1 day'),
        ('${id(101)}','${wsA}','viewer@example.com','viewer','${token('b')}','${admin}',now()-interval '2 days',now()-interval '1 day'),
        ('${id(102)}','${wsA}','viewer@example.com','viewer','${token('c')}','${admin}',now(),now()+interval '1 day'),
        ('${id(103)}','${wsB}','viewer@example.com','viewer','${token('d')}','${admin}',now(),now()+interval '1 day');
      update public.workspace_invites set revoked_at=now() where id='${id(102)}';
    `);

    await setUid(db, other);
    await assert.rejects(db.query(`select * from public.accept_workspace_invite('${token('a')}')`), /email does not match/i);
    assert.equal((await db.query(`select count(*)::int as n from public.workspace_members where workspace_id='${wsA}' and user_id='${other}'`)).rows[0].n, 0);

    await setUid(db, invited);
    await assert.rejects(db.query(`select * from public.accept_workspace_invite('not-a-digest')`), /invalid invite token/i);
    await assert.rejects(db.query(`select * from public.accept_workspace_invite('${token('b')}')`), /invalid, expired, or already used/i);
    await assert.rejects(db.query(`select * from public.accept_workspace_invite('${token('c')}')`), /invalid, expired, or already used/i);

    const acceptedA = await db.query(`select * from public.accept_workspace_invite('${token('a')}')`);
    assert.equal(acceptedA.rows[0].workspace_id, wsA);
    assert.equal(acceptedA.rows[0].role, 'viewer');
    await assert.rejects(db.query(`select * from public.accept_workspace_invite('${token('a')}')`), /invalid, expired, or already used/i);

    assert.equal((await db.query(`select role from public.workspace_members where workspace_id='${wsA}' and user_id='${invited}'`)).rows[0].role, 'viewer');
    assert.equal((await db.query(`select role from public.workspace_members where workspace_id='${wsB}' and user_id='${invited}'`)).rows[0].role, 'admin');

    const acceptedB = await db.query(`select * from public.accept_workspace_invite('${token('d')}')`);
    assert.equal(acceptedB.rows[0].workspace_id, wsB);
    assert.equal((await db.query(`select role from public.workspace_members where workspace_id='${wsB}' and user_id='${invited}'`)).rows[0].role, 'admin');
  } finally {
    await db.close();
  }
});
