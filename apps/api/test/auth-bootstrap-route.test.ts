import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAuthBootstrapRequest } from '../src/auth/routes.ts';

const clientFor = (user: { id: string; email?: string } | null, profile?: Record<string, unknown>) => ({
  auth: { getUser: async () => ({ data: { user }, error: null }) },
  from: () => ({
    select() { return this; },
    eq() { return this; },
    single: async () => ({ data: profile ?? null, error: null }),
  }),
});

test('GET /api/auth/bootstrap resolves the signed-in user profile', async () => {
  const client = clientFor({ id: 'user-1', email: 'builder@example.com' }, {
    id: 'user-1', display_name: 'Builder', is_platform_admin: false, created_at: '2026-09-02T00:00:00Z',
  });
  const response = await handleAuthBootstrapRequest(new Request('https://roughbid.test/api/auth/bootstrap'), client as never);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.email, 'builder@example.com');
  assert.equal((body.profile as Record<string, unknown>).displayName, 'Builder');
});

test('GET /api/auth/bootstrap requires authentication', async () => {
  const client = clientFor(null);
  const response = await handleAuthBootstrapRequest(new Request('https://roughbid.test/api/auth/bootstrap'), client as never);
  assert.equal(response.status, 401);
});

test('rejects non-GET methods', async () => {
  const client = clientFor({ id: 'user-1' });
  const response = await handleAuthBootstrapRequest(
    new Request('https://roughbid.test/api/auth/bootstrap', { method: 'POST' }),
    client as never,
  );
  assert.equal(response.status, 405);
});
