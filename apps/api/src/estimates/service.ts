import {
  calculateEstimate,
  type EstimateInput,
  type EstimateResult,
} from '../../../../packages/domain/src/index.ts';

export type EstimateStatus = 'draft' | 'final';

export type Estimate = EstimateInput & EstimateResult & {
  id: string;
  workspaceId: string;
  projectId: string;
  createdBy: string;
  version: number;
  status: EstimateStatus;
  createdAt: Date;
  updatedAt: Date;
  finalizedAt: Date | null;
};

export type NewEstimateDraft = EstimateInput & {
  workspaceId: string;
  projectId: string;
  createdBy: string;
};

export interface EstimateRepository {
  /** Allocates the next project version and inserts the row atomically. */
  createDraft(
    draft: NewEstimateDraft & EstimateResult & { status: 'draft' },
  ): Promise<Estimate>;
  findById(id: string): Promise<Estimate | null>;
  updateDraft(
    id: string,
    expectedUpdatedAt: Date,
    values: EstimateInput & EstimateResult,
  ): Promise<Estimate | null>;
  finalizeDraft(id: string, expectedUpdatedAt: Date): Promise<Estimate | null>;
}

export class EstimateNotFoundError extends Error {}
export class EstimateNotDraftError extends Error {}
export class EstimateConflictError extends Error {}

/**
 * Application-level estimate workflow. All derived money fields originate from
 * calculateEstimate; repositories only persist the supplied result.
 */
export class EstimateService {
  private readonly repository: EstimateRepository;

  constructor(repository: EstimateRepository) {
    this.repository = repository;
  }

  async createDraft(input: NewEstimateDraft): Promise<Estimate> {
    const costs = estimateCosts(input);
    return this.repository.createDraft({
      ...input,
      ...calculateEstimate(costs),
      status: 'draft',
    });
  }

  async updateDraft(
    id: string,
    input: EstimateInput,
    expectedUpdatedAt?: Date,
  ): Promise<Estimate> {
    const existing = await this.requireDraft(id);
    const updated = await this.repository.updateDraft(
      id,
      expectedUpdatedAt ?? existing.updatedAt,
      { ...input, ...calculateEstimate(input) },
    );
    if (!updated) throw new EstimateConflictError('The estimate was modified concurrently.');
    return updated;
  }

  async finalizeDraft(id: string, expectedUpdatedAt?: Date): Promise<Estimate> {
    const existing = await this.requireDraft(id);
    const finalized = await this.repository.finalizeDraft(
      id,
      expectedUpdatedAt ?? existing.updatedAt,
    );
    if (!finalized) throw new EstimateConflictError('The estimate was modified concurrently.');
    return finalized;
  }

  private async requireDraft(id: string): Promise<Estimate> {
    const estimate = await this.repository.findById(id);
    if (!estimate) throw new EstimateNotFoundError(`Estimate ${id} was not found.`);
    if (estimate.status !== 'draft') {
      throw new EstimateNotDraftError('Final estimates are immutable; create a new version instead.');
    }
    return estimate;
  }
}

function estimateCosts(input: EstimateInput): EstimateInput {
  return {
    materialCost: input.materialCost,
    laborCost: input.laborCost,
    equipmentCost: input.equipmentCost,
    otherCost: input.otherCost,
    overheadPercent: input.overheadPercent,
    markupPercent: input.markupPercent,
  };
}
