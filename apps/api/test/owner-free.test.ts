import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoPaidFallback, isFreeOwnerWorkspace, isUuid } from '../src/ai-plan/owner-free.ts';

const OWNER = '3f1a7c2e-9b44-4d1a-8f2b-6c5d4e3a2b10';
const CUSTOMER = '8c2b5d1f-4e33-4a7c-9d6e-1b2a3c4d5e6f';
const enabled = { FREE_OWNER_READINGS_ENABLED: 'true', FREE_OWNER_WORKSPACE_ID: OWNER };

test('owner workspace is entitled only when flag and exact id are configured', () => {
  assert.equal(isFreeOwnerWorkspace(OWNER, enabled), true);
  assert.equal(isFreeOwnerWorkspace(OWNER.toUpperCase(), enabled), true);
});

test('customer workspaces never receive the free entitlement', () => {
  assert.equal(isFreeOwnerWorkspace(CUSTOMER, enabled), false);
  // A near-miss id must not match.
  assert.equal(isFreeOwnerWorkspace(OWNER.slice(0, -1) + '1', enabled), false);
});

test('entitlement is closed by default and refuses placeholder configuration', () => {
  assert.equal(isFreeOwnerWorkspace(OWNER, {}), false);
  assert.equal(isFreeOwnerWorkspace(OWNER, { FREE_OWNER_WORKSPACE_ID: OWNER }), false);
  assert.equal(isFreeOwnerWorkspace(OWNER, { ...enabled, FREE_OWNER_READINGS_ENABLED: 'false' }), false);
  assert.equal(isFreeOwnerWorkspace(OWNER, { ...enabled, FREE_OWNER_READINGS_ENABLED: 'TRUE' }), false);
  for (const bad of ['', '   ', 'changeme', 'your-workspace-id', '${WORKSPACE}', 'null', 'not-a-uuid']) {
    assert.equal(isFreeOwnerWorkspace(OWNER, { ...enabled, FREE_OWNER_WORKSPACE_ID: bad }), false, bad);
  }
});

test('a malformed caller workspace is never entitled', () => {
  for (const bad of ['', '   ', 'not-a-uuid', OWNER.replace(/-/g, '')]) {
    assert.equal(isFreeOwnerWorkspace(bad, enabled), false, bad);
  }
});

test('isUuid accepts canonical v4 ids and rejects malformed ones', () => {
  assert.equal(isUuid(OWNER), true);
  assert.equal(isUuid('3f1a7c2e9b444d1a8f2b6c5d4e3a2b10'), false);
});

test('free readings refuse a paid provider fallback', () => {
  assert.doesNotThrow(() => assertNoPaidFallback('openrouter/free'));
  assert.doesNotThrow(() => assertNoPaidFallback('gemini-free-tier'));
  assert.throws(() => assertNoPaidFallback('gemini'), /not a verified free-tier route/);
});
