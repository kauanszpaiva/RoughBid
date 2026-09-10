import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handlePilotRequest, normalizePilotBatch, pilotToken } from '../src/pilot/routes.ts';
import { composePilotEmail, sendPilotEmail } from '../src/pilot/email.ts';
import { sendBrandedMagicLink } from '../src/auth/sign-in.ts';

const env = { PILOT_INVITE_SIGNING_SECRET: 'a-secure-test-secret-of-at-least-32-characters', RESEND_API_KEY: 're_test', APP_URL: 'https://roughbid.example' };
const invitation = { id: '11111111-1111-4111-8111-111111111111', email: 'builder@example.com', preset: 'pilot60', expires_at: '2099-01-01T00:00:00Z', email_status: 'pending', accepted_at: null, revoked_at: null, token_hash: 'never-return-this-hash' };
const request = (path: string, body?: unknown) => new Request(`https://roughbid.example${path}`, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
function fixture(options: { user?: string | null; owner?: boolean; rpcError?: string; issued?: Record<string, unknown> } = {}) {
  const calls: { name: string; args?: Record<string, unknown> }[] = [];
  const db = {
    auth: { getUser: async () => ({ data: { user: options.user === null ? null : { id: options.user ?? 'owner-id' } }, error: null }) },
    from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { is_platform_admin: options.owner ?? true }, error: null }) }),
    rpc: async (name: string, args?: Record<string, unknown>) => {
      calls.push({ name, args });
      if (options.rpcError) return { data: null, error: { message: options.rpcError } };
      if (name === 'issue_pilot_invitation') return { data: options.issued ?? invitation, error: null };
      if (name === 'list_pilot_invitations') return { data: [{ ...invitation, access: { expires_at: '2099-02-01T00:00:00Z', reserved_cents: 75, budget_cents: 500 } }], error: null };
      return { data: { enrolled: false, active: false, workspace_id: 'private-workspace' }, error: null };
    },
  };
  return { db, calls };
}

test('pilot batch normalizes recipients, caps input, and accepts only bounded presets', () => {
  assert.deepEqual(normalizePilotBatch({ emails: [' Builder@Example.com ', 'builder@example.com'], preset: 'sample1' }), { emails: ['builder@example.com'], preset: 'sample1' });
  assert.throws(() => normalizePilotBatch({ emails: Array(26).fill('a@example.com') }), /between 1 and 25/);
  assert.throws(() => normalizePilotBatch({ emails: ['a@example.com'], preset: '__proto__' }), /available access preset/);
  assert.throws(() => normalizePilotBatch({ emails: ['wrong'] }), /email/i);
});

test('pilot signing is stable per normalized email and requires a server secret', () => {
  assert.equal(pilotToken('Builder@Example.com', env.PILOT_INVITE_SIGNING_SECRET), pilotToken('builder@example.com', env.PILOT_INVITE_SIGNING_SECRET));
  assert.notEqual(pilotToken('other@example.com', env.PILOT_INVITE_SIGNING_SECRET), pilotToken('builder@example.com', env.PILOT_INVITE_SIGNING_SECRET));
  assert.throws(() => pilotToken('a@example.com', 'short'), /not configured/);
});

test('signed-out and customer callers cannot list or send pilot invitations', async () => {
  for (const [settings, expected] of [[{ user: null }, 401], [{ owner: false }, 403]] as const) {
    const { db, calls } = fixture(settings);
    const response = await handlePilotRequest(request('/api/pilot/invitations', { emails: ['builder@example.com'] }), db, db, env, async () => { throw new Error('Must never send'); });
    assert.equal(response.status, expected); assert.equal(calls.length, 0);
  }
});

test('owner send derives token hash, persists provider acceptance, and never exposes secrets', async () => {
  const { db, calls } = fixture(); let delivered = 0;
  const response = await handlePilotRequest(request('/api/pilot/invitations', { emails: ['builder@example.com'], preset: 'pilot60' }), db, db, env, async (input) => {
    delivered += 1; assert.match(input.inviteUrl, /pilot_invite=/); assert.equal(input.preset, 'pilot60'); return 'email-confirmed';
  });
  assert.equal(response.status, 200); assert.equal(delivered, 1);
  assert.equal(calls[0]?.args?.p_admin_user_id, 'owner-id');
  assert.equal(calls[0]?.args?.p_token_hash, createHash('sha256').update(pilotToken('builder@example.com', env.PILOT_INVITE_SIGNING_SECRET)).digest('hex'));
  assert.deepEqual(calls[1]?.args, { p_admin_user_id: 'owner-id', p_invitation_id: invitation.id, p_message_id: 'email-confirmed', p_error: null });
  const output = await response.text(); assert.doesNotMatch(output, /never-return-this-hash|re_test|a-secure-test-secret/); assert.match(output, /"email_status":"sent"/);
});

test('already sent, revoked, accepted, or expired invitations do not send or extend on retry', async () => {
  for (const override of [{ email_status: 'sent' }, { revoked_at: '2026-01-01' }, { accepted_at: '2026-01-01' }, { expires_at: '2020-01-01' }]) {
    const { db, calls } = fixture({ issued: { ...invitation, ...override } });
    const response = await handlePilotRequest(request('/api/pilot/invitations', { emails: ['builder@example.com'], preset: 'month1' }), db, db, env, async () => { throw new Error('Must never send'); });
    assert.equal(response.status, 200); assert.match(await response.text(), /"skipped":true/); assert.equal(calls.length, 1);
  }
});

test('cohort exhaustion never dispatches email and returns the concrete rejection', async () => {
  const { db } = fixture({ rpcError: 'Pilot cohort capacity reached' });
  const response = await handlePilotRequest(request('/api/pilot/invitations', { emails: ['builder@example.com'] }), db, db, env, async () => { throw new Error('Must never send'); });
  assert.match(await response.text(), /Pilot cohort capacity reached/);
});

test('provider rejection records failed delivery for retry without pretending email was sent', async () => {
  const { db, calls } = fixture();
  const response = await handlePilotRequest(request('/api/pilot/invitations', { emails: ['builder@example.com'] }), db, db, env, async () => { throw new Error('Provider unavailable'); });
  assert.equal(calls[1]?.args?.p_message_id, null); assert.equal(calls[1]?.args?.p_error, 'Provider unavailable'); assert.match(await response.text(), /"email_status":"failed"/);
});

test('access lookup derives identity from the authenticated session', async () => {
  const { db, calls } = fixture({ user: 'signed-in-user', owner: false });
  const response = await handlePilotRequest(request('/api/pilot/access?userId=owner-id'), db, db, env);
  assert.equal(response.status, 200); assert.deepEqual(calls[0], { name: 'get_pilot_access', args: { p_user_id: 'signed-in-user' } });
});

test('redemption calls the authenticated client with a digest instead of the plaintext token', async () => {
  const { db, calls } = fixture({ owner: false });
  const token = pilotToken('builder@example.com', env.PILOT_INVITE_SIGNING_SECRET);
  const response = await handlePilotRequest(request('/api/pilot/redeem', { token }), db, db, env);
  assert.equal(response.status, 200); assert.equal(calls[0]?.name, 'redeem_pilot_invitation'); assert.equal(calls[0]?.args?.p_token_digest, createHash('sha256').update(token).digest('hex'));
});

test('owner dashboard sanitizes hashes and exposes server-derived budget data', async () => {
  const { db } = fixture(); const response = await handlePilotRequest(request('/api/pilot/invitations'), db, db, env);
  const result = await response.json();
  assert.equal(result.cohortBudgetCents, 10000);
  assert.equal(result.capacity, 25);
  assert.equal(result.invitations[0].reserved_cents, 75);
  assert.equal(result.invitations[0].enrollment_expires_at, '2099-02-01T00:00:00Z');
  assert.equal('token_hash' in result.invitations[0], false);
});

test('pilot email discloses limits and no automatic charge, with stable provider idempotency', async () => {
  const input = { to: 'builder@example.com', inviteUrl: 'https://roughbid.example/app/?pilot_invite=abc', preset: 'sample1' as const, expiresAt: '2099-01-01T00:00:00Z', invitationId: invitation.id };
  const composed = composePilotEmail(input); assert.match(composed.text, /7 days from activation/); assert.match(composed.text, /1 project total/); assert.match(composed.text, /not be charged automatically/); assert.match(composed.text, /10 MiB and 10 pages/);
  await sendPilotEmail(input, 're_test', async (_url, options) => { assert.equal(new Headers(options?.headers).get('Idempotency-Key'), `roughbid-pilot-invite/${invitation.id}`); return Response.json({ id: 'email-id' }); });
});

test('pilot token survives branded account-creation magic-link redirects', async () => {
  const token = pilotToken('builder@example.com', env.PILOT_INVITE_SIGNING_SECRET); let redirect = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: 'sent-test' });
  try {
    await sendBrandedMagicLink({ auth: { admin: { generateLink: async (input) => { redirect = input.options.redirectTo; return { data: { properties: { action_link: 'https://auth.example/verify?token=example' } }, error: null }; } } } }, { email: 'builder@example.com', appUrl: env.APP_URL, pilotInviteToken: token, mode: 'create-account' }, env);
    assert.equal(new URL(redirect).searchParams.get('pilot_invite'), token);
  } finally { globalThis.fetch = originalFetch; }
});
