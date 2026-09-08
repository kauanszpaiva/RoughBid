import test from 'node:test';
import assert from 'node:assert/strict';
import { AiPlanReadingService, type PlanReader } from '../src/ai-plan/service.ts';
import { handleAiPlanRequest } from '../src/ai-plan/routes.ts';
import { handleApiRequest } from '../src/http/handler.ts';
import { PDF_DIGEST } from '../src/billing/project-preflight.ts';

const OWNER_WS = '60d9e2bc-06f6-4f2b-a648-aee6bdf4fb72';
const CUSTOMER_WS = '8c2b5d1f-4e33-4a7c-9d6e-1b2a3c4d5e6f';
const OWNER_USER = 'c6453b85-f0e2-4af0-aad7-dcecb6fbb487';

const freeEnv = {
  FREE_OWNER_READINGS_ENABLED: 'true', FREE_OWNER_WORKSPACE_ID: OWNER_WS,
  FREE_PROVIDER_ENABLED: 'true', GEMINI_FREE_API_KEY: 'free-project-credential',
  GEMINI_FREE_MODEL: 'gemini-2.5-flash', GEMINI_FREE_PROJECT_ID: 'cedar-amulet-507710-u8',
  GEMINI_FREE_TIER_VERIFIED: 'true',
};

/** Minimal valid one-page PDF so inspectPdf/pdf-lib can parse real bytes. */
function syntheticPdf(): Uint8Array {
  const content = Buffer.from('BT /F1 12 Tf 72 700 Td (plan) Tj ET\n');
  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('endstream')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  let out = Buffer.from('%PDF-1.4\n');
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
  });
  const xref = out.length;
  let table = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) table += `${String(off).padStart(10, '0')} 00000 n \n`;
  out = Buffer.concat([out, Buffer.from(table), Buffer.from(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)]);
  return new Uint8Array(out);
}

const PDF = syntheticPdf();

function makeQuery(resolve: () => { data?: unknown; error?: unknown }, onCall?: (m: string, a: unknown[]) => void) {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'order', 'insert', 'update', 'maybeSingle', 'single']) {
    builder[m] = (...args: unknown[]) => { onCall?.(m, args); return builder; };
  }
  builder.then = (ok: (v: unknown) => unknown, bad: (v: unknown) => unknown) =>
    Promise.resolve(resolve()).then(ok, bad);
  return builder;
}

function fakeDb(workspaceId: string) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: OWNER_USER } }, error: null }) },
    from(table: string) {
      const calls: Array<[string, unknown[]]> = [];
      return makeQuery(() => {
        if (table === 'workspaces') return { data: { ai_processing_consented_at: '2026-09-01T00:00:00Z' }, error: null };
        if (table === 'projects') return { data: { id: 'project-1' }, error: null };
        if (table === 'project_files') {
          return { data: { id: 'file-1', original_name: 'plan.pdf', storage_path: `${workspaceId}/project-1/file-1/source.pdf`, processing_status: 'ready' }, error: null };
        }
        if (table === 'plan_reading_jobs') {
          if (calls.some(([m]) => m === 'insert') || calls.some(([m]) => m === 'update')) return { data: { id: 'job-free-1' }, error: null };
          return { data: [], error: null };
        }
        throw new Error(`unexpected table ${table}`);
      }, (m, a) => calls.push([m, a]));
    },
  };
}

function harness(opts: { rpc?: (fn: string, args: any) => any } = {}) {
  const rpcCalls: Array<{ fn: string; args: any }> = [];
  const findingsWriter = {
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      if (opts.rpc) { const r = opts.rpc(fn, args); if (r !== undefined) return r; }
      if (fn === 'reserve_owner_free_reading') {
        return { data: { reused: false, job: { id: 'job-free-1', workspace_id: OWNER_WS } }, error: null };
      }
      if (fn === 'finish_owner_free_reading') return { data: { id: 'job-free-1', status: 'needs_review' }, error: null };
      return { data: null, error: null };
    },
  };
  const storage = { presign: () => ({ url: 'https://storage.test/plan.pdf' }) };
  const fetcher = async () => new Response(PDF, { status: 200, headers: { 'content-length': String(PDF.length) } });
  const paidReads: any[] = [];
  const freeReads: any[] = [];
  const paidReader: PlanReader = { read: async (i) => { paidReads.push(i); throw new Error('paid reader must not run for a free reading'); } };
  const freeReader: PlanReader = {
    read: async (i) => {
      freeReads.push(i);
      return {
        summary: { synthetic: false, model: 'gemini-2.5-flash' },
        findings: [{ page_number: 1, finding_type: 'measurement', label: 'Slab', value_text: '10 ft', quantity: 10, unit: 'ft', confidence: 0.8, geometry: {}, source_excerpt: 'slab' }],
      } as never;
    },
  };
  return { findingsWriter, storage, fetcher, paidReader, freeReader, rpcCalls, paidReads, freeReads };
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { prior[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

test('owner workspace runs a free reading through the free reader only', async () => {
  const h = harness();
  await withEnv(freeEnv, async () => {
    const svc = new AiPlanReadingService(fakeDb(OWNER_WS) as never, h.findingsWriter as never, h.storage as never, h.paidReader, OWNER_USER, OWNER_WS, h.fetcher as never, h.freeReader);
    const result = await svc.create('project-1', { file_id: 'file-1', trades: ['Framing'], scope: 'garage slab' });
    assert.equal((result as any).status, 'needs_review');
  });
  assert.equal(h.freeReads.length, 1, 'free reader ran');
  assert.equal(h.paidReads.length, 0, 'billed reader never ran');

  const reserve = h.rpcCalls.find(c => c.fn === 'reserve_owner_free_reading');
  assert.ok(reserve, 'used the quote-less owner reservation');
  assert.equal(reserve!.args.p_model, 'gemini-2.5-flash');
  assert.equal(reserve!.args.p_file_sha256, PDF_DIGEST(PDF), 'server-verified digest, not client supplied');
  assert.match(reserve!.args.p_request_fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(!h.rpcCalls.some(c => c.fn === 'reserve_project_reading'), 'no paid reservation');
  assert.ok(!h.rpcCalls.some(c => c.fn === 'finish_project_reading'), 'no paid completion');
});

test('free route fails closed before any provider call when unverified', async () => {
  for (const missing of ['GEMINI_FREE_API_KEY', 'GEMINI_FREE_TIER_VERIFIED', 'FREE_PROVIDER_ENABLED', 'GEMINI_FREE_PROJECT_ID']) {
    const h = harness();
    await withEnv({ ...freeEnv, [missing]: '' }, async () => {
      const svc = new AiPlanReadingService(fakeDb(OWNER_WS) as never, h.findingsWriter as never, h.storage as never, h.paidReader, OWNER_USER, OWNER_WS, h.fetcher as never, h.freeReader);
      await assert.rejects(() => svc.create('project-1', { file_id: 'file-1' }), /not configured/i, missing);
    });
    assert.equal(h.freeReads.length, 0, `${missing}: no provider call`);
    assert.equal(h.paidReads.length, 0, `${missing}: no provider call`);
    assert.equal(h.rpcCalls.length, 0, `${missing}: no reservation`);
  }
});

test('free route refuses to run when the free reader is absent', async () => {
  const h = harness();
  await withEnv(freeEnv, async () => {
    const svc = new AiPlanReadingService(fakeDb(OWNER_WS) as never, h.findingsWriter as never, h.storage as never, h.paidReader, OWNER_USER, OWNER_WS, h.fetcher as never, undefined);
    await assert.rejects(() => svc.create('project-1', { file_id: 'file-1' }), /not configured/i);
  });
  assert.equal(h.paidReads.length, 0, 'never falls back to the billed reader');
});

test('customer workspace still requires a confirmed payment', async () => {
  const h = harness();
  await withEnv(freeEnv, async () => {
    const svc = new AiPlanReadingService(fakeDb(CUSTOMER_WS) as never, h.findingsWriter as never, h.storage as never, h.paidReader, OWNER_USER, CUSTOMER_WS, h.fetcher as never, h.freeReader);
    await assert.rejects(() => svc.create('project-1', { file_id: 'file-1' }), (e: any) => e.status === 402);
  });
  assert.equal(h.freeReads.length, 0, 'a customer never reaches the free provider');
  assert.ok(!h.rpcCalls.some(c => c.fn === 'reserve_owner_free_reading'), 'no free reservation for a customer');
});

test('an existing identical reading is re-used instead of spending quota', async () => {
  const h = harness({ rpc: (fn) => fn === 'reserve_owner_free_reading'
    ? { data: { reused: true, job: { id: 'job-free-1' } }, error: null } : undefined });
  await withEnv(freeEnv, async () => {
    const svc = new AiPlanReadingService(fakeDb(OWNER_WS) as never, h.findingsWriter as never, h.storage as never, h.paidReader, OWNER_USER, OWNER_WS, h.fetcher as never, h.freeReader);
    await svc.create('project-1', { file_id: 'file-1', trades: ['Framing'], scope: 'garage slab' });
  });
  assert.equal(h.freeReads.length, 0, 're-used job does not call the provider again');
});

test('a different scope produces a different request fingerprint', async () => {
  const seen: string[] = [];
  for (const scope of ['garage slab', 'roof framing']) {
    const h = harness();
    await withEnv(freeEnv, async () => {
      const svc = new AiPlanReadingService(fakeDb(OWNER_WS) as never, h.findingsWriter as never, h.storage as never, h.paidReader, OWNER_USER, OWNER_WS, h.fetcher as never, h.freeReader);
      await svc.create('project-1', { file_id: 'file-1', trades: ['Framing'], scope });
    });
    seen.push(h.rpcCalls.find(c => c.fn === 'reserve_owner_free_reading')!.args.p_request_fingerprint);
  }
  assert.notEqual(seen[0], seen[1], 'scope change must not re-use the previous analysis');
});

test('entitlement is answered by the database for the authenticated caller', async () => {
  // The SQL answer is authoritative; the header alone must never decide it.
  const mk = (dbAnswer: boolean, freeReader?: PlanReader) => {
    const seen: any[] = [];
    const writer = {
      rpc: async (fn: string, args: any) => {
        seen.push({ fn, args });
        if (fn === 'owner_free_reading_available') return { data: dbAnswer, error: null };
        return { data: null, error: null };
      },
    };
    const h = harness();
    return { seen, writer, h, freeReader: freeReader ?? h.freeReader };
  };
  const call = (ws: string, ctx: ReturnType<typeof mk>) => handleAiPlanRequest(
    new Request('https://app.test/api/projects/project-1/ai-plan-entitlement', {
      method: 'GET', headers: { 'x-workspace-id': ws, authorization: 'Bearer t' },
    }),
    fakeDb(ws) as never,
    { findingsWriter: ctx.writer as never, storage: ctx.h.storage as never, reader: ctx.h.paidReader, freeReader: ctx.freeReader },
  );

  await withEnv(freeEnv, async () => {
    const ok = mk(true);
    assert.deepEqual(await (await call(OWNER_WS, ok)).json(), { freeReadingAvailable: true });
    assert.equal(ok.seen[0].fn, 'owner_free_reading_available');
    assert.equal(ok.seen[0].args.p_project_id, 'project-1', 'project is checked, not just the workspace');

    // Authenticated caller supplying an allowlisted workspace they do not own:
    // the database says no, so the endpoint says no.
    const spoof = mk(false);
    assert.deepEqual(await (await call(OWNER_WS, spoof)).json(), { freeReadingAvailable: false });

    // A customer workspace never even reaches the database check.
    const customer = mk(true);
    assert.deepEqual(await (await call(CUSTOMER_WS, customer)).json(), { freeReadingAvailable: false });
    assert.equal(customer.seen.length, 0, 'no entitlement lookup for a non-owner workspace');

    // Configured, DB says yes, but no usable free reader: still unavailable.
    const noReader = mk(true, undefined as never);
    noReader.freeReader = undefined as never;
    assert.deepEqual(await (await call(OWNER_WS, noReader)).json(), { freeReadingAvailable: false });
  });

  await withEnv({ ...freeEnv, GEMINI_FREE_TIER_VERIFIED: '' }, async () => {
    const unverified = mk(true);
    assert.deepEqual(await (await call(OWNER_WS, unverified)).json(), { freeReadingAvailable: false });
    assert.equal(unverified.seen.length, 0, 'unverified provider short-circuits before the lookup');
  });
});

test('the entitlement path is reachable through the real outer HTTP entry point', async () => {
  // Guards the outer dispatcher matcher: a route the router understands is
  // useless if handleApiRequest never routes to it. A 404 here means the UI
  // endpoint is unreachable and the free action could never appear.
  const res = await handleApiRequest(new Request('https://app.test/api/projects/project-1/ai-plan-entitlement', {
    method: 'GET', headers: { 'x-workspace-id': OWNER_WS, authorization: 'Bearer t' },
  }));
  assert.notEqual(res.status, 404, 'outer handler must dispatch the entitlement route');
  const body = await res.json().catch(() => ({}));
  assert.ok(!('error' in body) || !/not found/i.test(String((body as any).error)),
    `entitlement route must not fall through to Not found (got ${res.status})`);
});

test('a quota or authorization refusal surfaces honestly and calls no provider', async () => {
  const h = harness({ rpc: (fn) => fn === 'reserve_owner_free_reading'
    ? { data: null, error: { message: 'Free daily reading limit reached for this workspace' } } : undefined });
  await withEnv(freeEnv, async () => {
    const svc = new AiPlanReadingService(fakeDb(OWNER_WS) as never, h.findingsWriter as never, h.storage as never, h.paidReader, OWNER_USER, OWNER_WS, h.fetcher as never, h.freeReader);
    await assert.rejects(() => svc.create('project-1', { file_id: 'file-1' }), /daily reading limit/i);
  });
  assert.equal(h.freeReads.length, 0, 'exhausted quota never reaches the provider');
});
