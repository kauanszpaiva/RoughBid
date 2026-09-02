import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkspaceName, WORKSPACE_ROLES } from '../src/index.ts';

test('normalizeWorkspaceName trims a valid name', () => {
  assert.equal(normalizeWorkspaceName('  Acme Estimating  '), 'Acme Estimating');
  assert.deepEqual(WORKSPACE_ROLES, ['admin', 'estimator', 'viewer']);
});

test('normalizeWorkspaceName enforces the database length limits', () => {
  assert.throws(() => normalizeWorkspaceName('   '), /between 1 and 120/);
  assert.throws(() => normalizeWorkspaceName('x'.repeat(121)), /between 1 and 120/);
});
