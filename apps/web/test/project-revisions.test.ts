import test from 'node:test';
import assert from 'node:assert/strict';
import { patchProjectRevision } from '../app/src/utils/projectRevisions.ts';
import type { Project } from '../app/src/types/index.ts';

test('a delayed AI result preserves edits made after the request began', () => {
  const latest = { id: 'p', name: 'Renamed while processing', quantities: [{ id: 'q', qty: 200 }],
    estimateItems: [{ id: 'e', directCost: 600 }], revisions: [
      { id: 'old', isCurrent: false, annotations: [{ id: 'note', text: 'New note' }] },
      { id: 'new', isCurrent: true },
    ] } as unknown as Project;
  const updated = patchProjectRevision(latest, 'old', { aiPlanJobId: 'job', aiPlanStatus: 'complete' });
  assert.equal(updated.name, latest.name);
  assert.equal(updated.quantities, latest.quantities);
  assert.equal(updated.estimateItems, latest.estimateItems);
  assert.equal(updated.revisions[0].annotations, latest.revisions[0].annotations);
  assert.equal(updated.revisions[1], latest.revisions[1]);
  assert.equal(updated.revisions[0].aiPlanJobId, 'job');
  assert.equal(patchProjectRevision(latest, 'deleted', { aiPlanJobId: 'job' }), latest);
});
