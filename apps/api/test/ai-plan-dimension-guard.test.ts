import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_UNITS, sanitizePlanReadingResult } from '../src/ai-plan/types.ts';

/**
 * The allowed unit list is SF/LF/EA/CY/SY/HR/LS, so it has no thickness code.
 * Before this guard a printed `4"` slab thickness had to be expressed as a
 * quantity and the nearest available unit was a length, producing "4 LF" — the
 * exact misread the 2026-09-10 estimator review rejected. A unit whitelist can
 * never catch it, because LF is a valid unit. These tests pin the dimensional
 * rule and, just as importantly, the cases it must NOT touch.
 */

const read = (findings: unknown[]) => sanitizePlanReadingResult({ summary: { sheet_count: 3 }, findings });

test('a printed thickness is never accepted as a linear quantity', () => {
  const result = read([{
    page_number: 2, finding_type: 'material', label: 'Slab on grade',
    value_text: 'SLAB 4" THK', quantity: 4, unit: 'LF', confidence: 0.8, source_excerpt: 'SLAB 4" THK TYP.',
  }]);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].quantity, null);
  assert.equal(result.findings[0].unit, null);
  assert.ok(result.summary.limitations.some(value => /printed dimension/.test(value)),
    'the removal must be disclosed, not silent');
});

test('a model-reported dimension is preserved as evidence and cannot carry a quantity', () => {
  const result = read([{
    page_number: 1, finding_type: 'material', label: 'Slab',
    dimension: '4 in', quantity: 4, unit: 'LF', confidence: 0.8, source_excerpt: 'SLAB 4"',
  }]);

  assert.equal(result.findings[0].quantity, null);
  assert.ok(result.findings[0].value_text?.includes('4 in'),
    'the printed dimension must survive as evidence');
});

test('an inch-unit thickness is kept as evidence instead of being dropped', () => {
  const result = read([{
    page_number: 1, finding_type: 'measurement', label: 'Slab thickness',
    value_text: null, quantity: 4, unit: 'IN', confidence: 0.7, source_excerpt: '4" CONC. SLAB',
  }]);

  assert.equal(result.findings.length, 1, 'the thickness is evidence, so the finding must survive');
  assert.equal(result.findings[0].quantity, null);
  assert.equal(result.findings[0].unit, null);
  assert.ok(result.findings[0].value_text?.includes('4 in'));
  assert.ok(!result.summary.limitations.some(value => /dropped/.test(value)));
});

test('a fractional sheet thickness is not a quantity, even when the model rounds it', () => {
  const result = read([{
    page_number: 1, finding_type: 'material', label: 'Gypsum board',
    quantity: 0.63, unit: 'LF', confidence: 0.8, source_excerpt: '5/8" GYPSUM BOARD',
  }]);

  assert.equal(result.findings[0].quantity, null);
});

test('a bar size is not a count', () => {
  const result = read([{
    page_number: 1, finding_type: 'material', label: 'Rebar',
    quantity: 4, unit: 'EA', confidence: 0.8, source_excerpt: '#4 REBAR @ 12"',
  }]);

  assert.equal(result.findings[0].quantity, null);
});

test('a legitimate length takeoff that does not restate a dimension is untouched', () => {
  const result = read([{
    page_number: 1, finding_type: 'material', label: 'Exterior stud wall',
    quantity: 860, unit: 'LF', confidence: 0.8, source_excerpt: '2x6 @ 16" O.C. STUDS',
  }]);

  assert.equal(result.findings[0].quantity, 860, 'an on-centre spacing is not the quantity');
  assert.equal(result.findings[0].unit, 'LF');
  assert.equal(result.summary.limitations.length, 0);
});

test('a slab area is preserved even when the same excerpt prints its thickness', () => {
  const result = read([{
    page_number: 1, finding_type: 'measurement', label: 'Slab area',
    quantity: 1240, unit: 'SF', confidence: 0.8, source_excerpt: '4" SLAB, 1240 SF',
  }]);

  assert.equal(result.findings[0].quantity, 1240, 'the area is a real quantity and must survive');
  assert.equal(result.findings[0].unit, 'SF');
  assert.equal(result.summary.limitations.length, 0);
});

test('a quantity with no printable dimension nearby keeps its normal validation', () => {
  const result = read([
    { page_number: 1, finding_type: 'room', label: 'Kitchen', quantity: 180, unit: 'SF', confidence: 0.9, source_excerpt: 'KITCHEN 180 SF' },
    { page_number: 1, finding_type: 'room', label: 'No evidence', quantity: 20, unit: 'SF', confidence: 0.9, source_excerpt: null },
    { page_number: 1, finding_type: 'room', label: 'Bad unit', quantity: 20, unit: 'USD', confidence: 0.9, source_excerpt: '20 USD' },
  ]);

  assert.equal(result.findings.length, 1, 'only the fully evidenced quantity survives');
  assert.equal(result.findings[0].quantity, 180);
  assert.ok(result.summary.limitations.some(value => /dropped/.test(value)));
});

test('the guard does not widen the priced unit list', () => {
  assert.deepEqual([...ALLOWED_UNITS].sort(), ['CY', 'EA', 'HR', 'LF', 'LS', 'SF', 'SY']);
});
