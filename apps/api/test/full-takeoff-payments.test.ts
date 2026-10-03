import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectPayments } from '../src/billing/project-payments.ts';
import { buildPaidFullContract, hashPaidFullContract } from '../src/billing/full-takeoff-pricing.ts';
import { pricingEnv, testManifest } from './full-takeoff-pricing.test.ts';
import { PDFDocument } from 'pdf-lib';
import { requirePaidFullScheduling, requirePaidFullBatchScheduling } from '../src/billing/full-takeoff-payments.ts';

const companyPolicy = { enabled: true, spend_cap_usd: 25, rolling_window_seconds: 86400, call_reservation_usd: 2.5 };

function fixture(capacity: unknown = true, dailyCapacity: unknown = true) {
  const env = { ...pricingEnv(), STRIPE_SECRET_KEY: 'sk_live_unit_only', STRIPE_WEBHOOK_SECRET: 'whsec_unit_only', STRIPE_EXPECTED_ACCOUNT_ID: 'acct_unit', APP_URL: 'https://roughbid.test' };
  const contract = buildPaidFullContract({ manifest: testManifest(), membership: 'standard', env });
  const quote: any = { id: 'quote-1', user_id: 'user-1', workspace_id: 'ws-1', project_id: 'project-1', file_id: 'file-1',
    mode: 'full_v2', status: 'quoted', expires_at: new Date(Date.now() + 3_600_000).toISOString(), livemode: true,
    currency: 'usd', amount_cents: contract.pricing.amountCents, cost_cents: contract.pricing.costCents,
    page_count: 1, file_sha256: contract.manifest.fileSha256, full_contract: contract, full_contract_hash: hashPaidFullContract(contract) };
  const calls: Array<{ fn: string; args: any }> = []; const requests: Array<{ url: string; init?: RequestInit }> = [];
  const workspace: { ai_processing_consented_at: string | null } = { ai_processing_consented_at: '2026-10-01T00:00:00Z' };
  const db = { from(table: string) { const query: any = { select: () => query, eq: () => query, maybeSingle: () => query,
    update: () => query, then: (resolve: any, reject: any) => Promise.resolve({ data: table === 'workspace_members' ? { role: 'admin' }
      : table === 'projects' ? { id: 'project-1' } : table === 'workspaces' ? workspace : quote, error: null }).then(resolve, reject) }; return query; },
    async rpc(fn: string, args: any) { calls.push({ fn, args }); return { data: fn === 'paid_full_capacity_ready' ? capacity : fn === 'paid_full_daily_capacity_ready' ? dailyCapacity : fn === 'paid_full_capacity_policy' ? companyPolicy : quote, error: null }; } };
  const payments = new ProjectPayments(db, env, (async (url: any, init?: RequestInit) => { requests.push({ url: String(url), init });
    if (String(url) === 'https://api.stripe.com/v1/account') return Response.json({ id: 'acct_unit', charges_enabled: true });
    return Response.json({ id: 'cs_unit', url: 'https://checkout.stripe.com/unit' }); }) as typeof fetch, async () => {},
    async quoteId => { calls.push({ fn: 'enqueue_paid_full', args: { quoteId } }); });
  const input = { mode: 'full_v2', consent: { confirmed: true, contract_hash: quote.full_contract_hash } };
  return { env, quote, calls, requests, payments, input, workspace };
}

test('real rolling policy rejects scopes that cannot reach their final budget window before tariff expiry', async () => {
  const now = Date.parse('2026-10-03T00:00:00Z');
  const contract = buildPaidFullContract({manifest:testManifest(23),membership:'standard',env:pricingEnv(),now});
  const db = { from: () => { throw new Error('Scheduling does not read source files'); },
    rpc: async (name:string) => { assert.equal(name,'paid_full_capacity_policy'); return {data:companyPolicy,error:null}; } };
  await requirePaidFullScheduling(db,contract,now); // 368 calls, 10 per window, 37 windows.
  const expiry = Date.parse(contract.pricing.expiresAt);
  await requirePaidFullScheduling(db,contract,expiry - 37 * 86400_000 - 1);
  await assert.rejects(requirePaidFullScheduling(db,contract,expiry - 37 * 86400_000), /price validity/);
  await requirePaidFullScheduling({...db,rpc:async()=>({data:{...companyPolicy,available_usd:25},error:null})},contract,expiry - 36 * 86400_000 - 1);
  await assert.rejects(requirePaidFullScheduling({...db,rpc:async()=>({data:{...companyPolicy,available_usd:0},error:null})},contract,expiry - 36 * 86400_000 - 1), /price validity/);
  const oversized = buildPaidFullContract({manifest:testManifest(200),membership:'standard',env:pricingEnv(),now});
  await assert.rejects(requirePaidFullScheduling(db,oversized,now), /price validity/);
  // Each 40-page PDF fits separately; the combined purchase must also fit.
  const child = buildPaidFullContract({manifest:testManifest(40),membership:'standard',env:pricingEnv(),now});
  await requirePaidFullScheduling(db,child,now);
  await assert.rejects(requirePaidFullBatchScheduling(db,[child,child],now), /price validity/);
  await assert.rejects(requirePaidFullBatchScheduling(db,[],now), /schedule is unavailable/);
  for (const policy of [null, {}, {...companyPolicy,enabled:false}, {...companyPolicy,rolling_window_seconds:0},
    {...companyPolicy,call_reservation_usd:1}, {...companyPolicy,spend_cap_usd:2}, {...companyPolicy,spend_cap_usd:'25'}]) {
    await assert.rejects(requirePaidFullScheduling({...db,rpc:async()=>({data:policy,error:null})},contract,now));
  }
});

test('checkout refuses a complete scope beyond current tariff scheduling before a hold or Stripe call', async () => {
  const f = fixture();
  const contract = buildPaidFullContract({manifest:testManifest(200),membership:'standard',env:f.env});
  Object.assign(f.quote,{full_contract:contract,full_contract_hash:hashPaidFullContract(contract),page_count:200,
    amount_cents:contract.pricing.amountCents,cost_cents:contract.pricing.costCents});
  f.input.consent.contract_hash = f.quote.full_contract_hash;
  await assert.rejects(f.payments.checkout('user-1','ws-1','project-1','quote-1',f.input), /price validity/);
  assert.deepEqual(f.calls.map(call=>call.fn),['paid_full_daily_capacity_ready','paid_full_capacity_policy']);
  assert.deepEqual(f.requests,[]);
});
test('Full checkout persists exact explicit consent before Stripe, with scoped hosted return and one quote idempotency', async () => {
  const f = fixture();
  assert.equal((await f.payments.checkout('user-1', 'ws-1', 'project-1', 'quote-1', f.input)).url, 'https://checkout.stripe.com/unit');
  assert.deepEqual(f.calls.map(call => call.fn), ['paid_full_daily_capacity_ready', 'paid_full_capacity_policy', 'paid_full_capacity_ready', 'accept_paid_full_quote']);
  assert.deepEqual(f.calls[2]!.args, { p_reserve_usd: 40, p_call_reservation_usd: 2.5, p_quote_id: 'quote-1' });
  assert.equal(f.calls[3]!.args.p_contract_hash, f.quote.full_contract_hash);
  assert.equal(f.requests.length, 2); assert.equal(f.requests[0]!.url, 'https://api.stripe.com/v1/account');
  const request = f.requests[1]!.init!; const params = request.body as URLSearchParams;
  assert.equal(new Headers(request.headers).get('stripe-version'), '2026-08-26.dahlia');
  assert.equal(new Headers(request.headers).get('idempotency-key'), 'roughbid-full-quote-quote-1');
  assert.equal(params.get('metadata[roughbid_mode]'), 'full_v2');
  assert.equal(params.has('payment_method_types'), false);
  assert.equal(params.has('automatic_tax[enabled]'), false);
  for (const field of ['success_url', 'cancel_url']) {
    const url = new URL(params.get(field)!);
    assert.equal(url.searchParams.get('file_id'), 'file-1'); assert.equal(url.searchParams.get('quote_id'), 'quote-1');
    assert.equal(url.searchParams.get('workspace_id'), 'ws-1'); assert.equal(url.searchParams.get('reading_mode'), 'full_v2');
  }
});
test('unknown or insufficient company capacity blocks before consent persistence and Stripe', async () => {
  for (const capacity of [false, null, {}, 'true']) { const f = fixture(capacity);
    await assert.rejects(f.payments.checkout('user-1', 'ws-1', 'project-1', 'quote-1', f.input), /capacity/);
    assert.equal(f.requests.length, 0); assert.deepEqual(f.calls.map(call => call.fn), ['paid_full_daily_capacity_ready', 'paid_full_capacity_policy', 'paid_full_capacity_ready']);
  }
});
test('daily admission limit blocks quote and checkout before PDF or Stripe and preserves current quote identity', async () => {
  const f = fixture(true, false);
  await assert.rejects(f.payments.quote('user-1', 'ws-1', 'project-1', { mode: 'full_v2', file_id: 'file-1' },
    { presign: async () => { throw new Error('No PDF download after admission rejection'); } }), /reading capacity is full/);
  await assert.rejects(f.payments.checkout('user-1', 'ws-1', 'project-1', 'quote-1', f.input), /reading capacity is full/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.calls.map(call => call.args), [{ p_user_id: 'user-1', p_quote_id: null }, { p_user_id: 'user-1', p_quote_id: 'quote-1' }]);
});
test('missing workspace AI consent returns actionable 403 before PDF preflight, capacity or Stripe', async () => {
  const f = fixture(); f.workspace.ai_processing_consented_at = null;
  const needsConsent = (error: any) => error.status === 403 && /consent/i.test(error.message);
  await assert.rejects(f.payments.quote('user-1', 'ws-1', 'project-1', { mode: 'full_v2', file_id: 'file-1' },
    { presign: async () => { throw new Error('No PDF preflight without consent'); } }), needsConsent);
  await assert.rejects(f.payments.checkout('user-1', 'ws-1', 'project-1', 'quote-1', f.input), needsConsent);
  assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0);
});
test('Full checkout rejects missing or stale consent, non-live quote, changed amount and different actor before Stripe', async () => {
  for (const mutation of [(f: ReturnType<typeof fixture>) => { f.input.consent.confirmed = false; },
    (f: ReturnType<typeof fixture>) => { f.input.consent.contract_hash = 'stale'; },
    (f: ReturnType<typeof fixture>) => { f.quote.livemode = false; }, (f: ReturnType<typeof fixture>) => { f.quote.amount_cents = 1; },
    (f: ReturnType<typeof fixture>) => { f.quote.user_id = 'another-user'; }]) {
    const f = fixture(); mutation(f);
    await assert.rejects(f.payments.checkout('user-1', 'ws-1', 'project-1', 'quote-1', f.input)); assert.equal(f.requests.length, 0);
  }
});
test('invalid new Checkout expiry cannot create a hold or contact Stripe', async () => {
  for (const duration of [15 * 60_000, 25 * 60 * 60_000]) {
    const f = fixture(); f.quote.expires_at = new Date(Date.now() + duration).toISOString();
    await assert.rejects(f.payments.checkout('user-1', 'ws-1', 'project-1', 'quote-1', f.input), /Refresh the Full reading quote/);
    assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0);
  }
});
test('Full unpaid or test events never confirm; only paid live confirmation enqueues the bound purchase', async () => {
  const f = fixture(); f.quote.stripe_session_id = 'cs_unit'; const base = { id: 'evt_unit', type: 'checkout.session.completed', livemode: true,
    data: { object: { id: 'cs_unit', mode: 'payment', payment_status: 'unpaid', payment_intent: 'pi_unit', amount_total: f.quote.amount_cents,
      client_reference_id: 'user-1', currency: 'usd', metadata: { roughbid_quote_id: 'quote-1', roughbid_mode: 'full_v2',
        roughbid_contract_hash: f.quote.full_contract_hash, workspace_id: 'ws-1', project_id: 'project-1' } } } };
  await f.payments.reconcile(base); assert.equal(f.calls.length, 0);
  await f.payments.reconcile({ ...base, livemode: false, data: { object: { ...base.data.object, payment_status: 'paid' } } }); assert.equal(f.calls.length, 0);
  await f.payments.reconcile({ ...base, type: 'checkout.session.async_payment_failed' });
  assert.equal(f.calls[0]!.fn, 'fail_paid_full_payment');
  await f.payments.reconcile({ ...base, data: { object: { ...base.data.object, payment_status: 'paid' } } });
  assert.deepEqual(f.calls.map(call => call.fn), ['fail_paid_full_payment', 'confirm_project_reading_payment', 'enqueue_paid_full']);
  assert.equal(f.requests.length, 0);
});
test('restricted live keys can open Full checkout; test keys and worker outages cannot', async () => {
  const f = fixture(); f.env.STRIPE_SECRET_KEY = 'rk_live_unit_only';
  await f.payments.checkout('user-1', 'ws-1', 'project-1', 'quote-1', f.input);
  assert.equal(f.requests.length, 2);
  const wrong = fixture(); wrong.env.STRIPE_SECRET_KEY = 'rk_test_unit_only';
  await assert.rejects(wrong.payments.checkout('user-1', 'ws-1', 'project-1', 'quote-1', wrong.input), /Live checkout/);
  assert.equal(wrong.requests.length, 0);
  const offline = fixture();
  (offline.payments as any).fullReadiness = async () => { throw new Error('Worker offline'); };
  await assert.rejects(offline.payments.checkout('user-1', 'ws-1', 'project-1', 'quote-1', offline.input), /Worker offline/);
  assert.equal(offline.requests.length, 0); assert.equal(offline.calls.length, 0);
});
test('Full checkout verifies the exact charge-enabled account before consent or a Stripe POST', async () => {
  const f = fixture(); f.env.STRIPE_EXPECTED_ACCOUNT_ID = 'acct_other';
  await assert.rejects(f.payments.checkout('user-1', 'ws-1', 'project-1', 'quote-1', f.input), /this application/);
  assert.deepEqual(f.requests.map(request => request.url), ['https://api.stripe.com/v1/account']);
  assert.deepEqual(f.calls.map(call => call.fn), ['paid_full_daily_capacity_ready', 'paid_full_capacity_policy', 'paid_full_capacity_ready']);
  for (const status of [401, 403, 200]) {
    const blocked = fixture();
    (blocked.payments as any).fetcher = async (_url: string, init: RequestInit) => {
      assert.notEqual(init.method, 'POST');
      return Response.json({ id: 'acct_unit', charges_enabled: false }, { status });
    };
    await assert.rejects(blocked.payments.checkout('user-1', 'ws-1', 'project-1', 'quote-1', blocked.input), /this application/);
    assert.equal(blocked.calls.some(call => call.fn === 'accept_paid_full_quote'), false);
  }
});
test('signed Full metadata cannot substitute another session, actor, workspace, project, mode or contract', async () => {
  for (const field of ['session', 'actor', 'workspace', 'project', 'contract', 'mode', 'account']) {
    const f = fixture(); f.quote.stripe_session_id = 'cs_unit';
    const event: any = { id: 'evt_unit', type: 'checkout.session.completed', livemode: true, data: { object: {
      id: field === 'session' ? 'cs_foreign' : 'cs_unit', client_reference_id: field === 'actor' ? 'user_other' : 'user-1',
      mode: 'payment', payment_status: 'paid', payment_intent: 'pi_unit', amount_total: f.quote.amount_cents, currency: 'usd',
      metadata: { roughbid_quote_id: 'quote-1', roughbid_mode: field === 'mode' ? 'quick' : 'full_v2',
        workspace_id: field === 'workspace' ? 'ws_other' : 'ws-1', project_id: field === 'project' ? 'project_other' : 'project-1',
        roughbid_contract_hash: field === 'contract' ? 'bad' : f.quote.full_contract_hash } } } };
    if (field === 'account') event.account = 'acct_foreign';
    if (['mode', 'account'].includes(field)) await f.payments.reconcile(event);
    else await assert.rejects(f.payments.reconcile(event), /saved purchase/);
    assert.equal(f.calls.length, 0);
  }
});
test('confirmed Full payment remains recoverable when automatic enqueue fails', async () => {
  const f = fixture(); f.quote.stripe_session_id = 'cs_unit';
  let tries = 0; (f.payments as any).startPaidFull = async (id: string) => { assert.equal(id, 'quote-1'); if (++tries === 1) throw new Error('Queue offline'); };
  const event: any = { id: 'evt_paid', type: 'checkout.session.completed', livemode: true, data: { object: {
    id: 'cs_unit', client_reference_id: 'user-1', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_unit', amount_total: f.quote.amount_cents, currency: 'usd',
    metadata: { roughbid_quote_id: 'quote-1', roughbid_mode: 'full_v2', workspace_id: 'ws-1', project_id: 'project-1', roughbid_contract_hash: f.quote.full_contract_hash } } } };
  await assert.rejects(f.payments.reconcile(event), /Queue offline/);
  await f.payments.reconcile(event);
  assert.equal(tries, 2); assert.equal(f.calls.filter(call => call.fn === 'confirm_project_reading_payment').length, 2);
  assert.equal(f.requests.length, 0);
});
test('Full quote inspects every PDF page without AI, uses real subscription membership for voluntary owner, and hides cost budgets', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage(); const bytes = await pdf.save();
  const rpcCalls: Array<{ fn: string; args: any }> = []; const requests: string[] = []; const tables: string[] = [];
  const db = { from(table: string) { tables.push(table);
    const data = table === 'workspace_members' ? { role: 'admin' } : table === 'projects' ? { id: 'project-1' }
      : table === 'workspaces' ? { created_by: 'user-1', ai_processing_consented_at: '2026-10-01T00:00:00Z' } : table === 'billing_customers' ? null
      : table === 'project_files' ? { id: 'file-1', storage_path: 'ws-1/project-1/file-1.pdf', processing_status: 'ready', page_count: 2 }
      : (() => { throw new Error(`Unexpected table ${table}`); })();
    const query: any = { select: () => query, eq: () => query, maybeSingle: () => query, single: () => query,
      then: (resolve: any) => Promise.resolve({ data, error: null }).then(resolve) }; return query;
  }, async rpc(fn: string, args: any) { rpcCalls.push({ fn, args });
    if (fn === 'paid_full_capacity_ready' || fn === 'paid_full_daily_capacity_ready') return { data: true, error: null };
    if (fn === 'paid_full_capacity_policy') return { data: companyPolicy, error: null };
    if (fn !== 'create_paid_full_quote') throw new Error(`Unexpected RPC ${fn}`);
    return { data: { ...args.p_input, id: 'quote-1', currency: 'usd', status: 'quoted', attempts: 0 }, error: null };
  } };
  const payments = new ProjectPayments(db, pricingEnv(), (async (url: any) => {
    requests.push(String(url)); assert.equal(String(url), 'https://storage.unit/plan'); return new Response(bytes);
  }) as typeof fetch, async () => {});
  const quote = await payments.quote('user-1', 'ws-1', 'project-1', { mode: 'full_v2', file_id: 'file-1', page_number: 1 },
    { presign: async () => ({ url: 'https://storage.unit/plan' }) });
  assert.equal(quote.mode, 'full_v2'); assert.equal(quote.membership, 'standard'); assert.equal(quote.max_attempts, 1);
  assert.equal(quote.full_summary?.physicalPageCount, 2); assert.equal(quote.full_summary?.maximumCalls, 32);
  assert.equal(quote.amount_cents, 6656); assert.equal(quote.full_consent_confirmed, false);
  assert.equal('approvedUsd' in quote.full_summary!.providers[0], false);
  assert.equal('cost_cents' in quote, false); assert.equal(tables.includes('profiles'), false);
  assert.deepEqual(requests, ['https://storage.unit/plan']);
  assert.deepEqual(rpcCalls.map(call => call.fn), ['paid_full_daily_capacity_ready', 'paid_full_capacity_policy', 'paid_full_capacity_ready', 'create_paid_full_quote']);
});
