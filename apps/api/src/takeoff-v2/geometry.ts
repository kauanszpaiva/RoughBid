import type { MeasuredQuantity, MeasurementGeometry, ScaleCalibration, ScaleEvidence } from './types.ts';

const finitePositive = (value: number) => Number.isFinite(value) && value > 0;

export function calibrateScale(evidence: readonly ScaleEvidence[], tolerancePercent = 1): ScaleCalibration {
  const usable = evidence.filter(item => finitePositive(item.drawingUnits) && finitePositive(item.pdfPoints) && item.sourceExcerpt.trim());
  if (!usable.length) return { drawingUnitsPerPoint: 0, confidence: 0, verificationStatus: 'blocked', evidence: [] };
  const ratios = usable.map(item => item.drawingUnits / item.pdfPoints);
  const mean = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
  const maximumDeviation = Math.max(...ratios.map(value => Math.abs(value - mean) / mean * 100));
  if (usable.length > 1 && maximumDeviation > tolerancePercent) {
    return { drawingUnitsPerPoint: mean, confidence: 0, verificationStatus: 'conflicting', evidence: [...usable] };
  }
  return {
    drawingUnitsPerPoint: mean,
    confidence: usable.length > 1 ? Math.max(0.8, 1 - maximumDeviation / 100) : 0.6,
    verificationStatus: usable.length > 1 ? 'verified' : 'single_source',
    evidence: [...usable],
  };
}

function validatePoints(geometry: MeasurementGeometry): void {
  const minimum = geometry.type === 'polygon' ? 3 : geometry.type === 'point' || geometry.type === 'count' ? 1 : 2;
  if (geometry.points.length < minimum || geometry.points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1)) {
    throw new RangeError('Geometry requires valid normalized coordinates.');
  }
}

function drawingPoint(point: [number, number], pageWidthPoints: number, pageHeightPoints: number, ratio: number): [number, number] {
  return [point[0] * pageWidthPoints * ratio, point[1] * pageHeightPoints * ratio];
}

/** Computes LF/SF/EA only from persisted geometry and a verified two-source calibration. */
export function measureGeometry(geometry: MeasurementGeometry, calibration: ScaleCalibration, pageWidthPoints: number, pageHeightPoints: number): MeasuredQuantity {
  validatePoints(geometry);
  if (calibration.verificationStatus !== 'verified') throw new Error('Geometry measurement requires a verified scale calibration.');
  if (!finitePositive(pageWidthPoints) || !finitePositive(pageHeightPoints)) throw new RangeError('Page dimensions must be positive.');
  const points = geometry.points.map(point => drawingPoint(point, pageWidthPoints, pageHeightPoints, calibration.drawingUnitsPerPoint));
  const input = { geometry, pageWidthPoints, pageHeightPoints, drawingUnitsPerPoint: calibration.drawingUnitsPerPoint };
  if (geometry.type === 'point' || geometry.type === 'count') return { quantity: 1, unit: 'EA', formula: { version: 'geometry-v1', operation: 'count(points)', inputs: input } };
  if (geometry.type === 'line' || geometry.type === 'polyline') {
    let length = 0;
    for (let index = 1; index < points.length; index += 1) length += Math.hypot(points[index]![0] - points[index - 1]![0], points[index]![1] - points[index - 1]![1]);
    return { quantity: Number(length.toFixed(6)), unit: 'LF', formula: { version: 'geometry-v1', operation: 'sum(segment_length)', inputs: input } };
  }
  const polygon = geometry.type === 'rectangle'
    ? [points[0]!, [points[1]![0], points[0]![1]] as [number, number], points[1]!, [points[0]![0], points[1]![1]] as [number, number]]
    : points;
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }
  return { quantity: Number((Math.abs(twiceArea) / 2).toFixed(6)), unit: 'SF', formula: { version: 'geometry-v1', operation: 'shoelace_area', inputs: input } };
}
