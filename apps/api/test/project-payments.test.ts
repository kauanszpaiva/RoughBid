import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { inspectPdf, normalizeScope, quoteProject, downloadPlan, MAX_AI_PDF_BYTES } from '../src/billing/project-preflight.ts';
import { ProjectPayments, handleProjectPayment } from '../src/billing/project-payments.ts';
import { projectChargeCents } from '../../../packages/domain/src/project-charge.ts';

test('margins are on revenue, rounded up in cents, including payment fees',()=>{
  assert.deepEqual(['standard','starter','pro','team','enterprise'].map(t=>projectChargeCents(1000,0,0,t as never)),[2000,1667,1539,1429,1250]);
  for(const tier of ['standard','starter','pro','team','enterprise'] as const) {
    const price=projectChargeCents(1000,30,290,tier);
    assert.ok(price>projectChargeCents(1000,0,0,tier));
  }
  assert.throws(()=>projectChargeCents(-1,0,0,'standard'));
  assert.throws(()=>projectChargeCents(1000,0,5000,'standard'));
  assert.throws(()=>projectChargeCents(1.1,0,0,'standard'));
});
test('no invented pricing defaults and no free generation in an unconfigured deployment',()=>{
  assert.throws(()=>quoteProject(2,3,'standard',{}),/not configured/);
  const env={PROJECT_COST_BASE_CENTS:'100',PROJECT_COST_PAGE_CENTS:'10',PROJECT_COST_TRADE_CENTS:'20',PROJECT_PAYMENT_FIXED_CENTS:'30',PROJECT_PAYMENT_FEE_BPS:'290',PROJECT_PRICING_VERSION:'test-only'};
  assert.ok(quoteProject(10,3,'standard',env).amountCents>quoteProject(1,3,'standard',env).amountCents);
  assert.ok(quoteProject(1,3,'standard',env).amountCents>quoteProject(1,3,'team',env).amountCents);
});
test('PDF preflight reads pages without AI and rejects oversized/invalid data',async()=>{
  const doc=await PDFDocument.create();doc.addPage();doc.addPage();
  const result=await inspectPdf(await doc.save());assert.equal(result.pages,2);assert.match(result.sha256,/^[a-f0-9]{64}$/);
  await assert.rejects(inspectPdf(new TextEncoder().encode('not a PDF')),/valid PDF/);
  await assert.rejects(inspectPdf(new Uint8Array(MAX_AI_PDF_BYTES+1)),/50 MB/);
  await assert.rejects(downloadPlan('https://storage.test/file',async()=>new Response('x',{headers:{'content-length':String(MAX_AI_PDF_BYTES+1)}})),/50 MB/);
});
test('scope cannot contain arbitrary trades or oversized user text',()=>{
  assert.throws(()=>normalizeScope({trades:['run other tasks']}));
  assert.throws(()=>normalizeScope({scope:'a'.repeat(501)}));
  assert.deepEqual(normalizeScope({trades:['Framing','Framing']}),{trades:['Framing'],scope:''});
});
test('unpaid and unrelated Stripe events never grant a project reading',async()=>{
  const calls:any[]=[];
  const db={from:()=>({}),rpc:async(fn:string,args:any)=>{calls.push({fn,args});return {data:true,error:null}}};
  const payments=new ProjectPayments(db,{});
  const event={id:'evt_test',type:'checkout.session.completed',livemode:false,data:{object:{mode:'payment',payment_status:'unpaid',metadata:{roughbid_quote_id:'quote'}}}};
  await payments.reconcile(event);assert.equal(calls.length,0);
  await payments.reconcile({...event,data:{object:{...event.data.object,payment_status:'paid',payment_intent:'pi_test',amount_total:100,currency:'usd',id:'cs_test'}}});
  assert.equal(calls.length,1);assert.equal(calls[0].fn,'confirm_project_reading_payment');
  assert.equal(calls[0].args.p_amount,100);
});

const pilotEnv = {
  PAID_PLAN_READINGS_ENABLED: 'true', PAID_PLAN_READINGS_STAGE: 'test', STRIPE_MODE: 'test',
  GEMINI_API_KEY: 'unit-provider-credential', GEMINI_MODEL: 'gemini-2.5-flash',
  STRIPE_SECRET_KEY: 'sk_test_unitcredential', STRIPE_WEBHOOK_SECRET: 'whsec_test_unitcredential', APP_URL: 'https://roughbid.test',
};
const activationState = { enabled: true, model: pilotEnv.GEMINI_MODEL, stripe_livemode: false, budget_usd: 1, exposure_usd: 0.2, reserved_usd_per_attempt: 0.05 };

function checkoutFixture(env: Record<string, string | undefined>, options: { activation?: unknown; activationError?: boolean } = {}) {
  const mutations: string[] = [];
  const requests: string[] = [];
  const activationCalls: Array<Record<string, unknown>> = [];
  const quote = { id: 'quote-1', user_id: 'user-1', workspace_id: 'workspace-1', project_id: 'project-1',
    status: 'quoted', expires_at: new Date(Date.now() + 60 * 60_000).toISOString(), livemode: false,
    amount_cents: 500, currency: 'usd', page_count: 1 };
  const db = { from: (table: string) => {
    const query: any = {
      select: () => query, eq: () => query, maybeSingle: () => query,
      update: () => { mutations.push(table); return query; },
      then: (resolve: any, reject: any) => Promise.resolve({
        data: table === 'workspace_members' ? { role: 'admin' } : table === 'projects' ? { id: 'project-1' } : quote, error: null,
      }).then(resolve, reject),
    };
    return query;
  }, rpc: async (fn: string, args: Record<string, unknown>) => {
    assert.equal(fn, 'assert_plan_reading_activation');
    activationCalls.push(args);
    return { data: options.activation === undefined ? activationState : options.activation,
      error: options.activationError ? { message: 'activation denied' } : null };
  } };
  const fetcher = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json({ id: 'cs_test', url: 'https://checkout.stripe.test/session' });
  }) as typeof fetch;
  return { payments: new ProjectPayments(db, env, fetcher), mutations, requests, activationCalls };
}

test('disabled or incomplete Gemini configuration blocks quotes and checkout before spending or reserving', async () => {
  for (const env of [
    {},
    { GEMINI_API_KEY: 'unit-provider-credential', GEMINI_MODEL: 'gemini-2.5-flash' },
    { PAID_PLAN_READINGS_ENABLED: 'false', GEMINI_API_KEY: 'unit-provider-credential', GEMINI_MODEL: 'gemini-2.5-flash' },
    { PAID_PLAN_READINGS_ENABLED: 'true', GEMINI_MODEL: 'gemini-2.5-flash' },
    { PAID_PLAN_READINGS_ENABLED: 'true', GEMINI_API_KEY: 'unit-provider-credential' },
    { PAID_PLAN_READINGS_ENABLED: 'true', GEMINI_API_KEY: '[sensitive]', GEMINI_MODEL: 'gemini-2.5-flash' },
    { PAID_PLAN_READINGS_ENABLED: 'true', GEMINI_API_KEY: 'unit-provider-credential', GEMINI_MODEL: 'gemini-placeholder' },
  ]) {
    const f = checkoutFixture({ PAID_PLAN_READINGS_STAGE: 'test', STRIPE_MODE: 'test', ...env });
    let signed = false;
    const storage = { presign: async () => { signed = true; return { url: 'https://storage.test/plan' }; } };
    await assert.rejects(f.payments.quote('user-1', 'workspace-1', 'project-1', { file_id: 'file-1' }, storage), (error: any) => error.status === 503);
    await assert.rejects(f.payments.checkout('user-1', 'workspace-1', 'project-1', 'quote-1'), (error: any) => error.status === 503);
    assert.equal(signed, false);
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.mutations, []);
  }
});

test('checkout requires payment reconciliation configuration before contacting Stripe', async () => {
  const f = checkoutFixture({ ...pilotEnv, STRIPE_WEBHOOK_SECRET: undefined });
  await assert.rejects(f.payments.checkout('user-1', 'workspace-1', 'project-1', 'quote-1'), (error: any) => error.status === 503);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.mutations, []);
});

test('deliberately configured paid checkout still works with an injected test gateway', async () => {
  const f = checkoutFixture(pilotEnv);
  const checkout = await f.payments.checkout('user-1', 'workspace-1', 'project-1', 'quote-1');
  assert.equal(checkout.url, 'https://checkout.stripe.test/session');
  assert.deepEqual(f.requests, ['https://api.stripe.com/v1/checkout/sessions']);
  assert.deepEqual(f.mutations, ['project_reading_quotes']);
  assert.deepEqual(f.activationCalls, [{ p_workspace_id: 'workspace-1', p_model: pilotEnv.GEMINI_MODEL }]);
});

test('absent allowlisting, invalid or exhausted budget, mismatched model, live activation and activation errors block Stripe and PDF download', async () => {
  for (const options of [
    { activation: null },
    { activation: { ...activationState, enabled: false } },
    { activation: { ...activationState, model: 'gemini-2.5-pro' } },
    { activation: { ...activationState, stripe_livemode: true } },
    { activation: { ...activationState, exposure_usd: 0.96 } },
    { activation: { ...activationState, budget_usd: 0 } },
    { activation: { ...activationState, exposure_usd: undefined } },
    { activation: { ...activationState, exposure_usd: null } },
    { activationError: true },
  ]) {
    const f = checkoutFixture(pilotEnv, options);
    let signed = false;
    const storage = { presign: async () => { signed = true; return { url: 'https://storage.test/plan' }; } };
    await assert.rejects(f.payments.quote('user-1', 'workspace-1', 'project-1', { file_id: 'file-1' }, storage), (error: any) => error.status === 503);
    await assert.rejects(f.payments.checkout('user-1', 'workspace-1', 'project-1', 'quote-1'), (error: any) => error.status === 503);
    assert.equal(signed, false);
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.mutations, []);
    assert.equal(f.activationCalls.length, 2);
  }
});

test('test-stage and nonproduction deployment are required before activation or payment', async () => {
  for (const overrides of [
    { PAID_PLAN_READINGS_STAGE: undefined }, { PAID_PLAN_READINGS_STAGE: 'live' },
    { STRIPE_MODE: undefined }, { STRIPE_MODE: 'live' },
    { VERCEL_ENV: 'production' }, { APP_ENV: 'production' },
    { GEMINI_MODEL: 'gemini-latest' }, { GEMINI_MODEL: 'gemini-2.5-flash-preview' },
  ]) {
    const f = checkoutFixture({ ...pilotEnv, ...overrides });
    let signed = false;
    await assert.rejects(f.payments.quote('user-1', 'workspace-1', 'project-1', { file_id: 'file-1' }, { presign: async () => { signed = true; return { url: 'https://storage.test/plan' }; } }), (error: any) => error.status === 503);
    await assert.rejects(f.payments.checkout('user-1', 'workspace-1', 'project-1', 'quote-1'), (error: any) => error.status === 503);
    assert.equal(signed, false);
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.mutations, []);
    assert.deepEqual(f.activationCalls, []);
  }
});

function savedQuoteFixture() {
  const quote = {
    id: 'quote-1', workspace_id: 'workspace-1', project_id: 'project-1', file_id: 'file-1', user_id: 'user-1',
    status: 'paid', amount_cents: 500, currency: 'usd', page_count: 2, trades: ['Drywall', 'Framing'], scope: 'Residential',
    attempts: 0, job_id: null, expires_at: '2026-01-01T00:00:00Z', membership: 'standard',
    cost_cents: 250, file_sha256: 'private-digest', payment_intent_id: 'private-intent', stripe_session_id: 'private-session',
  };
  const rows: Record<string, Array<Record<string, unknown>>> = {
    workspace_members: [
      { workspace_id: 'workspace-1', user_id: 'user-1', role: 'admin' },
      { workspace_id: 'workspace-1', user_id: 'estimator-1', role: 'estimator' },
      { workspace_id: 'workspace-1', user_id: 'viewer-1', role: 'viewer' },
      { workspace_id: 'workspace-2', user_id: 'user-1', role: 'admin' },
    ],
    projects: [{ workspace_id: 'workspace-1', id: 'project-1' }, { workspace_id: 'workspace-2', id: 'project-2' }],
    project_reading_quotes: [quote],
  };
  const db = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const query: any = {
        select: () => query,
        eq: (field: string, value: unknown) => { filters.push([field, value]); return query; },
        maybeSingle: async () => ({ data: rows[table]?.find(row => filters.every(([field, value]) => row[field] === value)) ?? null, error: null }),
      };
      return query;
    },
    rpc: async () => { throw new Error('Quote lookup must not authorize or mutate a reading.'); },
  };
  const payments = new ProjectPayments(db, {}, async () => { throw new Error('Quote lookup must not call a provider.'); });
  const read = (options: { userId?: string | null; workspaceId?: string; projectId?: string; fileId?: string; quoteId?: string; path?: string } = {}) => {
    const userId = options.userId === undefined ? 'user-1' : options.userId;
    const auth = { auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null }, error: null }) } };
    const params = new URLSearchParams({ file_id: options.fileId ?? 'file-1', quote_id: options.quoteId ?? 'quote-1', status: 'paid' });
    const path = options.path ?? `/api/projects/${options.projectId ?? 'project-1'}/reading-quote`;
    return handleProjectPayment(new Request(`https://roughbid.test${path}?${params}`, {
      headers: { 'x-workspace-id': options.workspaceId ?? 'workspace-1' },
    }), auth as never, payments);
  };
  return { quote, read };
}

test('saved quote restores authoritative subset and payment status with disabled providers, without exposing private billing data', async () => {
  const { quote, read } = savedQuoteFixture();
  for (const status of ['quoted', 'paid', 'processing', 'complete', 'failed', 'revoked']) {
    quote.status = status;
    const response = await read({ userId: 'estimator-1' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const saved = await response.json();
    assert.equal(saved.status, status, 'browser query status cannot override the database');
    assert.deepEqual(saved.trades, ['Drywall', 'Framing']);
    assert.equal(saved.scope, 'Residential');
    assert.equal(saved.amount_cents, 500);
    assert.deepEqual(Object.keys(saved).sort(), ['id', 'project_id', 'file_id', 'amount_cents', 'currency', 'page_count', 'trades', 'scope', 'status', 'attempts', 'job_id', 'expires_at', 'membership', 'max_attempts'].sort());
  }
});

test('saved quote lookup authenticates role and binds quote, workspace, project and file before returning payment state', async () => {
  const { read } = savedQuoteFixture();
  for (const [options, status] of [
    [{ userId: null }, 401], [{ userId: 'outsider' }, 403], [{ userId: 'viewer-1' }, 403],
    [{ projectId: 'project-2' }, 404], [{ workspaceId: 'workspace-2', projectId: 'project-2' }, 404],
    [{ fileId: 'file-2' }, 404], [{ quoteId: 'quote-2' }, 404],
    [{ fileId: '' }, 400], [{ quoteId: '' }, 400],
    [{ path: '/api/projects/project-1/reading-checkout' }, 405],
  ] as const) {
    const response = await read(options);
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(typeof body.error, 'string');
    assert.equal(body.trades, undefined);
    assert.equal(body.amount_cents, undefined);
  }
});
