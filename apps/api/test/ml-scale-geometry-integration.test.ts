import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrateScale, measureGeometry } from '../src/takeoff-v2/geometry.ts';
import { scaleEvidenceFromExplicitDimension, scaleEvidenceFromPrintedScale } from '../src/ml/architectural-measurement.ts';

test('printed scale plus independent dimension verifies a scale used by deterministic geometry', () => {
  const printed = scaleEvidenceFromPrintedScale(`1/4" = 1'-0"`);
  const dimension = scaleEvidenceFromExplicitDimension(`4'-0"`, 72);
  assert.ok(printed && dimension);
  const calibration = calibrateScale([printed, dimension]);
  assert.equal(calibration.verificationStatus, 'verified');
  assert.ok(Math.abs(calibration.drawingUnitsPerPoint - 1 / 18) < 1e-12);

  const pageWidthPoints = 612;
  const fourFeetAcrossPage = 72 / pageWidthPoints;
  const measured = measureGeometry({ type: 'line', points: [[0, 0], [fourFeetAcrossPage, 0]] }, calibration, pageWidthPoints, 792);
  assert.equal(measured.unit, 'LF');
  assert.equal(measured.quantity, 4);
});

test('conflicting OCR/dimension evidence blocks deterministic measurement', () => {
  const printed = scaleEvidenceFromPrintedScale(`1/4" = 1'-0"`);
  const conflicting = scaleEvidenceFromExplicitDimension(`5'-0"`, 72);
  assert.ok(printed && conflicting);
  const calibration = calibrateScale([printed, conflicting]);
  assert.equal(calibration.verificationStatus, 'conflicting');
  assert.throws(() => measureGeometry({ type: 'line', points: [[0, 0], [0.1, 0]] }, calibration, 612, 792), /verified scale calibration/i);
});
