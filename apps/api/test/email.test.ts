import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createClassPassWelcomeEmail,
  loadResendServerConfig,
  sendClassPassWelcomeEmail,
} from '../src/email/resend.ts';

test('Class Pass email references the staged Resend template and never requires payment', () => {
  const email = createClassPassWelcomeEmail({
    to: 'student@example.com',
    appUrl: 'https://app.example.com',
  });
  assert.equal(email.templateAlias, 'roughbid-class-pass-welcome');
  assert.equal(email.from, 'RoughBid <hello@mail.kspdominion.group>');
  assert.equal(email.to, 'student@example.com');
  assert.equal(email.variables.CLASS_PASS_DAYS, 60);
  assert.equal(email.variables.APP_URL, 'https://app.example.com');
  assert.equal('priceId' in email.variables, false);
});

test('Resend client sends the fixed template and sender with a server credential', async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: url.toString(), init };
    return new Response(JSON.stringify({ id: 'email_123' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const result = await sendClassPassWelcomeEmail(
    loadResendServerConfig({ RESEND_API_KEY: 're_secret' }),
    { to: 'student@example.com', appUrl: 'https://app.example.com/' },
    fetchMock,
  );
  assert.deepEqual(result, { id: 'email_123' });
  assert.equal(request?.url, 'https://api.resend.com/emails');
  assert.equal(new Headers(request?.init?.headers).get('Authorization'), 'Bearer re_secret');
  const body = JSON.parse(String(request?.init?.body));
  assert.deepEqual(body, {
    from: 'RoughBid <hello@mail.kspdominion.group>',
    to: ['student@example.com'],
    template: {
      id: 'roughbid-class-pass-welcome',
      variables: { APP_URL: 'https://app.example.com', CLASS_PASS_DAYS: 60 },
    },
  });
  assert.equal(JSON.stringify(body).includes('re_secret'), false);
});

test('Resend config rejects missing server-only API key', () => {
  assert.throws(() => loadResendServerConfig({}), /RESEND_API_KEY/);
});
