/**
 * Live end-to-end reading: the real service, the real OpenAI reader, a real PDF.
 *
 * Skipped unless OPENAI_API_KEY is present, so the normal suite stays offline
 * and free. When it does run it is the strongest available check short of
 * production: the whole service path (authorization, local evidence extraction,
 * the provider call, page-number restoration, the citation check against the
 * local transcript, and the saved output summary) against a real model.
 *
 *   OPENAI_API_KEY=... OPENAI_MODEL=gpt-4o-mini \
 *     node --experimental-strip-types --test apps/api/test/live-openai-plan-reading.test.ts
 *
 * It costs a fraction of a cent per run on a cheap model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { AiPlanReadingService } from '../src/ai-plan/service.ts';
import { PDF_DIGEST } from '../src/billing/project-preflight.ts';
import { OpenAiCompatibleVisionPlanReader, requireOpenAiVisionConfig } from '../src/ai-plan/openai-vision.ts';

const live = Boolean(process.env.OPENAI_API_KEY);

/** Three sheets: general notes, a floor plan with areas, and a schedule. */
async function samplePlan(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const notes = doc.addPage([612, 792]);
  notes.drawText('GENERAL NOTES', { x: 60, y: 720, size: 14, font });
  notes.drawText('1. PROVIDE 2x6 WOOD STUDS AT 16 INCH O.C. FOR ALL EXTERIOR WALLS.', { x: 60, y: 690, size: 9, font });
  notes.drawText('2. PROVIDE 24 LF OF KITCHEN BASE CABINET WITH 3/4 INCH PLYWOOD CASES.', { x: 60, y: 674, size: 9, font });
  notes.drawText('SHEET A-000 SCALE 1/4" = 1\'-0"', { x: 60, y: 60, size: 9, font });

  const plan = doc.addPage([612, 792]);
  plan.drawText('FIRST FLOOR PLAN', { x: 60, y: 720, size: 14, font });
  plan.drawRectangle({ x: 80, y: 240, width: 420, height: 400, borderWidth: 3 });
  plan.drawText('LIVING 320 SF', { x: 110, y: 560, size: 10, font });
  plan.drawText('KITCHEN 180 SF', { x: 330, y: 560, size: 10, font });
  plan.drawText('SHEET A-101 SCALE 1/4" = 1\'-0"', { x: 60, y: 60, size: 9, font });

  const schedule = doc.addPage([612, 792]);
  schedule.drawText('DOOR AND WINDOW SCHEDULE', { x: 60, y: 720, size: 14, font });
  schedule.drawText('D1 3\'-0" x 6\'-8" HOLLOW METAL DOOR 4 EA', { x: 60, y: 690, size: 9, font });
  schedule.drawText('W1 4\'-0" x 4\'-0" SLIDER WINDOW 6 EA', { x: 60, y: 674, size: 9, font });
  schedule.drawText('SHEET A-601 SCALE 1/4" = 1\'-0"', { x: 60, y: 60, size: 9, font });

  return doc.save();
}

test('a real OpenAI reading of a real plan set saves cited evidence for every sheet it read', { skip: live ? false : 'OPENAI_API_KEY is not set; the live reading is skipped.' }, async () => {
  const bytes = await samplePlan();

  const jobs: any[] = [];
  let next = 0;
  const reservations: any[] = [];
  function query(table: string, payload?: any) {
    const filters: any[] = []; let update: any; const q: any = {};
    for (const method of ['select', 'order', 'limit', 'in', 'eq']) if (method !== 'eq') q[method] = () => q;
    q.eq = (k: string, v: any) => { filters.push([k, v]); return q; };
    q.update = (v: any) => { update = v; return q; };
    q.upsert = async (v: any) => ({ data: v, error: null });
    // The usage meter inserts an event and settles it: both must report success.
    q.insert = async (v: any) => ({ data: v, error: null });
    const run = () => {
      if (table === 'plan_reading_jobs') {
        const match = jobs.filter(job => filters.every(([k, v]) => job[k] === v));
        if (update) for (const job of match) Object.assign(job, update);
        return { data: match.length === 1 ? match[0] : null, error: null };
      }
      if (table === 'project_file_pages') return { data: [], error: null };
      return { data: payload, error: null };
    };
    q.maybeSingle = async () => run(); q.single = async () => run();
    q.then = (a: any, b: any) => Promise.resolve(run()).then(a, b);
    return q;
  }
  const db: any = {
    from: (table: string) => query(table, table === 'workspaces' ? { ai_processing_consented_at: '2026-09-01' }
      : table === 'projects' ? { id: 'p' }
      : table === 'project_files' ? { id: 'f', original_name: 'live-sample.pdf', storage_path: 'w/p/f/source.pdf', processing_status: 'ready', page_count: 3 }
      : null),
  };
  const writer: any = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: any) => {
      if (fn === 'reserve_provider_spend') { reservations.push(args); return { data: {}, error: null }; }
      if (fn === 'capture_provider_spend') return { data: {}, error: null };
      if (fn === 'reserve_platform_admin_reading') {
        const job = { id: `job-${++next}`, workspace_id: 'w', project_id: 'p', file_id: 'f', requested_by: 'u', status: 'processing', input_summary: { entitlement: 'platform_admin_complimentary', file_sha256: args.p_file_sha256, request_fingerprint: args.p_request_fingerprint, requested_scope: args.p_scope, requested_trades: args.p_requested_trades }, output_summary: {}, plan_reading_findings: [] };
        jobs.push(job); return { data: { job: structuredClone(job), reused: false }, error: null };
      }
      if (fn === 'finish_platform_admin_reading') {
        const job = jobs.find(candidate => candidate.id === args.p_job_id)!;
        job.status = args.p_error ? 'failed' : 'needs_review';
        job.output_summary = args.p_summary; job.plan_reading_findings = args.p_findings;
        return { data: structuredClone(job), error: null };
      }
      throw Error(fn);
    },
  };

  const config = requireOpenAiVisionConfig({
    OPENAI_PLAN_READING_ENABLED: 'true',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    // Force the sweep so this run covers the windowed path as well.
    AI_PLAN_OPENAI_BATCH_PAGES: '2',
  });
  const real = new OpenAiCompatibleVisionPlanReader(config);
  let captured: any = null;
  const reader: any = { read: async (input: any) => { captured = input; return real.read(input); } };

  const service = new AiPlanReadingService(
    db, writer, { presign: () => ({ url: 'https://storage.test/live-sample.pdf' }) }, reader,
    'u', 'w', (async () => new Response(bytes)) as typeof fetch, undefined, true,
  );
  const result = await service.create('p', {
    file_id: 'f', mode: 'detailed', source_sha256: PDF_DIGEST(bytes), trades: ['Framing', 'Drywall'], scope: 'Full reading of the supplied set',
  });

  // The service handed the reader the whole set and the local evidence.
  assert.equal(captured.pageCount, 3, 'the reader must know the real page count to sweep');
  assert.equal(captured.linework.pages.length, 3, 'measured linework reaches the provider');
  assert.equal(captured.sheetText.pages.length, 3, 'the local transcript reaches the provider');
  assert.match(captured.sheetText.pages[2].text, /HOLLOW METAL DOOR/, 'the schedule text was transcribed locally');

  // A real reading saved real cited evidence for the sheets it read.
  const findings = result.plan_reading_findings;
  assert.ok(findings.length >= 4, `expected cited findings, received ${findings.length}`);
  for (const finding of findings) {
    assert.ok(finding.page_number >= 1 && finding.page_number <= 3, `page ${finding.page_number} is not a physical page of this set`);
    assert.ok(typeof finding.source_excerpt === 'string' && finding.source_excerpt.length > 0, 'every saved finding cites an excerpt');
  }
  assert.equal(result.output_summary.physical_page_count, 3);
  assert.equal(result.output_summary.human_review_required, true);
  assert.ok(result.output_summary.reading_coverage.pagesWithFindings.length >= 1);
  assert.equal(result.output_summary.reading_coverage.completeTakeoffVerified, false);
  assert.ok(result.output_summary.limitations.length >= 1);

  // One spend reservation per provider request, never one for the whole set.
  assert.ok(reservations.length >= 2, `expected a reservation per request, received ${reservations.length}`);
  assert.ok(reservations.every(entry => entry.p_provider === 'openai'));

  console.log(`live reading: ${findings.length} findings over ${result.output_summary.reading_coverage.pagesWithFindings.length} page(s) | ${reservations.length} provider request(s) | model ${config.model}`);
});