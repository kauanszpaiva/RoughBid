import type { PlanPageImage } from './gemini.ts';
import type { AiPlanObjectStorage } from './service.ts';

/**
 * Rendered page images of the drawing itself.
 *
 * RoughBid's own Poppler document worker already writes private
 * `project_file_pages` JPEGs (2000px wide) for the in-app blueprint viewer.
 * Image-native plan readers (DeepSeek, Kimi, and any future vision provider)
 * cannot read a construction PDF, so they need those same private page images
 * instead of a public image URL.
 *
 * This loader is deliberately bounded and best-effort: it never fails a
 * reading, never touches another tenant's objects, and never returns an image
 * large or numerous enough to become an unbounded provider cost.
 */

export const PLAN_PAGE_IMAGE_DEFAULT_MAX_PAGES = 8;
export const PLAN_PAGE_IMAGE_MAX_PAGES = 16;
export const PLAN_PAGE_IMAGE_MAX_PAGE_BYTES = 12 * 1024 * 1024;
export const PLAN_PAGE_IMAGE_MAX_TOTAL_BYTES = 24 * 1024 * 1024;

/** `project_file_pages.mime_type` is constrained to image/jpeg, but the reader
 *  interface also accepts png/webp so a future renderer needs no rewrite. */
const ALLOWED_PAGE_MIME_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface PlanPageImageRow {
  page_number?: unknown;
  mime_type?: unknown;
  storage_path?: unknown;
  byte_size?: unknown;
}

export interface PlanPageImageDb {
  from(table: string): {
    select(columns: string): any;
  };
}

export interface PlanPageImageLoaderOptions {
  db: PlanPageImageDb;
  storage: AiPlanObjectStorage;
  workspaceId: string;
  projectId: string;
  fileId: string;
  /** Limit the lookup to specific physical pages (page-by-page review). */
  pageNumbers?: readonly number[];
  fetcher?: typeof fetch;
  maxPages?: number;
  maxTotalBytes?: number;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max ? (value as number) : fallback;
}

/** Storage key convention written by the Poppler document worker. */
export function isPlanPageImageKey(key: string, workspaceId: string, projectId: string, fileId: string): boolean {
  return typeof key === 'string'
    && key.startsWith(`${workspaceId}/${projectId}/${fileId}/pages/`)
    && /\.(?:jpe?g|png|webp)$/i.test(key);
}

async function loadPlanPageImages(options: PlanPageImageLoaderOptions): Promise<readonly PlanPageImage[]> {
  const maxPages = boundedInteger(options.maxPages, PLAN_PAGE_IMAGE_DEFAULT_MAX_PAGES, 1, PLAN_PAGE_IMAGE_MAX_PAGES);
  const maxTotalBytes = boundedInteger(options.maxTotalBytes, PLAN_PAGE_IMAGE_MAX_TOTAL_BYTES, 1, PLAN_PAGE_IMAGE_MAX_TOTAL_BYTES);
  const fetcher = options.fetcher ?? fetch;

  let query = options.db.from('project_file_pages')
    .select('page_number,mime_type,storage_path,byte_size')
    .eq('file_id', options.fileId);
  if (options.pageNumbers?.length) query = query.in('page_number', [...options.pageNumbers]);
  const response = await query.order('page_number', { ascending: true }).limit(maxPages);
  if (response?.error || !Array.isArray(response?.data)) return [];

  const images: PlanPageImage[] = [];
  let totalBytes = 0;
  for (const raw of response.data as PlanPageImageRow[]) {
    const pageNumber = Number(raw.page_number);
    const storagePath = typeof raw.storage_path === 'string' ? raw.storage_path : '';
    const mimeType = typeof raw.mime_type === 'string' ? raw.mime_type : '';
    const byteSize = Number(raw.byte_size);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) continue;
    // Tenant boundary: only this workspace/project/file's rendered pages.
    if (!isPlanPageImageKey(storagePath, options.workspaceId, options.projectId, options.fileId)) continue;
    if (!ALLOWED_PAGE_MIME_TYPES.has(mimeType)) continue;
    if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > PLAN_PAGE_IMAGE_MAX_PAGE_BYTES) continue;
    if (totalBytes + byteSize > maxTotalBytes) break;
    const signed = await options.storage.presign('GET', storagePath, { expiresIn: 300 });
    const download = await fetcher(signed.url);
    if (!download.ok) continue;
    const bytes = new Uint8Array(await download.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > PLAN_PAGE_IMAGE_MAX_PAGE_BYTES) continue;
    totalBytes += bytes.byteLength;
    images.push({ pageNumber, bytes, mimeType: mimeType as PlanPageImage['mimeType'] });
  }
  return images;
}

/**
 * Returns a memoized lazy loader. It is only invoked by a provider that
 * actually needs raster pages, so the PDF-native path never pays for a page
 * render it will not use. Any failure resolves to an empty list: the provider
 * then fails closed on its own instead of the whole reading crashing.
 */
export function createPlanPageImageLoader(options: PlanPageImageLoaderOptions): () => Promise<readonly PlanPageImage[]> {
  let pending: Promise<readonly PlanPageImage[]> | null = null;
  return () => {
    pending ??= loadPlanPageImages(options).catch(() => [] as readonly PlanPageImage[]);
    return pending;
  };
}
