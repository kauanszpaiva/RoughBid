import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findingGraphicEvidence, readingModeStatus } from '../app/src/utils/aiFindingReview.ts';
import type { PlanReadingFinding } from '../app/src/services/api.ts';

test('the reading mode is reported honestly, including a text-only reading', () => {
  assert.equal(readingModeStatus('visual_pdf').visual, true);
  assert.equal(readingModeStatus('visual_page_images').visual, true);

  const textOnly = readingModeStatus('text_only');
  assert.equal(textOnly.visual, false);
  assert.match(textOnly.label, /NOT inspected/i);
  assert.match(textOnly.detail, /were not reviewed/i);

  const unrecorded = readingModeStatus(undefined);
  assert.equal(unrecorded.mode, 'unknown');
  assert.equal(unrecorded.visual, false);
  assert.match(unrecorded.detail, /does not record/i);

  // An unrecognized value is never treated as proof that the drawing was read.
  assert.equal(readingModeStatus('definitely_visual').mode, 'unknown');
  assert.equal(readingModeStatus(null).visual, false);
});

const findingWith = (geometry: Record<string, unknown>): PlanReadingFinding => ({
  id: 'finding-1',
  page_number: 1,
  finding_type: 'symbol',
  label: 'Ceiling fixture icon',
  value_text: null,
  quantity: null,
  unit: null,
  confidence: 0.6,
  geometry,
  source_excerpt: null,
  status: 'needs_review',
});

test('graphic drawing evidence is exposed only when it is well formed', () => {
  assert.deepEqual(
    findingGraphicEvidence(findingWith({ visual: { kind: 'hatch_pattern', description: 'Diagonal hatch on the exterior wall' } })),
    { kind: 'hatch_pattern', description: 'Diagonal hatch on the exterior wall' },
  );
  assert.equal(findingGraphicEvidence(findingWith({})), null);
  assert.equal(findingGraphicEvidence(findingWith({ visual: { kind: 'icon' } })), null);
  assert.equal(findingGraphicEvidence(findingWith({ visual: 'icon' })), null);
  assert.equal(findingGraphicEvidence(findingWith({ visual: { kind: '  ', description: 'x' } })), null);
});

test('the AI estimator surfaces how the plan was read and each graphic finding', () => {
  const modal = readFileSync(new URL('../app/src/components/AIPlanModal.tsx', import.meta.url), 'utf8');
  assert.match(modal, /readingModeStatus\(/);
  assert.match(modal, /findingGraphicEvidence\(/);
  assert.match(modal, /visual_evidence_count/);
  assert.match(modal, /How this plan was read/);
});
