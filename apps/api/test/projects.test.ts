import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PLAN_BYTES, ProjectApiError, ProjectService, validatePlanFile } from '../src/projects/service.ts';
import { handleProjectRequest } from '../src/projects/routes.ts';

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

test('project creation rejects PostgreSQL-incompatible year zero before insertion', async () => {
  let insertAttempts = 0;
  const service = new ProjectService({
    from() {
      return { insert(row: Record<string, unknown>) {
        insertAttempts++;
        return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
      } };
    },
  } as never, 'user-1', 'workspace-1');
  await assert.rejects(service.create({ ...VALID_PROJECT, permitDate: '0000-01-01' }), (error: unknown) =>
    error instanceof ProjectApiError && error.status === 400 && error.message === 'permit_date must be a valid YYYY-MM-DD date');
  assert.equal(insertAttempts, 0);
});

test('two authorized services read the identical immutable estimate revision and hash', async () => {
  const canonical = {
    id: 'version-1', project_id: 'project-1', revision: 3,
    state: { revisions: [], quantities: [{ id: 'q-1', quantity: 12, unit: 'EA' }], estimateItems: [{ id: 'e-1', materialCost: 100, laborCost: 200, equipmentCost: 0 }] },
    state_sha256: 'a'.repeat(64), calculation_version: 'calculation-v1-fixed-6dp',
    created_by: 'estimator-1', created_at: '2026-09-11T16:00:00Z',
  };
  const db = {
    from(table: string) {
      const query: any = {
        select: () => query,
        eq: () => query,
        order: async () => ({ data: [{ ...canonical, state: undefined }], error: null }),
        maybeSingle: async () => ({ data: table === 'projects' ? { id: 'project-1' } : canonical, error: null }),
      };
      return query;
    },
  } as never;
  const first = new ProjectService(db, 'user-a', 'workspace-1');
  const second = new ProjectService(db, 'user-b', 'workspace-1');
  const [left, right] = await Promise.all([
    first.getEstimateVersion('project-1', '3'),
    second.getEstimateVersion('project-1', '3'),
  ]);
  assert.deepEqual(left, right);
  assert.equal(left.state_sha256, 'a'.repeat(64));
  assert.equal(left.calculation_version, 'calculation-v1-fixed-6dp');
});

test('estimate revision lookup rejects malformed revisions before querying the database', async () => {
  let reads = 0;
  const service = new ProjectService({ from() { reads++; return {}; } } as never, 'user-1', 'workspace-1');
  for (const revision of ['', '0', '-1', '1.5', 'latest']) {
    await assert.rejects(service.getEstimateVersion('project-1', revision), (error: unknown) => error instanceof ProjectApiError && error.status === 400);
  }
  assert.equal(reads, 0);
});

test('estimate version route rejects an explicitly empty revision parameter instead of listing versions', async () => {
  let reads = 0;
  const query: any = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: { id: 'project-1' }, error: null }),
    order: async () => ({ data: [], error: null }),
  };
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from() { reads++; return query; },
  } as never;
  const response = await handleProjectRequest(new Request(
    'https://roughbid.test/api/projects/project-1/estimate-versions?revision=',
    { headers: { 'x-workspace-id': 'workspace-1' } },
  ), db);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'revision must be a positive integer' });
  assert.equal(reads, 0);
});
