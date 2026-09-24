import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizePlanGeometry,
  sanitizePlanReadingResult,
  TEXT_ONLY_READING_NOTICE,
} from '../src/ai-plan/types.ts';
import { assertReaderInspectsDrawing } from '../src/ai-plan/readiness.ts';
import { MultiProviderPlanReader } from '../src/ai-plan/multi-provider.ts';
import { OpenAiCompatibleVisionPlanReader } from '../src/ai-plan/openai-vision.ts';
import { GeminiPlanReader } from '../src/ai-plan/gemini.ts';
import { createPlanPageImageLoader, isPlanPageImageKey } from '../src/ai-plan/plan-page-images.ts';
import { AiPlanReadingService } from '../src/ai-plan/service.ts';
import { ProjectApiError } from '../src/projects/service.ts';

const noEnv: Record<string, string | undefined> = {};

// ---------------------------------------------------------------------------
// The reading covers the drawing, not only its text
// ---------------------------------------------------------------------------

test('graphic drawing evidence is kept and provider money inside geometry is still stripped', () => {
  const geometry = sanitizePlanGeometry({
    bbox: [0.1, 0.2, 0.3, 0.2],
    point: [0.2, 0.3],
    room: 'Kitchen',
    element: 'door',
    legend_mark: 'D1',
    sheet_reference: 'A-101',
    visual: { kind: 'symbol', description: 'Door swing arc at the kitchen entry', legend_mark: 'D1', confidence: 0.7 },
    pricing: [{ cost: 999 }],
  });
  assert.deepEqual(geometry, {
    bbox: [0.1, 0.2, 0.3, 0.2],
    point: [0.2, 0.3],
    coordinate_space: 'normalized',
    room: 'Kitchen',
    element: 'door',
    legend_mark: 'D1',
    sheet_reference: 'A-101',
    visual: { kind: 'symbol', description: 'Door swing arc at the kitchen entry', confidence: 0.7, legend_mark: 'D1' },
  });
  assert.equal((geometry as Record<string, unknown>).pricing, undefined);
});

test('an unknown graphic-evidence kind is dropped instead of stored', () => {
  assert.deepEqual(sanitizePlanGeometry({ point: [1.4, 0.2] }), {});
  assert.deepEqual(sanitizePlanGeometry({ visual: { kind: 'not_a_real_kind', description: 'x', confidence: 0.9 } }), {});
  assert.deepEqual(sanitizePlanGeometry({ visual: { kind: 'icon', description: '   ' } }), {});
});

test('a located icon keeps its page and position without becoming a quantity', () => {
  const result = sanitizePlanReadingResult({
    summary: { sheet_count: 1 },
    findings: [{
      page_number: 1, finding_type: 'symbol', label: 'Recessed downlight (ceiling icon)',
      quantity: null, unit: null, confidence: 0.6, source_excerpt: null,
      geometry: {
        bbox: [0.4, 0.4, 0.05, 0.05],
        visual: { kind: 'icon', description: 'Circular fixture icon repeated across the ceiling plan', confidence: 0.6 },
      },
    }],
  });
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0]?.geometry.bbox, [0.4, 0.4, 0.05, 0.05]);
  assert.equal(result.findings[0]?.quantity, null);
  assert.equal(result.summary.visual_evidence_count, 1);
  assert.ok((result.summary.limitations as string[]).some(text => /graphic drawing evidence/i.test(text)));
});

test('an icon count without printed evidence is dropped, never trusted as a quantity', () => {
  const result = sanitizePlanReadingResult({
    summary: { sheet_count: 1 },
    findings: [{
      page_number: 1, finding_type: 'measurement', label: 'Downlights', quantity: 14, unit: 'EA',
      confidence: 0.6, source_excerpt: null,
      geometry: { bbox: [0.4, 0.4, 0.05, 0.05], visual: { kind: 'icon', description: 'repeated fixture icons', confidence: 0.6 } },
    }],
  });
  assert.equal(result.findings.length, 0);
  assert.ok((result.summary.limitations as string[]).some(text => /dropped/i.test(text)));
});

test('a location without a page is still never displayed as a mapped area', () => {
  const result = sanitizePlanReadingResult({
    summary: { sheet_count: 2 },
    findings: [{
      finding_type: 'symbol', label: 'Unplaced icon', quantity: null, unit: null,
      geometry: { bbox: [0, 0, 1, 1], visual: { kind: 'icon', description: 'icon', confidence: 0.5 } },
    }],
  });
  assert.deepEqual(result.findings[0]?.geometry, {});
});

// ---------------------------------------------------------------------------
// The API discloses how the plan was read
// ---------------------------------------------------------------------------

test('the reading mode is assigned by the server and cannot be spoofed by model output', () => {
  const result = sanitizePlanReadingResult({
    summary: { sheet_count: 1, reading_mode: 'visual_pdf' },
    findings: [{ page_number: 1, finding_type: 'room', label: 'Kitchen', source_excerpt: 'KITCHEN' }],
  }, [], false, 'text_only');
  assert.equal(result.summary.reading_mode, 'text_only');
  assert.ok((result.summary.limitations as string[]).includes(TEXT_ONLY_READING_NOTICE));
});

test('the PDF-native reader reports that the drawing itself was inspected', async () => {
  const reader = new GeminiPlanReader({
    generateContent: async () => ({
      text: JSON.stringify({
        summary: { sheet_count: 1, detected_trade_scope: ['Framing'], scale_status: 'detected' },
        findings: [{ page_number: 1, finding_type: 'room', label: 'Kitchen', source_excerpt: 'KITCHEN' }],
      }),
    }),
  }, ['gemini-3.8-flash']);
  const result = await reader.read({
    fileBytes: new Uint8Array([37, 80, 68, 70]), mimeType: 'application/pdf',
    sheetName: 'A-101', requestedTrades: ['Framing'], scope: null,
  });
  assert.equal(result.summary.reading_mode, 'visual_pdf');
});

test('an image-native reader resolves rendered plan pages lazily and reports its mode', async () => {
  let lazyLoads = 0;
  const bodies: string[] = [];
  const reader = new OpenAiCompatibleVisionPlanReader({
    provider: 'deepseek', apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', maxImages: 4,
  }, async (_url, init) => {
    bodies.push(String(init?.body ?? ''));
    return Response.json({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            summary: { sheet_count: 1, detected_trade_scope: ['Electrical'], scale_status: 'detected' },
            findings: [{
              page_number: 1, finding_type: 'symbol', label: 'Ceiling fixture icon',
              quantity: null, unit: null, confidence: 0.6, source_excerpt: null,
              geometry: { point: [0.5, 0.5], visual: { kind: 'icon', description: 'Recessed fixture icon on the ceiling plan', confidence: 0.6 } },
            }],
          }),
        },
      }],
    });
  });
  const base = {
    fileBytes: new Uint8Array([37, 80, 68, 70]), mimeType: 'application/pdf',
    sheetName: 'E101', requestedTrades: ['Electrical'], scope: null,
  };
  const result = await reader.read({
    ...base,
    pageImageLoader: async () => {
      lazyLoads += 1;
      return [{ pageNumber: 1, bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' as const }];
    },
  });
  assert.equal(lazyLoads, 1);
  assert.equal(result.summary.reading_mode, 'visual_page_images');
  assert.match(bodies[0]!, /data:image\/jpeg;base64/);

  // Already-supplied images must never trigger a redundant render.
  await reader.read({
    ...base,
    pageImages: [{ pageNumber: 1, bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' as const }],
    pageImageLoader: async () => { lazyLoads += 1; return []; },
  });
  assert.equal(lazyLoads, 1);
});

test('a reader that cannot inspect the drawing is refused before any spend', () => {
  const textOnly = { visualCapability: 'text_only' as const };
  assert.throws(() => assertReaderInspectsDrawing(textOnly, noEnv), (error: unknown) => error instanceof ProjectApiError && error.status === 503);
  assert.doesNotThrow(() => assertReaderInspectsDrawing(textOnly, { AI_PLAN_ALLOW_TEXT_ONLY_READING: 'true' }));
  assert.doesNotThrow(() => assertReaderInspectsDrawing({ visualCapability: 'pdf_native' as const }, noEnv));
  assert.doesNotThrow(() => assertReaderInspectsDrawing({ visualCapability: 'page_images' as const }, noEnv));
  assert.doesNotThrow(() => assertReaderInspectsDrawing(undefined, noEnv));
});

test('the provider chain drops text-only readers and refuses a text-only-only chain', () => {
  const realResult = async () => ({
    summary: { sheet_count: 1, detected_trade_scope: [], scale_status: 'detected' as const, human_review_required: true as const, limitations: [] },
    findings: [{
      page_number: 1, finding_type: 'risk' as const, label: 'Unreadable dimension', value_text: null,
      quantity: null, unit: null, confidence: 0.5, geometry: {}, source_excerpt: null,
    }],
  });
  let textReaderRan = false;
  const chain = new MultiProviderPlanReader([
    { name: 'openrouter/free', visualCapability: 'text_only', read: async () => { textReaderRan = true; return realResult(); } },
    { name: 'gemini', visualCapability: 'pdf_native', read: async () => realResult() },
  ], noEnv);
  assert.equal(chain.visualCapability, 'pdf_native');
  assert.throws(() => new MultiProviderPlanReader([{ name: 'openrouter/free', visualCapability: 'text_only', read: realResult }], noEnv), /extracts PDF text only/i);
  assert.equal(textReaderRan, false);
});

// ---------------------------------------------------------------------------
// Rendered page images stay private, bounded and tenant-scoped
// ---------------------------------------------------------------------------

function pageQuery(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'order', 'limit']) builder[method] = () => builder;
  (builder as { then?: unknown }).then = (onFulfilled: (value: unknown) => unknown, onRejected: (value: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
  return builder;
}

test('rendered plan pages are only read from this tenant file and within bounds', async () => {
  assert.equal(isPlanPageImageKey('w/p/f/pages/0001.jpg', 'w', 'p', 'f'), true);
  assert.equal(isPlanPageImageKey('other/p/f/pages/0001.jpg', 'w', 'p', 'f'), false);
  assert.equal(isPlanPageImageKey('w/p/f/pages/0001.jpg', 'w', 'p', 'other-file'), false);

  const fetched: string[] = [];
  const storage = { presign: (method: string, key: string) => ({ url: `https://signed.test/${method}/${key}` }) };
  const loader = createPlanPageImageLoader({
    db: {
      from: () => ({
        select: () => pageQuery([
          { page_number: 1, mime_type: 'image/jpeg', storage_path: 'w/p/f/pages/0001.jpg', byte_size: 3 },
          { page_number: 2, mime_type: 'image/jpeg', storage_path: 'w/other/f/pages/0002.jpg', byte_size: 3 },
          { page_number: 3, mime_type: 'image/jpeg', storage_path: 'w/p/f/pages/0003.jpg', byte_size: 99 * 1024 * 1024 },
        ]),
      }),
    } as never,
    storage: storage as never,
    workspaceId: 'w', projectId: 'p', fileId: 'f',
    fetcher: (async (url: string) => { fetched.push(String(url)); return new Response(new Uint8Array([1, 2, 3])); }) as never,
  });

  const images = await loader();
  assert.equal(images.length, 1);
  assert.equal(images[0]?.pageNumber, 1);
  assert.equal(fetched.length, 1);
  assert.match(fetched[0]!, /w\/p\/f\/pages\/0001\.jpg$/);

  // Memoized: a second provider attempt in the same request reuses the result.
  await loader();
  assert.equal(fetched.length, 1);

  const failing = createPlanPageImageLoader({
    db: { from: () => ({ select: () => { throw new Error('storage unavailable'); } }) } as never,
    storage: storage as never,
    workspaceId: 'w', projectId: 'p', fileId: 'f',
  });
  assert.deepEqual(await failing(), []);
});

// ---------------------------------------------------------------------------
// Service boundary
// ---------------------------------------------------------------------------

function makeQuery(resolve: () => { data?: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'gte', 'order', 'insert', 'update', 'maybeSingle', 'single']) builder[method] = () => builder;
  builder.then = (onFulfilled: (value: unknown) => unknown, onRejected: (value: unknown) => unknown) =>
    Promise.resolve(resolve()).then(onFulfilled, onRejected);
  return builder;
}

function baseResolver() {
  return (table: string): { data?: unknown; error?: unknown } => {
    if (table === 'workspaces') return { data: { ai_processing_consented_at: '2026-09-01T00:00:00Z' }, error: null };
    if (table === 'projects') return { data: { id: 'project-1', address_text: null }, error: null };
    if (table === 'project_files') {
      return { data: { id: 'file-1', original_name: 'plan.pdf', storage_path: 'workspace-1/project-1/file-1/source.pdf', processing_status: 'ready' }, error: null };
    }
    if (table === 'plan_reading_jobs') return { data: [], error: null };
    throw new Error(`unexpected table ${table}`);
  };
}

function fakeDb() {
  const resolve = baseResolver();
  return {
    from: (table: string) => makeQuery(() => resolve(table)) as never,
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
  };
}

test('a text-only reader cannot reserve a paid reading', async () => {
  let reserved = false;
  const writer = { from: () => ({}), rpc: async () => { reserved = true; throw new Error('no reservation expected'); } };
  const reader = { visualCapability: 'text_only' as const, read: async () => { throw new Error('no provider call expected'); } };
  const service = new AiPlanReadingService(
    fakeDb() as never, writer, { presign: async () => ({ url: 'https://signed.test/source.pdf' }) },
    reader, 'user-1', 'workspace-1', (async () => new Response(new Uint8Array([1, 2, 3]))) as never,
  );
  await assert.rejects(
    service.create('project-1', { file_id: 'file-1', quote_id: 'quote-1' }),
    (error: unknown) => error instanceof ProjectApiError && error.status === 503,
  );
  assert.equal(reserved, false);
});
