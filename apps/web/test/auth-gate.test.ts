import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const authGate = readFileSync(new URL('../app/src/components/AuthGate.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');

test('signed-out RoughBid users must pass the login gate before the app loads', () => {
  assert.match(app, /if \(!session\)/);
  assert.match(app, /<AuthGate \/>/);
});

test('auth gate offers sign-in and account creation without password storage', () => {
  assert.match(authGate, /Sign In/);
  assert.match(authGate, /Create Account/);
  assert.match(authGate, /requestMagicLink/);
  assert.match(authGate, /No password to remember/);
  assert.match(authGate, /Supabase Auth is configured/);
  assert.match(authGate, /\/brand\/roughbid-icon\.png/);
  assert.doesNotMatch(authGate, /signInWithOtp|PrimeBid|Class Pass|60\s+days/i);
});

test('account modal sends auth and organization invite links back to the protected app path', () => {
  const authModal = readFileSync(new URL('../app/src/components/AuthModal.tsx', import.meta.url), 'utf8');
  assert.match(authModal, /\/app\/\?invite=/);
  assert.match(authModal, /requestMagicLink/);
  assert.doesNotMatch(authModal, /Supabase sends|Demo mode|local demo data/);
});
