import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handlePilotReminders, handleResendWebhook, verifyResendWebhook } from '../src/pilot/notifications.ts';

const secret='whsec_'+Buffer.from('test-webhook-secret-with-32-bytes!').toString('base64');
const env={CRON_SECRET:'protected-cron-test',RESEND_API_KEY:'re-test',APP_URL:'https://roughbid.example',RESEND_WEBHOOK_SECRET:secret};
const payload={type:'email.delivered',created_at:'2026-09-08T12:00:00Z',data:{email_id:'provider-message-id'}};
const signed=(raw:string,timestamp=Math.floor(Date.now()/1000))=>{
  const sig=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`event-id.${timestamp}.${raw}`).digest('base64');
  return new Headers({'svix-id':'event-id','svix-timestamp':String(timestamp),'svix-signature':`v1,${sig}`});
};
test('Svix verification matches the published primary-source signature vector',()=>{
  const raw='{"event_type":"ping","data":{"success":true}}';
  const verified=verifyResendWebhook(raw,new Headers({'svix-id':'msg_loFOjxBNrRLzqYUf','svix-timestamp':'1731705121','svix-signature':'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0='}),'whsec_plJ3nmyCDGBKInavdOK15jsl',1731705121000);
  assert.equal(verified.event.event_type,'ping');
});
test('Resend signature rejects tampering, missing headers, wrong secrets, and stale timestamps',()=>{
  const raw=JSON.stringify(payload);const headers=signed(raw);
  assert.equal(verifyResendWebhook(raw,headers,secret).eventId,'event-id');
  assert.throws(()=>verifyResendWebhook(raw+' ',headers,secret),/signature/);
  assert.throws(()=>verifyResendWebhook(raw,new Headers(),secret),/signature/);
  assert.throws(()=>verifyResendWebhook(raw,headers,'whsec_'+Buffer.from('another-secret-of-adequate-length').toString('base64')),/signature/);
  assert.throws(()=>verifyResendWebhook(raw,signed(raw,1),secret),/signature/);
});
test('unsigned webhooks never mutate delivery tracking; verified metadata is persisted',async()=>{
  const calls:any[]=[];const db={rpc:async(name:string,args?:Record<string,unknown>)=>{calls.push({name,args});return {data:{duplicate:false},error:null};}};
  const raw=JSON.stringify(payload);
  const bad=await handleResendWebhook(new Request('https://roughbid.example/api/webhooks/resend',{method:'POST',body:raw}),db,env);
  assert.equal(bad.status,400);assert.equal(calls.length,0);
  const good=await handleResendWebhook(new Request('https://roughbid.example/api/webhooks/resend',{method:'POST',body:raw,headers:signed(raw)}),db,env);
  assert.equal(good.status,200);assert.deepEqual(calls[0],{name:'record_pilot_email_event',args:{p_event_id:'event-id',p_message_id:'provider-message-id',p_event_type:'email.delivered',p_occurred_at:payload.created_at}});
});
test('cron is closed without its secret and cannot be invoked by public callers',async()=>{
  const db={rpc:async()=>{throw new Error('Must not run');}};const request=new Request('https://roughbid.example/api/pilot/reminders');
  assert.equal((await handlePilotReminders(request,db,{})).status,503);
  assert.equal((await handlePilotReminders(request,db,env)).status,401);
});
test('empty cohort creates no provider calls and claimed notices persist stable provider ids',async()=>{
  const calls:any[]=[];let empty=true;let sent=0;
  const db={rpc:async(name:string,args?:Record<string,unknown>)=>{calls.push({name,args});return {data:name==='claim_pilot_notifications' ? empty ? [] : [{id:'notice-id',lease_id:'lease-id',email:'builder@example.com',kind:'expires_1d',expires_at:'2099-01-01T00:00:00Z'}]:{},error:null};}};
  const request=()=>new Request('https://roughbid.example/api/pilot/reminders',{headers:{authorization:'Bearer protected-cron-test'}});
  const sender:typeof fetch=async(_url,options)=>{sent+=1;assert.equal(new Headers(options?.headers).get('Idempotency-Key'),'roughbid-pilot-notice/notice-id');return Response.json({id:'message-id'});};
  assert.equal((await handlePilotReminders(request(),db,env,sender)).status,200);assert.equal(sent,0);
  empty=false;assert.equal((await handlePilotReminders(request(),db,env,sender)).status,200);assert.equal(sent,1);
  assert.deepEqual(calls.at(-1),{name:'finish_pilot_notification',args:{p_notification_id:'notice-id',p_lease_id:'lease-id',p_message_id:'message-id',p_error:null}});
});
