import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('real SQL: payment, tenant isolation, idempotency, bounded retries and atomic results', async () => {
  const db=new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema private;
      create table auth.users(id uuid primary key);
      create table public.workspaces(id uuid primary key,ai_processing_consented_at timestamptz);
      create table public.workspace_members(workspace_id uuid,user_id uuid,role text);
      create table public.projects(id uuid primary key,workspace_id uuid,unique(id,workspace_id));
      create table public.project_files(id uuid primary key,workspace_id uuid,project_id uuid,processing_status text);
      create function private.has_workspace_access(uuid) returns boolean language sql as 'select false';
      create function private.has_product_access() returns boolean language sql as 'select false';
      create function private.has_workspace_role(uuid,text[]) returns boolean language sql as 'select false';
      create function auth.uid() returns uuid language sql as 'select null::uuid';
    `);
    await db.exec(readFileSync(new URL('../migrations/0007_plan_ai_pipeline.sql',import.meta.url),'utf8'));
    await db.exec(readFileSync(new URL('../migrations/0017_paid_project_readings.sql',import.meta.url),'utf8'));
    await db.exec(`insert into auth.users values('${id(1)}'),('${id(2)}'),('${id(3)}');
      insert into workspaces values('${id(10)}',now()),('${id(20)}',now());
      insert into workspace_members values('${id(10)}','${id(1)}','admin'),('${id(10)}','${id(3)}','viewer'),('${id(20)}','${id(2)}','admin');
      insert into projects values('${id(11)}','${id(10)}'),('${id(21)}','${id(20)}');
      insert into project_files values('${id(12)}','${id(10)}','${id(11)}','ready'),('${id(22)}','${id(20)}','${id(21)}','ready');
      insert into project_reading_quotes(id,workspace_id,project_id,file_id,user_id,file_sha256,page_count,trades,scope,amount_cents,cost_cents,pricing_version,membership,livemode)
      values('${id(13)}','${id(10)}','${id(11)}','${id(12)}','${id(1)}','${'a'.repeat(64)}',1,'["Framing"]','',2000,1000,'test','standard',false);`);
    const reserve=(user=id(1),workspace=id(10),project=id(11),file=id(12))=>db.query('select reserve_project_reading($1,$2,$3,$4,$5,$6) as result',[id(13),user,workspace,project,file,'gemini-test']);
    await assert.rejects(reserve(),/Paid quote required/);
    await assert.rejects(reserve(id(2)),/access denied/);
    await assert.rejects(reserve(id(3)),/access denied/);
    await assert.rejects(reserve(id(1),id(10),id(21),id(22)),/Paid quote required/);
    const pay=(event='evt_1',amount=2000,live=false)=>db.query('select confirm_project_reading_payment($1,$2,$3,$4,$5,$6,$7) as applied',[event,id(13),'cs_test','pi_test',amount,'usd',live]);
    await assert.rejects(pay('evt_bad_amount',1999),/does not match/);
    await assert.rejects(pay('evt_bad_mode',2000,true),/does not match/);
    assert.equal((await pay()).rows[0].applied,true);
    assert.equal((await pay()).rows[0].applied,false);
    const first=(await reserve()).rows[0].result;
    assert.equal(first.quote.attempts,1);
    await assert.rejects(reserve(),/already processing/);
    const finish=(summary,findings,error=null)=>db.query('select finish_project_reading($1,$2,$3,$4,$5) as result',[id(13),first.job.id,JSON.stringify(summary),JSON.stringify(findings),error]);
    await assert.rejects(finish({synthetic:true},[{}]),/Real findings required/);
    assert.equal((await db.query('select count(*)::int as n from plan_reading_findings')).rows[0].n,0);
    await finish({},[],'Provider unavailable');
    const retry=(await reserve()).rows[0].result;
    assert.equal(retry.quote.attempts,2);
    assert.equal(retry.job.id,first.job.id);
    const findings=[{page_number:1,finding_type:'material',label:'Wall',quantity:20,unit:'LF',confidence:0.9,geometry:{},source_excerpt:'20 LF wall'}];
    const completed=(await finish({sheet_count:1},findings)).rows[0].result;
    assert.equal(completed.plan_reading_findings.length,1);
    assert.equal((await reserve()).rows[0].result.reused,true);
    assert.equal((await db.query('select count(*)::int as n from plan_reading_findings')).rows[0].n,1);
    await db.query('select revoke_project_reading_payment($1,$2,$3,$4)',['evt_refund',id(13),'pi_test',false]);
    await pay('evt_paid_out_of_order');
    await assert.rejects(reserve(),/Paid quote required/);
    // Untrusted browser roles cannot call server RPCs or change financial/job state.
    await db.exec('set role authenticated');
    await assert.rejects(pay('evt_forged'),/permission denied/);
    await assert.rejects(db.exec("update project_reading_quotes set status='paid'"),/permission denied/);
    await assert.rejects(db.exec("insert into plan_reading_jobs default values"),/permission denied/);
    await db.exec('reset role');
    // A second paid quote exhausted by two failures cannot spend again.
    await db.exec(`update project_reading_quotes set status='failed',attempts=2 where id='${id(13)}'`);
    await assert.rejects(reserve(),/Attempt limit reached/);
  } finally { await db.close(); }
});
