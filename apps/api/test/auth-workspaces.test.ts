import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapAuth } from '../src/auth/bootstrap.ts';
import { sendBrandedMagicLink } from '../src/auth/sign-in.ts';
import { handleMagicLinkRequest } from '../src/auth/routes.ts';
import { createWorkspace } from '../src/workspaces/actions.ts';

test('auth bootstrap maps the trigger-created profile', async () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'builder@example.com' } }, error: null }) },
    from: () => ({
      select() { return this; }, eq() { return this; },
      single: async () => ({ data: {
        id: 'user-1', display_name: 'Builder', is_platform_admin: false,
        created_at: '2026-09-02T00:00:00Z',
      }, error: null }),
    }),
  };

  const result = await bootstrapAuth(client as never);
  assert.equal(result.profile.displayName, 'Builder');
  assert.equal(result.email, 'builder@example.com');
});

test('branded magic link creation preserves invite redirects and never exposes the service credential', async () => {
  let generated: unknown;
  const admin = {
    auth: {
      admin: {
        generateLink: async (input: unknown) => {
          generated = input;
          return { data: { properties: { action_link: 'https://auth.example.com/verify?token=abc' } }, error: null };
        },
      },
    },
  };
  const originalFetch = globalThis.fetch;
  let body: unknown;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: 'email_auth_123' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    assert.deepEqual(await sendBrandedMagicLink(
      admin,
      { email: 'builder@example.com', appUrl: 'https://roughbid.vercel.app', inviteToken: 'invite_123', mode: 'create-account' },
      { RESEND_API_KEY: 're_secret' },
    ), { sent: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal((generated as { type: string }).type, 'signup');
  assert.equal((generated as { email: string }).email, 'builder@example.com');
  assert.match((generated as { password: string }).password, /^[A-Za-z0-9_-]{32,}$/);
  assert.deepEqual((generated as { options: unknown }).options, { redirectTo: 'https://roughbid.vercel.app/app/?invite=invite_123' });
  assert.equal(JSON.stringify(body).includes('re_secret'), false);
});

test('workspace creation derives created_by from the authenticated user', async () => {
  let inserted: Record<string, unknown> | undefined;
  const query = {
    insert(value: Record<string, unknown>) { inserted = value; return { error: null }; },
    select() { return this; },
    eq() { return this; },
    single: async () => ({ data: {
      id: inserted?.id ?? 'workspace-1', ...inserted, created_at: '2026-09-02T00:00:00Z',
    }, error: null }),
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => table === 'workspace_members' ? {
      select() { return this; }, eq() { return this; },
      then(resolve: (result: unknown) => unknown) { return Promise.resolve(resolve({ data: [{ role: 'admin' }], error: null })); },
    } : query,
  };

  const result = await createWorkspace(client as never, { name: '  Main Shop  ' });
  assert.equal(inserted?.name, 'Main Shop');
  assert.equal(inserted?.created_by, 'user-1');
  assert.equal(result.createdBy, 'user-1');
  assert.equal(result.role, 'admin');
});



test('invite-only magic link keeps unknown addresses private and sends no account link', async () => {
  let generated = 0;
  const admin = {
    auth: { admin: { generateLink: async () => {
      generated += 1;
      return { data: { properties: { action_link: 'https://auth.example/verify?token=unexpected' } }, error: null };
    } } },
    rpc: async (name: string) => {
      if (name === 'reserve_magic_link_attempt') return { data: { allowed: true, retry_after_seconds: 0 }, error: null };
      if (name === 'authorize_roughbid_magic_link') return { data: false, error: null };
      throw new Error(name);
    },
  };
  const response = await handleMagicLinkRequest(
    new Request('https://roughbid.example/api/auth/magic-link', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'unknown@example.com', mode: 'create-account' }),
    }),
    admin as never,
    { appUrl: 'https://roughbid.example', env: { AUTH_RATE_LIMIT_SECRET: 'x'.repeat(32), RESEND_API_KEY: 're_test' } as NodeJS.ProcessEnv },
  );
  assert.equal(response.status, 202);
  assert.equal(generated, 0);
  assert.match(await response.text(), /If this address can receive a sign-in link/);
});

test('valid pilot invitation authorizes account creation without exposing the plaintext token to the database', async () => {
  const pilotToken = 'A'.repeat(43);
  let authorizationArgs: Record<string, unknown> | undefined;
  let generated = 0;
  const admin = {
    auth: { admin: { generateLink: async () => {
      generated += 1;
      return { data: { properties: { action_link: 'https://auth.example/verify?token=ok' } }, error: null };
    } } },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'reserve_magic_link_attempt') return { data: { allowed: true, retry_after_seconds: 0 }, error: null };
      if (name === 'authorize_roughbid_magic_link') { authorizationArgs = args; return { data: true, error: null }; }
      throw new Error(name);
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: 'email-ok' });
  try {
    const response = await handleMagicLinkRequest(
      new Request('https://roughbid.example/api/auth/magic-link', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'builder@example.com', pilotInviteToken: pilotToken, mode: 'create-account' }),
      }),
      admin as never,
      { appUrl: 'https://roughbid.example', env: { AUTH_RATE_LIMIT_SECRET: 'x'.repeat(32), RESEND_API_KEY: 're_test' } as NodeJS.ProcessEnv },
    );
    assert.equal(response.status, 202);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(generated, 1);
  assert.equal(authorizationArgs?.p_email, 'builder@example.com');
  assert.notEqual(authorizationArgs?.p_pilot_token_digest, pilotToken);
  assert.match(String(authorizationArgs?.p_pilot_token_digest), /^[a-f0-9]{64}$/);
});
