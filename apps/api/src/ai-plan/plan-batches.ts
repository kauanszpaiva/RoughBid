/**
 * Page-window planning for a whole-set reading.
 *
 * A 60-sheet construction set cannot be read honestly in one provider request:
 * the model skims it, the output limit truncates the last third, and nothing
 * tells the estimator which sheets were actually examined. This module turns a
 * set into ordered windows of physical pages so a reader can work through the
 * whole set — one metered request per window — and still report exactly which
 * pages produced evidence.
 *
 * Two boundaries are deliberate:
 *  - `maxBatches` caps fan-out. A capped sweep reads the leading windows and
 *    the caller is told, in summary.limitations, which pages were never read.
 *  - `slicePdfPages` copies only the window's pages, so each request carries
 *    just its own sheets and the provider returns local page numbers (1..n)
 *    that the caller restores to physical numbering.
 */
import { PDFDocument } from 'pdf-lib';

export interface PageWindow {
  /** First physical page in the window (1-based, inclusive). */
  from: number;
  /** Last physical page in the window (1-based, inclusive). */
  to: number;
}

export const DEFAULT_BATCH_PAGES = 8;
export const MAX_BATCH_PAGES = 50;
export const DEFAULT_MAX_BATCHES = 25;
export const MAX_MAX_BATCHES = 60;

const boundedInteger = (value: number | undefined, fallback: number, ceiling: number): number =>
  Number.isSafeInteger(value) && (value as number) > 0 ? Math.min(value as number, ceiling) : fallback;

export function boundedBatchPages(value: number | undefined): number {
  return boundedInteger(value, DEFAULT_BATCH_PAGES, MAX_BATCH_PAGES);
}

export function boundedMaxBatches(value: number | undefined): number {
  return boundedInteger(value, DEFAULT_MAX_BATCHES, MAX_MAX_BATCHES);
}

export function integerFromEnv(value: string | undefined, fallback: number, ceiling: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, ceiling) : fallback;
}

/**
 * Ordered windows over a set. Returns one window when the set already fits a
 * single request, so the caller can treat "one batch" as the plain path.
 */
export function planPageWindows(pageCount: number, batchPages: number, maxBatches: number): PageWindow[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) return [];
  const size = boundedBatchPages(batchPages);
  const cap = boundedMaxBatches(maxBatches);
  const windows: PageWindow[] = [];
  for (let from = 1; from <= pageCount && windows.length < cap; from += size) {
    windows.push({ from, to: Math.min(from + size - 1, pageCount) });
  }
  return windows;
}

/** The pages no window covers, because the batch cap was reached. */
export function unreadPages(pageCount: number, windows: readonly PageWindow[]): number[] {
  if (!windows.length) return [];
  const last = windows[windows.length - 1]!.to;
  return last >= pageCount ? [] : Array.from({ length: pageCount - last }, (_, index) => last + index + 1);
}

/**
 * Loads the set once so a sweep can slice many windows from it. Re-parsing the
 * whole file for every window would multiply the cost of a large set by its
 * window count.
 */
export async function loadPlanDocument(fileBytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(fileBytes.slice(), { ignoreEncryption: true, updateMetadata: false });
}

/** Copies one window's physical pages out of an already-loaded set. */
export async function slicePlanDocument(source: PDFDocument, window: PageWindow): Promise<Uint8Array> {
  const total = source.getPageCount();
  const first = Math.max(1, window.from);
  const last = Math.min(window.to, total);
  if (first > last) throw new Error('The requested page window is outside the plan.');
  const target = await PDFDocument.create();
  const indices = Array.from({ length: last - first + 1 }, (_, index) => first - 1 + index);
  const pages = await target.copyPages(source, indices);
  for (const page of pages) target.addPage(page);
  return target.save();
}

/** Convenience wrapper for a one-off window (used by tests and small callers). */
export async function slicePdfPages(fileBytes: Uint8Array, window: PageWindow): Promise<Uint8Array> {
  return slicePlanDocument(await loadPlanDocument(fileBytes), window);
}

export async function countPdfPages(fileBytes: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(fileBytes.slice(), { ignoreEncryption: true, updateMetadata: false });
  return document.getPageCount();
}