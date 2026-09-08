import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { inspectPdf, normalizeScope, quoteProject, downloadPlan, MAX_AI_PDF_BYTES } from '../src/billing/project-preflight.ts';
import { ProjectPayments } from '../src/billing/project-payments.ts';
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

test('quoteProject calculates exact all-in markup pricing for $10 illustrative cost (1000 cents)', () => {
  // Configured so base + pages*perPage + trades*perTrade = 1000 cents ($10.00)
  const env = {
    PROJECT_COST_BASE_CENTS: '500',
    PROJECT_COST_PAGE_CENTS: '50', // 8 pages = 400
    PROJECT_COST_TRADE_CENTS: '50', // 2 trades = 100 => 500 + 400 + 100 = 1000 cents
    PROJECT_PAYMENT_FIXED_CENTS: '30',
    PROJECT_PAYMENT_FEE_BPS: '290',
    PROJECT_PRICING_VERSION: 'test-v1',
  };

  const noSub = quoteProject(8, 2, 'standard', env);
  assert.equal(noSub.costCents, 1000);
  assert.equal(noSub.bufferedCostUsd, 13.00);
  assert.equal(noSub.markupPercent, 50);
  assert.equal(noSub.finalPriceUsd, 19.50);
  assert.equal(noSub.amountCents, 1950);

  const starter = quoteProject(8, 2, 'starter', env);
  assert.equal(starter.markupPercent, 40);
  assert.equal(starter.finalPriceUsd, 18.20);
  assert.equal(starter.amountCents, 1820);

  const pro = quoteProject(8, 2, 'pro', env);
  assert.equal(pro.markupPercent, 33);
  assert.equal(pro.finalPriceUsd, 17.29);
  assert.equal(pro.amountCents, 1729);

  const team = quoteProject(8, 2, 'team', env);
  assert.equal(team.markupPercent, 25);
  assert.equal(team.finalPriceUsd, 16.25);
  assert.equal(team.amountCents, 1625);
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

function checkoutFixture(env: Record<string, string | undefined>) {
  const mutations: string[] = [];
  const requests: string[] = [];
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
  }, rpc: async () => { mutations.push('rpc'); return { data: null, error: null }; } };
  const fetcher = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json({ id: 'cs_test', url: 'https://checkout.stripe.test/session' });
  }) as typeof fetch;
  return { payments: new ProjectPayments(db, env, fetcher), mutations, requests };
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
    const f = checkoutFixture(env);
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
  const f = checkoutFixture({ PAID_PLAN_READINGS_ENABLED: 'true', GEMINI_API_KEY: 'unit-provider-credential', GEMINI_MODEL: 'gemini-2.5-flash',
    STRIPE_SECRET_KEY: 'sk_test_unitcredential', APP_URL: 'https://roughbid.test' });
  await assert.rejects(f.payments.checkout('user-1', 'workspace-1', 'project-1', 'quote-1'), (error: any) => error.status === 503);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.mutations, []);
});

test('deliberately configured paid checkout still works with an injected test gateway', async () => {
  const f = checkoutFixture({ PAID_PLAN_READINGS_ENABLED: 'true', GEMINI_API_KEY: 'unit-provider-credential', GEMINI_MODEL: 'gemini-2.5-flash',
    STRIPE_SECRET_KEY: 'sk_test_unitcredential', STRIPE_WEBHOOK_SECRET: 'whsec_test_unitcredential', APP_URL: 'https://roughbid.test' });
  const checkout = await f.payments.checkout('user-1', 'workspace-1', 'project-1', 'quote-1');
  assert.equal(checkout.url, 'https://checkout.stripe.test/session');
  assert.deepEqual(f.requests, ['https://api.stripe.com/v1/checkout/sessions']);
  assert.deepEqual(f.mutations, ['project_reading_quotes']);
});
