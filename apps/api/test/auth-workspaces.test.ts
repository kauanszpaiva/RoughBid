import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapAuth } from '../src/auth/bootstrap.ts';
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

