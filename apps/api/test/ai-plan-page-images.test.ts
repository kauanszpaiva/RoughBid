import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_PAGE_IMAGES,
  MAX_PAGE_IMAGES,
  MAX_PAGE_IMAGE_BYTES,
  loadPlanPageImages,
} from '../src/ai-plan/page-images.ts';

/**
 * `pageImages` was declared on the reader input and consumed by
 * OpenAiCompatibleVisionPlanReader, but nothing ever populated it, so DeepSeek
 * and Kimi always failed closed with "requires server-rendered plan page
 * images. No provider request was sent." These tests pin the loader that
 * finally reads the assets the document worker already writes.
 *
 * Equally important: rendering is optional. Every failure mode here must
 * degrade to the existing PDF path, never fail a paid reading.
 */

const FILE_ID = 'file-1';
const assetPath = (page: number) => `ws-1/proj-1/${FILE_ID}/pages/${String(page).padStart(4, '0')}.jpg`;

function fakeDb(rows: Record<string, unknown>[], error: { message: string } | null = null) {
  const seen = { limit: 0, filters: {} as Record<string, unknown> };
  let pageScope: number[] | null = null;
  const builder: any = {
    select: () => builder,
    eq: (column: string, value: unknown) => { seen.filters[column] = value; return builder; },
    in: (column: string, values: unknown) => {
      seen.filters[column] = values;
      if (column === 'page_number' && Array.isArray(values)) pageScope = values as number[];
      return builder;
    },
    order: () => builder,
    limit: (count: number) => {
      seen.limit = count;
      if (error) return Promise.resolve({ data: null, error });
      const scoped = pageScope ? rows.filter(row => pageScope!.includes(row.page_number as number)) : rows;
      return Promise.resolve({ data: scoped.slice(0, count), error: null });
    },
  };
  return { db: { from: (table: string) => { seen.filters.table = table; return builder; } }, seen };
}

const storage = { presign: (_method: string, key: string) => ({ url: `https://objects.test/${key}` }) };

const bytesFetcher = (size = 3, ok = true) => async () =>
  ({ ok, arrayBuffer: async () => new Uint8Array(size).fill(7).buffer }) as unknown as Response;

const rows = (pages: number[]) => pages.map(page => ({
  page_number: page, storage_path: assetPath(page), mime_type: 'image/jpeg',
}));

test('loads the rendered pages the document worker already wrote', async () => {
  const { db, seen } = fakeDb(rows([1, 2, 3]));
  const images = await loadPlanPageImages({ db, storage, fetcher: bytesFetcher(), fileId: FILE_ID });

  assert.equal(images.length, 3);
  assert.deepEqual(images.map(image => image.pageNumber), [1, 2, 3]);
  assert.equal(images[0]!.mimeType, 'image/jpeg');
  assert.ok(images[0]!.bytes.byteLength > 0, 'the actual page bytes must travel, not just the row');
  assert.equal(seen.filters.table, 'project_file_pages');
  assert.equal(seen.filters.file_id, FILE_ID, 'reads stay scoped to this file');
});

test('an unrendered plan degrades to the PDF path instead of failing the reading', async () => {
  const { db } = fakeDb([]);
  assert.deepEqual(await loadPlanPageImages({ db, storage, fetcher: bytesFetcher(), fileId: FILE_ID }), []);
});

test('a database error degrades instead of throwing', async () => {
  const { db } = fakeDb([], { message: 'relation does not exist' });
  assert.deepEqual(await loadPlanPageImages({ db, storage, fetcher: bytesFetcher(), fileId: FILE_ID }), []);
});

test('a storage failure degrades instead of throwing', async () => {
  const { db } = fakeDb(rows([1]));
  const images = await loadPlanPageImages({ db, storage, fetcher: bytesFetcher(3, false), fileId: FILE_ID });
  assert.deepEqual(images, []);
});

test('a page asset pointing outside this file is ignored', async () => {
  const { db } = fakeDb([
    { page_number: 1, storage_path: `ws-1/proj-1/other-file/pages/0001.jpg`, mime_type: 'image/jpeg' },
    { page_number: 2, storage_path: `ws-1/proj-1/${FILE_ID}/pages/../../secrets.jpg`, mime_type: 'image/jpeg' },
    { page_number: 3, storage_path: assetPath(3), mime_type: 'image/jpeg' },
  ]);

  const images = await loadPlanPageImages({ db, storage, fetcher: bytesFetcher(), fileId: FILE_ID });
  assert.deepEqual(images.map(image => image.pageNumber), [3], 'only this file\'s own page folder is fetched');
});

test('a mime type the vision providers reject is skipped', async () => {
  const { db } = fakeDb([
    { page_number: 1, storage_path: assetPath(1), mime_type: 'application/pdf' },
    { page_number: 2, storage_path: assetPath(2), mime_type: 'image/png' },
  ]);

  const images = await loadPlanPageImages({ db, storage, fetcher: bytesFetcher(), fileId: FILE_ID });
  assert.deepEqual(images.map(image => image.mimeType), ['image/png']);
});

test('the requested physical page narrows the fetch for page-by-page review', async () => {
  const { db, seen } = fakeDb(rows([1, 2, 3]));
  const images = await loadPlanPageImages({
    db, storage, fetcher: bytesFetcher(), fileId: FILE_ID, pageNumbers: [3],
  });

  assert.deepEqual(seen.filters.page_number, [3]);
  assert.deepEqual(images.map(image => image.pageNumber), [3]);
});

test('the fetch is bounded by image count and total bytes', async () => {
  const { db, seen } = fakeDb(rows(Array.from({ length: 20 }, (_, index) => index + 1)));
  await loadPlanPageImages({ db, storage, fetcher: bytesFetcher(), fileId: FILE_ID });
  assert.equal(seen.limit, DEFAULT_MAX_PAGE_IMAGES);

  const oversized = fakeDb(rows([1, 2]));
  const budgeted = await loadPlanPageImages({
    db: oversized.db, storage, fetcher: bytesFetcher(1024), fileId: FILE_ID, maxTotalBytes: 1024,
  });
  assert.equal(budgeted.length, 1, 'the byte budget must stop unbounded growth');

  assert.ok(MAX_PAGE_IMAGES >= DEFAULT_MAX_PAGE_IMAGES);
  assert.ok(MAX_PAGE_IMAGE_BYTES > 0);
});
