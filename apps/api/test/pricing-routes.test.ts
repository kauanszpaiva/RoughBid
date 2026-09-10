import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePricingContextRequest } from '../src/pricing/routes.ts';

const workspaceId = 'workspace-1';
const projectId = 'project-1';

function query(resolve: () => { data: any; error: any }, calls: Array<{ method: string; args: any[] }>) {
  const q: any = {};
  for (const method of ['select', 'eq', 'maybeSingle', 'single']) {
    q[method] = (...args: any[]) => { calls.push({ method, args }); return q; };
  }
  q.then = (ok: any, bad: any) => Promise.resolve(resolve()).then(ok, bad);
  return q;
}

function db(options: {
  user?: { id: string } | null;
  role?: 'admin' | 'estimator' | 'viewer' | null;
  context?: any;
  afterRpcContext?: any;
  rpcError?: { message: string } | null;
} = {}) {
  const user = options.user === undefined ? { id: 'user-1' } : options.user;
  const role = options.role === undefined ? 'estimator' : options.role;
  const context = options.context === undefined ? {
    project_id: projectId,
    workspace_id: workspaceId,
    project_address_text: '52 Main St, Needham, MA 02492',
    plan_address: { street_address: '12 Main St', city: 'Needham', state: 'MA', postal_code: '02492', page_number: 1, source_excerpt: 'PROJECT ADDRESS 12 MAIN ST', confidence: 0.98 },
    pricing_address: null,
    address_source: null,
    address_status: 'needs_resolution',
    plan_file_id: 'file-1',
    plan_job_id: 'job-1',
    resolved_by: null,
    resolved_at: null,
  } : options.context;
  let resolved = false;
  const seen: any[] = [];
  return {
    seen,
    auth: { getUser: async () => ({ data: { user }, error: user ? null : { message: 'no auth' } }) },
    from(table: string) {
      const calls: Array<{ method: string; args: any[] }> = [];
      return query(() => {
        seen.push({ table, calls: [...calls] });
        if (table === 'workspace_members') return { data: role ? { role } : null, error: null };
        if (table === 'project_pricing_contexts') return { data: resolved ? (options.afterRpcContext ?? context) : context, error: null };
        throw new Error(`unexpected table ${table}`);
      }, calls);
    },
    rpc: async (fn: string, args: any) => {
      seen.push({ rpc: fn, args });
      assert.equal(fn, 'resolve_project_pricing_address');
      resolved = true;
      return options.rpcError ? { data: null, error: options.rpcError } : { data: { ignored: true }, error: null };
    },
  };
}

const request = (method: string, body?: unknown, workspace = workspaceId) => new Request(
  `https://roughbid.test/api/projects/${projectId}/pricing-context${method === 'PATCH' ? '/address' : ''}`,
  {
    method,
    headers: { 'x-workspace-id': workspace, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  },
);

test('pricing context routes require authentication', async () => {
  const database = db({ user: null });
  const response = await handlePricingContextRequest(request('GET'), database as never);
  assert.equal(response.status, 401);
});

test('GET is scoped to both workspace and project and does not leak another workspace row', async () => {
  const database = db({ context: null });
  const response = await handlePricingContextRequest(request('GET', undefined, 'other-workspace'), database as never);
  assert.equal(response.status, 404);
  const select = database.seen.find((entry: any) => entry.table === 'project_pricing_contexts');
  assert.ok(select);
  assert.ok(select.calls.some((call: any) => call.method === 'eq' && call.args[0] === 'workspace_id' && call.args[1] === 'other-workspace'));
  assert.ok(select.calls.some((call: any) => call.method === 'eq' && call.args[0] === 'project_id' && call.args[1] === projectId));
});

test('viewer cannot resolve an address', async () => {
  const database = db({ role: 'viewer' });
  const response = await handlePricingContextRequest(request('PATCH', { choice: 'plan' }), database as never);
  assert.equal(response.status, 403);
  assert.equal(database.seen.some((entry: any) => entry.rpc), false);
});

test('admin and estimator resolve through the protected RPC and return a fresh DB read', async () => {
  for (const role of ['admin', 'estimator'] as const) {
    const resolvedRow = {
      project_id: projectId,
      workspace_id: workspaceId,
      project_address_text: '52 Main St, Needham, MA 02492',
      plan_address: { street_address: '12 Main St' },
      pricing_address: { formatted: '12 Main St, Needham, MA 02492' },
      address_source: 'confirmed_override',
      address_status: 'resolved',
      resolved_by: 'user-1',
      resolved_at: '2026-09-09T17:00:00Z',
    };
    const database = db({ role, afterRpcContext: resolvedRow });
    const response = await handlePricingContextRequest(request('PATCH', { choice: 'plan' }), database as never);
    assert.equal(response.status, 200, role);
    assert.deepEqual(await response.json(), resolvedRow, role);
    const rpc = database.seen.find((entry: any) => entry.rpc);
    assert.deepEqual(rpc, { rpc: 'resolve_project_pricing_address', args: { p_project_id: projectId, p_choice: 'plan' } });
    const reads = database.seen.filter((entry: any) => entry.table === 'project_pricing_contexts');
    assert.ok(reads.length >= 2, 'must read context after RPC instead of trusting RPC/client payload');
  }
});

test('PATCH rejects unavailable source choices before RPC', async () => {
  const noPlan = db({ context: {
    project_id: projectId, workspace_id: workspaceId, project_address_text: '52 Main St', plan_address: null,
    pricing_address: { formatted: '52 Main St' }, address_source: 'project', address_status: 'clear',
  } });
  const planResponse = await handlePricingContextRequest(request('PATCH', { choice: 'plan' }), noPlan as never);
  assert.equal(planResponse.status, 409);
  assert.equal(noPlan.seen.some((entry: any) => entry.rpc), false);

  const noProject = db({ context: {
    project_id: projectId, workspace_id: workspaceId, project_address_text: null, plan_address: { street_address: '12 Main St' },
    pricing_address: { formatted: '12 Main St' }, address_source: 'plan', address_status: 'clear',
  } });
  const projectResponse = await handlePricingContextRequest(request('PATCH', { choice: 'project' }), noProject as never);
  assert.equal(projectResponse.status, 409);
  assert.equal(noProject.seen.some((entry: any) => entry.rpc), false);
});

test('PATCH accepts only the choice field and cannot carry arbitrary trust-state mutations', async () => {
  for (const body of [
    { choice: 'plan', pricing_address: { formatted: 'attacker' } },
    { choice: 'project', plan_address: { street_address: 'attacker' } },
    { choice: 'plan', plan_job_id: 'fake-job' },
    { choice: 'plan', plan_file_id: 'fake-file' },
    { choice: 'plan', resolved_by: 'attacker' },
    { choice: 'plan', address_status: 'resolved' },
    { choice: 'other' },
  ]) {
    const database = db();
    const response = await handlePricingContextRequest(request('PATCH', body), database as never);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(database.seen.some((entry: any) => entry.rpc), false, JSON.stringify(body));
  }
});
