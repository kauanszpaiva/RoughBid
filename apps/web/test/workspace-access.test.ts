import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canWriteWorkspace } from '../app/src/utils/workspaceAccess.ts';

test('only admin and estimator roles can change workspace data', () => {
  assert.equal(canWriteWorkspace('admin'), true);
  assert.equal(canWriteWorkspace('estimator'), true);
  for (const role of ['viewer', 'owner', 'ADMIN', null, undefined, '', true, {}]) assert.equal(canWriteWorkspace(role), false);
});

test('application mutation guards run before project state or API changes', () => {
  const app = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
  for (const name of ['handleUpdateProject', 'handleAppendRevision', 'handleDuplicateProject', 'handleUpdateUser', 'handleUseTemplate']) {
    const body = app.slice(app.indexOf(`const ${name} =`));
    assert.match(body, new RegExp(`const ${name} = [^]*?=> \\{\\s+if \\(!canWriteRef\\.current`));
  }
  assert.match(app, /const recovered = writable \?/);
  assert.match(app, /canPublish=\{canWrite\}/);
});

test('a completed upload appends to the current project instead of its old page snapshot', () => {
  const plans = readFileSync(new URL('../app/src/pages/PlansPage.tsx', import.meta.url), 'utf8');
  assert.match(plans, /onAppendRevision\(newRev\)/);
  assert.match(plans, /signal: AbortSignal\.timeout\(120_000\)/);
});
