import test from 'node:test';
import assert from 'node:assert/strict';
import { listWorkspaces, createWorkspace } from '../src/workspaces/actions.ts';

function roleClient(role: unknown, membershipError: { message: string } | null = null) {
  const filters: Array<[string, string]> = [];
  const row = { id: 'workspace-one', name: 'Workspace', created_by: 'user-one', created_at: '2026-09-05T00:00:00Z' };
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-one' } }, error: null }) },
    from: (table: string) => ({
      select() { return this; }, insert() { return this; }, order() { return this; },
      eq(key: string, value: string) { filters.push([key, value]); return this; },
      single: async () => ({ data: row, error: null }),
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve(resolve(table === 'workspace_members'
          ? { data: role === undefined ? [] : [{ workspace_id: row.id, role }], error: membershipError }
          : { data: [row], error: null }));
      },
    }),
  };
  return { client, filters };
}

test('workspace API returns the authenticated membership role without promoting the creator', async () => {
  for (const role of ['admin', 'estimator', 'viewer']) {
    const { client, filters } = roleClient(role);
    const result = await listWorkspaces(client as never);
    assert.equal(result[0]?.role, role);
    assert.deepEqual(filters, [['user_id', 'user-one']]);
  }
});

test('missing or unrecognized membership stays read-only, even when created_by matches', async () => {
  for (const role of [undefined, 'owner', 'super-admin', null]) {
    const { client } = roleClient(role);
    assert.equal((await listWorkspaces(client as never))[0]?.role, null);
    assert.equal((await createWorkspace(client as never, { name: 'Workspace' })).role, null);
  }
});

test('membership access errors fail instead of returning a guessed permission', async () => {
  const { client } = roleClient('admin', { message: 'Permission denied' });
  await assert.rejects(listWorkspaces(client as never), /Permission denied/);
});
