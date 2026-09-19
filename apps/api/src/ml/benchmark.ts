import {
  evaluateClassification,
  evaluateQuantities,
  validateProjectFamilySplit,
  type ClassificationMetrics,
  type ClassificationSample,
  type QuantityMetrics,
  type QuantitySample,
} from './evaluation.ts';

export type BlueprintBenchmarkInput = {
  version: 'rbai-benchmark-v1';
  quantityTolerancePercent?: number;
  split: {
    trainProjectFamilyIds: string[];
    evaluationProjectFamilyIds: string[];
  };
  classification: ClassificationSample[];
  quantities: QuantitySample[];
};

export type BlueprintBenchmarkReport = {
  version: 'rbai-benchmark-report-v1';
  generatedAt: string;
  trainProjectFamilyCount: number;
  evaluationProjectFamilyCount: number;
  classification: ClassificationMetrics;
  quantities: QuantityMetrics;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new TypeError(`${label} must be an array of non-empty strings.`);
  }
  return value.map(item => item.trim());
}

function taskArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value as T[];
}

function uniqueCanonicalProjectFamilies(values: readonly string[]): number {
  const families = new Set(values.map(value => {
    const normalized = value.trim().toLowerCase();
    const separator = normalized.lastIndexOf(':');
    return separator >= 0 ? normalized.slice(separator + 1).trim() : normalized;
  }));
  return families.size;
}

export function evaluateBlueprintBenchmark(value: unknown, now = new Date()): BlueprintBenchmarkReport {
  const input = asRecord(value, 'benchmark');
  if (input.version !== 'rbai-benchmark-v1') throw new RangeError('benchmark.version must be rbai-benchmark-v1.');
  const split = asRecord(input.split, 'benchmark.split');
  const trainProjectFamilyIds = stringArray(split.trainProjectFamilyIds, 'benchmark.split.trainProjectFamilyIds');
  const evaluationProjectFamilyIds = stringArray(split.evaluationProjectFamilyIds, 'benchmark.split.evaluationProjectFamilyIds');
  const classification = taskArray<ClassificationSample>(input.classification, 'benchmark.classification');
  const quantities = taskArray<QuantitySample>(input.quantities, 'benchmark.quantities');
  const tolerance = input.quantityTolerancePercent === undefined ? 5 : input.quantityTolerancePercent;
  if (typeof tolerance !== 'number') throw new TypeError('benchmark.quantityTolerancePercent must be a number.');

  validateProjectFamilySplit(trainProjectFamilyIds, evaluationProjectFamilyIds);

  const evaluationFamilies = new Set(evaluationProjectFamilyIds.map(value => {
    const normalized = value.trim().toLowerCase();
    const separator = normalized.lastIndexOf(':');
    return separator >= 0 ? normalized.slice(separator + 1).trim() : normalized;
  }));
  const taskFamilies = [...classification, ...quantities].map(sample => {
    const normalized = sample.projectFamilyId.trim().toLowerCase();
    const separator = normalized.lastIndexOf(':');
    return separator >= 0 ? normalized.slice(separator + 1).trim() : normalized;
  });
  const outsideEvaluationSplit = [...new Set(taskFamilies.filter(family => !evaluationFamilies.has(family)))].sort();
  if (outsideEvaluationSplit.length) {
    throw new Error(`Benchmark task rows must belong to the evaluation split: ${outsideEvaluationSplit.join(', ')}`);
  }

  return {
    version: 'rbai-benchmark-report-v1',
    generatedAt: now.toISOString(),
    trainProjectFamilyCount: uniqueCanonicalProjectFamilies(trainProjectFamilyIds),
    evaluationProjectFamilyCount: uniqueCanonicalProjectFamilies(evaluationProjectFamilyIds),
    classification: evaluateClassification(classification),
    quantities: evaluateQuantities(quantities, tolerance),
  };
}
