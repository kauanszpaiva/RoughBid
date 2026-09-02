import test from 'node:test';
import assert from 'node:assert/strict';
import { beginEnterpriseSso, beginSso, sendMagicLink } from '../src/auth/sign-in.ts';
import { hashClassPassToken, issueClassPass, redeemClassPass } from '../src/class-pass/tokens.ts';
import { hasWorkspacePermission } from '../../../packages/domain/src/index.ts';

test('RBAC grants write access to estimators while keeping viewers read-only', () => {
  assert.equal(hasWorkspacePermission('estimator', 'estimate:write'), true);
  assert.equal(hasWorkspacePermission('viewer', 'estimate:write'), false);
  assert.equal(hasWorkspacePermission('viewer', 'estimate:read'), true);
  assert.equal(hasWorkspacePermission('admin', 'member:manage'), true);
});

test('magic links normalize email and use only the configured app callback', async () => {
  let request: unknown;
  const auth = {
    async signInWithOtp(input: unknown) { request = input; return { error: null }; },
    async signInWithOAuth() { return { data: {}, error: null }; },
  };
  await sendMagicLink(auth as never, { email: ' Student@Example.COM ', appUrl: 'https://app.roughbid.com' });
  assert.deepEqual(request, { email: 'student@example.com', options: {
    emailRedirectTo: 'https://app.roughbid.com/auth/callback', shouldCreateUser: true,
  } });
});

test('SSO supports configured enterprise providers', async () => {
  const auth = {
    async signInWithOtp() { return { error: null }; },
    async signInWithOAuth(input: unknown) {
      assert.deepEqual(input, { provider: 'azure', options: { redirectTo: 'https://app.roughbid.com/auth/callback' } });
      return { data: { url: 'https://identity.example/login' }, error: null };
    },
  };
  assert.equal(await beginSso(auth as never, { provider: 'azure', appUrl: 'https://app.roughbid.com' }), 'https://identity.example/login');
});

test('SAML SSO uses verified organization-domain discovery', async () => {
  const auth = {
    async signInWithOtp() { return { error: null }; },
    async signInWithOAuth() { return { data: {}, error: null }; },
    async signInWithSSO(input: unknown) {
      assert.deepEqual(input, { domain: 'school.edu', options: { redirectTo: 'https://app.roughbid.com/auth/callback' } });
      return { data: { url: 'https://school.example/saml' }, error: null };
    },
  };
  assert.equal(await beginEnterpriseSso(auth, { domain: ' School.EDU ', appUrl: 'https://app.roughbid.com' }), 'https://school.example/saml');
});

test('Class Pass plaintext is returned once and only its digest is persisted', async () => {
  let stored: Record<string, unknown> | undefined;
  const store = {
    async create(input: Record<string, unknown>) { stored = input; },
    async redeem() { return { workspaceId: 'workspace-1', expiresAt: '2026-11-01T00:00:00.000Z' }; },
  };
  const pass = await issueClassPass({ label: 'Fall cohort', startsAt: new Date('2026-09-02T00:00:00Z') }, store as never);
  assert.match(pass.token, /^rbcp_[A-Za-z0-9_-]{43}$/);
  assert.equal(stored?.tokenHash, hashClassPassToken(pass.token));
  assert.equal(JSON.stringify(stored).includes(pass.token), false);
  const redeemed = await redeemClassPass({ token: pass.token }, store as never);
  assert.equal(redeemed.workspaceId, 'workspace-1');
});
