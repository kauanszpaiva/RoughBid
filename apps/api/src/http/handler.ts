import { ProjectPayments, handleProjectPayment } from '../billing/project-payments.ts';
import { createClient } from '@supabase/supabase-js';
import { handleAuthBootstrapRequest, handleMagicLinkRequest } from '../auth/routes.ts';
import { handleWorkspacesRequest } from '../workspaces/routes.ts';
import { handleProjectRequest } from '../projects/routes.ts';
import { handleDocumentRequest } from '../documents/routes.ts';
import { createDocumentQueue, type JobQueue } from '../documents/service.ts';
import { createEstimateCalculationHandler } from '../estimates/routes.ts';
import { StripeHttpGateway, SupabaseBillingRepository } from '../billing/adapters.ts';
import { createBillingEndpointHandler } from '../billing/endpoints.ts';
import { createBillingConfigFromEnv } from '../billing/stripe.ts';
import { handleAiPlanRequest, type AiPlanRequestDependencies } from '../ai-plan/routes.ts';
import { handleClientProposalRequest } from '../proposals/routes.ts';
import { createGeminiClient, GeminiPlanReader } from '../ai-plan/gemini.ts';
import { PLAN_READING_UNAVAILABLE, requirePaidPlanReadingConfig } from '../ai-plan/readiness.ts';
import { MultiProviderPlanReader } from '../ai-plan/multi-provider.ts';
import { runtimeCapabilities } from './capabilities.ts';
import { requireFreeProviderConfig } from '../ai-plan/free-provider.ts';
import { assertNoPaidFallback } from '../ai-plan/owner-free.ts';
import type { PlanReadingFindingsWriter } from '../ai-plan/service.ts';
import { loadObjectStorageConfig, S3ObjectStorage } from '../storage/object-storage.ts';
import { loadVercelBlobStorageConfig, VercelBlobObjectStorage } from '../storage/vercel-blob-storage.ts';
import { loadResendServerConfig, sendProposalOpenedEmail, sendProposalSignedEmail, sendWorkspaceInviteEmail } from '../email/resend.ts';
import type { AuthenticatedSupabaseClient } from '../supabase/client.ts';
import type { SupabaseLike } from '../projects/service.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * Builds a real Supabase client scoped to one request's Authorization header —
 * never the service-role key. Row-level security (see supabase/migrations/)
 * is the authorization boundary; this client only proves *who* is calling.
 */
function clientForRequest(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be configured on the server.');
  }
  const authorization = request.headers.get('authorization');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: authorization ? { headers: { Authorization: authorization } } : {},
  });
}

function loadSupabaseServiceRoleKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_PLAN_FUNCTION?.trim() || '';
  if (key.startsWith('sb_secret_')) return key;
  try {
    const claims = JSON.parse(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString('utf8'));
    if (claims.role === 'service_role') return key;
  } catch { /* Invalid server configuration, never log the credential. */ }
  if (key) console.error('supabase_server_writer_not_configured', { reason: 'Configured value is not a service role or server secret key.' });
  return '';
}

/**
 * Single entrypoint for every RoughBid API route, mounted at the repo root by
 * /api/[...path].ts (a thin Vercel Edge Function adapter — see that file).
 * Framework-neutral on purpose: apps/api's handlers only know Request/Response.
 */
export async function handleApiRequest(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === '/api/health') {
    return json({ status: 'ok', service: 'RoughBid API' });
  }
  if (pathname === '/api/capabilities') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return Response.json(runtimeCapabilities(process.env), { headers: { 'cache-control': 'no-store' } });
  }
  if (pathname === '/api/auth/magic-link') {
    const supabaseUrl = process.env.SUPABASE_URL?.trim();
    const serviceRoleKey = loadSupabaseServiceRoleKey();
    if (!supabaseUrl || !serviceRoleKey || !process.env.RESEND_API_KEY) {
      return json({ error: 'RoughBid email sign-in is not configured.' }, 503);
    }
    const appUrl = process.env.APP_URL?.trim() || 'https://roughbid.vercel.app';
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    return handleMagicLinkRequest(request, admin, { appUrl, env: process.env });
  }

  let client: ReturnType<typeof clientForRequest>;
  try {
    client = clientForRequest(request);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Server misconfigured' }, 500);
  }

  if (pathname === '/api/auth/bootstrap') {
    return handleAuthBootstrapRequest(request, client as unknown as AuthenticatedSupabaseClient);
  }
  if (pathname === '/api/workspaces' || pathname === '/api/workspace-invites/accept' || /^\/api\/workspaces\/[^/]+\/(invites|ai-consent)$/.test(pathname)) {
    const appUrl = process.env.APP_URL?.trim() || 'https://roughbid.vercel.app';
    const inviteMailer = process.env.RESEND_API_KEY
      ? (input: { to: string; workspaceName: string; inviteUrl: string; role: 'estimator' | 'viewer'; inviteId: string }) => sendWorkspaceInviteEmail(loadResendServerConfig(process.env), {
        ...input,
        idempotencyKey: `workspace-invite/${input.inviteId}`,
      })
      : undefined;
    return handleWorkspacesRequest(request, client as unknown as AuthenticatedSupabaseClient, {
      appUrl,
      ...(inviteMailer ? { sendInviteEmail: inviteMailer } : {}),
    });
  }
  if (/^\/api\/projects\/[^/]+\/(reading-quote|reading-checkout)$/.test(pathname)) {
    const serviceRoleKey = loadSupabaseServiceRoleKey();
    if (!serviceRoleKey || !process.env.SUPABASE_URL) return json({error:'Project billing is not configured.'},503);
    try {
      const admin = createClient(process.env.SUPABASE_URL, serviceRoleKey, {auth:{persistSession:false,autoRefreshToken:false}});
      const storage = process.env.BLOB_READ_WRITE_TOKEN
        ? new VercelBlobObjectStorage(loadVercelBlobStorageConfig(process.env))
        : new S3ObjectStorage(loadObjectStorageConfig(process.env));
      return handleProjectPayment(request,client as unknown as SupabaseLike,new ProjectPayments(admin,process.env),storage);
    } catch { return json({error:'Project billing is not configured.'},503); }
  }
  if (pathname === '/api/billing/checkout' || pathname === '/api/billing/portal' || pathname === '/api/webhooks/stripe') {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
    const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
    const supabaseServiceRoleKey = loadSupabaseServiceRoleKey();
    const supabaseUrl = process.env.SUPABASE_URL?.trim();
    if (!stripeSecretKey || !stripeWebhookSecret || !supabaseServiceRoleKey || !supabaseUrl) {
      return json({ error: 'Billing is not configured.' }, 503);
    }
    const billing = createBillingEndpointHandler({
      config: createBillingConfigFromEnv(process.env),
      membershipsEnabled: process.env.BILLING_MEMBERSHIPS_ENABLED === 'true',
      webhookSecret: stripeWebhookSecret,
      reconcileProjectPayment: event => new ProjectPayments(createClient(supabaseUrl,supabaseServiceRoleKey,{auth:{persistSession:false,autoRefreshToken:false}}),process.env).reconcile(event),
      stripe: new StripeHttpGateway(stripeSecretKey),
      repository: new SupabaseBillingRepository(supabaseUrl, supabaseServiceRoleKey),
      authenticate: async () => {
        const { data } = await client.auth.getUser();
        return data.user?.email ? { id: data.user.id, email: data.user.email } : null;
      },
    });
    return billing(request);
  }
  if (pathname === '/api/estimates/recalculate') {
    const recalculate = createEstimateCalculationHandler({
      authenticate: async () => {
        const { data } = await client.auth.getUser();
        return data.user ? { id: data.user.id } : null;
      },
    });
    return recalculate(request);
  }
  if (/^\/api\/projects\/[^/]+\/documents\/upload-url$/.test(pathname) || /^\/api\/documents\/[^/]+\/(complete|download-url|preview)$/.test(pathname)) {
    let queue: JobQueue | null = null;
    try {
      const storage = process.env.BLOB_READ_WRITE_TOKEN
        ? new VercelBlobObjectStorage(loadVercelBlobStorageConfig(process.env))
        : new S3ObjectStorage(loadObjectStorageConfig(process.env));
      if (request.method === 'POST' && pathname.endsWith('/complete') && process.env.PDF_PAGE_PROCESSING_ENABLED === 'true' && process.env.REDIS_URL) {
        try { queue = await createDocumentQueue(process.env.REDIS_URL); }
        catch { /* Original PDF uploads do not depend on optional page rendering. */ }
      }
      const isCompletion = request.method === 'POST' && pathname.endsWith('/complete');
      const writerKey = isCompletion ? loadSupabaseServiceRoleKey() : null;
      if (isCompletion && (!writerKey || !process.env.SUPABASE_URL)) return json({ error: 'Document completion is not configured.' }, 503);
      const completionWriter = writerKey ? createClient(process.env.SUPABASE_URL!, writerKey, { auth: { persistSession: false, autoRefreshToken: false } }) : undefined;
      return await handleDocumentRequest(request, client as unknown as SupabaseLike, storage, queue, completionWriter);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Document processing is not configured.' }, 503);
    } finally {
      await queue?.close?.().catch(() => {});
    }
  }
  if (/^\/api\/projects\/[^/]+\/ai-plan-readings$/.test(pathname) || /^\/api\/ai-plan-readings\/[^/]+$/.test(pathname) || /^\/api\/ai-plan-readings\/findings\/[^/]+$/.test(pathname)) {
    const supabaseServiceRoleKey = loadSupabaseServiceRoleKey();
    const supabaseUrl = process.env.SUPABASE_URL?.trim();
    if (!supabaseServiceRoleKey || !supabaseUrl) {
      return json({ error: 'AI plan reading is not configured.' }, 503);
    }
    try {
      const storage = process.env.BLOB_READ_WRITE_TOKEN
        ? new VercelBlobObjectStorage(loadVercelBlobStorageConfig(process.env))
        : new S3ObjectStorage(loadObjectStorageConfig(process.env));
      const readers = [];
      try {
        const readingConfig = requirePaidPlanReadingConfig(process.env);
        const geminiClient = await createGeminiClient(readingConfig.apiKey);
        const gemini = new GeminiPlanReader(geminiClient, [readingConfig.model]);
        readers.push({ name: 'gemini', read: (input: any) => gemini.read(input) });
      } catch { /* Paid Gemini remains disabled unless explicitly configured. */ }
      // The owner-only free reader is built from its OWN credentials and kept in
      // a separate dependency, never appended to `readers`. A free reading can
      // therefore never fall through to the billed Gemini project, and a paid
      // reading can never be served by the free one.
      let freeReader: { read(input: any): Promise<any> } | undefined;
      try {
        const freeConfig = requireFreeProviderConfig(process.env);
        const freeClient = await createGeminiClient(freeConfig.apiKey);
        const freeGemini = new GeminiPlanReader(freeClient, [freeConfig.model]);
        assertNoPaidFallback('gemini-free-tier');
        freeReader = { read: (input: any) => freeGemini.read(input) };
      } catch { /* Free owner route stays closed until its own config is verified. */ }

      const isCreateReading = request.method === 'POST' && /^\/api\/projects\/[^/]+\/ai-plan-readings$/.test(pathname);
      if (!readers.length && !freeReader && isCreateReading) {
        return json({ error: PLAN_READING_UNAVAILABLE }, 503);
      }
      const reader = readers.length
        ? new MultiProviderPlanReader(readers)
        : { read: async () => { throw new Error(PLAN_READING_UNAVAILABLE); } };
      const findingsWriter = createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as PlanReadingFindingsWriter;
      const deps: AiPlanRequestDependencies = { findingsWriter, storage, reader, freeReader };
      return handleAiPlanRequest(request, client as unknown as SupabaseLike, deps);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'AI plan reading is not configured.' }, 503);
    }
  }
  if (/^\/api\/projects\/[^/]+\/client-proposals$/.test(pathname) || /^\/api\/client-proposals\/[^/]+(\/sign)?$/.test(pathname)) {
    const resend = process.env.RESEND_API_KEY ? loadResendServerConfig(process.env) : null;
    return handleClientProposalRequest(request, client as never, {
      ...(resend ? {
        sendProposalOpenedEmail: (input) => sendProposalOpenedEmail(resend, input),
        sendProposalSignedEmail: (input) => sendProposalSignedEmail(resend, input),
      } : {}),
    });
  }
  if (pathname.startsWith('/api/projects') || pathname.startsWith('/api/project-files')) {
    return handleProjectRequest(request, client as unknown as SupabaseLike);
  }

  return json({ error: 'Not found' }, 404);
}
