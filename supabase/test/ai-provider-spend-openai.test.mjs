import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const admin = '00000000-0000-4000-8000-000000000001';
const workspace = '10000000-0000-4000-8000-000000000001';
const project = '20000000-0000-4000-8000-000000000001';
const job = '30000000-0000-4000-8000-000000000001';

const migration = name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

async function database(options = { includeOpenAi: true }) {
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
    insert into auth.users values('${admin}');
    insert into profiles values('${admin}',false);
    insert into workspaces values('${workspace}');
    insert into workspace_members values('${workspace}','${admin}','admin');
    insert into projects values('${project}','${workspace}');
    insert into plan_reading_jobs values('${job}','${workspace}','${admin}');
  `);
  await db.exec(migration('0039_commercial_spend_and_marketplace.sql'));
  await db.exec(migration('0041_retry_stale_stripe_reconciliation.sql'));
  // The low-cost migration approves gemini/deepseek/kimi only; the OpenAI/Claude
  // migration is applied on top exactly as the deployment applies them in order.
  await db.exec(migration('20260919142500_low_cost_ai_provider_spend.sql'));
  if (options.includeOpenAi) await db.exec(migration('20260924134500_openai_claude_provider_spend.sql'));
  return db;
}

const reserve = (db, eventId, provider, model) =>
  db.query('select reserve_provider_spend($1,$2,$3,$4,$5,$6) as reservation', [eventId, job, workspace, admin, provider, model]);

test('the previous allowlist refused OpenAI, which is the defect this migration fixes', async () => {
  const db = await database({ includeOpenAi: false });
  try {
    await db.exec('update provider_spend_policy set spend_cap_usd=10,call_reservation_usd=1');
    const event = '40000000-0000-4000-8000-000000000011';
    await db.query("insert into api_usage_events(id,workspace_id,project_id,user_id,provider,model,operation) values($1,$2,$3,$4,'openai','gpt-4.1','pending')", [event, workspace, project, admin]);
    await assert.rejects(reserve(db, event, 'openai', 'gpt-4.1'), /provider spend identity is invalid/i);
    await assert.rejects(reserve(db, event, 'claude', 'claude-sonnet-4-5'), /provider spend identity is invalid/i);
  } finally { await db.close(); }
});

test('the company breaker accepts OpenAI and Claude so a configured reader can actually run', async () => {
  const db = await database();
  try {
    await db.exec('update provider_spend_policy set spend_cap_usd=10,call_reservation_usd=1');
    const openai = '40000000-0000-4000-8000-000000000021';
    const claude = '40000000-0000-4000-8000-000000000022';
    for (const [id, provider, model] of [[openai, 'openai', 'gpt-4.1'], [claude, 'claude', 'claude-sonnet-4-5']]) {
      await db.query("insert into api_usage_events(id,workspace_id,project_id,user_id,provider,model,operation) values($1,$2,$3,$4,$5,$6,'pending')", [id, workspace, project, admin, provider, model]);
      const result = await reserve(db, id, provider, model);
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].reservation.provider, provider);
      assert.equal(result.rows[0].reservation.model, model);
    }

    const rows = (await db.query('select provider,model from provider_spend_reservations where event_id in ($1,$2) order by provider', [openai, claude])).rows;
    assert.deepEqual(rows.map(row => [row.provider, row.model]), [['claude', 'claude-sonnet-4-5'], ['openai', 'gpt-4.1']]);
  } finally { await db.close(); }
});

test('an unapproved provider and a blank model are still refused', async () => {
  const db = await database();
  try {
    await db.exec('update provider_spend_policy set spend_cap_usd=10,call_reservation_usd=1');
    const unknown = '40000000-0000-4000-8000-000000000031';
    const blank = '40000000-0000-4000-8000-000000000032';
    await db.query("insert into api_usage_events(id,workspace_id,project_id,user_id,provider,model,operation) values($1,$2,$3,$4,'other','other-model','pending')", [unknown, workspace, project, admin]);
    await db.query("insert into api_usage_events(id,workspace_id,project_id,user_id,provider,model,operation) values($1,$2,$3,$4,'openai','   ','pending')", [blank, workspace, project, admin]);

    await assert.rejects(reserve(db, unknown, 'other', 'other-model'), /provider spend identity is invalid/i);
    await assert.rejects(reserve(db, blank, 'openai', '   '), /provider spend identity is invalid/i);
    const total = (await db.query('select count(*)::int as count from provider_spend_reservations')).rows[0].count;
    assert.equal(total, 0);
  } finally { await db.close(); }
});

test('the per-provider reservation identity cannot be borrowed by another provider or batch', async () => {
  const db = await database();
  try {
    await db.exec('update provider_spend_policy set spend_cap_usd=10,call_reservation_usd=1');
    // One batched whole-set sweep reserves an event id per provider call, so a
    // reused id must not be able to change provider, model or billing identity.
    const event = '40000000-0000-4000-8000-000000000041';
    await db.query("insert into api_usage_events(id,workspace_id,project_id,user_id,provider,model,operation) values($1,$2,$3,$4,'openai','gpt-4.1','pending')", [event, workspace, project, admin]);
    await reserve(db, event, 'openai', 'gpt-4.1');

    const repeated = await reserve(db, event, 'openai', 'gpt-4.1');
    assert.equal(repeated.rows.length, 1);
    assert.equal(repeated.rows[0].reservation.provider, 'openai');

    await assert.rejects(reserve(db, event, 'gemini', 'gemini-3.8-flash'), /reservation identity mismatch/i);
    await assert.rejects(reserve(db, event, 'openai', 'gpt-5.1'), /reservation identity mismatch/i);

    const count = (await db.query('select count(*)::int as count from provider_spend_reservations')).rows[0].count;
    assert.equal(count, 1);
  } finally { await db.close(); }
});

test('one exhausted company cap stops OpenAI too, and the breaker stays service-only', async () => {
  const db = await database();
  try {
    await db.exec('update provider_spend_policy set spend_cap_usd=2,call_reservation_usd=1');
    const gemini = '40000000-0000-4000-8000-000000000051';
    const openai = '40000000-0000-4000-8000-000000000052';
    const openaiModel = 'gpt-4.1';
    await db.query("insert into api_usage_events(id,workspace_id,project_id,user_id,provider,model,operation) values($1,$2,$3,$4,'gemini','gemini-3.8-flash','pending')", [gemini, workspace, project, admin]);
    await db.query("insert into api_usage_events(id,workspace_id,project_id,user_id,provider,model,operation) values($1,$2,$3,$4,'openai','gpt-4.1','pending')", [openai, workspace, project, admin]);

    await reserve(db, gemini, 'gemini', 'gemini-3.8-flash');
    await db.query('select capture_provider_spend($1,$2)', [gemini, 2]);
    await assert.rejects(reserve(db, openai, 'openai', openaiModel), /company ai spend limit reached/i);

    await db.exec('set role authenticated');
    await assert.rejects(reserve(db, openai, 'openai', openaiModel), /permission denied/i);
  } finally { await db.close(); }
});