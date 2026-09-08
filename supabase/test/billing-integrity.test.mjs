import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const user = '00000000-0000-4000-8000-000000000001';
const owner = '00000000-0000-4000-8000-000000000002';
test('SQL checkout claims and Stripe state protect concurrent purchases and stale event writes', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create table profiles(id uuid primary key,is_platform_admin boolean not null default false);
      create table billing_customers(user_id uuid primary key,stripe_customer_id text unique,stripe_subscription_id text unique,stripe_price_id text,subscription_status text,current_period_end timestamptz,updated_at timestamptz default now());
      create table stripe_events(event_id text primary key,event_type text,livemode boolean);
      create function process_stripe_event(text,text,boolean,uuid,text,text,text,text,timestamptz) returns boolean language sql as 'select true';
      create function get_pilot_access(uuid) returns jsonb language sql as 'select jsonb_build_object(''active'',false)';
      insert into auth.users values('${user}'),('${owner}');
      insert into profiles values('${user}',false),('${owner}',true);
    `);
    await db.exec(readFileSync(new URL('../migrations/0030_billing_checkout_integrity.sql', import.meta.url), 'utf8'));
    const claim = (id=user,tier='plan_pro') => db.query('select claim_billing_checkout($1,$2) as result',[id,tier]);
    const concurrent = await Promise.all([claim(), claim()]);
    assert.equal(concurrent[0].rows[0].result.id, concurrent[1].rows[0].result.id);
    await assert.rejects(claim(user,'plan_team'), /different membership/i);
    await assert.rejects(claim(owner), /complimentary owner/i);
    await db.exec(`create or replace function get_pilot_access(uuid) returns jsonb language sql as 'select jsonb_build_object(''active'',true)'`);
    await assert.rejects(claim(), /sponsored pilot is active/i);
    await db.exec(`create or replace function get_pilot_access(uuid) returns jsonb language sql as 'select jsonb_build_object(''active'',false)'`);
    await db.query('select save_billing_customer($1,$2)',[user,'cus_verified']);
    await assert.rejects(db.query('select save_billing_customer($1,$2)',[user,'cus_other']), /identity mismatch/i);

    const sync = async () => (await db.query("select begin_billing_subscription_sync('sub_verified') as n")).rows[0].n;
    const older = await sync(); const newer = await sync();
    const apply = (event,revision,status='active',paid=true,customer='cus_verified') => db.query(
      'select process_stripe_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as applied',
      [event,'invoice.paid',false,user,customer,'sub_verified','price_Pro123',status,'2030-01-01',paid,revision]);
    await apply('evt_new',newer,'past_due',false);
    await apply('evt_old',older,'active',true);
    let row = (await db.query('select * from billing_customers')).rows[0];
    assert.equal(row.subscription_status,'past_due'); assert.equal(row.invoice_paid,false);
    assert.equal((await apply('evt_new',newer)).rows[0].applied,false);
    await assert.rejects(claim(), /existing subscription/i);
    await assert.rejects(apply('evt_mismatch',await sync(),'active',true,'cus_other'), /identity mismatch/i);
    assert.equal((await db.query("select count(*)::int as n from stripe_events where event_id='evt_mismatch'")).rows[0].n,0);
    await apply('evt_paid',await sync());
    row = (await db.query('select * from billing_customers')).rows[0];
    assert.equal(row.subscription_status,'active'); assert.equal(row.invoice_paid,true);
    await db.exec('set role authenticated');
    await assert.rejects(claim(), /permission denied/i);
  } finally { await db.close(); }
});
