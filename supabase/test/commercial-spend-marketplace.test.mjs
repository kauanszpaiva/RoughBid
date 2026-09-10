import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const admin = '00000000-0000-4000-8000-000000000001';
const estimator = '00000000-0000-4000-8000-000000000002';
const workspace = '10000000-0000-4000-8000-000000000001';
const project = '20000000-0000-4000-8000-000000000001';
const job = '30000000-0000-4000-8000-000000000001';

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key);
    create table profiles(id uuid primary key,is_platform_admin boolean not null default false);
    create table workspaces(id uuid primary key);
    create table workspace_members(workspace_id uuid,user_id uuid,role text,primary key(workspace_id,user_id));
    create table projects(id uuid primary key,workspace_id uuid not null,unique(id,workspace_id));
    create table plan_reading_jobs(id uuid primary key,workspace_id uuid not null,requested_by uuid,unique(id,workspace_id));
    create table api_usage_events(id uuid primary key,workspace_id uuid,project_id uuid,user_id uuid,provider text,model text,operation text,input_tokens int default 0,output_tokens int default 0,estimated_cost_usd numeric default 0,actual_cost_usd numeric,sensitive_payload boolean default false,provider_request_id text,created_at timestamptz default now());
    create table marketplace_entitlements(id uuid primary key default gen_random_uuid(),workspace_id uuid,feed_id text,status text default 'trialing' check(status in ('trialing','active','canceled','revoked','expired')),region_coverage text[] default '{}',stripe_subscription_item_id text,source_license text,created_by uuid,starts_at timestamptz default now(),expires_at timestamptz,created_at timestamptz default now(),unique(workspace_id,feed_id));
    create table marketplace_purchases(id uuid primary key default gen_random_uuid(),workspace_id uuid,feed_id text,stripe_checkout_session_id text unique,stripe_invoice_id text unique,amount_paid_usd numeric not null,data_cogs_usd numeric default 0,created_at timestamptz default now());
    create table stripe_price_mappings(id uuid primary key default gen_random_uuid(),internal_id text,internal_type text,stripe_price_id text unique,mode text,active boolean default true,created_at timestamptz default now(),unique(internal_id,internal_type,mode));
    create table billing_customers(user_id uuid primary key,stripe_customer_id text unique,stripe_subscription_id text unique,stripe_price_id text,subscription_status text,current_period_end timestamptz,invoice_paid boolean default false,updated_at timestamptz default now());
    create table billing_subscription_sync(subscription_id text primary key,revision bigint default 1);
    create table stripe_events(event_id text primary key,event_type text,livemode boolean);
    create function process_stripe_event(text,text,boolean,uuid,text,text,text,text,timestamptz,boolean,bigint) returns boolean language sql as 'select true';
    create function get_pilot_access(uuid) returns jsonb language sql as 'select jsonb_build_object(''active'',false)';
    insert into auth.users values('${admin}'),('${estimator}');
    insert into profiles values('${admin}',false),('${estimator}',false);
    insert into workspaces values('${workspace}');
    insert into workspace_members values('${workspace}','${admin}','admin'),('${workspace}','${estimator}','estimator');
    insert into projects values('${project}','${workspace}');
    insert into plan_reading_jobs values('${job}','${workspace}','${admin}');
  `);
  await db.exec(readFileSync(new URL('../migrations/0039_commercial_spend_and_marketplace.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../migrations/0041_retry_stale_stripe_reconciliation.sql', import.meta.url), 'utf8'));
  return db;
}

test('company provider breaker atomically reserves, retains unknown exposure, and is service-only', async () => {
  const db = await database();
  try {
    await db.exec("update provider_spend_policy set spend_cap_usd=5,call_reservation_usd=2.5");
    const reserve = id => db.query("select reserve_provider_spend($1,$2,$3,$4,'gemini','gemini-3.8-flash')",[id,job,workspace,admin]);
    const first='40000000-0000-4000-8000-000000000001', second='40000000-0000-4000-8000-000000000002', third='40000000-0000-4000-8000-000000000003';
    for (const id of [first,second,third]) await db.query("insert into api_usage_events(id,workspace_id,project_id,user_id,provider,model,operation) values($1,$2,$3,$4,'gemini','gemini-3.8-flash','pending')",[id,workspace,project,admin]);
    await reserve(first); await db.query('select capture_provider_spend($1,$2)',[first,0.02]);
    await reserve(second); await db.query('select capture_provider_spend($1,$2)',[second,null]);
    await assert.rejects(reserve(third),/company ai spend limit/i);
    const again=await reserve(first); assert.equal(again.rows.length,1);
    const row=(await db.query('select * from provider_spend_reservations where event_id=$1',[second])).rows[0];
    assert.equal(row.telemetry_known,false); assert.equal(Number(row.reserved_usd),2.5);
    await db.exec('set role authenticated');
    await assert.rejects(reserve(first),/permission denied/i);
  } finally { await db.close(); }
});

test('Marketplace checkout and webhook reconciliation are workspace-scoped, paid, and revocable', async () => {
  const db = await database();
  try {
    await db.exec("insert into stripe_price_mappings(internal_id,internal_type,stripe_price_id,mode) values('supplier_import','marketplace_feed','price_supplier_test','test')");
    const claim=()=>db.query("select claim_marketplace_checkout($1,$2,'supplier_import','price_supplier_test','test') as result",[admin,workspace]);
    const [one,two]=await Promise.all([claim(),claim()]);
    assert.equal(one.rows[0].result.id,two.rows[0].result.id);
    await assert.rejects(db.query("select claim_marketplace_checkout($1,$2,'supplier_import','price_supplier_test','test')",[estimator,workspace]),/administrator/i);
    await db.query("insert into billing_customers(user_id,stripe_customer_id) values($1,'cus_market')",[admin]);
    await db.exec("insert into billing_subscription_sync(subscription_id,revision) values('sub_market',1)");
    await db.exec("update billing_subscription_sync set revision=2 where subscription_id='sub_market'");
    await assert.rejects(db.query(`select process_stripe_event(
      'evt_stale_claim','invoice.paid',false,$1,'cus_market','sub_market','price_supplier_test','active','2030-01-01',true,1,
      $2,'supplier_import','in_market','cs_market',4900,'usd',false)`,[admin,workspace]),/stale stripe verification/i);
    assert.equal(Number((await db.query("select count(*) as count from stripe_events where event_id='evt_stale_claim'")).rows[0].count),0);
    const apply=(event,status='active',paid=true,force=false)=>db.query(`select process_stripe_event(
      $1,'invoice.paid',false,$2,'cus_market','sub_market','price_supplier_test',$3,'2030-01-01',$4,2,
      $5,'supplier_import','in_market','cs_market',4900,'usd',$6) as applied`,[event,admin,status,paid,workspace,force]);
    assert.equal((await apply('evt_market')).rows[0].applied,true);
    assert.equal((await apply('evt_market')).rows[0].applied,false);
    let entitlement=(await db.query("select * from marketplace_entitlements where workspace_id=$1 and feed_id='supplier_import'",[workspace])).rows[0];
    assert.equal(entitlement.status,'active'); assert.equal(entitlement.invoice_paid,true);
    const purchase=(await db.query("select * from marketplace_purchases where stripe_invoice_id='in_market'")).rows[0];
    assert.equal(Number(purchase.amount_paid_usd),49); assert.equal(purchase.currency,'usd'); assert.equal(purchase.livemode,false);
    await db.exec("update billing_subscription_sync set revision=3 where subscription_id='sub_market'");
    const revoked=await db.query(`select process_stripe_event(
      'evt_refund','charge.refunded',false,$1,'cus_market','sub_market','price_supplier_test','active','2030-01-01',false,3,
      $2,'supplier_import',null,null,null,null,true)`,[admin,workspace]);
    assert.equal(revoked.rows.length,1);
    entitlement=(await db.query("select * from marketplace_entitlements where workspace_id=$1 and feed_id='supplier_import'",[workspace])).rows[0];
    assert.equal(entitlement.status,'revoked'); assert.equal(entitlement.invoice_paid,false);
    await db.exec("update billing_subscription_sync set revision=4 where subscription_id='sub_market'");
    await db.query(`select process_stripe_event(
      'evt_stale_paid','invoice.paid',false,$1,'cus_market','sub_market','price_supplier_test','active','2030-01-01',true,4,
      $2,'supplier_import','in_market',null,4900,'usd',false)`,[admin,workspace]);
    entitlement=(await db.query("select * from marketplace_entitlements where workspace_id=$1 and feed_id='supplier_import'",[workspace])).rows[0];
    assert.equal(entitlement.status,'revoked');assert.equal(entitlement.invoice_paid,false);
  } finally { await db.close(); }
});
