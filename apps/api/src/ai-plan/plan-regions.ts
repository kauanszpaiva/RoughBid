import { PDFDocument } from 'pdf-lib';
import type { DrawingLinework, PageLinework } from './drawing-linework.ts';
import type { PlanReadingFinding } from './types.ts';

export interface PlanRegion {
  id: 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';
  pageNumber: number;
  /** [x, y, width, height], normalized 0..1 from top-left of the displayed page. */
  bbox: [number, number, number, number];
}

const REGION_SIZE = 0.6;
const REGION_OFFSET = 1 - REGION_SIZE;

export function overlappingRegions(pageNumber: number): PlanRegion[] {
  return [
    { id: 'top_left', pageNumber, bbox: [0, 0, REGION_SIZE, REGION_SIZE] },
    { id: 'top_right', pageNumber, bbox: [REGION_OFFSET, 0, REGION_SIZE, REGION_SIZE] },
    { id: 'bottom_left', pageNumber, bbox: [0, REGION_OFFSET, REGION_SIZE, REGION_SIZE] },
    { id: 'bottom_right', pageNumber, bbox: [REGION_OFFSET, REGION_OFFSET, REGION_SIZE, REGION_SIZE] },
  ];
}

function isDrawingDense(page: PageLinework): boolean {
  return page.spaces.length > 0
    || page.openings.length > 0
    || page.wallLikeSegments >= 40
    || page.segments >= 4_000
    || page.truncated;
}

/**
 * Selects pages that contain enough measured drawing geometry to deserve a
 * second, zoomed visual pass. The native whole-page sweep still reads every
 * physical page; this list only decides where a high-attention pass adds value.
 */
export function denseDrawingPages(linework: DrawingLinework | undefined, pageCount: number, maxPages = 200): number[] {
  if (!linework) return [];
  const bounded = Math.max(1, Math.min(maxPages, pageCount, 200));
  return linework.pages
    .filter(page => page.pageNumber <= bounded && isDrawingDense(page))
    .map(page => page.pageNumber);
}

/**
 * Produces a one-page vector PDF clipped to a region of a physical source page.
 *
 * The provider receives the actual vector content instead of a low-resolution
 * screenshot. Regions overlap by 20% in each direction, so a door, room or
 * symbol straddling a quadrant boundary is visible in at least one crop.
 */
async function appendRegionPage(
  target: PDFDocument,
  source: PDFDocument,
  region: PlanRegion,
): Promise<void> {
  const sourcePage = source.getPage(region.pageNumber - 1);
  if (!sourcePage) throw new Error('The requested region page is outside the plan.');

  const rotation = sourcePage.getRotation().angle % 360;
  if (rotation !== 0) {
    throw new Error(`Region sweep requires an unrotated PDF page; physical page ${region.pageNumber} is rotated ${rotation} degrees.`);
  }

  const width = sourcePage.getWidth();
  const height = sourcePage.getHeight();
  const [x, y, regionWidth, regionHeight] = region.bbox;
  const left = x * width;
  const right = (x + regionWidth) * width;
  const top = height - y * height;
  const bottom = height - (y + regionHeight) * height;

  const embedded = await target.embedPage(sourcePage, { left, bottom, right, top });
  const page = target.addPage([right - left, top - bottom]);
  page.drawPage(embedded, {
    x: 0,
    y: 0,
    width: right - left,
    height: top - bottom,
  });
}

export async function cropPdfRegion(
  source: PDFDocument,
  region: PlanRegion,
): Promise<Uint8Array> {
  const target = await PDFDocument.create();
  await appendRegionPage(target, source, region);
  return target.save();
}

/**
 * One provider request per dense physical sheet. Its four PDF pages are
 * overlapping vector crops in stable order, which is both cheaper and more
 * complete than four unrelated provider calls.
 */
export async function cropPdfRegions(
  source: PDFDocument,
  physicalPage: number,
): Promise<{ bytes: Uint8Array; regions: PlanRegion[] }> {
  const regions = overlappingRegions(physicalPage);
  const target = await PDFDocument.create();
  for (const region of regions) await appendRegionPage(target, source, region);
  return { bytes: await target.save(), regions };
}

export function remapRegionFinding(finding: PlanReadingFinding, region: PlanRegion): PlanReadingFinding {
  const raw = finding.geometry?.bbox;
  const [rx, ry, rw, rh] = region.bbox;
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every(value => typeof value === 'number' && Number.isFinite(value))) {
    return { ...finding, page_number: region.pageNumber };
  }
  const [x, y, width, height] = raw as number[];
  const bbox: [number, number, number, number] = [
    Math.max(0, Math.min(1, rx + x * rw)),
    Math.max(0, Math.min(1, ry + y * rh)),
    Math.max(0, Math.min(1, width * rw)),
    Math.max(0, Math.min(1, height * rh)),
  ];
  return {
    ...finding,
    page_number: region.pageNumber,
    geometry: { ...finding.geometry, bbox, coordinate_space: 'normalized' },
  };
}

function bboxOf(finding: PlanReadingFinding): [number, number, number, number] | null {
  const raw = finding.geometry?.bbox;
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every(value => typeof value === 'number' && Number.isFinite(value))) return null;
  return raw as [number, number, number, number];
}

function intersectionOverUnion(a: [number, number, number, number], b: [number, number, number, number]): number {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const left = Math.max(ax, bx);
  const top = Math.max(ay, by);
  const right = Math.min(ax + aw, bx + bw);
  const bottom = Math.min(ay + ah, by + bh);
  if (right <= left || bottom <= top) return 0;
  const intersection = (right - left) * (bottom - top);
  const union = aw * ah + bw * bh - intersection;
  return union > 0 ? intersection / union : 0;
}

function normalizedLabel(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function sameFinding(a: PlanReadingFinding, b: PlanReadingFinding): boolean {
  if (a.page_number !== b.page_number || a.finding_type !== b.finding_type) return false;
  const boxA = bboxOf(a);
  const boxB = bboxOf(b);
  if (boxA && boxB && intersectionOverUnion(boxA, boxB) >= 0.68) return true;
  const sameLabel = normalizedLabel(a.label) === normalizedLabel(b.label);
  if (!sameLabel) return false;
  if (boxA && boxB) {
    const centerA = [boxA[0] + boxA[2] / 2, boxA[1] + boxA[3] / 2];
    const centerB = [boxB[0] + boxB[2] / 2, boxB[1] + boxB[3] / 2];
    return Math.hypot(centerA[0] - centerB[0], centerA[1] - centerB[1]) <= 0.035;
  }
  return Boolean(a.source_excerpt && b.source_excerpt && a.source_excerpt === b.source_excerpt);
}

function evidenceScore(finding: PlanReadingFinding): number {
  return finding.confidence
    + (bboxOf(finding) ? 0.1 : 0)
    + (finding.source_excerpt ? 0.05 : 0)
    + (finding.value_text ? 0.02 : 0);
}

/** Conservatively removes only obvious overlap duplicates. Unique crop evidence is kept. */
export function mergeRegionFindings(
  base: readonly PlanReadingFinding[],
  supplemental: readonly PlanReadingFinding[],
): PlanReadingFinding[] {
  const merged = [...base];
  for (const candidate of supplemental) {
    const index = merged.findIndex(existing => sameFinding(existing, candidate));
    if (index < 0) {
      merged.push(candidate);
      continue;
    }
    if (evidenceScore(candidate) > evidenceScore(merged[index]!)) merged[index] = candidate;
  }
  return merged.sort((a, b) =>
    (a.page_number ?? Number.MAX_SAFE_INTEGER) - (b.page_number ?? Number.MAX_SAFE_INTEGER)
    || a.finding_type.localeCompare(b.finding_type)
    || a.label.localeCompare(b.label));
}
