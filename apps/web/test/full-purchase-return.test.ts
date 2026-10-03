import test from 'node:test';
import assert from 'node:assert/strict';
import { persistFullPurchaseRevision, readFullPurchaseReturn, restoreFullPurchaseRevision } from '../app/src/utils/fullPurchaseReturn.ts';
import { ProjectSaveQueue } from '../app/src/utils/projectSaveQueue.ts';
import type { Project } from '../app/src/types/index.ts';

const search = '?payment=returned&reading_mode=full_v2&workspace_id=w&project_id=p&file_id=original&quote_id=q';
const project = { remoteId: 'p', revisions: [
  { id: 'r1', remoteFileId: 'original', isCurrent: false },
  { id: 'r2', remoteFileId: 'newer', isCurrent: true },
] } as Project;

test('Full return identifies the original purchase without manufacturing payment status', () => {
  const returned = readFullPurchaseReturn(search)!;
  assert.deepEqual(returned, { payment: 'returned', workspaceId: 'w', projectId: 'p', fileId: 'original', quoteId: 'q' });
  assert.equal('paid' in returned, false);
  const restored = restoreFullPurchaseRevision(project, returned)!;
  assert.equal(restored.revisions.find(revision => revision.isCurrent)?.remoteFileId, 'original');
  assert.equal(project.revisions[1]!.isCurrent, true, 'return selection cannot mutate the saved source');
  assert.equal(readFullPurchaseReturn(search.replace('returned', 'canceled'))?.payment, 'canceled');
});

test('incomplete, malformed or legacy return parameters cannot choose a Full purchase', () => {
  for (const invalid of ['?payment=returned', search.replace('full_v2', 'quick'), search.replace('quote_id=q', ''), search.replace('file_id=original', 'file_id=../../other'), search.replace('payment=returned', 'payment=paid')]) {
    assert.equal(readFullPurchaseReturn(invalid), null);
  }
});

test('return cannot invent a project or missing revision in the authenticated response', () => {
  const returned = readFullPurchaseReturn(search)!;
  assert.equal(restoreFullPurchaseRevision(project, { ...returned, projectId: 'other' }), null);
  assert.equal(restoreFullPurchaseRevision(project, { ...returned, fileId: 'unknown' }), null);
});

test('checkout waits for the selected revision save, blocks failure and explicitly retries the same project', async () => {
  let fail!: (reason: Error) => void;
  const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
  let writes = 0, checkouts = 0;
  const selected = { ...project, id: 'local-project' };
  const queue = new ProjectSaveQueue<Project>(async () => { if (++writes === 1) await pending; }, () => {});
  queue.enqueue(selected);
  const input = { projectId: selected.id, fileId: 'newer', queue, getProject: () => selected, isActive: () => true };
  const opening = persistFullPurchaseRevision(input).then(() => { checkouts++; });
  assert.equal(checkouts, 0);
  fail(new Error('Synthetic save failure'));
  await assert.rejects(opening, /revision could not be saved/);
  assert.equal(checkouts, 0);
  await persistFullPurchaseRevision(input); checkouts++;
  assert.equal(writes, 2); assert.equal(checkouts, 1);
});

test('changing workspace or revision during persistence prevents opening the old checkout', async () => {
  for (const change of ['workspace', 'revision']) {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let selected = { ...project, id: 'local-project' }, active = true;
    const queue = new ProjectSaveQueue<Project>(async () => pending, () => {});
    queue.enqueue(selected);
    const opening = persistFullPurchaseRevision({ projectId: selected.id, fileId: 'newer', queue, getProject: () => selected, isActive: () => active });
    if (change === 'workspace') active = false;
    else selected = restoreFullPurchaseRevision(selected, readFullPurchaseReturn(search)!)!;
    finish();
    await assert.rejects(opening, /workspace or selected PDF changed/);
  }
});
