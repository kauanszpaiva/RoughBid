import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBlueprintBenchmark } from '../src/ml/benchmark.ts';

test('benchmark report evaluates sheet classification and takeoff quantities together', () => {
  const report = evaluateBlueprintBenchmark({
    version: 'rbai-benchmark-v1',
    quantityTolerancePercent: 5,
    split: { trainProjectFamilyIds: ['train-1'], evaluationProjectFamilyIds: ['eval-1'] },
    classification: [
      { projectFamilyId: 'eval-1', actual: 'architectural', predicted: 'architectural', confidence: 0.9 },
    ],
    quantities: [
      { projectFamilyId: 'eval-1', key: 'exterior-wall', unit: 'LF', actual: 100, predicted: 102, confidence: 0.8 },
    ],
  });
  assert.equal(report.version, 'rbai-benchmark-report-v1');
  assert.equal(report.classification.accuracy, 1);
  assert.equal(report.quantities.withinToleranceRate, 1);
  assert.equal(report.evaluationProjectFamilyCount, 1);
});

test('benchmark rejects accidental train/evaluation project leakage', () => {
  assert.throws(() => evaluateBlueprintBenchmark({
    version: 'rbai-benchmark-v1',
    split: { trainProjectFamilyIds: ['permit:family-a'], evaluationProjectFamilyIds: ['addendum:family-a'] },
    classification: [],
    quantities: [],
  }), /project-family leakage/i);
});

test('benchmark rejects unknown versions and non-array tasks', () => {
  assert.throws(() => evaluateBlueprintBenchmark({ version: 'v0', split: { trainProjectFamilyIds: [], evaluationProjectFamilyIds: [] }, classification: [], quantities: [] }), /version/i);
  assert.throws(() => evaluateBlueprintBenchmark({ version: 'rbai-benchmark-v1', split: { trainProjectFamilyIds: [], evaluationProjectFamilyIds: [] }, classification: {}, quantities: [] }), /classification/i);
});
