export type ClassificationSample = {
  projectFamilyId: string;
  actual: string;
  predicted: string;
  confidence: number;
};

export type QuantitySample = {
  projectFamilyId: string;
  key: string;
  unit: string;
  actual: number;
  predicted: number;
  confidence: number;
};

export type LabelMetrics = {
  support: number;
  predicted: number;
  truePositive: number;
  precision: number;
  recall: number;
  f1: number;
};

export type ClassificationMetrics = {
  sampleCount: number;
  accuracy: number;
  macroPrecision: number;
  macroRecall: number;
  macroF1: number;
  expectedCalibrationError: number;
  byLabel: Record<string, LabelMetrics>;
};

export type QuantitySliceMetrics = {
  sampleCount: number;
  nonZeroTruthCount: number;
  meanAbsoluteError: number;
  meanAbsolutePercentageError: number | null;
  withinToleranceRate: number;
  expectedCalibrationError: number;
};

export type QuantityMetrics = QuantitySliceMetrics & {
  tolerancePercent: number;
  byUnit: Record<string, QuantitySliceMetrics>;
};

const finiteConfidence = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
const nonEmpty = (value: string) => typeof value === 'string' && value.trim().length > 0;
const roundMetric = (value: number) => Number(value.toFixed(12));
const safeRate = (numerator: number, denominator: number) => denominator === 0 ? 0 : numerator / denominator;

function validateClassificationSample(sample: ClassificationSample, index: number): void {
  if (!sample || !nonEmpty(sample.projectFamilyId)) throw new RangeError(`classification[${index}].projectFamilyId is required.`);
  if (!nonEmpty(sample.actual)) throw new RangeError(`classification[${index}].actual label is required.`);
  if (!nonEmpty(sample.predicted)) throw new RangeError(`classification[${index}].predicted label is required.`);
  if (!finiteConfidence(sample.confidence)) throw new RangeError(`classification[${index}].confidence must be between 0 and 1.`);
}

function validateQuantitySample(sample: QuantitySample, index: number): void {
  if (!sample || !nonEmpty(sample.projectFamilyId)) throw new RangeError(`quantity[${index}].projectFamilyId is required.`);
  if (!nonEmpty(sample.key)) throw new RangeError(`quantity[${index}].key is required.`);
  if (!nonEmpty(sample.unit)) throw new RangeError(`quantity[${index}].unit is required.`);
  if (!Number.isFinite(sample.actual) || !Number.isFinite(sample.predicted) || sample.actual < 0 || sample.predicted < 0) {
    throw new RangeError(`quantity[${index}] actual and predicted values must be finite and non-negative.`);
  }
  if (!finiteConfidence(sample.confidence)) throw new RangeError(`quantity[${index}].confidence must be between 0 and 1.`);
}

/**
 * Expected calibration error with fixed-width confidence buckets.
 * The correctness vector is task-specific: exact label match for classification,
 * and tolerance-qualified correctness for quantity takeoff.
 */
function expectedCalibrationError(samples: readonly { confidence: number; correct: boolean }[], binCount = 10): number {
  if (!samples.length) return 0;
  const bins = Array.from({ length: binCount }, () => ({ count: 0, confidence: 0, correct: 0 }));
  for (const sample of samples) {
    const index = Math.min(binCount - 1, Math.floor(sample.confidence * binCount));
    const bin = bins[index]!;
    bin.count += 1;
    bin.confidence += sample.confidence;
    if (sample.correct) bin.correct += 1;
  }
  const ece = bins.reduce((total, bin) => {
    if (!bin.count) return total;
    const accuracy = bin.correct / bin.count;
    const confidence = bin.confidence / bin.count;
    return total + (bin.count / samples.length) * Math.abs(accuracy - confidence);
  }, 0);
  return roundMetric(ece);
}

export function evaluateClassification(samples: readonly ClassificationSample[]): ClassificationMetrics {
  samples.forEach(validateClassificationSample);
  if (!samples.length) {
    return { sampleCount: 0, accuracy: 0, macroPrecision: 0, macroRecall: 0, macroF1: 0, expectedCalibrationError: 0, byLabel: {} };
  }

  const labels = [...new Set(samples.flatMap(sample => [sample.actual.trim(), sample.predicted.trim()]))].sort();
  const byLabel: Record<string, LabelMetrics> = {};
  for (const label of labels) {
    let support = 0;
    let predicted = 0;
    let truePositive = 0;
    for (const sample of samples) {
      if (sample.actual.trim() === label) support += 1;
      if (sample.predicted.trim() === label) predicted += 1;
      if (sample.actual.trim() === label && sample.predicted.trim() === label) truePositive += 1;
    }
    const precision = safeRate(truePositive, predicted);
    const recall = safeRate(truePositive, support);
    const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
    byLabel[label] = {
      support,
      predicted,
      truePositive,
      precision: roundMetric(precision),
      recall: roundMetric(recall),
      f1: roundMetric(f1),
    };
  }

  const correct = samples.filter(sample => sample.actual.trim() === sample.predicted.trim()).length;
  const metricValues = Object.values(byLabel);
  return {
    sampleCount: samples.length,
    accuracy: roundMetric(correct / samples.length),
    macroPrecision: roundMetric(metricValues.reduce((sum, item) => sum + item.precision, 0) / metricValues.length),
    macroRecall: roundMetric(metricValues.reduce((sum, item) => sum + item.recall, 0) / metricValues.length),
    macroF1: roundMetric(metricValues.reduce((sum, item) => sum + item.f1, 0) / metricValues.length),
    expectedCalibrationError: expectedCalibrationError(samples.map(sample => ({
      confidence: sample.confidence,
      correct: sample.actual.trim() === sample.predicted.trim(),
    }))),
    byLabel,
  };
}

function quantitySlice(samples: readonly QuantitySample[], tolerancePercent: number): QuantitySliceMetrics {
  if (!samples.length) {
    return { sampleCount: 0, nonZeroTruthCount: 0, meanAbsoluteError: 0, meanAbsolutePercentageError: null, withinToleranceRate: 0, expectedCalibrationError: 0 };
  }
  const errors = samples.map(sample => Math.abs(sample.predicted - sample.actual));
  const nonZero = samples.filter(sample => sample.actual > 0);
  const toleranceRatio = tolerancePercent / 100;
  const within = samples.map((sample, index) => ({
    confidence: sample.confidence,
    correct: errors[index]! <= sample.actual * toleranceRatio,
  }));
  return {
    sampleCount: samples.length,
    nonZeroTruthCount: nonZero.length,
    meanAbsoluteError: roundMetric(errors.reduce((sum, value) => sum + value, 0) / samples.length),
    meanAbsolutePercentageError: nonZero.length
      ? roundMetric(nonZero.reduce((sum, sample) => sum + Math.abs(sample.predicted - sample.actual) / sample.actual, 0) / nonZero.length)
      : null,
    withinToleranceRate: roundMetric(within.filter(item => item.correct).length / samples.length),
    expectedCalibrationError: expectedCalibrationError(within),
  };
}

export function evaluateQuantities(samples: readonly QuantitySample[], tolerancePercent = 5): QuantityMetrics {
  if (!Number.isFinite(tolerancePercent) || tolerancePercent < 0 || tolerancePercent > 100) {
    throw new RangeError('tolerancePercent must be between 0 and 100.');
  }
  samples.forEach(validateQuantitySample);
  const byUnit: Record<string, QuantitySliceMetrics> = {};
  const units = [...new Set(samples.map(sample => sample.unit.trim().toUpperCase()))].sort();
  for (const unit of units) {
    byUnit[unit] = quantitySlice(samples.filter(sample => sample.unit.trim().toUpperCase() === unit), tolerancePercent);
  }
  return { ...quantitySlice(samples, tolerancePercent), tolerancePercent, byUnit };
}

function canonicalProjectFamily(value: string): string {
  if (!nonEmpty(value)) throw new RangeError('project family identifier is required.');
  const normalized = value.trim().toLowerCase();
  const separator = normalized.lastIndexOf(':');
  return separator >= 0 ? normalized.slice(separator + 1).trim() : normalized;
}

/**
 * Guards benchmark integrity. A permit set, bid set, addendum, or revision from
 * the same project family must not be split across training and evaluation.
 * Version-qualified IDs may use `version:project-family` notation.
 */
export function validateProjectFamilySplit(trainIds: readonly string[], evaluationIds: readonly string[]): void {
  const trainFamilies = new Set(trainIds.map(canonicalProjectFamily));
  const leaked = [...new Set(evaluationIds.map(canonicalProjectFamily).filter(id => trainFamilies.has(id)))].sort();
  if (leaked.length) throw new Error(`Project-family leakage detected: ${leaked.join(', ')}`);
}
