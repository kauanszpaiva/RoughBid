import test from 'node:test';
import assert from 'node:assert/strict';
import { roughbidEmailHtml, ROUGHBID_EMAIL_LOGO_URL } from '../src/email/brand.ts';
import { sendMagicLinkEmail, createProposalOpenedEmail, createProposalSignedEmail } from '../src/email/resend.ts';
import { composePilotEmail, composePilotReminder } from '../src/pilot/email.ts';

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
