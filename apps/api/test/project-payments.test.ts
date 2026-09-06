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
test('PDF preflight reads pages without AI and rejects oversized/invalid data',async()=>{
  const doc=await PDFDocument.create();doc.addPage();doc.addPage();
  const result=await inspectPdf(await doc.save());assert.equal(result.pages,2);assert.match(result.sha256,/^[a-f0-9]{64}$/);
  await assert.rejects(inspectPdf(new TextEncoder().encode('not a PDF')),/valid PDF/);
  await assert.rejects(inspectPdf(new Uint8Array(MAX_AI_PDF_BYTES+1)),/18 MB/);
  await assert.rejects(downloadPlan('https://storage.test/file',async()=>new Response('x',{headers:{'content-length':String(MAX_AI_PDF_BYTES+1)}})),/18 MB/);
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
