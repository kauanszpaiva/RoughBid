import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { handleProjectPayment, ProjectPayments } from '../src/billing/project-payments.ts';
import type { SupabaseLike } from '../src/projects/service.ts';

const paid = { id: 'paid-quote', user_id: 'user-1', workspace_id: 'workspace-1', project_id: 'project-1', file_id: 'file-1',
  status: 'paid', created_at: '2026-09-01T12:00:00Z', expires_at: '2026-09-01T13:00:00Z', amount_cents: 500,
  currency: 'usd', page_count: 10, trades: ['Framing'], scope: 'Original paid scope', attempts: 0, job_id: null,
  membership: 'standard', livemode: false, payment_intent_id: 'private-intent', stripe_session_id: 'private-session', file_sha256: 'private-hash' };

function fixture(quotes: Record<string, unknown>[] = [paid], role: string | null = 'estimator') {
  const calls: { table: string; url: URL; method: string }[] = [];
  const rows: Record<string, Record<string, unknown>[]> = {
    workspace_members: role ? [{ workspace_id: 'workspace-1', user_id: 'user-1', role }] : [],
    projects: [{ id: 'project-1', workspace_id: 'workspace-1' }],
    project_files: [{ id: 'file-1', workspace_id: 'workspace-1', project_id: 'project-1' }],
    project_reading_quotes: quotes,
  };
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://database.test', 'Recovery must not call Stripe, storage or AI.');
    const table = url.pathname.split('/').at(-1)!;
    calls.push({ table, url, method: request.method });
    assert.equal(request.method, 'GET', 'Recovery must not mutate rows or call a reservation RPC.');
    assert.ok(rows[table], `Unexpected table or RPC: ${table}`);
    let data = [...rows[table]!];
    for (const [key, value] of url.searchParams) {
      if (value.startsWith('eq.')) data = data.filter(row => String(row[key]) === value.slice(3));
      if (value.startsWith('in.(')) data = data.filter(row => value.slice(4, -1).split(',').includes(String(row[key])));
      if (value.startsWith('gt.')) data = data.filter(row => String(row[key]) > value.slice(3));
    }
    if (url.searchParams.get('order') === 'created_at.desc') data.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (url.searchParams.has('limit')) data = data.slice(0, Number(url.searchParams.get('limit')));
    return Response.json(data);
  };
  const db = createClient('https://database.test', 'unit-test-key', { auth: { persistSession: false }, global: { fetch: fetcher } });
  const payments = new ProjectPayments(db, {}, fetcher);
  const auth = { auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) } } as unknown as SupabaseLike;
  return { payments, calls, auth };
}

test('reload recovers the original paid subset before a newer abandoned quote, with no writes or provider configuration', async () => {
  const f = fixture([paid, { ...paid, id: 'abandoned', status: 'quoted', trades: ['Framing', 'Concrete'], created_at: '2099-01-01', expires_at: '2099-01-02' }]);
  const result = await f.payments.savedQuote('user-1', 'workspace-1', 'project-1', 'file-1');
  assert.equal(result.id, paid.id);
  assert.deepEqual(result.trades, ['Framing']);
  assert.equal(result.scope, paid.scope);
  assert.equal(result.status, 'paid');
  assert.equal(result.attempts, 0);
  assert.equal(result.job_id, null);
  assert.doesNotMatch(JSON.stringify(result), /private-|file_sha256|payment_intent|stripe_session|user_id/);
  const query = f.calls.find(call => call.table === 'project_reading_quotes')!.url.searchParams;
  for (const [key, value] of Object.entries({ workspace_id: 'workspace-1', project_id: 'project-1', file_id: 'file-1', livemode: 'false' })) assert.equal(query.get(key), `eq.${value}`);
  assert.equal(query.get('order'), 'created_at.desc');
  assert.equal(query.get('limit'), '1');
});

test('saved status and exact quote identity are never inferred from the return URL or changed during recovery', async () => {
  for (const status of ['paid', 'processing', 'complete', 'failed', 'revoked']) {
    const f = fixture([{ ...paid, status, attempts: 2, job_id: 'saved-job' }]);
    const response = await handleProjectPayment(new Request('https://app.test/api/projects/project-1/reading-quote?file_id=file-1&quote_id=paid-quote&payment=returned', { headers: { 'x-workspace-id': 'workspace-1' } }), f.auth, f.payments);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const result = await response.json();
    assert.equal(result.status, status);
    assert.equal(result.attempts, 2);
    assert.equal(result.job_id, 'saved-job');
    assert.equal(f.calls.at(-1)!.url.searchParams.get('id'), 'eq.paid-quote');
  }
});

test('unpaid recovery only selects an unexpired quote and never grants paid status', async () => {
  const f = fixture([{ ...paid, status: 'quoted', expires_at: '2099-01-01' }]);
  assert.equal((await f.payments.savedQuote('user-1', 'workspace-1', 'project-1', 'file-1')).status, 'quoted');
  const expired = fixture([{ ...paid, status: 'quoted' }]);
  assert.equal(await expired.payments.savedQuote('user-1', 'workspace-1', 'project-1', 'file-1'), null);
});

test('recovery scopes quote identity to the workspace, project, file and current payment mode', async () => {
  for (const field of ['workspace_id', 'project_id', 'file_id', 'livemode']) {
    const f = fixture([{ ...paid, [field]: field === 'livemode' ? true : 'someone-else' }]);
    assert.equal(await f.payments.savedQuote('user-1', 'workspace-1', 'project-1', 'file-1'), null);
    assert.equal(await f.payments.savedQuote('user-1', 'workspace-1', 'project-1', 'file-1', paid.id), null);
  }
  const f = fixture();
  await assert.rejects(f.payments.savedQuote('user-1', 'workspace-1', 'foreign-project', 'file-1'), (error: any) => error.status === 404);
  await assert.rejects(f.payments.savedQuote('user-1', 'workspace-1', 'project-1', 'foreign-file'), (error: any) => error.status === 404);
  await assert.rejects(f.payments.savedQuote('user-1', 'workspace-1', 'project-1', ''), (error: any) => error.status === 400);
  assert.ok(f.calls.every(call => call.table !== 'project_reading_quotes'));
});

test('authorized estimators recover colleague-created workspace quotes just as the canonical reservation allows', async () => {
  const f = fixture([{ ...paid, user_id: 'colleague' }]);
  assert.equal((await f.payments.savedQuote('user-1', 'workspace-1', 'project-1', 'file-1')).id, paid.id);
  assert.equal(f.calls[0]!.url.searchParams.get('user_id'), 'eq.user-1');
});

test('missing membership, viewer role and unauthenticated requests cannot recover payment state', async () => {
  for (const role of [null, 'viewer']) {
    const f = fixture([paid], role);
    await assert.rejects(f.payments.savedQuote('user-1', 'workspace-1', 'project-1', 'file-1'), (error: any) => error.status === 403);
    assert.deepEqual(f.calls.map(call => call.table), ['workspace_members']);
  }
  const f = fixture();
  const auth = { auth: { getUser: async () => ({ data: { user: null }, error: null }) } } as unknown as SupabaseLike;
  assert.equal((await handleProjectPayment(new Request('https://app.test/api/projects/project-1/reading-quote?file_id=file-1'), auth, f.payments)).status, 401);
  assert.equal((await handleProjectPayment(new Request('https://app.test/api/projects/project-1/reading-checkout'), f.auth, f.payments)).status, 405);
  assert.deepEqual(f.calls, []);
});
