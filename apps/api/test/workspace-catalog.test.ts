import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWorkspaceCatalogRequest } from '../src/catalogs/routes.ts';

const material = { id: 'mat-1', name: 'Concrete', category: 'Concrete', unit: 'CY', unitCost: 150, lastUpdated: '2026-09-11' };
const assembly = { id: 'asm-1', name: 'Slab', category: 'Concrete', description: 'Four inch slab', unit: 'SF', materialCostPerUnit: 4, laborCostPerUnit: 3, equipmentCostPerUnit: 1 };
const row = { id: 'version-1', workspace_id: 'ws-1', revision: 1, materials: [material], assemblies: [assembly], content_sha256: 'a'.repeat(64), created_by: 'user-1', created_at: '2026-09-11T17:00:00Z' };

test('GET returns the identical latest workspace catalog to distinct authorized users', async () => {
  const makeClient = (userId: string) => ({
    auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
    from: () => ({ select() { return this; }, eq() { return this; }, order() { return this; }, limit: async () => ({ data: [row], error: null }) }),
  });
  const responses = await Promise.all(['user-1', 'user-2'].map(userId => handleWorkspaceCatalogRequest(
    new Request('https://roughbid.test/api/workspaces/ws-1/estimating-catalog'), makeClient(userId) as never,
  )));
  assert.deepEqual(await responses[0]!.json(), await responses[1]!.json());
  assert.equal(responses[0]!.status, 200);
});

test('POST validates and passes optimistic revision to the atomic save RPC', async () => {
  let called: Record<string, unknown> | undefined;
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, 'save_workspace_catalog_version'); called = args;
      return { data: [row], error: null };
    },
  };
  const response = await handleWorkspaceCatalogRequest(new Request(
    'https://roughbid.test/api/workspaces/ws-1/estimating-catalog',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ materials: [material], assemblies: [assembly], expectedRevision: 0 }) },
  ), client as never);
  assert.equal(response.status, 201);
  assert.equal(called?.p_workspace_id, 'ws-1');
  assert.equal(called?.p_expected_revision, 0);
});

test('POST rejects duplicate IDs before calling the database', async () => {
  let called = false;
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    rpc: async () => { called = true; return { data: [], error: null }; },
  };
  const response = await handleWorkspaceCatalogRequest(new Request(
    'https://roughbid.test/api/workspaces/ws-1/estimating-catalog',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ materials: [material, material], assemblies: [], expectedRevision: 0 }) },
  ), client as never);
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test('POST exposes a stale expected revision as a conflict', async () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    rpc: async () => ({ data: null, error: { code: '40001', message: 'catalog revision conflict: expected 1, current 2' } }),
  };
  const response = await handleWorkspaceCatalogRequest(new Request(
    'https://roughbid.test/api/workspaces/ws-1/estimating-catalog',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ materials: [material], assemblies: [], expectedRevision: 1 }) },
  ), client as never);
  assert.equal(response.status, 409);
});
