import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlanReadingFinding } from '../app/src/services/api.ts';
import { getFindingTarget, getValidFindingBox, getValidFindingPoint } from '../app/src/features/plans/utils/findingGeometry.ts';

const makeFinding = (geometry: Record<string, unknown>, page_number: number | null = 3): PlanReadingFinding => ({
  id: 'f', page_number, finding_type: 'material', label: 'Wall', value_text: null,
  quantity: null, unit: null, confidence: 0.9, geometry, source_excerpt: 'source', status: 'needs_review',
});

test('accepts only normalized in-page boxes', () => {
  assert.deepEqual(getValidFindingBox(makeFinding({ bbox: [0.1, 0.2, 0.3, 0.4] })), [0.1, 0.2, 0.3, 0.4]);
  assert.equal(getValidFindingBox(makeFinding({ bbox: [0.9, 0.2, 0.3, 0.4] })), null);
  assert.equal(getValidFindingBox(makeFinding({ bbox: [-0.1, 0.2, 0.3, 0.4] })), null);
});

test('bbox center wins over point and geometry-free finding remains page-only', () => {
  assert.deepEqual(getValidFindingPoint(makeFinding({ bbox: [0.2, 0.2, 0.2, 0.2], point: [0.9, 0.9] })), { x: 0.3, y: 0.3 });
  assert.deepEqual(getFindingTarget(makeFinding({}), 10), { kind: 'page', page: 3 });
  assert.deepEqual(getFindingTarget(makeFinding({ point: [0.5, 0.25] }), 10), { kind: 'point', page: 3, point: { x: 0.5, y: 0.25 } });
  assert.equal(getFindingTarget(makeFinding({ point: [0.5, 0.25] }, 99), 10), null);
});
