import test from 'node:test';
import assert from 'node:assert/strict';
import { roughbidEmailHtml, roughbidEmailLogoUrl, ROUGHBID_EMAIL_LOGO_URL } from '../src/email/brand.ts';
import { loadResendServerConfig, sendMagicLinkEmail, sendWorkspaceInviteEmail, createProposalOpenedEmail, createProposalSignedEmail } from '../src/email/resend.ts';
import { composePilotEmail, composePilotReminder, sendPilotEmail } from '../src/pilot/email.ts';
import { handlePilotReminders } from '../src/pilot/notifications.ts';

test('email brand layout preserves the action URL and escapes untrusted copy and query delimiters',()=>{
  const action='https://auth.example/verify?token=one&redirect_to=https%3A%2F%2Froughbid.vercel.app%2Fapp%2F%3Fpilot_invite%3Dtwo';
  const html=roughbidEmailHtml({title:'<unsafe>',paragraphs:['<img src=x onerror=alert(1)>'],action:{label:'Open & continue',url:action},footer:'Footer'});
  assert.match(html,/&lt;unsafe&gt;/);assert.doesNotMatch(html,/<img src=x/);
  assert.ok(html.includes(`href="${action.replaceAll('&','&amp;')}"`));
  assert.ok(html.includes(`src="${ROUGHBID_EMAIL_LOGO_URL}"`));
  assert.match(html,/<img [^>]*alt="RoughBid"[^>]*width="240"[^>]*height="80"[^>]*border="0"/);
  assert.doesNotMatch(html,/<style|<script|<div|<form|<input/);
  assert.throws(()=>roughbidEmailHtml({title:'Open',paragraphs:[],action:{label:'Unsafe',url:'javascript:alert(1)'},footer:''}),/HTTPS/);
});

test('login email retains real sign-in URL in plaintext and branded HTML without replacing tokens',async()=>{
  const magicLink='https://auth.example/verify?token=secret-token&redirect_to=https%3A%2F%2Froughbid.vercel.app%2Fapp%2F';
  await sendMagicLinkEmail({apiKey:'re_test'},{to:'owner@example.com',magicLink,appUrl:'https://roughbid.vercel.app',idempotencyKey:'test-login'},async(_url,options)=>{
    const body=JSON.parse(String(options?.body));assert.ok(body.text.includes(magicLink));
    assert.ok(body.html.includes(ROUGHBID_EMAIL_LOGO_URL));assert.ok(body.html.includes(magicLink.replaceAll('&','&amp;')));
    assert.equal(new Headers(options?.headers).get('Idempotency-Key'),'test-login');return Response.json({id:'message-id'});
  });
});

test('pilot invitations and expiry notices share branding, preserve limits, and retain plaintext fallbacks',()=>{
  const invite=composePilotEmail({to:'builder@example.com',inviteUrl:'https://roughbid.vercel.app/app/?pilot_invite=test_token',preset:'pilot60',expiresAt:'2099-01-01T00:00:00Z'});
  const reminder=composePilotReminder({daysRemaining:7,appUrl:'https://roughbid.vercel.app',expiresAt:'2099-02-01T00:00:00Z'});
  for(const email of [invite,reminder]) {assert.ok(email.html.includes(ROUGHBID_EMAIL_LOGO_URL));assert.match(email.text,/RoughBid/);assert.match(email.html,/<!DOCTYPE html>/);}
  assert.match(invite.text,/60 days from activation/);assert.match(invite.text,/10 MiB and 10 pages/);assert.match(invite.text,/not be charged automatically/);
  assert.match(invite.html,/pilot_invite=test_token/);assert.match(reminder.text,/no automatic charge is scheduled/);
});

test('proposal notifications populate the APP_URL expected by the published templates',()=>{
  for(const compose of [createProposalOpenedEmail,createProposalSignedEmail]) {
    const email=compose({to:'owner@example.com',proposalTitle:'Estimate',clientName:'Client',projectName:'Project',proposalUrl:'https://roughbid.vercel.app/proposal/real-token'});
    assert.equal(email.variables.APP_URL,'https://roughbid.vercel.app/proposal/real-token');
    assert.equal(email.variables.PROPOSAL_URL,email.variables.APP_URL);
  }
});

test('email logo uses a public HTTPS app origin and preserves the existing fallback',()=>{
  assert.equal(roughbidEmailLogoUrl({ APP_URL: ' https://theroughbid.com/app/?invite=private ' }), 'https://theroughbid.com/brand/roughbid-logo-email.png');
  for (const appUrl of [undefined, '', 'not a URL', 'http://localhost:3000', 'https://user:password@example.com']) {
    assert.equal(roughbidEmailLogoUrl({ APP_URL: appUrl }), ROUGHBID_EMAIL_LOGO_URL);
  }
});

test('configured sender reaches every email transport without changing message links or idempotency',async(t)=>{
  const previousFrom = process.env.RESEND_FROM_EMAIL;
  const previousAppUrl = process.env.APP_URL;
  t.after(()=>{
    if (previousFrom === undefined) delete process.env.RESEND_FROM_EMAIL; else process.env.RESEND_FROM_EMAIL = previousFrom;
    if (previousAppUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = previousAppUrl;
  });
  process.env.RESEND_FROM_EMAIL = ' RoughBid <hello@mail.theroughbid.com> ';
  process.env.APP_URL = 'https://theroughbid.com';
  const messages: any[] = [];
  const sender: typeof fetch = async(_url,options)=>{
    const body = JSON.parse(String(options?.body));
    assert.equal(body.from, 'RoughBid <hello@mail.theroughbid.com>');
    assert.ok(new Headers(options?.headers).get('Idempotency-Key'));
    if (body.html) assert.ok(body.html.includes('https://theroughbid.com/brand/roughbid-logo-email.png'));
    messages.push(body);
    return Response.json({ id: `email-${messages.length}` });
  };
  const config = loadResendServerConfig({ RESEND_API_KEY: 're_test', RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL });
  const magicLink = 'https://auth.example/verify?token=unchanged&redirect_to=https%3A%2F%2Ftheroughbid.com%2Fapp%2F';
  await sendMagicLinkEmail(config,{to:'builder@example.com',magicLink,appUrl:process.env.APP_URL,idempotencyKey:'login-test'},sender);
  await sendWorkspaceInviteEmail(config,{to:'builder@example.com',workspaceName:'Test',role:'estimator',inviteUrl:'https://theroughbid.com/app/?invite=unchanged',idempotencyKey:'workspace-test'},sender);
  await sendPilotEmail({to:'builder@example.com',inviteUrl:'https://theroughbid.com/app/?pilot_invite=unchanged',preset:'pilot60',expiresAt:'2099-01-01T00:00:00Z',invitationId:'pilot-test'},'re_test',sender);
  const db = { rpc: async(name: string) => ({data: name === 'claim_pilot_notifications' ? [{id:'notice-test',lease_id:'lease-test',email:'builder@example.com',kind:'expires_1d',expires_at:'2099-01-01T00:00:00Z'}] : {}, error:null}) };
  const response = await handlePilotReminders(new Request('https://theroughbid.com/api/pilot/reminders',{headers:{authorization:'Bearer cron-test'}}),db,{...process.env,RESEND_API_KEY:'re_test',CRON_SECRET:'cron-test'},sender);
  assert.equal(response.status, 200);
  assert.equal(messages.length, 4);
  assert.ok(messages[0].text.includes(magicLink));
  assert.equal(messages[1].template.variables.INVITE_URL, 'https://theroughbid.com/app/?invite=unchanged');
  assert.equal(loadResendServerConfig({RESEND_API_KEY:'re_test',RESEND_FROM_EMAIL:' '}).from, 'RoughBid <hello@mail.kspdominion.group>');
});
