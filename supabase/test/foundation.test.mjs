import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('foundation migration encodes tenancy, entitlements, RLS and private plan storage', async () => {
  const sql = await readFile(new URL('../migrations/0001_foundation.sql', import.meta.url), 'utf8');
  for (const required of [
    'create table public.workspaces',
    'create table public.workspace_members',
    'create table public.projects',
    'create table public.estimates',
    'create table public.entitlements',
    'create table public.billing_customers',
    'create table public.stripe_events',
    'enable row level security',
    "'access_grant'",
    "'plan-files'",
    'allowed_mime_types',
  ]) {
    assert.match(sql.toLowerCase(), new RegExp(required.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
