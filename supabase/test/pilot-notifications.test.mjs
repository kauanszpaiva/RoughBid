import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const id=(n)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function fixture() {
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create table pilot_invitations(id uuid primary key,email text,email_message_id text,revoked_at timestamptz);
    create table pilot_enrollments(user_id uuid primary key,invitation_id uuid references pilot_invitations(id),preset text,expires_at timestamptz,revoked_at timestamptz);
    grant usage on schema public to authenticated;`);
  await db.exec(readFileSync(new URL('../migrations/0031_pilot_notifications.sql',import.meta.url),'utf8'));
  return db;
}
async function add(db,n,preset,remaining) {
  await db.query('insert into auth.users values($1,$2,now())',[id(n),`user${n}@example.com`]);
  await db.query('insert into pilot_invitations(id,email,email_message_id) values($1,$2,$3)',[id(n),`user${n}@example.com`,`invite${n}`]);
  await db.query("insert into pilot_enrollments values($1,$1,$2,now()+$3::interval,null)",[id(n),preset,remaining]);
}
const claim=async(db)=>(await db.query('select claim_pilot_notifications(10) as r')).rows[0].r;
test('expiry outbox selects seven-day, one-day, expired windows and excludes seven-day samples',async()=>{
  const db=await fixture();try {
    await add(db,1,'pilot60','6 days');await add(db,2,'month1','12 hours');await add(db,3,'pilot60','-1 hour');await add(db,4,'sample1','6 days');await add(db,5,'pilot60','10 days');
    const notices=await claim(db);assert.equal(notices.length,3);assert.deepEqual(notices.map(n=>n.kind).sort(),['expired','expires_1d','expires_7d']);
    assert.equal((await claim(db)).length,0,'live leases cannot be claimed twice');
    for(const row of notices) await db.query('select finish_pilot_notification($1,$2,$3,null)',[row.id,row.lease_id,`message-${row.id}`]);
    assert.equal((await claim(db)).length,0,'successful sends never repeat');
    await db.exec('set role authenticated');await assert.rejects(db.query('select claim_pilot_notifications(10)'),/permission denied/);
  } finally {await db.close();}
});
test('retry preserves outbox id and rejects obsolete leases; ambiguous stale sends stop for review',async()=>{
  const db=await fixture();try {
    await add(db,1,'pilot60','6 days');const [first]=await claim(db);
    await db.query('select finish_pilot_notification($1,$2,null,$3)',[first.id,first.lease_id,'Temporary failure']);
    assert.equal((await claim(db)).length,0);
    await db.exec("update pilot_notification_outbox set next_attempt_at=now()-interval '1 minute'");const [second]=await claim(db);
    assert.equal(first.id,second.id);assert.notEqual(first.lease_id,second.lease_id);
    await assert.rejects(db.query('select finish_pilot_notification($1,$2,$3,null)',[first.id,first.lease_id,'late-message']),/lease is no longer active/);
    await db.exec("update pilot_notification_outbox set first_attempt_at=now()-interval '24 hours',lease_expires_at=now()-interval '1 minute'");
    assert.equal((await claim(db)).length,0);assert.equal((await db.query('select status from pilot_notification_outbox')).rows[0].status,'needs_review');
  } finally {await db.close();}
});
test('revocations and bounced recipients suppress reminders; delivery events dedupe and ignore older updates',async()=>{
  const db=await fixture();try {
    await add(db,1,'pilot60','6 days');await add(db,2,'month1','12 hours');
    await db.query("select record_pilot_email_event('event1','invite1','email.bounced',now())");
    const notices=await claim(db);assert.equal(notices.length,1);assert.equal(notices[0].user_id,id(2));
    const duplicate=(await db.query("select record_pilot_email_event('event1','invite1','email.bounced',now()) as r")).rows[0].r;assert.equal(duplicate.duplicate,true);
    await db.query("select record_pilot_email_event('old-event','invite1','email.sent',now()-interval '1 day')");
    assert.equal((await db.query('select email_delivery_status from pilot_invitations where id=$1',[id(1)])).rows[0].email_delivery_status,'email.bounced');
    await db.query('update pilot_enrollments set revoked_at=now() where user_id=$1',[id(2)]);assert.equal((await claim(db)).length,0);
    assert.equal((await db.query('select status from pilot_notification_outbox')).rows[0].status,'suppressed');
  } finally {await db.close();}
});
test('delivery events arriving before provider message persistence reconcile afterwards',async()=>{
  const db=await fixture();try {
    await add(db,1,'pilot60','6 days');const [notice]=await claim(db);
    await db.query("select record_pilot_email_event('early-notice','notification-id','email.delivered',now())");
    await db.query('select finish_pilot_notification($1,$2,$3,null)',[notice.id,notice.lease_id,'notification-id']);
    assert.equal((await db.query('select provider_delivery_status from pilot_notification_outbox')).rows[0].provider_delivery_status,'email.delivered');
    await db.query("select record_pilot_email_event('early-invite','invitation-late','email.delivered',now())");
    await db.query("update pilot_invitations set email_message_id='invitation-late' where id=$1",[id(1)]);
    assert.equal((await db.query('select email_delivery_status from pilot_invitations')).rows[0].email_delivery_status,'email.delivered');
  } finally {await db.close();}
});
