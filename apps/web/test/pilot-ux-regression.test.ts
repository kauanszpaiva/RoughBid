import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('PlansPageContent disables upload and analysis triggers while operations are in progress', () => {
  const code = readFileSync(new URL('../app/src/pages/PlansPageContent.tsx', import.meta.url), 'utf8');

  // Check upload handler guard
  assert.match(code, /if \(!canWrite \|\| isUploading \|\| isStartingAi \|\| isPaying\) return;/);

  // Check start reading handlers guard
  assert.match(code, /handleStartFreeReading = async \(\) => \{\s*if \(!canWrite \|\| isStartingAi \|\| isUploading \|\| isPaying\) return;/);
  assert.match(code, /handleStartAiReading = async \(\) => \{\s*if \(!canWrite \|\| isStartingAi \|\| isUploading \|\| isPaying\) return;/);

  // Check UI button disabled attributes
  assert.match(code, /disabled=\{!canWrite \|\| !selectedTrades\.length \|\| !currentRevision\?\.remoteFileId \|\| currentRevision\.processingStatus !== "ready" \|\| isStartingAi \|\| isUploading \|\| isPaying\}/);
});

test('AIPlanModal guards finding accept/reject buttons against re-entrant clicks', () => {
  const code = readFileSync(new URL('../app/src/components/AIPlanModal.tsx', import.meta.url), 'utf8');

  assert.match(code, /handleAcceptFinding = async \(finding: PlanReadingFinding\) => \{\s*if \(!workspaceId \|\| pendingFindingIds\[finding\.id\] \|\| finding\.status !== "needs_review"\) return;/);
  assert.match(code, /handleRejectFinding = async \(finding: PlanReadingFinding\) => \{\s*if \(!workspaceId \|\| pendingFindingIds\[finding\.id\] \|\| finding\.status !== "needs_review"\) return;/);
});

test('PlansPageContent revokes object URLs on unmount/cleanup to prevent memory leaks', () => {
  const code = readFileSync(new URL('../app/src/pages/PlansPageContent.tsx', import.meta.url), 'utf8');

  assert.match(code, /return \(\) => \{\s*canceled = true;\s*if \(objectUrl\) URL\.revokeObjectURL\(objectUrl\);\s*\};/);
});
