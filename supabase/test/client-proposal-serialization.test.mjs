import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../migrations/0038_serialize_client_proposal_actions.sql', import.meta.url), 'utf8');

async function fixture(t, { locked = true, probe = false } = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema private;
    create table auth.users(id uuid primary key, email text);
    create table public.client_proposals(
      id uuid primary key default gen_random_uuid(), workspace_id uuid,
      token_hash text unique, title text, client_name text, client_email text,
      total_amount numeric, status text default 'sent', expires_at timestamptz,
      created_by uuid, first_viewed_at timestamptz, last_viewed_at timestamptz,
      signed_at timestamptz, signature_name text, signature_ip_hash text,
      signature_user_agent text, public_payload jsonb default '{}'
    );
    create table public.client_proposal_events(
      proposal_id uuid, workspace_id uuid, event_type text, event_metadata jsonb
    );
    insert into auth.users values('00000000-0000-0000-0000-000000000001','owner@example.invalid');
  `);
  let sql = locked ? migration : migration.replaceAll('for update of cp', '');
  if (probe) {
    await requirePriorRowLock(db);
    sql = sql.replaceAll('  update public.client_proposals',
      '  perform private.assert_proposal_lock(proposal.id);\n  update public.client_proposals');
  }
  await db.exec(sql);
  return db;
}

async function proposal(db, token = 'valid', status = 'sent', expired = false) {
  await db.query(`insert into public.client_proposals(
    token_hash,title,client_name,total_amount,expires_at,created_by,status
  ) values($1,'Estimate','Client',123,now()+$3::interval,
    '00000000-0000-0000-0000-000000000001',$2)`, [token, status, expired ? '-1 day' : '1 day']);
}

// PGlite has one connection, so Promise.all would not reproduce a transaction
// race. A probe between the read and UPDATE verifies the real PostgreSQL tuple
// was locked by this transaction before the UPDATE acquires its own lock.
// Removing FOR UPDATE must fail the same probe.
async function requirePriorRowLock(db) {
  await db.exec(`
    create function private.assert_proposal_lock(p_id uuid) returns void language plpgsql as $$
    declare locked_by text;
    begin
      select cp.xmax::text into locked_by from public.client_proposals cp where cp.id=p_id;
      if locked_by <> pg_current_xact_id()::text then
        raise exception 'Proposal must be locked before mutation';
      end if;
    end $$;
  `);
}

test('every public proposal action locks its tuple before mutating it', async (t) => {
  const db = await fixture(t, { probe: true });
  for (const [i, call] of [
    `select * from public.get_client_proposal($1)`,
    `select * from public.sign_client_proposal($1,'First signer')`,
    `select * from public.track_client_proposal_open($1)`,
  ].entries()) {
    await proposal(db, `lock-${i}`);
    assert.equal((await db.query(call, [`lock-${i}`])).rows.length, 1);
  }
});

test('row-lock probe rejects the previous unlocked implementation', async (t) => {
  const db = await fixture(t, { locked: false, probe: true });
  await proposal(db);
  await assert.rejects(db.query(`select * from public.sign_client_proposal('valid','First signer')`), /must be locked before mutation/);
});

test('only the first open requests notification and the first signature is preserved', async (t) => {
  const db = await fixture(t);
  await proposal(db);
  assert.equal((await db.query(`select * from public.get_client_proposal('valid')`)).rows[0].was_first_open, true);
  assert.equal((await db.query(`select * from public.get_client_proposal('valid')`)).rows[0].was_first_open, false);
  const first = await db.query(`select * from public.sign_client_proposal('valid','First signer')`);
  assert.equal(first.rows[0].signature_name, 'First signer');
  assert.deepEqual((await db.query(`select * from public.sign_client_proposal('valid','Second signer')`)).rows, []);
  const reread = (await db.query(`select * from public.get_client_proposal('valid')`)).rows[0];
  assert.equal(reread.status, 'signed');
  assert.equal(reread.signature_name, 'First signer');
  assert.equal((await db.query(`select count(*)::int n from public.client_proposal_events where event_type='signed'`)).rows[0].n, 1);
});

test('revoked, expired and unknown tokens cause no signature or event', async (t) => {
  const db = await fixture(t);
  await proposal(db, 'revoked', 'revoked');
  await proposal(db, 'expired', 'sent', true);
  for (const token of ['revoked', 'expired', 'missing']) {
    assert.deepEqual((await db.query(`select * from public.sign_client_proposal($1,'Signer')`, [token])).rows, []);
    assert.deepEqual((await db.query(`select * from public.get_client_proposal($1)`, [token])).rows, []);
    assert.deepEqual((await db.query(`select * from public.track_client_proposal_open($1)`, [token])).rows, []);
  }
  assert.equal((await db.query(`select count(*)::int n from public.client_proposal_events`)).rows[0].n, 0);
});
