import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWorkspacesRequest } from '../src/workspaces/routes.ts';

test('GET /api/workspaces lists the signed-in user workspaces', async () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: () => ({
      select() { return this; },
      order: async () => ({
        data: [{ id: 'ws-1', name: 'Main Shop', created_by: 'user-1', created_at: '2026-09-02T00:00:00Z' }],
        error: null,
      }),
    }),
  };
  const response = await handleWorkspacesRequest(new Request('https://roughbid.test/api/workspaces'), client as never);
  assert.equal(response.status, 200);
  const body = await response.json() as Array<Record<string, unknown>>;
  assert.equal(body.length, 1);
  assert.equal(body[0]?.name, 'Main Shop');
});

test('POST /api/workspaces creates a workspace derived from the authenticated user', async () => {
  let inserted: Record<string, unknown> | undefined;
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: () => ({
      insert(value: Record<string, unknown>) { inserted = value; return this; },
      select() { return this; },
      single: async () => ({ data: { id: 'ws-1', ...inserted, created_at: '2026-09-02T00:00:00Z' }, error: null }),
    }),
  };
  const response = await handleWorkspacesRequest(
    new Request('https://roughbid.test/api/workspaces', {
      method: 'POST', body: JSON.stringify({ name: 'My Class Workspace' }), headers: { 'content-type': 'application/json' },
    }),
    client as never,
  );
  assert.equal(response.status, 201);
  assert.deepEqual(inserted, { name: 'My Class Workspace', created_by: 'user-1' });
});

test('rejects an unauthenticated request', async () => {
  const client = { auth: { getUser: async () => ({ data: { user: null }, error: null }) }, from: () => ({}) };
  const response = await handleWorkspacesRequest(new Request('https://roughbid.test/api/workspaces'), client as never);
  assert.equal(response.status, 401);
});

test('rejects unsupported methods', async () => {
  const client = { auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) }, from: () => ({}) };
  const response = await handleWorkspacesRequest(
    new Request('https://roughbid.test/api/workspaces', { method: 'DELETE' }),
    client as never,
  );
  assert.equal(response.status, 405);
});
