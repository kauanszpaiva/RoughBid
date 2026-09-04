import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('client proposal migration supports public open tracking without anonymous table access', async () => {
  const sql = (await readFile(new URL('../migrations/0008_client_proposals.sql', import.meta.url), 'utf8')).toLowerCase();
  for (const required of [
    'create table if not exists public.client_proposals',
    'token_hash text not null unique',
    'create table if not exists public.client_proposal_events',
    'alter table public.client_proposals enable row level security',
    'alter table public.client_proposal_events enable row level security',
    'revoke all on public.client_proposals from anon',
    'revoke all on public.client_proposal_events from anon',
    'create or replace function public.track_client_proposal_open',
    'security definer',
    'grant execute on function public.track_client_proposal_open(text, jsonb) to anon, authenticated',
    "event_type text not null check (event_type in ('opened', 'downloaded', 'signed', 'email_sent'))",
  ]) {
    assert.ok(sql.includes(required), `missing client proposal primitive: ${required}`);
  }
});
