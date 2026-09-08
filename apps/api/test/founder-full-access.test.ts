import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { ProjectPayments } from '../src/billing/project-payments.ts';
import { AiPlanReadingService } from '../src/ai-plan/service.ts';
import { handleAiPlanRequest } from '../src/ai-plan/routes.ts';
import { createBillingEndpointHandler } from '../src/billing/endpoints.ts';
import { ProjectApiError } from '../src/projects/service.ts';

function queryResult(data: unknown, error: unknown = null) {
  const query: any = {};
  for (const method of ['select', 'eq', 'gte', 'order', 'limit', 'insert', 'update', 'single', 'maybeSingle']) {
    query[method] = () => query;
  }
  query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve({ data, error }).then(resolve, reject);
  return query;
}

function paymentDb(rows: Record<string, unknown>) {
  return {
    from(table: string) {
      return queryResult(rows[table] ?? null);
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

test('platform admin receives the highest commercial tier without a Stripe subscription', async () => {
  const payments = new ProjectPayments(paymentDb({
    profiles: { is_platform_admin: true },
    workspaces: { created_by: 'founder-1' },
    billing_customers: null,
  }) as never, {});

  const tier = await (payments.membership as any)('workspace-1', 'founder-1');
  assert.equal(tier, 'enterprise');
});

function aiDb(options: { platformAdmin?: boolean; projectExists?: boolean } = {}) {
  const { platformAdmin = true, projectExists = true } = options;
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'founder-1', email: 'kauan@kspdominion.group' } }, error: null }) },
    from(table: string) {
      if (table === 'profiles') return queryResult({ is_platform_admin: platformAdmin });
      if (table === 'workspaces') return queryResult({ ai_processing_consented_at: '2026-09-08T00:00:00Z' });
      if (table === 'projects') return queryResult(projectExists ? { id: 'project-1' } : null);
      if (table === 'project_files') return queryResult({
        id: 'file-1',
        original_name: 'plan.pdf',
        storage_path: 'workspace-1/project-1/file-1/source.pdf',
        processing_status: 'ready',
        page_count: 1,
      });
      if (table === 'plan_reading_jobs') return queryResult([]);
      throw new Error(`Unexpected table ${table}`);
    },
  };
}

async function onePagePdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  return new Uint8Array(await pdf.save());
}

const storage = { presign: async () => ({ url: 'https://storage.test/plan.pdf' }) };

const realFindingReader = {
  assertReady() {},
  read: async () => ({
    summary: {
      sheet_count: 1,
      detected_trade_scope: ['Framing'],
      scale_status: 'detected' as const,
      human_review_required: true,
      limitations: [],
    },
    findings: [{
      page_number: 1,
      finding_type: 'measurement' as const,
      label: 'Test wall',
      value_text: null,
      quantity: 10,
      unit: 'LF',
      confidence: 0.9,
      geometry: {},
      source_excerpt: 'A1 test wall',
    }],
  }),
};

test('platform admin can run the paid provider without a Stripe quote or fake payment', async () => {
  const calls: string[] = [];
  const findingsWriter = {
    from: () => { throw new Error('Direct writes are not expected'); },
    rpc: async (fn: string) => {
      calls.push(fn);
      if (fn === 'reserve_platform_admin_reading') {
        return { data: { reused: false, job: { id: 'job-founder' } }, error: null };
      }
      if (fn === 'finish_platform_admin_reading') {
        return {
          data: { id: 'job-founder', status: 'needs_review', processing_error: null, output_summary: {}, plan_reading_findings: [] },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${fn}`);
    },
  };
  const pdf = await onePagePdf();
  const service = new AiPlanReadingService(
    aiDb() as never,
    findingsWriter,
    storage,
    realFindingReader,
    'founder-1',
    'workspace-1',
    (async () => new Response(pdf)) as typeof fetch,
  );

  const result = await service.create('project-1', {
    file_id: 'file-1',
    trades: ['Framing'],
    scope: 'Founder product test',
    mode: 'quick',
  });

  assert.equal(result.status, 'needs_review');
  assert.deepEqual(calls, ['reserve_platform_admin_reading', 'finish_platform_admin_reading']);
});

test('platform admin commercial bypass never bypasses workspace/project tenancy', async () => {
  const pdf = await onePagePdf();
  let providerCalled = false;
  const service = new AiPlanReadingService(
    aiDb({ projectExists: false }) as never,
    { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
    storage,
    { read: async () => { providerCalled = true; return realFindingReader.read(); } },
    'founder-1',
    'workspace-1',
    (async () => new Response(pdf)) as typeof fetch,
  );

  await assert.rejects(
    service.create('other-project', { file_id: 'file-1' }),
    (error: unknown) => error instanceof ProjectApiError && error.status === 404,
  );
  assert.equal(providerCalled, false);
});

test('AI entitlement endpoint exposes complimentary analysis to platform admin without owner-free provider configuration', async () => {
  const previousEnabled = process.env.FREE_OWNER_READINGS_ENABLED;
  const previousWorkspace = process.env.FREE_OWNER_WORKSPACE_ID;
  delete process.env.FREE_OWNER_READINGS_ENABLED;
  delete process.env.FREE_OWNER_WORKSPACE_ID;
  try {
    const response = await handleAiPlanRequest(
      new Request('https://roughbid.test/api/projects/project-1/ai-plan-entitlement', {
        method: 'GET',
        headers: { 'x-workspace-id': 'workspace-1' },
      }),
      aiDb() as never,
      { findingsWriter: { from: () => ({}) }, storage, reader: realFindingReader, paidReaderAvailable: true },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { freeReadingAvailable: true });
  } finally {
    if (previousEnabled === undefined) delete process.env.FREE_OWNER_READINGS_ENABLED;
    else process.env.FREE_OWNER_READINGS_ENABLED = previousEnabled;
    if (previousWorkspace === undefined) delete process.env.FREE_OWNER_WORKSPACE_ID;
    else process.env.FREE_OWNER_WORKSPACE_ID = previousWorkspace;
  }
});

test('generic billing checkout is disabled for platform admin and never contacts Stripe', async () => {
  let stripeCalled = false;
  const handler = createBillingEndpointHandler({
    config: {
      mode: 'test',
      productId: 'prod_test',
      priceId: null,
      priceIds: { plan_pro: 'price_pro' },
    },
    webhookSecret: 'whsec_test',
    membershipsEnabled: true,
    stripe: {
      createCheckoutSession: async () => { stripeCalled = true; return { url: 'https://checkout.stripe.test/session' }; },
      createPortalSession: async () => ({ url: 'https://billing.stripe.test/portal' }),
    },
    repository: {
      customerIdForUser: async () => null,
      processStripeEvent: async () => true,
    },
    authenticate: async () => ({
      id: 'founder-1',
      email: 'kauan@kspdominion.group',
      isPlatformAdmin: true,
    } as any),
  });

  const response = await handler(new Request('https://roughbid.test/api/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      priceKey: 'plan_pro',
      successUrl: 'https://roughbid.test/app/',
      cancelUrl: 'https://roughbid.test/app/',
    }),
  }));

  assert.equal(response.status, 409);
  assert.match(String((await response.json() as { error?: string }).error), /complimentary|platform owner/i);
  assert.equal(stripeCalled, false);
});
