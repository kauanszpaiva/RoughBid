import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PLAN_BYTES, ProjectApiError, ProjectService, validatePlanFile } from '../src/projects/service.ts';

const VALID_PROJECT = {
  name: '24 Angell Street', clientName: 'Authorized client', projectType: 'Custom Residential',
  address: '24 Angell Street', jurisdictionState: 'MA', municipality: 'Boston', postalCode: '02108',
  permitDate: '2026-09-11',
};

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

test('project creation maps only the exact pilot quota exception to 429 without retrying insertion', async () => {
  for (const [error, expectedStatus] of [
    [{ code: 'P0001', message: 'Pilot project limit reached' }, 429],
    [{ code: 'P0001', message: 'Unexpected database failure' }, 500],
    [{ code: 'XX000', message: 'Pilot project limit reached' }, 500],
    [{ code: 'P0001', message: 'Pilot project limit reached unexpectedly' }, 500],
  ] as const) {
    let insertAttempts = 0;
    const service = new ProjectService({
      from(table: string) {
        assert.equal(table, 'projects');
        return { insert(row: Record<string, unknown>) {
          insertAttempts++;
          assert.equal(row.workspace_id, 'workspace-1');
          assert.equal(row.created_by, 'user-1');
          return { select: () => ({ single: async () => ({ data: null, error }) }) };
        } };
      },
    } as never, 'user-1', 'workspace-1');
    await assert.rejects(service.create({ ...VALID_PROJECT, name: 'Quota regression' }), (actual: unknown) =>
      actual instanceof ProjectApiError && actual.status === expectedStatus && actual.message === error.message);
    assert.equal(insertAttempts, 1);
  }
});

test('project creation persists structured New England jurisdiction inputs', async () => {
  let inserted: Record<string, unknown> | null = null;
  const service = new ProjectService({
    from(table: string) {
      assert.equal(table, 'projects');
      return { insert(row: Record<string, unknown>) {
        inserted = row;
        return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
      } };
    },
  } as never, 'user-1', 'workspace-1');
  await service.create(VALID_PROJECT);
  assert.equal(inserted!.jurisdiction_state, 'MA');
  assert.equal(inserted!.municipality, 'Boston');
  assert.equal(inserted!.postal_code, '02108');
  assert.equal(inserted!.permit_date, '2026-09-11');
  assert.equal(inserted!.client_name, 'Authorized client');
});

test('project creation rejects states outside New England and incomplete applicability data before insertion', async () => {
  let insertAttempts = 0;
  const service = new ProjectService({ from() { return { insert() { insertAttempts++; } }; } } as never, 'user-1', 'workspace-1');
  await assert.rejects(service.create({ ...VALID_PROJECT, jurisdictionState: 'NY' }), (error: unknown) => error instanceof ProjectApiError && error.status === 400);
  await assert.rejects(service.create({ ...VALID_PROJECT, municipality: '' }), (error: unknown) => error instanceof ProjectApiError && error.status === 400);
  await assert.rejects(service.create({ ...VALID_PROJECT, postalCode: 'not-a-zip' }), (error: unknown) => error instanceof ProjectApiError && error.status === 400);
  await assert.rejects(service.create({ ...VALID_PROJECT, permitDate: 'September 11' }), (error: unknown) => error instanceof ProjectApiError && error.status === 400);
  await assert.rejects(service.create({ ...VALID_PROJECT, permitDate: '2026-02-31' }), (error: unknown) => error instanceof ProjectApiError && error.status === 400);
  assert.equal(insertAttempts, 0);
});
