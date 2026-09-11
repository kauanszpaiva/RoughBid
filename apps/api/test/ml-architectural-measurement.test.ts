import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArchitecturalLength,
  parsePrintedArchitecturalScale,
  scaleEvidenceFromExplicitDimension,
  scaleEvidenceFromPrintedScale,
} from '../src/ml/architectural-measurement.ts';

test('parses US architectural feet/inches including mixed fractions and unicode primes', () => {
  assert.deepEqual(parseArchitecturalLength(`15'-8"`), { feet: 15, inches: 8, totalFeet: 15 + 8 / 12 });
  assert.deepEqual(parseArchitecturalLength(`7' 3 1/2"`), { feet: 7, inches: 3.5, totalFeet: 7 + 3.5 / 12 });
  assert.deepEqual(parseArchitecturalLength('6′-9 3/4″'), { feet: 6, inches: 9.75, totalFeet: 6 + 9.75 / 12 });
  assert.deepEqual(parseArchitecturalLength(`36"`), { feet: 0, inches: 36, totalFeet: 3 });
  assert.deepEqual(parseArchitecturalLength(`8'`), { feet: 8, inches: 0, totalFeet: 8 });
});

test('rejects ambiguous or corrupted dimension strings instead of guessing', () => {
  assert.equal(parseArchitecturalLength(`1/4" = 1'-0"`), null, 'printed scales are not dimensions');
  assert.equal(parseArchitecturalLength(`15'-13"`), null, 'feet+inches notation must keep inches below 12');
  assert.equal(parseArchitecturalLength(`about 15'-8"`), null, 'free text must be isolated before parsing');
  assert.equal(parseArchitecturalLength(`-4'-0"`), null);
  assert.equal(parseArchitecturalLength(`7' 1/0"`), null);
});

test('parses common architectural printed scales into real feet per PDF point', () => {
  const quarter = parsePrintedArchitecturalScale(`1/4" = 1'-0"`);
  assert.ok(quarter);
  assert.equal(quarter.paperInches, 0.25);
  assert.equal(quarter.realFeet, 1);
  assert.ok(Math.abs(quarter.drawingFeetPerPdfPoint - 1 / 18) < 1e-12);

  const threeSixteenths = parsePrintedArchitecturalScale(`3/16" = 1'-0"`);
  assert.ok(threeSixteenths);
  assert.ok(Math.abs(threeSixteenths.drawingFeetPerPdfPoint - 1 / 13.5) < 1e-12);

  const engineeringLike = parsePrintedArchitecturalScale(`1" = 10'-0"`);
  assert.ok(engineeringLike);
  assert.ok(Math.abs(engineeringLike.drawingFeetPerPdfPoint - 10 / 72) < 1e-12);
});

test('NTS and malformed scale strings fail closed', () => {
  for (const text of ['NTS', 'NOT TO SCALE', `1/4" = NTS`, `0" = 1'-0"`, `1/4" = -1'-0"`]) {
    assert.equal(parsePrintedArchitecturalScale(text), null, text);
  }
});

test('converts printed scale and explicit dimensions into calibratable ScaleEvidence', () => {
  assert.deepEqual(scaleEvidenceFromPrintedScale(`1/4" = 1'-0"`), {
    sourceType: 'printed_scale', drawingUnits: 1, pdfPoints: 18, sourceExcerpt: `1/4" = 1'-0"`,
  });
  assert.deepEqual(scaleEvidenceFromExplicitDimension(`4'-0"`, 72), {
    sourceType: 'explicit_dimension', drawingUnits: 4, pdfPoints: 72, sourceExcerpt: `4'-0"`,
  });
  assert.equal(scaleEvidenceFromExplicitDimension(`4'-0"`, 0), null);
});
