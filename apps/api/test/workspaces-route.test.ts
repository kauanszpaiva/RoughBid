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
      method: 'POST', body: JSON.stringify({ name: 'Main Shop' }), headers: { 'content-type': 'application/json' },
    }),
    client as never,
  );
  assert.equal(response.status, 201);
  assert.deepEqual(inserted, { name: 'Main Shop', created_by: 'user-1' });
});

test('POST /api/workspaces/:id/invites returns a one-time organization invite token', async () => {
  let inserted: Record<string, unknown> | undefined;
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }) },
    from: (table: string) => {
      assert.equal(table, 'workspace_invites');
      return {
        insert(value: Record<string, unknown>) { inserted = value; return this; },
        select() { return this; },
        single: async () => ({ data: {
          id: 'invite-1',
          workspace_id: inserted?.workspace_id,
          email: inserted?.email,
          role: inserted?.role,
          expires_at: inserted?.expires_at,
          accepted_at: null,
          created_at: '2026-09-04T00:00:00Z',
        }, error: null }),
      };
    },
  };

  const response = await handleWorkspacesRequest(
    new Request('https://roughbid.test/api/workspaces/ws-1/invites', {
      method: 'POST',
      body: JSON.stringify({ email: ' Builder@Example.COM ', role: 'viewer' }),
      headers: { 'content-type': 'application/json' },
    }),
    client as never,
  );

  assert.equal(response.status, 201);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.email, 'builder@example.com');
  assert.equal(body.role, 'viewer');
  assert.match(String(body.token), /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(typeof inserted?.token_hash, 'string');
  assert.notEqual(inserted?.token_hash, body.token);
});

test('POST /api/workspace-invites/accept hashes the token before RPC', async () => {
  let rpcArgs: Record<string, unknown> | undefined;
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-2' } }, error: null }) },
    from: () => ({}),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      assert.equal(fn, 'accept_workspace_invite');
      rpcArgs = args;
      return { data: [{ workspace_id: 'ws-1', role: 'estimator' }], error: null };
    },
  };

  const token = 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456';
  const response = await handleWorkspacesRequest(
    new Request('https://roughbid.test/api/workspace-invites/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
      headers: { 'content-type': 'application/json' },
    }),
    client as never,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { workspaceId: 'ws-1', role: 'estimator' });
  assert.match(String(rpcArgs?.invite_token_digest), /^[0-9a-f]{64}$/);
  assert.notEqual(rpcArgs?.invite_token_digest, token);
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
