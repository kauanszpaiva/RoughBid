import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewedQuantityDataset } from '../src/ml/review-dataset.ts';

const base = {
  id: 'review-1',
  finding_id: 'finding-1',
  project_id: 'project-1',
  action: 'accepted',
  original_prediction: { label: 'Wall', quantity: 10, unit: 'LF', confidence: 0.8 },
  canonical_target: { label: 'Wall', quantity: 10, unit: 'LF' },
  model: 'gemini-test',
  training_eligible: false,
  created_at: '2026-09-11T18:00:00.000Z',
} as const;

test('accepted and corrected latest reviews become quantity benchmark samples with project-family provenance', () => {
  const rows = [
    base,
    {
      ...base,
      id: 'review-2',
      action: 'corrected',
      canonical_target: { label: 'Wall', quantity: 12, unit: 'lf' },
      created_at: '2026-09-11T18:01:00.000Z',
    },
    {
      ...base,
      id: 'review-3',
      finding_id: 'finding-2',
      project_id: 'project-2',
      original_prediction: { label: 'Deck', quantity: 100, unit: 'SF', confidence: 0.9 },
      canonical_target: { label: 'Deck', quantity: 100, unit: 'SF' },
      created_at: '2026-09-11T18:02:00.000Z',
    },
  ];

  assert.deepEqual(buildReviewedQuantityDataset(rows), [
    {
      projectFamilyId: 'project-1', key: 'finding-1', unit: 'LF', actual: 12, predicted: 10, confidence: 0.8,
      reviewId: 'review-2', model: 'gemini-test', action: 'corrected',
    },
    {
      projectFamilyId: 'project-2', key: 'finding-2', unit: 'SF', actual: 100, predicted: 100, confidence: 0.9,
      reviewId: 'review-3', model: 'gemini-test', action: 'accepted',
    },
  ]);
});

test('latest review wins deterministically by created_at then review id', () => {
  const sameTime = '2026-09-11T18:03:00.000Z';
  const rows = [
    { ...base, id: 'review-a', canonical_target: { quantity: 11, unit: 'LF' }, created_at: sameTime },
    { ...base, id: 'review-z', canonical_target: { quantity: 13, unit: 'LF' }, created_at: sameTime },
  ];
  const [sample] = buildReviewedQuantityDataset(rows);
  assert.equal(sample?.reviewId, 'review-z');
  assert.equal(sample?.actual, 13);
});

test('rejected, malformed, unit-mismatched, and confidence-less reviews are excluded from quantity evaluation', () => {
  const rows = [
    { ...base, id: 'rejected', finding_id: 'f-rejected', action: 'rejected', canonical_target: null },
    { ...base, id: 'bad-negative', finding_id: 'f-negative', canonical_target: { quantity: -1, unit: 'LF' } },
    { ...base, id: 'bad-unit', finding_id: 'f-unit', canonical_target: { quantity: 10, unit: 'SF' } },
    { ...base, id: 'bad-confidence', finding_id: 'f-confidence', original_prediction: { quantity: 10, unit: 'LF' } },
    { ...base, id: 'bad-date', finding_id: 'f-date', created_at: 'not-a-date' },
    null,
  ];
  assert.deepEqual(buildReviewedQuantityDataset(rows), []);
});

test('training_eligible=true is treated as a corrupted invariant, not as permission to train', () => {
  assert.throws(
    () => buildReviewedQuantityDataset([{ ...base, training_eligible: true }]),
    /training_eligible invariant/i,
  );
});

test('dataset construction does not mutate review rows or nested predictions', () => {
  const row = {
    ...base,
    original_prediction: { ...base.original_prediction },
    canonical_target: { ...base.canonical_target },
  };
  const before = structuredClone(row);
  buildReviewedQuantityDataset([row]);
  assert.deepEqual(row, before);
});
