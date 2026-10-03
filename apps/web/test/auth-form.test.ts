import test from 'node:test';
import assert from 'node:assert/strict';
import { authCallbackNotice, clearAuthCallbackError, normalizeAuthEmail, signOutLocally } from '../app/src/services/authForm.ts';

test('email input is normalized and malformed requests do not leave the browser', () => {
  assert.equal(normalizeAuthEmail('  Estimator@Example.com '), 'estimator@example.com');
  for (const invalid of ['', 'user', 'a @example.com', 'a@example', `a${'x'.repeat(255)}@example.com`]) {
    assert.throws(() => normalizeAuthEmail(invalid), /valid email/);
  }
});

test('expired and rejected sign-in links have actionable copy without echoing callback values', () => {
  assert.match(authCallbackNotice('https://app.example/app/#error=access_denied&error_code=otp_expired&error_description=secret')!, /expired.*newest email/);
  assert.match(authCallbackNotice('https://app.example/app/?error=private-token')!, /Request a new link/);
  assert.doesNotMatch(authCallbackNotice('https://app.example/app/?error_description=secret&error=bad')!, /secret|bad/);
  assert.equal(authCallbackNotice('https://app.example/app/?invite=private-invite#access_token=private-token'), null);
});

test('dismissing a callback failure preserves invitation and successful callback parameters', () => {
  assert.equal(clearAuthCallbackError('https://app.example/app/?invite=invite-code&pilot_invite=pilot-code&error=denied#code=success'), '/app/?invite=invite-code&pilot_invite=pilot-code#code=success');
  assert.equal(clearAuthCallbackError('https://app.example/app/?invite=invite-code#error=denied&error_code=otp_expired&error_description=secret'), '/app/?invite=invite-code');
  assert.equal(clearAuthCallbackError('https://app.example/app/#access_token=token&refresh_token=refresh'), '/app/#access_token=token&refresh_token=refresh');
});

test('logout is local to this device and only succeeds after the SDK confirms it', async () => {
  const scopes: string[] = [];
  await signOutLocally({ signOut: async ({ scope }) => { scopes.push(scope); return { error: null }; } });
  assert.deepEqual(scopes, ['local']);
});

test('logout failures remain visible instead of claiming the session closed', async () => {
  for (const auth of [null, { signOut: async () => ({ error: { message: 'private-value' } }) }, { signOut: async () => { throw new Error('private-value'); } }]) {
    await assert.rejects(signOutLocally(auth), (error: unknown) => error instanceof Error && /configured|still open/.test(error.message) && !/private-value/.test(error.message));
  }
});
