import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PLAN_BYTES, ProjectApiError, validatePlanFile } from '../src/projects/service.ts';

test('plan upload validation accepts a genuine PDF by name, MIME type, and signature', async () => {
  const file = new File(['%PDF-1.7\ncontent'], 'plans.PDF', { type: 'application/pdf' });
  await assert.doesNotReject(validatePlanFile(file));
});

test('plan upload validation rejects renamed files and non-PDF MIME types', async () => {
  const renamed = new File(['not a pdf'], 'plans.pdf', { type: 'application/pdf' });
  const wrongType = new File(['%PDF-1.7'], 'plans.pdf', { type: 'text/plain' });
  await assert.rejects(validatePlanFile(renamed), (error: unknown) => error instanceof ProjectApiError && error.status === 415);
  await assert.rejects(validatePlanFile(wrongType), (error: unknown) => error instanceof ProjectApiError && error.status === 415);
});

test('plan upload validation enforces the 50 MB boundary before reading contents', async () => {
  const oversized = new File([new Uint8Array(MAX_PLAN_BYTES + 1)], 'plans.pdf', { type: 'application/pdf' });
  await assert.rejects(validatePlanFile(oversized), (error: unknown) => error instanceof ProjectApiError && error.status === 413);
});
