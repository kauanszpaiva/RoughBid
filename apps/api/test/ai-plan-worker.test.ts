import test from 'node:test';
import assert from 'node:assert/strict';
import { AiPlanReadingJobProcessor, type PlanReader, type WorkerObjectStorage } from '../src/ai-plan/worker.ts';
import type { PlanReadingResult } from '../src/ai-plan/openai.ts';

function makeQuery(result: unknown, onCall?: (method: string, args: unknown[]) => void) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'update', 'insert', 'maybeSingle']) {
    builder[method] = (...args: unknown[]) => { onCall?.(method, args); return builder; };
  }
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

class FakeDb {
  updates: Record<string, unknown>[] = [];
  inserted: Array<Record<string, unknown>> | null = null;
  private readonly jobRow: Record<string, unknown>;
  private readonly pageRows: Array<Record<string, unknown>>;

  constructor(jobRow: Record<string, unknown>, pageRows: Array<Record<string, unknown>>) {
    this.jobRow = jobRow;
    this.pageRows = pageRows;
  }

  from(table: string) {
    if (table === 'plan_reading_jobs') {
      return makeQuery({ data: this.jobRow, error: null }, (method, args) => {
        if (method === 'update') this.updates.push(args[0] as Record<string, unknown>);
      });
    }
    if (table === 'project_file_pages') {
      return makeQuery({ data: this.pageRows, error: null });
    }
    if (table === 'plan_reading_findings') {
      return makeQuery({ error: null }, (method, args) => {
        if (method === 'insert') this.inserted = args[0] as Array<Record<string, unknown>>;
      });
    }
    throw new Error(`unexpected table ${table}`);
  }
}

class FakeStorage implements WorkerObjectStorage {
  async presign(_method: 'GET', key: string) { return { url: `https://signed.example/${key}` }; }
}

class FakeReader implements PlanReader {
  calls: Array<{ pages: unknown; scope: string | null | undefined }> = [];
  private readonly result: PlanReadingResult;
  constructor(result: PlanReadingResult) { this.result = result; }
  async read(pages: Parameters<PlanReader['read']>[0], scope?: string | null) {
    this.calls.push({ pages, scope });
    return this.result;
  }
}

const job = { jobId: 'job-1', workspaceId: 'workspace-1', projectId: 'project-1', fileId: 'file-1' };

test('reads plan pages, prices materials and labor, and persists reviewable findings', async () => {
  const jobRow = { id: 'job-1', input_summary: { requested_scope: 'Deck rebuild' } };
  const pageRows = [
    { page_number: 1, storage_path: 'workspace-1/project-1/file-1/pages/0001.jpg' },
    { page_number: 2, storage_path: 'workspace-1/project-1/file-1/pages/0002.jpg' },
  ];
  const db = new FakeDb(jobRow, pageRows);
  const reader = new FakeReader({
    summary: { sheet_count: 2, detected_trade_scope: ['carpentry'], scale_status: 'detected', human_review_required: true },
    findings: [
      { page_number: 1, finding_type: 'material', label: 'Exterior Composite Decking Boards', value_text: null, quantity: 450, unit: 'SF', confidence: 0.9, geometry: {}, source_excerpt: 'Sheet A1' },
      { page_number: 1, finding_type: 'labor', label: 'Deck framing labor', value_text: null, quantity: 1, unit: 'LS', confidence: 0.8, geometry: {}, source_excerpt: 'Sheet A1' },
      { page_number: 2, finding_type: 'question', label: 'Unclear scale on sheet A2', value_text: null, quantity: null, unit: null, confidence: 0.4, geometry: {}, source_excerpt: 'Sheet A2' },
    ],
  });
  const processor = new AiPlanReadingJobProcessor(db, new FakeStorage(), reader);

  const outcome = await processor.process(job);

  assert.equal(outcome.findings, 3);
  assert.equal(reader.calls.length, 1);
  assert.equal(reader.calls[0]?.scope, 'Deck rebuild');
  assert.equal((reader.calls[0]?.pages as unknown[]).length, 2);

  assert.equal(db.inserted?.length, 3);
  const [decking, framing, question] = db.inserted!;
  assert.equal((decking!.geometry as { pricing: unknown[] }).pricing.length, 2);
  assert.equal((framing!.geometry as { pricing: unknown[] }).pricing.length, 1);
  assert.equal((question!.geometry as Record<string, unknown>).pricing, undefined);

  assert.equal(db.updates.length, 2);
  assert.equal(db.updates[0]?.status, 'processing');
  const finalUpdate = db.updates[1] as { status: string; output_summary: { pricing: Record<string, number> } };
  assert.equal(finalUpdate.status, 'needs_review');
  assert.equal(finalUpdate.output_summary.pricing.materialCost, 3262.5);
  assert.equal(finalUpdate.output_summary.pricing.laborCost, 2029.25);
  assert.equal(finalUpdate.output_summary.pricing.pricedFindings, 2);
  // The "question" finding isn't a material/labor finding at all, so it's
  // never counted as unpriced — only material/labor findings that couldn't
  // be priced are.
  assert.equal(finalUpdate.output_summary.pricing.unpricedFindings, 0);
});

test('marks the job failed and rethrows when the model call fails, without storing partial findings', async () => {
  const jobRow = { id: 'job-1', input_summary: {} };
  const pageRows = [{ page_number: 1, storage_path: 'workspace-1/project-1/file-1/pages/0001.jpg' }];
  const db = new FakeDb(jobRow, pageRows);
  const processor = new AiPlanReadingJobProcessor(db, new FakeStorage(), {
    read: async () => { throw new Error('OpenAI plan reading failed (500)'); },
  });

  await assert.rejects(processor.process(job), /OpenAI plan reading failed/);
  const lastUpdate = db.updates.at(-1) as { status: string; processing_error: string };
  assert.equal(lastUpdate.status, 'failed');
  assert.equal(lastUpdate.processing_error, 'OpenAI plan reading failed (500)');
  assert.equal(db.inserted, null);
});
