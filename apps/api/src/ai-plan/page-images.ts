/**
 * Loads the Poppler-rendered page images the document worker already writes.
 *
 * `apps/api/src/documents/worker.ts` renders every physical page to JPEG and
 * upserts it into `project_file_pages`. Until now nothing ever read that table:
 * `pageImages` was declared on `GeminiPlanReadInput` and consumed by
 * `OpenAiCompatibleVisionPlanReader`, but no code path ever populated it, so
 * every image-native provider failed closed before a network request with
 * "requires server-rendered plan page images". This module is the missing wire.
 *
 * Reading is deliberately best-effort. A missing, unrendered or oversized page
 * asset must never fail a paid reading: the caller falls back to the existing
 * PDF path, which Gemini reads directly.
 *
 * The caller passes its own tenant-scoped client. `project_file_pages` has a
 * SELECT policy for `authenticated` scoped through the owning project
 * (`0004_document_processing.sql`), so no service-role connection is needed and
 * the tenant boundary stays exactly where it already is.
 */

export interface PageImageSource {
  from(table: string): any;
}

export interface PageImageStorage {
  presign(method: 'GET', key: string, options?: { expiresIn?: number }): { url: string } | Promise<{ url: string }>;
}

export interface LoadedPageImage {
  pageNumber: number;
  bytes: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

const ACCEPTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Matches `LOW_COST_VISION_MAX_PAGES` bounds so one reading cannot fan out unbounded. */
export const MAX_PAGE_IMAGES = 16;
export const DEFAULT_MAX_PAGE_IMAGES = 8;
/** Provider-side per-image ceiling, mirrored from openai-vision.ts. */
export const MAX_PAGE_IMAGE_BYTES = 12 * 1024 * 1024;
/** Total budget for one reading's page images, so one request cannot fetch a whole plan set twice. */
export const MAX_PAGE_IMAGE_TOTAL_BYTES = 32 * 1024 * 1024;

function boundedMax(value: number | undefined, fallback: number, ceiling: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? Math.min(value as number, ceiling) : fallback;
}

/**
 * A page asset row must point inside this file's own page folder. The row came
 * from a tenant-scoped query, so this only rejects a malformed or tampered path
 * rather than acting as the tenant check.
 */
function isPageAssetPath(key: unknown, fileId: string): key is string {
  return typeof key === 'string'
    && key.includes(`/${fileId}/pages/`)
    && !key.includes('..')
    && /\.(?:jpe?g|png|webp)$/i.test(key);
}

function storageKeyFrom(row: Record<string, unknown>): string | null {
  const value = row.storage_path ?? row.storagePath ?? row.key;
  return typeof value === 'string' ? value : null;
}

export async function loadPlanPageImages(options: {
  db: PageImageSource;
  storage: PageImageStorage;
  fileId: string;
  /** Only these physical pages are wanted. Omit to take the first `maxImages` rendered pages. */
  pageNumbers?: readonly number[];
  maxImages?: number;
  maxTotalBytes?: number;
  fetcher?: typeof fetch;
}): Promise<LoadedPageImage[]> {
  const fetcher = options.fetcher ?? fetch;
  const maxImages = boundedMax(options.maxImages, DEFAULT_MAX_PAGE_IMAGES, MAX_PAGE_IMAGES);
  const maxTotalBytes = boundedMax(options.maxTotalBytes, MAX_PAGE_IMAGE_TOTAL_BYTES, MAX_PAGE_IMAGE_TOTAL_BYTES);
  const wanted = options.pageNumbers?.filter(page => Number.isSafeInteger(page) && page > 0);

  try {
    let query = options.db
      .from('project_file_pages')
      .select('page_number, storage_path, mime_type')
      .eq('file_id', options.fileId);
    if (wanted?.length) query = query.in('page_number', wanted);
    const result = await query.order('page_number', { ascending: true }).limit(maxImages);
    if (result?.error || !Array.isArray(result?.data)) return [];

    const images: LoadedPageImage[] = [];
    let totalBytes = 0;

    for (const row of result.data as Record<string, unknown>[]) {
      const pageNumber = row?.page_number;
      const mimeType = typeof row?.mime_type === 'string' ? row.mime_type.toLowerCase() : '';
      const storageKey = storageKeyFrom(row ?? {});
      if (!Number.isSafeInteger(pageNumber) || (pageNumber as number) < 1) continue;
      // Re-assert the caller's page scope here rather than trusting the query
      // alone: page-by-page review must never attach a different physical page.
      if (wanted?.length && !wanted.includes(pageNumber as number)) continue;
      if (!ACCEPTED_MIME_TYPES.has(mimeType)) continue;
      if (!isPageAssetPath(storageKey, options.fileId)) continue;

      const presigned = await options.storage.presign('GET', storageKey, { expiresIn: 300 });
      const response = await fetcher(presigned.url);
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.byteLength || bytes.byteLength > MAX_PAGE_IMAGE_BYTES) continue;
      if (totalBytes + bytes.byteLength > maxTotalBytes) continue;

      totalBytes += bytes.byteLength;
      images.push({ pageNumber: pageNumber as number, bytes, mimeType: mimeType as LoadedPageImage['mimeType'] });
    }

    return images;
  } catch {
    // Rendering is optional: an absent worker, a cold table or a storage outage
    // must degrade to the PDF path rather than fail the reading.
    return [];
  }
}
