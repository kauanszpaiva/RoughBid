import type { QuantitySample } from './evaluation.ts';

export type ReviewedQuantitySample = QuantitySample & {
  reviewId: string;
  model: string;
  action: 'accepted' | 'corrected';
};

type ParsedReview = {
  id: string;
  findingId: string;
  projectId: string;
  action: 'accepted' | 'rejected' | 'corrected';
  originalPrediction: Record<string, unknown>;
  canonicalTarget: Record<string, unknown> | null;
  model: string;
  createdAtMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function confidence(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function parseReview(value: unknown): ParsedReview | null {
  if (!isRecord(value)) return null;
  if (value.training_eligible === true) {
    throw new Error('training_eligible invariant violated: review datasets are QA/evaluation-only.');
  }
  if (value.training_eligible !== false) return null;

  const id = nonEmptyString(value.id);
  const findingId = nonEmptyString(value.finding_id);
  const projectId = nonEmptyString(value.project_id);
  const model = nonEmptyString(value.model);
  const createdAt = nonEmptyString(value.created_at);
  const action = value.action;
  if (!id || !findingId || !projectId || !model || !createdAt) return null;
  if (action !== 'accepted' && action !== 'rejected' && action !== 'corrected') return null;
  if (!isRecord(value.original_prediction)) return null;
  if (value.canonical_target !== null && !isRecord(value.canonical_target)) return null;

  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return null;
  return {
    id,
    findingId,
    projectId,
    action,
    originalPrediction: value.original_prediction,
    canonicalTarget: value.canonical_target,
    model,
    createdAtMs,
  };
}

/**
 * Builds a QA/evaluation quantity corpus from the latest review for each finding.
 * This function never grants training rights and never invents a comparable unit
 * or confidence value. Rejected/incomplete reviews remain useful QA evidence but
 * are not fabricated into supervised quantity targets.
 */
export function buildReviewedQuantityDataset(rows: readonly unknown[]): ReviewedQuantitySample[] {
  const latestByFinding = new Map<string, ParsedReview>();
  for (const raw of rows) {
    const review = parseReview(raw);
    if (!review) continue;
    const previous = latestByFinding.get(review.findingId);
    if (!previous
      || review.createdAtMs > previous.createdAtMs
      || (review.createdAtMs === previous.createdAtMs && review.id.localeCompare(previous.id) > 0)) {
      latestByFinding.set(review.findingId, review);
    }
  }

  const samples: ReviewedQuantitySample[] = [];
  const reviews = [...latestByFinding.values()].sort((left, right) =>
    left.projectId.localeCompare(right.projectId)
      || left.findingId.localeCompare(right.findingId)
      || left.id.localeCompare(right.id));

  for (const review of reviews) {
    if (review.action === 'rejected' || !review.canonicalTarget) continue;
    const predicted = finiteNonNegative(review.originalPrediction.quantity);
    const actual = finiteNonNegative(review.canonicalTarget.quantity);
    const predictedUnit = nonEmptyString(review.originalPrediction.unit)?.toUpperCase() ?? null;
    const actualUnit = nonEmptyString(review.canonicalTarget.unit)?.toUpperCase() ?? null;
    const modelConfidence = confidence(review.originalPrediction.confidence);
    if (predicted === null || actual === null || !predictedUnit || !actualUnit || predictedUnit !== actualUnit || modelConfidence === null) {
      continue;
    }

    samples.push({
      projectFamilyId: review.projectId,
      key: review.findingId,
      unit: actualUnit,
      actual,
      predicted,
      confidence: modelConfidence,
      reviewId: review.id,
      model: review.model,
      action: review.action,
    });
  }

  return samples;
}
