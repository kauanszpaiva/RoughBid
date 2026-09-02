import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EstimateConflictError,
  EstimateNotDraftError,
  EstimateService,
  type Estimate,
  type EstimateRepository,
  type NewEstimateDraft,
} from '../src/estimates/service.ts';
import { calculateEstimate, type EstimateInput, type EstimateResult } from '../../../packages/domain/src/index.ts';

class MemoryEstimates implements EstimateRepository {
  rows: Estimate[] = [];
  private clock = 0;

  async createDraft(values: NewEstimateDraft & EstimateResult & { status: 'draft' }) {
    const versions = this.rows.filter((row) => row.projectId === values.projectId).map((row) => row.version);
    const now = new Date(++this.clock);
    const row: Estimate = {
      ...values,
      id: `estimate-${this.rows.length + 1}`,
      version: Math.max(0, ...versions) + 1,
      createdAt: now,
      updatedAt: now,
      finalizedAt: null,
    };
    this.rows.push(row);
    return row;
  }

  async findById(id: string) { return this.rows.find((row) => row.id === id) ?? null; }

  async updateDraft(id: string, expected: Date, values: EstimateInput & EstimateResult) {
    const row = await this.findById(id);
    if (!row || row.status !== 'draft' || row.updatedAt.getTime() !== expected.getTime()) return null;
    Object.assign(row, values, { updatedAt: new Date(++this.clock) });
    return row;
  }

  async finalizeDraft(id: string, expected: Date) {
    const row = await this.findById(id);
    if (!row || row.status !== 'draft' || row.updatedAt.getTime() !== expected.getTime()) return null;
    const now = new Date(++this.clock);
    Object.assign(row, { status: 'final' as const, updatedAt: now, finalizedAt: now });
    return row;
  }
}

const costs: EstimateInput = {
  materialCost: 1000, laborCost: 500, equipmentCost: 100, otherCost: 50,
  overheadPercent: 10, markupPercent: 20,
};
const context = { workspaceId: 'workspace', projectId: 'project', createdBy: 'user' };

test('creates versioned drafts with every domain-calculated field', async () => {
  const repository = new MemoryEstimates();
  const service = new EstimateService(repository);
  const first = await service.createDraft({ ...context, ...costs });
  const second = await service.createDraft({ ...context, ...costs });

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.deepEqual(
    { directCost: first.directCost, overheadAmount: first.overheadAmount,
      costWithOverhead: first.costWithOverhead, markupAmount: first.markupAmount,
      finalPrice: first.finalPrice, grossMarginPercent: first.grossMarginPercent },
    calculateEstimate(costs),
  );
});

test('recalculates a draft without changing its version', async () => {
  const service = new EstimateService(new MemoryEstimates());
  const draft = await service.createDraft({ ...context, ...costs });
  const updated = await service.updateDraft(draft.id, { ...costs, materialCost: 2000 });
  assert.equal(updated.version, 1);
  assert.equal(updated.directCost, 2650);
  assert.equal(updated.finalPrice, 3498);
});

test('final estimates cannot be edited or finalized twice', async () => {
  const service = new EstimateService(new MemoryEstimates());
  const draft = await service.createDraft({ ...context, ...costs });
  const final = await service.finalizeDraft(draft.id);
  assert.equal(final.status, 'final');
  assert.ok(final.finalizedAt);
  await assert.rejects(() => service.updateDraft(final.id, costs), EstimateNotDraftError);
  await assert.rejects(() => service.finalizeDraft(final.id), EstimateNotDraftError);
});

test('rejects stale updates', async () => {
  const service = new EstimateService(new MemoryEstimates());
  const draft = await service.createDraft({ ...context, ...costs });
  await assert.rejects(
    () => service.updateDraft(draft.id, costs, new Date(999)),
    EstimateConflictError,
  );
});
