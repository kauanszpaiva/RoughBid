import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePlanReadingResult } from '../src/ai-plan/types.ts';

test('preserves evidenced project address metadata from a physical plan page', () => {
  const result = sanitizePlanReadingResult({
    summary: {
      sheet_count: 12,
      project_address: {
        project_name: 'Smith Renovation',
        street_address: '12 Main St',
        city: 'Needham',
        state: 'MA',
        postal_code: '02492',
        building_lot_unit: 'Lot 4',
        page_number: 1,
        source_excerpt: 'PROJECT ADDRESS: 12 MAIN ST, NEEDHAM MA 02492',
        confidence: 0.98,
      },
    },
    findings: [{
      page_number: 1,
      finding_type: 'scope_note',
      label: 'Project information',
      value_text: null,
      quantity: null,
      unit: null,
      confidence: 0.9,
      source_excerpt: 'PROJECT INFORMATION',
      geometry: {},
    }],
  });

  const address = (result.summary as any).project_address;
  assert.equal(address?.postal_code, '02492');
  assert.equal(address?.page_number, 1);
  assert.equal(address?.source_excerpt, 'PROJECT ADDRESS: 12 MAIN ST, NEEDHAM MA 02492');
  assert.equal(address?.confidence, 0.98);
});

test('drops invalid project address evidence and records the limitation instead of inventing an address', () => {
  for (const project_address of [
    {
      street_address: '12 Main St', city: 'Needham', state: 'MA', postal_code: '02492',
      page_number: 13, source_excerpt: 'PROJECT ADDRESS: 12 MAIN ST', confidence: 0.9,
    },
    {
      street_address: '12 Main St', city: 'Needham', state: 'MA', postal_code: '02492',
      page_number: 1, source_excerpt: '   ', confidence: 0.9,
    },
  ]) {
    const result = sanitizePlanReadingResult({ summary: { sheet_count: 12, project_address }, findings: [] });
    assert.equal((result.summary as any).project_address, undefined);
    assert.ok(result.summary.limitations.some((value) => /address/i.test(value) && /drop|invalid|evidence/i.test(value)));
  }
});
