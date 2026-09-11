import type { PlanReadingFinding } from '../../../services/api.ts';
import type { FindingTarget, NormalizedBox, NormalizedPoint } from '../types.ts';

function normalizedNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

const stableCoordinate = (value: number) => Number(value.toFixed(12));

export function getValidFindingBox(finding: PlanReadingFinding): NormalizedBox | null {
  const box = finding.geometry?.bbox;
  if (!Array.isArray(box) || box.length !== 4) return null;
  const [x, y, width, height] = box;
  if (![x, y, width, height].every(normalizedNumber)) return null;
  if (width <= 0 || height <= 0 || x + width > 1 || y + height > 1) return null;
  return [x, y, width, height];
}

function getRawValidPoint(finding: PlanReadingFinding): NormalizedPoint | null {
  const point = finding.geometry?.point;
  if (!Array.isArray(point) || point.length !== 2) return null;
  const [x, y] = point;
  if (!normalizedNumber(x) || !normalizedNumber(y)) return null;
  return { x, y };
}

export function getValidFindingPoint(finding: PlanReadingFinding): NormalizedPoint | null {
  const box = getValidFindingBox(finding);
  if (box) {
    return {
      x: stableCoordinate(box[0] + box[2] / 2),
      y: stableCoordinate(box[1] + box[3] / 2),
    };
  }
  return getRawValidPoint(finding);
}

export function getFindingTarget(finding: PlanReadingFinding, totalPages: number): FindingTarget | null {
  const page = finding.page_number;
  if (page === null || !Number.isInteger(page) || page < 1 || page > totalPages) return null;
  const box = getValidFindingBox(finding);
  if (box) return { kind: 'box', page, box };
  const point = getRawValidPoint(finding);
  if (point) return { kind: 'point', page, point };
  return { kind: 'page', page };
}
