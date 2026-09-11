import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAiPlanRequest } from '../src/ai-plan/routes.ts';

const storage = { presign: async () => ({ url: 'https://signed.example/source.pdf' }) };
const reader = { read: async () => ({ summary: {}, findings: [] }) };

function request(body: Record<string, unknown>) {
  return new Request('https://roughbid.test/api/ai-plan-readings/findings/finding-1', {
    method: 'PATCH',
    headers: { 'x-workspace-id': 'workspace-1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deps() {
  return {
    storage,
    reader,
    findingsWriter: {
      from() { throw new Error('service-role writer must not be used for corrected review'); },
      async rpc() { throw new Error('service-role RPC must not be used for corrected review'); },
    },
  };
}

test('corrected finding review uses the request-scoped authenticated RPC and returns the review event', async () => {
  let calls = 0;
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from() { throw new Error('table access is not expected'); },
    storage: { from() { throw new Error('storage access is not expected'); } },
    async rpc(fn: string, args: Record<string, unknown>) {
      calls += 1;
      assert.equal(fn, 'review_plan_reading_finding');
      assert.deepEqual(args, {
        p_finding_id: 'finding-1',
        p_action: 'corrected',
        p_correction: { quantity: 12, unit: 'LF' },
      });
      return {
        data: [{ id: 'review-1', workspace_id: 'workspace-1', finding_id: 'finding-1', action: 'corrected' }],
        error: null,
      };
    },
  };

  const response = await handleAiPlanRequest(request({
    status: 'corrected',
    correction: { quantity: 12, unit: 'LF' },
  }), db as never, deps() as never);

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  const body = await response.json() as any;
  assert.equal(body.review.id, 'review-1');
  assert.equal(body.review.action, 'corrected');
});

test('corrected review rejects unsupported or malformed correction fields before any RPC', async () => {
  let calls = 0;
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from() { return {}; },
    storage: { from() { return {}; } },
    async rpc() { calls += 1; return { data: null, error: null }; },
  };

  for (const correction of [
    {},
    { confidence: 1 },
    { quantity: -1 },
    { label: '   ' },
    { geometry: [] },
  ]) {
    const response = await handleAiPlanRequest(request({ status: 'corrected', correction }), db as never, deps() as never);
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test('corrected review fails closed if an RPC result is outside the requested workspace', async () => {
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from() { return {}; },
    storage: { from() { return {}; } },
    async rpc() {
      return { data: [{ id: 'review-foreign', workspace_id: 'other-workspace', action: 'corrected' }], error: null };
    },
  };

  const response = await handleAiPlanRequest(request({
    status: 'corrected', correction: { quantity: 12 },
  }), db as never, deps() as never);
  assert.equal(response.status, 404);
});

test('legacy statuses reject a correction payload instead of silently dropping it', async () => {
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from() { return {}; },
    storage: { from() { return {}; } },
    async rpc() { throw new Error('RPC must not be called'); },
  };

  const response = await handleAiPlanRequest(request({
    status: 'accepted', correction: { quantity: 12 },
  }), db as never, deps() as never);
  assert.equal(response.status, 400);
  assert.match((await response.json() as any).error, /only when status is corrected/i);
});
