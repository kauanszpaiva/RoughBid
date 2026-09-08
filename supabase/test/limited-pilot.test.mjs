import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const token=n=>Number(n).toString(16).padStart(64,'0');
async function fixture() {
  const db=new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema private; create schema storage;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create table public.profiles(id uuid primary key,is_platform_admin boolean not null default false);
    create table public.workspaces(id uuid primary key default gen_random_uuid(),name text,created_by uuid,ai_processing_consented_at timestamptz);
    create table public.workspace_members(workspace_id uuid,user_id uuid,role text);
    create table public.entitlements(id uuid primary key default gen_random_uuid(),user_id uuid,kind text,source text,external_ref text,starts_at timestamptz,expires_at timestamptz,revoked_at timestamptz);
    create table public.projects(id uuid primary key,workspace_id uuid,created_by uuid,unique(id,workspace_id));
    create table public.project_files(id uuid primary key,workspace_id uuid,project_id uuid,uploaded_by uuid,byte_size bigint,storage_path text,processing_status text);
    create table public.billing_customers(user_id uuid primary key,subscription_status text);
    create table public.billing_checkout_attempts(user_id uuid primary key,expires_at timestamptz);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function private.has_workspace_access(uuid) returns boolean language sql as 'select false';
    create function private.has_product_access() returns boolean language sql as 'select false';
    create function private.has_workspace_role(uuid,text[]) returns boolean language sql security definer as $$select exists(select 1 from public.workspace_members where workspace_id=$1 and user_id=auth.uid() and role=any($2))$$;
    create function private.can_write_plan_object(text) returns boolean language sql as 'select false';
    alter table storage.objects enable row level security;
    create policy storage_select on storage.objects for select to authenticated using (true);
    create policy plan_files_storage_insert_rbac on storage.objects for insert to authenticated with check(bucket_id='plan-files' and private.can_write_plan_object(name));
    create policy plan_files_storage_update_rbac on storage.objects for update to authenticated using(bucket_id='plan-files' and private.can_write_plan_object(name)) with check(bucket_id='plan-files' and private.can_write_plan_object(name));
    create policy plan_files_storage_delete_rbac on storage.objects for delete to authenticated using(bucket_id='plan-files' and private.can_write_plan_object(name));
    create function private.add_member() returns trigger language plpgsql security definer as $$begin insert into public.workspace_members values(new.id,new.created_by,'admin'); return new; end$$;
    create trigger add_member after insert on public.workspaces for each row execute function private.add_member();
    grant usage on schema public,auth,private,storage to authenticated;
    grant insert,update,delete,select on storage.objects to authenticated;
    grant execute on function auth.uid() to authenticated;
    grant insert,update,delete,select on public.projects,public.project_files,public.workspace_members to authenticated;
  `);
  for(const migration of ['0007_plan_ai_pipeline.sql','0017_paid_project_readings.sql','0026_platform_admin_complimentary_access.sql','0027_limited_pilot.sql','0029_platform_admin_unlimited_readings.sql','0032_pilot_storage_and_enrollment_guards.sql']) {
    await db.exec(readFileSync(new URL(`../migrations/${migration}`,import.meta.url),'utf8'));
  }
  await db.exec(`insert into auth.users values('${id(1)}','owner@example.com',now());insert into profiles values('${id(1)}',true);`);
  return db;
}
const asUser=(db,n)=>db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(n)]);
const issue=async(db,n,preset='pilot60')=>{
  await db.query('insert into auth.users values($1,$2,now()) on conflict do nothing',[id(n),`pilot${n}@example.com`]);
  await db.query('insert into profiles values($1,false) on conflict do nothing',[id(n)]);
  return (await db.query('select issue_pilot_invitation($1,$2,$3,$4) as r',[id(1),`pilot${n}@example.com`,token(n),preset])).rows[0].r;
};
const redeem=async(db,n)=>{
  await asUser(db,n);
  const e=(await db.query('select redeem_pilot_invitation($1,$2) as r',[token(n),'Pilot workspace'])).rows[0].r;
  await db.query('update workspaces set ai_processing_consented_at=now() where id=$1',[e.workspace_id]);
  return e;
};
const project=(db,n,workspace,p)=>db.query('insert into projects values($1,$2,$3)',[id(p),workspace,id(n)]);
const file=(db,n,workspace,p,f,size=100)=>db.query('insert into project_files values($1,$2,$3,$4,$5,$6,$7)',[id(f),workspace,id(p),id(n),size,`${workspace}/${id(p)}/${id(f)}.pdf`,'ready']);
const reserve=(db,n,workspace,p,f,fp=token(999),pages=1,bytes=100)=>db.query('select reserve_pilot_reading($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as r',[id(n),workspace,id(p),id(f),'gemini-2.5-flash',token(888),fp,['Framing'],'',pages,bytes]);

test('pilot SQL: verified recipient, immutable offers, 25-seat cap, presets and service-only administration',async()=>{
  const db=await fixture();
  try {
    const first=await issue(db,2,'sample1');
    const resent=await issue(db,2,'pilot60');
    assert.equal(resent.id,first.id); assert.equal(resent.preset,'sample1'); assert.equal(resent.expires_at,first.expires_at);
    assert.equal(resent.token_hash,undefined);
    await issue(db,3,'month1'); await asUser(db,3);
    await assert.rejects(db.query('select redeem_pilot_invitation($1)',[token(2)]),/verified recipient email/);
    await db.exec(`update auth.users set email_confirmed_at=null where id='${id(2)}'`);
    await asUser(db,2); await assert.rejects(db.query('select redeem_pilot_invitation($1)',[token(2)]),/verified recipient email/);
    await db.exec(`update auth.users set email_confirmed_at=now() where id='${id(2)}'`);
    const sample=await redeem(db,2); const sampleRetry=await redeem(db,2);
    assert.equal(sample.workspace_id,sampleRetry.workspace_id); assert.equal(sampleRetry.reused,true);
    assert.equal((Date.parse(sample.expires_at)-Date.parse(sample.starts_at))/86400000,7);
    const month=await redeem(db,3); assert.equal((Date.parse(month.expires_at)-Date.parse(month.starts_at))/86400000,30);
    for(let n=4;n<=26;n++) await issue(db,n);
    await assert.rejects(issue(db,27),/cohort is full/);
    const full=await redeem(db,4); assert.equal((Date.parse(full.expires_at)-Date.parse(full.starts_at))/86400000,60);
    await db.query('select mark_pilot_invitation_delivery($1,$2,$3,$4)',[id(1),first.id,'email_accepted_1',null]);
    const dashboard=(await db.query('select list_pilot_invitations($1) as r',[id(1)])).rows[0].r;
    const recipient=dashboard.find(row=>row.id===first.id);
    assert.equal(dashboard.length,25); assert.equal(recipient.token_hash,undefined);
    assert.equal(recipient.enrollment_expires_at,sample.expires_at);
    assert.equal(recipient.email_status,'sent'); assert.equal(recipient.email_attempts,1);
    assert.equal(recipient.access.limits.total_projects,1); assert.equal(recipient.reserved_cents,0);
    await db.exec('set role authenticated');
    await assert.rejects(project(db,1,full.workspace_id,100),/creator must match/);
    await assert.rejects(db.query('select issue_pilot_invitation($1,$2,$3)',[id(1),'forged@example.com',token(222)]),/permission denied/);
    await assert.rejects(db.query('select get_pilot_access($1)',[id(2)]),/permission denied/);
    await assert.rejects(db.exec('update pilot_enrollments set reserved_cents=0'),/permission denied/);
    const status=(await db.query('select pilot_status() as r')).rows[0].r;
    assert.equal(status.preset,'pilot60'); assert.equal(status.limits.projects_per_week,2);
    await db.exec('reset role');
  } finally {await db.close();}
});

test('pilot SQL: direct inserts, cross-workspace creation, deletion and forged metadata cannot reset quotas',async()=>{
  const db=await fixture();
  try {
    await issue(db,2); const e=await redeem(db,2);
    await db.query('insert into workspaces(name,created_by) values($1,$2)',['Other workspace',id(2)]);
    const other=(await db.query('select id from workspaces where id<>$1',[e.workspace_id])).rows[0].id;
    await db.exec('set role authenticated');
    await project(db,2,e.workspace_id,101); await project(db,2,other,102);
    await db.query('delete from projects where id=$1',[id(101)]);
    await assert.rejects(project(db,2,e.workspace_id,103),/project limit reached/);
    await assert.rejects(db.query('update projects set created_by=$1 where id=$2',[id(1),id(102)]),/identity is immutable/);
    await assert.rejects(file(db,1,other,102,201),/uploader must match/);
    await assert.rejects(file(db,2,other,102,201,10485761),/at most 10 MiB/);
    await file(db,2,other,102,201);
    await db.query('delete from project_files where id=$1',[id(201)]);
    await assert.rejects(file(db,2,other,102,202),/one PDF per project/);
    await assert.rejects(db.query('insert into workspace_members values($1,$2,$3)',[e.workspace_id,id(1),'admin']),/one login only/);
    await db.exec('reset role');
    await db.exec(`update pilot_project_creations set created_at=now()-interval '8 days' where user_id='${id(2)}'`);
    await project(db,2,e.workspace_id,104); // Rolling window, even though deleted history remains.
    assert.equal((await db.query('select count(*)::int as n from pilot_project_creations')).rows[0].n,3);
    await issue(db,3,'sample1'); const sample=await redeem(db,3);
    await project(db,3,sample.workspace_id,105);
    await db.exec(`update pilot_project_creations set created_at=now()-interval '8 days' where user_id='${id(3)}'`);
    await assert.rejects(project(db,3,sample.workspace_id,106),/project limit reached/);
  } finally {await db.close();}
});

test('pilot SQL: one reserved attempt, actual PDF bounds, failure retention, scope deduplication and budget exhaustion',async()=>{
  const db=await fixture();
  try {
    await issue(db,2); const e=await redeem(db,2);
    await project(db,2,e.workspace_id,101); await file(db,2,e.workspace_id,101,201);
    await assert.rejects(db.query('select reserve_pilot_reading($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id(2),e.workspace_id,id(101),id(201),'unbounded-model',token(888),token(999),['Framing'],'',1,100]),/model is not authorized/);
    await assert.rejects(reserve(db,2,e.workspace_id,101,201,token(999),11),/at most 10 pages/);
    await assert.rejects(reserve(db,2,e.workspace_id,101,201,token(999),1,10485761),/10 MiB/);
    await assert.rejects(reserve(db,3,e.workspace_id,101,201),/Active pilot/);
    const first=(await reserve(db,2,e.workspace_id,101,201)).rows[0].r;
    const retry=(await reserve(db,2,e.workspace_id,101,201)).rows[0].r;
    assert.equal(retry.reused,true); assert.equal(retry.job.id,first.job.id);
    await assert.rejects(reserve(db,2,e.workspace_id,101,201,token(1000)),/one AI attempt/);
    assert.equal((await db.query('select reserved_cents from pilot_cohorts')).rows[0].reserved_cents,25);
    await db.query('select finish_pilot_reading($1,$2,$3,$4,$5)',[first.job.id,id(2),'{}','[]','Provider timeout']);
    await assert.rejects(reserve(db,2,e.workspace_id,101,201),/failed attempts remain counted/);
    assert.equal((await db.query('select reserved_cents from pilot_enrollments')).rows[0].reserved_cents,25);
    await project(db,2,e.workspace_id,102); await file(db,2,e.workspace_id,102,202);
    await db.exec('update pilot_enrollments set reserved_cents=500');
    await assert.rejects(reserve(db,2,e.workspace_id,102,202),/budget exhausted/);
    await db.exec('update pilot_enrollments set reserved_cents=25;update pilot_cohorts set reserved_cents=12500');
    await assert.rejects(reserve(db,2,e.workspace_id,102,202),/budget exhausted/);
    await db.exec('update pilot_cohorts set reserved_cents=25');
    const second=(await reserve(db,2,e.workspace_id,102,202)).rows[0].r;
    const findings=[{page_number:1,finding_type:'measurement',label:'Wall',quantity:10,unit:'LF',confidence:.9,geometry:{},source_excerpt:'10 LF'}];
    await assert.rejects(db.query('select finish_pilot_reading($1,$2,$3,$4,$5)',[second.job.id,id(2),'{"synthetic":true}',JSON.stringify(findings),null]),/Real findings required/);
    const completed=(await db.query('select finish_pilot_reading($1,$2,$3,$4,$5) as r',[second.job.id,id(2),'{"sheet_count":1}',JSON.stringify(findings),null])).rows[0].r;
    assert.equal(completed.status,'needs_review'); assert.equal(completed.plan_reading_findings.length,1);
    assert.equal((await db.query('select count(*)::int as n from project_reading_quotes')).rows[0].n,0);
    await db.exec('set role authenticated');
    await assert.rejects(reserve(db,2,e.workspace_id,102,202),/permission denied/);
    await db.exec('reset role');
  } finally {await db.close();}
});

test('pilot SQL: expiry and revocation end sponsored AI; personal owner has no 25/day ceiling',async()=>{
  const db=await fixture();
  try {
    const invitation=await issue(db,2); const e=await redeem(db,2);
    await project(db,2,e.workspace_id,101); await file(db,2,e.workspace_id,101,201);
    await db.exec(`update pilot_enrollments set starts_at=starts_at-interval '61 days',expires_at=expires_at-interval '61 days'`);
    assert.equal((await db.query('select get_pilot_access($1) as r',[id(2)])).rows[0].r.status,'expired');
    await assert.rejects(reserve(db,2,e.workspace_id,101,201),/Active pilot enrollment/);
    await project(db,2,e.workspace_id,102); await project(db,2,e.workspace_id,103); // ordinary manual access preserved
    await db.query('select revoke_pilot_invitation($1,$2)',[id(1),invitation.id]);
    assert.equal((await db.query('select get_pilot_access($1) as r',[id(2)])).rows[0].r.status,'revoked');
    await asUser(db,1);
    await db.exec(`insert into workspaces(id,name,created_by,ai_processing_consented_at) values('${id(10)}','Owner','${id(1)}',now());`);
    await project(db,1,id(10),110); await file(db,1,id(10),110,210);
    for(let n=0;n<26;n++) await db.query('select reserve_platform_admin_reading($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id(1),id(10),id(110),id(210),'gemini-test',token(888),token(n+1),['Framing'],'']);
    assert.equal((await db.query("select count(*)::int as n from plan_reading_jobs where input_summary->>'entitlement'='platform_admin_complimentary'")).rows[0].n,26);
    assert.equal((await db.query('select reserved_cents from pilot_cohorts')).rows[0].reserved_cents,0);
  } finally {await db.close();}
});

test('pilot SQL: legacy storage writes are denied during sponsorship while cleanup and ordinary tenant access remain',async()=>{
  const db=await fixture();
  try {
    await issue(db,2); const e=await redeem(db,2);
    const path=`${e.workspace_id}/${id(101)}/${id(201)}.pdf`;
    await db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['plan-files',path]);
    await db.exec('set role authenticated');
    await assert.rejects(db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['plan-files',`${e.workspace_id}/hidden.pdf`]),/row-level security/);
    assert.equal((await db.query('update storage.objects set name=$1 where name=$2 returning name',[`${e.workspace_id}/overwritten.pdf`,path])).rows.length,0);
    assert.equal((await db.query('delete from storage.objects where name=$1 returning name',[path])).rows.length,1);
    await db.exec('reset role');
    await db.exec(`update pilot_enrollments set starts_at=starts_at-interval '61 days',expires_at=expires_at-interval '61 days'`);
    await db.exec('set role authenticated');
    await db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['plan-files',path]);
    await assert.rejects(db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['plan-files',`${id(999)}/foreign.pdf`]),/row-level security/);
    await db.exec('reset role');
    await asUser(db,1);
    await db.exec(`insert into workspaces(id,name,created_by) values('${id(10)}','Owner','${id(1)}');`);
    await db.exec('set role authenticated');
    await db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['plan-files',`${id(10)}/owner.pdf`]);
    await assert.rejects(db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['plan-files',`${e.workspace_id}/foreign-owner.pdf`]),/row-level security/);
    await db.exec('reset role');
  } finally {await db.close();}
});

test('pilot SQL: existing memberships and open checkout prevent enrollment without canceling billing',async()=>{
  const db=await fixture();
  try {
    await issue(db,2); await asUser(db,2);
    await db.query('insert into billing_customers values($1,$2)',[id(2),'active']);
    for(const status of ['active','trialing','past_due','paused','unpaid','incomplete']) {
      await db.query('update billing_customers set subscription_status=$1',[status]);
      await assert.rejects(db.query('select redeem_pilot_invitation($1)',[token(2)]),/end the existing membership/);
    }
    assert.equal((await db.query('select count(*)::int as n from workspaces')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int as n from pilot_enrollments')).rows[0].n,0);
    assert.equal((await db.query('select accepted_at from pilot_invitations')).rows[0].accepted_at,null);
    await db.exec("update billing_customers set subscription_status='canceled'");
    await db.query("insert into billing_checkout_attempts values($1,now()+interval '1 hour')",[id(2)]);
    await assert.rejects(db.query('select redeem_pilot_invitation($1)',[token(2)]),/checkout is still open/);
    await db.exec("update billing_checkout_attempts set expires_at=now()-interval '1 minute'");
    const redeemed=(await db.query('select redeem_pilot_invitation($1) as r',[token(2)])).rows[0].r;
    assert.equal(redeemed.reused,false);
    assert.equal((await db.query('select subscription_status from billing_customers')).rows[0].subscription_status,'canceled');
    await issue(db,3); await asUser(db,3);
    await db.query('insert into billing_customers values($1,$2)',[id(3),'incomplete_expired']);
    await db.query('select redeem_pilot_invitation($1)',[token(3)]);
    await issue(db,4); await asUser(db,4);
    await db.query('insert into billing_customers values($1,null)',[id(4)]);
    await db.query('select redeem_pilot_invitation($1)',[token(4)]);
  } finally {await db.close();}
});
