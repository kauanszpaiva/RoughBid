import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const authGate = readFileSync(new URL('../app/src/components/AuthGate.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');

test('signed-out RoughBid users see a real login gate when Supabase Auth is configured', () => {
  assert.match(app, /isAuthConfigured && !session/);
  assert.match(app, /<AuthGate \/>/);
});

test('auth gate offers sign-in and account creation without password storage', () => {
  assert.match(authGate, /Sign In/);
  assert.match(authGate, /Create Account/);
  assert.match(authGate, /signInWithOtp/);
  assert.match(authGate, /No password needed/);
  assert.doesNotMatch(authGate, /PrimeBid|Class Pass|60\s+days/i);
});
