import { createClient } from '@supabase/supabase-js';
import { handleAuthBootstrapRequest } from '../auth/routes.ts';
import { handleWorkspacesRequest } from '../workspaces/routes.ts';
import { handleProjectRequest } from '../projects/routes.ts';
import { handleDocumentRequest } from '../documents/routes.ts';
import { createEstimateCalculationHandler } from '../estimates/routes.ts';
import { StripeHttpGateway, SupabaseBillingRepository } from '../billing/adapters.ts';
import { createBillingEndpointHandler } from '../billing/endpoints.ts';
import { createBillingConfigFromEnv } from '../billing/stripe.ts';
import { handleClientProposalRequest } from '../proposals/routes.ts';
import { GeminiPdfReader } from '../ai-plan/gemini.ts';
import { handleGeminiPlanRequest } from '../ai-plan/gemini-service.ts';
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

  // Optional Supabase-hosted execution keeps its administrative key inside Supabase.
  const planPath = /^\/api\/projects\/[^/]+\/(documents\/upload-url|ai-plan-readings)$/.test(pathname)
    || /^\/api\/documents\/[^/]+\/(complete|download-url)$/.test(pathname)
    || /^\/api\/ai-plan-readings\/[^/]+(\/process)?$/.test(pathname);
  if (planPath && process.env.SUPABASE_PLAN_FUNCTION === 'roughbid-plans') {
    if (!request.headers.get('authorization')) return json({ error: 'Authentication required' }, 401);
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY || !process.env.BLOB_READ_WRITE_TOKEN || !process.env.GEMINI_API_KEY) return json({ error: 'AI plan reading is not configured.' }, 503);
    try {
      const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/roughbid-plans`, {
        method: request.method,
        headers: {
          authorization: request.headers.get('authorization')!, apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
          'content-type': 'application/json', 'x-workspace-id': request.headers.get('x-workspace-id') ?? '',
          'x-roughbid-path': pathname, 'x-roughbid-gemini-key': process.env.GEMINI_API_KEY,
          'x-roughbid-storage-token': process.env.BLOB_READ_WRITE_TOKEN,
        },
        ...(request.method === 'GET' ? {} : { body: await request.text() }),
        signal: AbortSignal.timeout(115_000), redirect: 'error',
      });
      if (!response.headers.get('content-type')?.includes('application/json')) return json({ error: 'Plan processing is temporarily unavailable.' }, 502);
      return new Response(await response.text(), { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    } catch { return json({ error: 'Plan processing did not respond. Refresh results before retrying.' }, 504); }
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
  if (pathname === '/api/workspaces' || pathname === '/api/workspace-invites/accept' || /^\/api\/workspaces\/[^/]+\/invites$/.test(pathname)) {
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
  if (pathname === '/api/billing/checkout' || pathname === '/api/billing/portal' || pathname === '/api/webhooks/stripe') {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
    const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    const supabaseUrl = process.env.SUPABASE_URL?.trim();
    if (!stripeSecretKey || !stripeWebhookSecret || !supabaseServiceRoleKey || !supabaseUrl) {
      return json({ error: 'Billing is not configured.' }, 503);
    }
    const billing = createBillingEndpointHandler({
      config: createBillingConfigFromEnv(process.env),
      webhookSecret: stripeWebhookSecret,
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
  if (/^\/api\/projects\/[^/]+\/documents\/upload-url$/.test(pathname) || /^\/api\/documents\/[^/]+\/(complete|download-url)$/.test(pathname)) {
    try {
      const storage = process.env.BLOB_READ_WRITE_TOKEN
        ? new VercelBlobObjectStorage(loadVercelBlobStorageConfig(process.env))
        : new S3ObjectStorage(loadObjectStorageConfig(process.env));
      const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!secret) return json({ error: 'Private PDF processing needs the Supabase server key configured.' }, 503);
      const writer = createClient(process.env.SUPABASE_URL!, secret, { auth: { persistSession: false, autoRefreshToken: false } });
      return handleDocumentRequest(request, client as unknown as SupabaseLike, storage, null, writer as unknown as SupabaseLike);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Document processing is not configured.' }, 503);
    }
  }
  if (/^\/api\/projects\/[^/]+\/ai-plan-readings$/.test(pathname) || /^\/api\/ai-plan-readings\/[^/]+(\/process)?$/.test(pathname)) {
    const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!process.env.GEMINI_API_KEY || !secret) {
      return json({ error: 'AI plan reading is not configured.' }, 503);
    }
    try {
      const storage = process.env.BLOB_READ_WRITE_TOKEN
        ? new VercelBlobObjectStorage(loadVercelBlobStorageConfig(process.env))
        : new S3ObjectStorage(loadObjectStorageConfig(process.env));
      const serviceClient = createClient(process.env.SUPABASE_URL!, secret, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      return handleGeminiPlanRequest(
        request,
        client as unknown as SupabaseLike,
        serviceClient as unknown as SupabaseLike,
        storage,
        new GeminiPdfReader(process.env.GEMINI_API_KEY),
      );
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
