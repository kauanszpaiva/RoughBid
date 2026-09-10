import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { createPlanSetManifest } from '../src/takeoff-v2/preflight.ts';
import { calibrateScale, measureGeometry } from '../src/takeoff-v2/geometry.ts';
import { DEEP_PASS_ORDER, runDeepTakeoff } from '../src/takeoff-v2/orchestrator.ts';
import type { DeepPassRequest } from '../src/takeoff-v2/types.ts';

test('preflight accounts for every physical page before AI work', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  pdf.addPage([792, 612]);
  const manifest = await createPlanSetManifest(await pdf.save());
  assert.equal(manifest.physicalPageCount, 2);
  assert.deepEqual(manifest.sheets.map(sheet => sheet.physicalPageNumber), [1, 2]);
  assert.deepEqual(manifest.sheets.map(sheet => sheet.orientation), ['portrait', 'landscape']);
  assert.ok(manifest.sheets.every(sheet => sheet.status === 'review_required' && /^[0-9a-f]{64}$/.test(sheet.pageSha256)));
});

test('geometry requires two agreeing scale checks and produces reproducible LF/SF', () => {
  const scale = calibrateScale([
    { sourceType: 'explicit_dimension', drawingUnits: 10, pdfPoints: 100, sourceExcerpt: '10\' - 0"' },
    { sourceType: 'graphic_scale', drawingUnits: 20, pdfPoints: 200, sourceExcerpt: 'graphic bar 0–20 ft' },
  ]);
  assert.equal(scale.verificationStatus, 'verified');
  assert.equal(measureGeometry({ type: 'line', points: [[0, 0], [0.5, 0]] }, scale, 200, 100).quantity, 10);
  assert.equal(measureGeometry({ type: 'rectangle', points: [[0, 0], [0.5, 0.5]] }, scale, 200, 100).quantity, 50);
  const conflict = calibrateScale([
    { sourceType: 'explicit_dimension', drawingUnits: 10, pdfPoints: 100, sourceExcerpt: '10 ft' },
    { sourceType: 'graphic_scale', drawingUnits: 30, pdfPoints: 100, sourceExcerpt: '30 ft' },
  ]);
  assert.equal(conflict.verificationStatus, 'conflicting');
  assert.throws(() => measureGeometry({ type: 'line', points: [[0, 0], [1, 0]] }, conflict, 100, 100), /verified scale/);
});

test('deep mode is per-sheet, high-reasoning, checkpointed and preserves partial success', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([100, 100]); pdf.addPage([100, 100]);
  const manifest = await createPlanSetManifest(await pdf.save());
  const begun: DeepPassRequest[] = []; const succeeded: DeepPassRequest[] = []; const failed: DeepPassRequest[] = [];
  const repository = {
    async begin(request: DeepPassRequest) { begun.push(request); return 'run' as const; },
    async succeed(request: DeepPassRequest) { succeeded.push(request); },
    async fail(request: DeepPassRequest) { failed.push(request); },
  };
  const summary = await runDeepTakeoff('run-1', manifest, {
    async runPass(request) {
      assert.equal(request.reasoningEffort, 'high');
      if (request.sheet.physicalPageNumber === 2 && request.passType === 'geometry') throw new Error('sheet failure');
      return { status: 'succeeded' as const, checkpoint: { page: request.sheet.physicalPageNumber } };
    },
  }, repository);
  assert.equal(summary.succeeded, DEEP_PASS_ORDER.length + 2);
  assert.equal(summary.failed, 1);
  assert.equal(failed[0]?.sheet.physicalPageNumber, 2);
  assert.equal(succeeded.filter(request => request.sheet.physicalPageNumber === 1).length, DEEP_PASS_ORDER.length);
  assert.ok(begun.every(request => /^[0-9a-f]{64}$/.test(request.idempotencyKey)));
});
