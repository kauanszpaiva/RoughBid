import test from 'node:test';
import assert from 'node:assert/strict';
import { createClassPassWelcomeEmail } from '../src/email/resend.ts';

test('Class Pass email references the staged Resend template and never requires payment', () => {
  const email = createClassPassWelcomeEmail({
    to: 'student@example.com',
    appUrl: 'https://app.example.com',
  });
  assert.equal(email.templateAlias, 'roughbid-class-pass-welcome');
  assert.equal(email.to, 'student@example.com');
  assert.equal(email.variables.CLASS_PASS_DAYS, 60);
  assert.equal(email.variables.APP_URL, 'https://app.example.com');
  assert.equal('priceId' in email.variables, false);
});
