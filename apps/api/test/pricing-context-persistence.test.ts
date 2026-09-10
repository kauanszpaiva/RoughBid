import test from 'node:test';
import assert from 'node:assert/strict';
import { AiPlanReadingService } from '../src/ai-plan/service.ts';
import { PDF_DIGEST } from '../src/billing/project-preflight.ts';
import type { PlanProjectAddressEvidence } from '../src/ai-plan/types.ts';

function query(result: unknown) {
  const builder: any = {};
  for (const method of ['select', 'eq', 'gte', 'order', 'maybeSingle', 'single']) builder[method] = () => builder;
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve({ data: result, error: null }).then(resolve, reject);
  return builder;
}

function db(projectAddress = '52 Main St, Needham, MA 02492') {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from(table: string) {
      if (table === 'workspaces') return query({ ai_processing_consented_at: '2026-09-01T00:00:00Z' });
      if (table === 'projects') return query({ id: 'project-1', address_text: projectAddress });
      if (table === 'project_files') return query({
        id: 'file-1', original_name: 'plan.pdf', storage_path: 'workspace-1/project-1/file-1/source.pdf', processing_status: 'ready',
      });
      if (table === 'plan_reading_jobs') return query([]);
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const planAddress: PlanProjectAddressEvidence = {
  project_name: 'Smith Renovation',
  street_address: '12 Main St',
  city: 'Needham',
  state: 'MA',
  postal_code: '02492',
  building_lot_unit: null,
  page_number: 1,
  source_excerpt: 'PROJECT ADDRESS: 12 MAIN ST NEEDHAM MA 02492',
  confidence: 0.98,
};

const finding = {
  page_number: 1, finding_type: 'material' as const, label: 'Decking', value_text: null,
  quantity: 100, unit: 'SF', confidence: 0.9, geometry: {}, source_excerpt: 'A1: 100 SF decking',
};

function writer(options: { existing?: any; onContext?: (row: any) => void } = {}) {
  return {
    from(table: string) {
      assert.equal(table, 'project_pricing_contexts');
      const builder: any = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.maybeSingle = async () => ({ data: options.existing ?? null, error: null });
      builder.upsert = async (row: any) => {
        options.onContext?.(row);
        return { data: row, error: null };
      };
      return builder;
    },
    async rpc(fn: string, args: any) {
      if (fn === 'reserve_project_reading') {
        return {
          data: {
            job: { id: 'job-1' },
            quote: { trades: ['Framing'], scope: '', file_sha256: PDF_DIGEST(new Uint8Array([1, 2, 3])), page_count: 1 },
            reused: false,
          },
          error: null,
        };
      }
      assert.equal(fn, 'finish_project_reading');
      return {
        data: { id: 'job-1', status: args.p_error ? 'failed' : 'needs_review', output_summary: args.p_summary, plan_reading_findings: args.p_findings },
        error: null,
      };
    },
  };
}

const storage = { presign: async () => ({ url: 'https://signed.example/source.pdf' }) };
const fetcher = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });

test('successful real reading persists conflicting plan/project address evidence through the trusted writer', async () => {
  let savedContext: any = null;
  const reader = {
    read: async () => ({
      summary: { sheet_count: 1, detected_trade_scope: [], scale_status: 'detected' as const, human_review_required: true as const, limitations: [], project_address: planAddress },
      findings: [finding],
    }),
  };
  const service = new AiPlanReadingService(db() as never, writer({ onContext: row => { savedContext = row; } }), storage, reader, 'user-1', 'workspace-1', fetcher as never);
  await service.create('project-1', { file_id: 'file-1', quote_id: 'quote-1' });

  assert.ok(savedContext, 'a successful reading must persist pricing context');
  assert.equal(savedContext.workspace_id, 'workspace-1');
  assert.equal(savedContext.project_id, 'project-1');
  assert.equal(savedContext.project_address_text, '52 Main St, Needham, MA 02492');
  assert.equal(savedContext.plan_address.postal_code, '02492');
  assert.equal(savedContext.address_status, 'needs_resolution');
  assert.equal(savedContext.pricing_address, null);
  assert.equal(savedContext.plan_file_id, 'file-1');
  assert.equal(savedContext.plan_job_id, 'job-1');
});

test('pricing context persistence preserves an unchanged prior human resolution', async () => {
  const pricing = await import('../src/pricing/context.ts') as any;
  assert.equal(typeof pricing.persistPlanPricingContext, 'function', 'persistence helper must exist');

  const existing = {
    project_id: 'project-1', workspace_id: 'workspace-1',
    project_address_text: '52 Main St, Needham, MA 02492',
    plan_address: planAddress,
    pricing_address: { formatted: '52 Main St, Needham, MA 02492' },
    address_source: 'confirmed_override', address_status: 'resolved',
    plan_file_id: 'old-file', plan_job_id: 'old-job',
    resolved_by: 'estimator-1', resolved_at: '2026-09-08T12:00:00Z',
  };
  let saved: any = null;
  await pricing.persistPlanPricingContext({
    writer: writer({ existing, onContext: row => { saved = row; } }),
    workspaceId: 'workspace-1', projectId: 'project-1',
    projectAddressText: '52 MAIN STREET, Needham MA 02492',
    planAddress: { ...planAddress, source_excerpt: 'TITLE BLOCK: 12 MAIN ST NEEDHAM MA 02492' },
    fileId: 'file-2', jobId: 'job-2',
  });

  assert.equal(saved.address_status, 'resolved');
  assert.deepEqual(saved.pricing_address, existing.pricing_address);
  assert.equal(saved.address_source, 'confirmed_override');
  assert.equal(saved.resolved_by, 'estimator-1');
  assert.equal(saved.resolved_at, '2026-09-08T12:00:00Z');
  assert.equal(saved.plan_file_id, 'file-2');
  assert.equal(saved.plan_job_id, 'job-2');
});

test('materially new conflicting plan evidence reopens resolution and keeps the new evidence lineage', async () => {
  const pricing = await import('../src/pricing/context.ts') as any;
  assert.equal(typeof pricing.persistPlanPricingContext, 'function', 'persistence helper must exist');
  const existing = {
    project_id: 'project-1', workspace_id: 'workspace-1',
    project_address_text: '52 Main St, Needham, MA 02492', plan_address: planAddress,
    pricing_address: { formatted: '52 Main St, Needham, MA 02492' },
    address_source: 'confirmed_override', address_status: 'resolved',
    plan_file_id: 'old-file', plan_job_id: 'old-job', resolved_by: 'estimator-1', resolved_at: '2026-09-08T12:00:00Z',
  };
  let saved: any = null;
  await pricing.persistPlanPricingContext({
    writer: writer({ existing, onContext: row => { saved = row; } }),
    workspaceId: 'workspace-1', projectId: 'project-1', projectAddressText: existing.project_address_text,
    planAddress: { ...planAddress, street_address: '88 Oak Rd', source_excerpt: 'PROJECT ADDRESS: 88 OAK RD NEEDHAM MA 02492' },
    fileId: 'file-new', jobId: 'job-new',
  });
  assert.equal(saved.address_status, 'needs_resolution');
  assert.equal(saved.pricing_address, null);
  assert.equal(saved.address_source, null);
  assert.equal(saved.resolved_by, null);
  assert.equal(saved.resolved_at, null);
  assert.equal(saved.plan_file_id, 'file-new');
  assert.equal(saved.plan_job_id, 'job-new');
});
