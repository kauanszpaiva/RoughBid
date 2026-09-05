import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProposalOpenedEmail,
  createProposalSignedEmail,
  createWorkspaceInviteEmail,
  createWorkspaceWelcomeEmail,
  loadResendServerConfig,
  sendProposalOpenedEmail,
  sendProposalSignedEmail,
  sendWorkspaceInviteEmail,
  sendWorkspaceWelcomeEmail,
} from '../src/email/resend.ts';

test('workspace welcome email references the staged Resend template and never requires payment', () => {
  const email = createWorkspaceWelcomeEmail({
    to: 'estimator@example.com',
    appUrl: 'https://app.example.com',
  });
  assert.equal(email.templateAlias, 'roughbid-workspace-welcome');
  assert.equal(email.from, 'RoughBid <hello@mail.kspdominion.group>');
  assert.equal(email.to, 'estimator@example.com');
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
  const result = await sendWorkspaceWelcomeEmail(
    loadResendServerConfig({ RESEND_API_KEY: 're_secret' }),
    { to: 'estimator@example.com', appUrl: 'https://app.example.com/' },
    fetchMock,
  );
  assert.deepEqual(result, { id: 'email_123' });
  assert.equal(request?.url, 'https://api.resend.com/emails');
  assert.equal(new Headers(request?.init?.headers).get('Authorization'), 'Bearer re_secret');
  const body = JSON.parse(String(request?.init?.body));
  assert.deepEqual(body, {
    from: 'RoughBid <hello@mail.kspdominion.group>',
    to: ['estimator@example.com'],
    template: {
      id: 'roughbid-workspace-welcome',
      variables: { APP_URL: 'https://app.example.com' },
    },
  });
  assert.equal(JSON.stringify(body).includes('re_secret'), false);
});

test('workspace invite email uses the RoughBid organization invite template', async () => {
  const email = createWorkspaceInviteEmail({
    to: 'builder@example.com',
    workspaceName: 'Main Shop',
    inviteUrl: 'https://roughbid.vercel.app/?invite=token_123',
    role: 'estimator',
  });
  assert.equal(email.templateAlias, 'roughbid-organization-invite');
  assert.equal(email.from, 'RoughBid <hello@mail.kspdominion.group>');
  assert.equal(email.to, 'builder@example.com');
  assert.deepEqual(email.variables, {
    WORKSPACE_NAME: 'Main Shop',
    INVITE_URL: 'https://roughbid.vercel.app/?invite=token_123',
    ROLE: 'estimator',
  });
});

test('Resend client sends organization invites without exposing the API key', async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: url.toString(), init };
    return new Response(JSON.stringify({ id: 'email_invite_123' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const result = await sendWorkspaceInviteEmail(
    loadResendServerConfig({ RESEND_API_KEY: 're_secret' }),
    { to: 'builder@example.com', workspaceName: 'Main Shop', inviteUrl: 'https://roughbid.vercel.app/?invite=token_123', role: 'viewer', idempotencyKey: 'workspace-invite/invite-1' },
    fetchMock,
  );
  assert.deepEqual(result, { id: 'email_invite_123' });
  assert.equal(new Headers(request?.init?.headers).get('Idempotency-Key'), 'workspace-invite/invite-1');
  const body = JSON.parse(String(request?.init?.body));
  assert.deepEqual(body, {
    from: 'RoughBid <hello@mail.kspdominion.group>',
    to: ['builder@example.com'],
    template: {
      id: 'roughbid-organization-invite',
      variables: {
        WORKSPACE_NAME: 'Main Shop',
        INVITE_URL: 'https://roughbid.vercel.app/?invite=token_123',
        ROLE: 'viewer',
      },
    },
  });
  assert.equal(JSON.stringify(body).includes('re_secret'), false);
});

test('proposal notification emails use published Resend templates', () => {
  const input = {
    to: 'estimator@example.com',
    proposalTitle: 'Kitchen Remodel Proposal',
    clientName: 'Jane Client',
    projectName: 'Newton Kitchen',
    proposalUrl: 'https://roughbid.vercel.app/client-proposals/token_123',
  };
  assert.deepEqual(createProposalOpenedEmail(input), {
    from: 'RoughBid <hello@mail.kspdominion.group>',
    to: 'estimator@example.com',
    templateAlias: 'roughbid-proposal-opened',
    variables: {
      PROPOSAL_TITLE: 'Kitchen Remodel Proposal',
      CLIENT_NAME: 'Jane Client',
      PROJECT_NAME: 'Newton Kitchen',
      PROPOSAL_URL: 'https://roughbid.vercel.app/client-proposals/token_123',
    },
  });
  assert.equal(createProposalSignedEmail(input).templateAlias, 'roughbid-proposal-signed');
});

test('Resend client sends proposal open and signature notifications without exposing the API key', async () => {
  const bodies: unknown[] = [];
  const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: `email_${bodies.length}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const config = loadResendServerConfig({ RESEND_API_KEY: 're_secret' });
  const input = {
    to: 'estimator@example.com',
    proposalTitle: 'Kitchen Remodel Proposal',
    clientName: 'Jane Client',
    projectName: 'Newton Kitchen',
    proposalUrl: 'https://roughbid.vercel.app/client-proposals/token_123',
  };
  assert.deepEqual(await sendProposalOpenedEmail(config, input, fetchMock), { id: 'email_1' });
  assert.deepEqual(await sendProposalSignedEmail(config, input, fetchMock), { id: 'email_2' });
  assert.deepEqual(bodies.map((body) => (body as { template: { id: string } }).template.id), [
    'roughbid-proposal-opened',
    'roughbid-proposal-signed',
  ]);
  assert.equal(JSON.stringify(bodies).includes('re_secret'), false);
});

test('Resend config rejects missing server-only API key', () => {
  assert.throws(() => loadResendServerConfig({}), /RESEND_API_KEY/);
});
