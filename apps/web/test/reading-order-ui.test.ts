import test from 'node:test';
import assert from 'node:assert/strict';
import { persistReadingOrderFiles, readReadingOrderReturn } from '../app/src/utils/fullPurchaseReturn.ts';
import { planFileCoverage } from '../app/src/utils/planFileCoverage.ts';
import { isAiPlanInFlight, presentFullTakeoffStatus } from '../app/src/utils/aiPlanStatus.ts';
import { ProjectSaveQueue } from '../app/src/utils/projectSaveQueue.ts';
import type { FullTakeoffRun } from '../app/src/services/api.ts';
import type { Project } from '../app/src/types/index.ts';

test('a batch return is a scoped navigation hint and never a payment assertion', () => {
  const query = '?reading_mode=full_order&payment=returned&workspace_id=w&project_id=p&order_id=o';
  assert.deepEqual(readReadingOrderReturn(query), { workspaceId: 'w', projectId: 'p', orderId: 'o', payment: 'returned' });
  for (const value of [query.replace('returned', 'paid'), query.replace('order_id=o', ''), query.replace('order_id=o', 'order_id=../x'), query.replace('full_order', 'full_v2')]) assert.equal(readReadingOrderReturn(value), null);
});

test('all purchased files must be saved before Checkout, and a missing file blocks retry', async () => {
  let project = { id: 'p', revisions: [{ remoteFileId: 'a', isCurrent: false }, { remoteFileId: 'b', isCurrent: true }] } as Project;
  let writes = 0;
  const queue = new ProjectSaveQueue<Project>(async () => { if (++writes === 1) throw new Error('offline'); }, () => {});
  queue.enqueue(project);
  const input = { projectId: 'p', fileIds: ['a', 'b'], queue, getProject: () => project, isActive: () => true };
  await assert.rejects(persistReadingOrderFiles(input), /could not be saved/);
  await persistReadingOrderFiles(input);
  project = { ...project, revisions: project.revisions.slice(0, 1) };
  await assert.rejects(persistReadingOrderFiles(input), /selected files changed/);
});

test('capacity waiting stays pending, polls, allows cancellation, and never offers a new paid attempt', () => {
  const presented = presentFullTakeoffStatus({ status: 'waiting_budget', not_before: '2026-10-05T12:00:00Z', progress: { completed: 2, total: 20 }, sheets: [] });
  assert.equal(isAiPlanInFlight('waiting_budget'), true);
  assert.equal(presented.finished, false); assert.equal(presented.canRestart, false); assert.equal(presented.canCancel, true);
  assert.match(presented.notice, /automatically/); assert.match(presented.notice, /no extra charge/); assert.ok(presented.resumeEstimate);
  assert.equal(presentFullTakeoffStatus({ status: 'waiting_budget', not_before: 'invalid' }).resumeEstimate, null);
});

test('blocked saved pages and absent pages remain pending rather than reporting complete coverage or zero quantities', () => {
  const run = { id: 'r', mode: 'full_v2', status: 'needs_review', sheets: [{ id: 's', physical_page_number: 1, status: 'blocked', status_reason: 'Scale missing', passes: [{ status: 'blocked' }] }] } as FullTakeoffRun;
  const coverage = planFileCoverage(run, 3);
  assert.equal(coverage.saved, '1/3 pages with saved results'); assert.equal(coverage.pending, '3 pages need attention');
  assert.equal(planFileCoverage({ ...run, sheets: [] }).pageCount, 'Page count pending');
  assert.doesNotMatch(JSON.stringify(coverage), /100%|quantity|price/);
});
