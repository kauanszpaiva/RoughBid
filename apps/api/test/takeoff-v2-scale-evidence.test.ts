import test from 'node:test';
import assert from 'node:assert/strict';
import { runDeepTakeoff } from '../src/takeoff-v2/orchestrator.ts';
import { deriveDeterministicScaleEvidence } from '../src/takeoff-v2/scale-evidence.ts';
import type { DeepPassResult, PlanSetManifest } from '../src/takeoff-v2/types.ts';

function manifest(): PlanSetManifest {
  return {
    fileSha256: 'a'.repeat(64),
    physicalPageCount: 1,
    sheets: [{
      physicalPageNumber: 1,
      pageSha256: 'b'.repeat(64),
      widthPoints: 612,
      heightPoints: 792,
      orientation: 'portrait',
      rotationDegrees: 0,
      contentKind: 'vector',
      textQuality: 'good',
      status: 'review_required',
      statusReason: 'fixture',
    }],
  };
}

test('derives one fail-safe scale source from repeated equivalent printed-scale excerpts', () => {
  const derived = deriveDeterministicScaleEvidence({
    observations: [
      { source_excerpt: `SCALE: 1/4" = 1'-0"` },
      { source_excerpt: `DETAIL SCALE 0.25" = 1'-0"` },
      { source_excerpt: `SCALE: 1/4" = 1'-0"` },
    ],
  });
  assert.equal(derived.version, 'scale-evidence-v1');
  assert.equal(derived.evidence.length, 1, 'repeated/equivalent printed scale is not independent verification');
  assert.equal(derived.calibration.verificationStatus, 'single_source');
  assert.ok(Math.abs(derived.calibration.drawingUnitsPerPoint - 1 / 18) < 1e-12);
});

test('preserves materially different printed scales as a conflict instead of choosing one', () => {
  const derived = deriveDeterministicScaleEvidence({
    observations: [
      { source_excerpt: `MAIN: 1/4" = 1'-0"` },
      { source_excerpt: `DETAIL: 1/8" = 1'-0"` },
    ],
  });
  assert.equal(derived.evidence.length, 2);
  assert.equal(derived.calibration.verificationStatus, 'conflicting');
  assert.equal(derived.calibration.confidence, 0);
});

test('NTS and non-observation content cannot become deterministic scale evidence', () => {
  assert.deepEqual(deriveDeterministicScaleEvidence({
    observations: [
      { source_excerpt: `NTS — reference says 1/4" = 1'-0"` },
      { source_excerpt: null },
      'not-an-observation',
    ],
  }).evidence, []);
  assert.equal(deriveDeterministicScaleEvidence({ observations: [] }).calibration.verificationStatus, 'blocked');
});

test('deep orchestration enriches only the geometry checkpoint before persistence', async () => {
  const saved = new Map<string, DeepPassResult>();
  await runDeepTakeoff('run-scale', manifest(), {
    async runPass(request) {
      return request.passType === 'geometry'
        ? {
            status: 'succeeded' as const,
            checkpoint: { observations: [{ source_excerpt: `SCALE: 1/4" = 1'-0"` }] },
          }
        : { status: 'succeeded' as const, checkpoint: { pass: request.passType } };
    },
  }, {
    async begin() { return 'run' as const; },
    async succeed(request, result) { saved.set(request.passType, result); },
    async fail() { throw new Error('fixture should not fail'); },
  });

  const geometry = saved.get('geometry')?.checkpoint as any;
  assert.equal(geometry.deterministic_scale.version, 'scale-evidence-v1');
  assert.equal(geometry.deterministic_scale.evidence.length, 1);
  assert.equal(geometry.deterministic_scale.calibration.verificationStatus, 'single_source');
  assert.equal((saved.get('classification')?.checkpoint as any).deterministic_scale, undefined);
});
