import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateClassification,
  evaluateQuantities,
  validateProjectFamilySplit,
} from '../src/ml/evaluation.ts';

test('classification metrics expose macro F1 and confidence calibration', () => {
  const result = evaluateClassification([
    { projectFamilyId: 'p1', actual: 'architectural', predicted: 'architectural', confidence: 0.9 },
    { projectFamilyId: 'p2', actual: 'structural', predicted: 'structural', confidence: 0.8 },
    { projectFamilyId: 'p3', actual: 'structural', predicted: 'architectural', confidence: 0.7 },
    { projectFamilyId: 'p4', actual: 'architectural', predicted: 'architectural', confidence: 0.6 },
  ]);
  assert.equal(result.sampleCount, 4);
  assert.equal(result.accuracy, 0.75);
  assert.equal(result.byLabel.architectural.recall, 1);
  assert.equal(result.byLabel.structural.recall, 0.5);
  assert.ok(result.macroF1 > 0 && result.macroF1 < 1);
  assert.ok(result.expectedCalibrationError >= 0 && result.expectedCalibrationError <= 1);
});

test('quantity metrics keep zero truth out of MAPE and track tolerance by unit', () => {
  const result = evaluateQuantities([
    { projectFamilyId: 'p1', key: 'walls', unit: 'LF', actual: 100, predicted: 104, confidence: 0.9 },
    { projectFamilyId: 'p2', key: 'walls', unit: 'LF', actual: 50, predicted: 60, confidence: 0.7 },
    { projectFamilyId: 'p3', key: 'doors', unit: 'EA', actual: 0, predicted: 1, confidence: 0.4 },
  ], 5);
  assert.equal(result.sampleCount, 3);
  assert.equal(result.nonZeroTruthCount, 2);
  assert.ok(Math.abs(result.withinToleranceRate - 1 / 3) < 1e-12);
  assert.equal(result.byUnit.LF.sampleCount, 2);
  assert.equal(result.byUnit.EA.meanAbsoluteError, 1);
  assert.ok(Math.abs(result.meanAbsolutePercentageError - 0.12) < 1e-12);
});

test('project-family leakage is rejected even when document versions differ', () => {
  assert.throws(() => validateProjectFamilySplit(['permit-set:a', 'bid-set:b'], ['addendum:a']), /project-family leakage/i);
  assert.doesNotThrow(() => validateProjectFamilySplit(['permit-set:a'], ['bid-set:b']));
});

test('invalid confidence, labels, units, and negative quantities are rejected', () => {
  assert.throws(() => evaluateClassification([{ projectFamilyId: 'p', actual: 'a', predicted: 'a', confidence: 1.1 }]), /confidence/i);
  assert.throws(() => evaluateQuantities([{ projectFamilyId: 'p', key: 'x', unit: '', actual: 1, predicted: 1, confidence: 0.5 }]), /unit/i);
  assert.throws(() => evaluateQuantities([{ projectFamilyId: 'p', key: 'x', unit: 'SF', actual: -1, predicted: 1, confidence: 0.5 }]), /non-negative/i);
});
