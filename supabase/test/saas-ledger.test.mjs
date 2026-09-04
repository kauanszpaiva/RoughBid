import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../migrations/0012_private_trial_saas_ledger.sql', import.meta.url), 'utf8');
const lower = sql.toLowerCase();

test('login trial is installed on the private auth trigger function', () => {
  assert.match(sql, /create or replace function private\.handle_new_user_profile\(\)/i);
  assert.match(sql, /roughbid_free_trial/i);
  assert.match(sql, /interval '14 days'/i);
  assert.match(sql, /drop function if exists public\.handle_new_user_profile\(\)/i);
});

test('SaaS ledger contains billing, credits, marketplace, AI usage, and sensitive data tables', () => {
  for (const table of [
    'billing_accounts',
    'credit_grants',
    'credit_ledger_entries',
    'project_entitlements',
    'api_usage_events',
    'marketplace_entitlements',
    'marketplace_purchases',
    'stripe_price_mappings',
    'sensitive_data_events',
    'audit_events',
    'project_members',
  ]) {
    assert.ok(lower.includes(`create table public.${table}`), `missing ${table}`);
    assert.ok(lower.includes(`alter table public.${table} enable row level security`), `missing RLS for ${table}`);
  }
});

test('tenant and project data cannot be mixed in the ledger schema', () => {
  for (const required of [
    'project_members_project_workspace_fkey',
    'credit_ledger_project_workspace_fkey',
    'project_entitlements_project_workspace_fkey',
    'api_usage_project_workspace_fkey',
    'sensitive_data_project_workspace_fkey',
    'audit_events_project_workspace_fkey',
  ]) {
    assert.ok(lower.includes(required), `missing tenant constraint: ${required}`);
  }
  assert.match(sql, /idempotency_key text not null unique/i);
});

test('financial and sensitive tables are not directly writable by browser users', () => {
  for (const forbidden of [
    'create policy billing_accounts_insert',
    'create policy credit_grants_insert',
    'create policy credit_ledger_insert',
    'create policy api_usage_insert',
    'create policy sensitive_data_events_insert',
    'grant all',
    ' to anon',
    'disable row level security',
  ]) {
    assert.equal(lower.includes(forbidden), false, `unexpected exposure: ${forbidden}`);
  }
});
