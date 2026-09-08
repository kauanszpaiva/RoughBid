import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapAuth } from '../src/auth/bootstrap.ts';
import { sendBrandedMagicLink } from '../src/auth/sign-in.ts';
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
    insert(value: Record<string, unknown>) { inserted = value; return this; },
    select() { return this; },
    single: async () => ({ data: {
      id: 'workspace-1', ...inserted, created_at: '2026-09-02T00:00:00Z',
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
  assert.deepEqual(inserted, { name: 'Main Shop', created_by: 'user-1' });
  assert.equal(result.createdBy, 'user-1');
  assert.equal(result.role, 'admin');
});

