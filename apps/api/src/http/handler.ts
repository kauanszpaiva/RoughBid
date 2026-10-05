import { handleOwnerUsageRequest } from '../owner-usage/routes.ts';
import { ProjectPayments, handleProjectPayment } from '../billing/project-payments.ts';
import { createClient } from '@supabase/supabase-js';
import { handleAuthBootstrapRequest, handleMagicLinkRequest } from '../auth/routes.ts';
import { handleWorkspacesRequest } from '../workspaces/routes.ts';
import { handlePilotRequest } from '../pilot/routes.ts';
import { handlePilotReminders, handleResendWebhook } from '../pilot/notifications.ts';
import { PilotPlanReader, requirePilotReaderConfig } from '../ai-plan/pilot-reader.ts';
import { handleProjectRequest } from '../projects/routes.ts';
import { handlePricingContextRequest } from '../pricing/routes.ts';
import { handleDocumentRequest } from '../documents/routes.ts';
import { createDocumentQueue, type JobQueue } from '../documents/service.ts';
import { createEstimateCalculationHandler } from '../estimates/routes.ts';
import { StripeHttpGateway, SupabaseBillingRepository } from '../billing/adapters.ts';
import { createBillingEndpointHandler } from '../billing/endpoints.ts';
import { createBillingConfigFromEnv } from '../billing/stripe.ts';
import { handleAiPlanRequest, type AiPlanRequestDependencies } from '../ai-plan/routes.ts';
import { createDurableAiPlanQueue, type DurableAiPlanQueue } from '../ai-plan/durable.ts';
import { createFullTakeoffV2Queue, type FullTakeoffV2Queue } from '../takeoff-v2/durable.ts';
import { handleClientProposalRequest } from '../proposals/routes.ts';
import { createGeminiClient, GeminiPlanReader } from '../ai-plan/gemini.ts';
import { PLAN_READING_UNAVAILABLE, requirePlatformAdminPlanReadingConfig } from '../ai-plan/readiness.ts';
import { MultiProviderPlanReader } from '../ai-plan/multi-provider.ts';
import { buildConfiguredPlanReaders } from '../ai-plan/readers.ts';
import { runtimeCapabilities } from './capabilities.ts';
import { requireFreeProviderConfig } from '../ai-plan/free-provider.ts';
import { assertNoPaidFallback } from '../ai-plan/owner-free.ts';
import type { PlanReadingFindingsWriter } from '../ai-plan/service.ts';
import { loadObjectStorageConfig, S3ObjectStorage } from '../storage/object-storage.ts';
import { loadVercelBlobStorageConfig, VercelBlobObjectStorage } from '../storage/vercel-blob-storage.ts';
import { loadResendServerConfig, sendProposalOpenedEmail, sendProposalSignedEmail, sendWorkspaceInviteEmail } from '../email/resend.ts';
import type { AuthenticatedSupabaseClient } from '../supabase/client.ts';
import type { SupabaseLike } from '../projects/service.ts';
import { handleMarketplaceCatalog } from '../marketplace/catalog.ts';
import { handleSupplierPriceImport } from '../marketplace/supplier-import.ts';
import { handleWorkspaceCatalogRequest } from '../catalogs/routes.ts';
import { handleConstructionBudgetRequest } from '../construction-budget/routes.ts';
import { handlePhotoRequest } from '../photos/routes.ts';
import { requirePhotoTakeoffProfile } from '../photos/config.ts';
import { createPhotoTakeoffQueue, type PhotoTakeoffQueue } from '../photos/queue.ts';
import type { PhotoRequestDependencies } from '../photos/service.ts';
import type { DocumentDb } from '../documents/service.ts';
import { handleMeasurementReviewRequest, type MeasurementReviewDependencies } from '../takeoff-v2/measurement-routes.ts';
import { handleGeometryRequest } from '../geometry/routes.ts';
import { loadGeometryProfile } from '../geometry/config.ts';
import { createGeometryQueue, type GeometryQueue } from '../geometry/queue.ts';
import { createAutomaticGeometryCoordinator } from '../takeoff-v2/automatic-geometry.ts';
import { BRIDGE_PATH } from '../provider-bridge/protocol.ts';
import { routeProviderBridge } from '../provider-bridge/router.ts';

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

  if (pathname === BRIDGE_PATH) {
    try {
      const serviceKey = loadSupabaseServiceRoleKey(), url = process.env.SUPABASE_URL;
      if (!serviceKey || !url) return json({ error: 'bridge_auth_unconfigured' }, 503);
      const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const storage = process.env.BLOB_READ_WRITE_TOKEN
        ? new VercelBlobObjectStorage(loadVercelBlobStorageConfig(process.env))
        : new S3ObjectStorage(loadObjectStorageConfig(process.env));
      return routeProviderBridge(request, { db, storage, env: process.env });
    } catch { return json({ error: 'bridge_adapter_unavailable' }, 503); }
  }

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
  if (pathname === '/api/pilot/reminders' || pathname === '/api/webhooks/resend') {
    const key = loadSupabaseServiceRoleKey();
    if (!key || !process.env.SUPABASE_URL) return json({ error: 'Pilot notifications are not configured.' }, 503);
    const admin = createClient(process.env.SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return pathname === '/api/pilot/reminders'
      ? handlePilotReminders(request, admin, process.env)
      : handleResendWebhook(request, admin, process.env);
  }
  try {
    client = clientForRequest(request);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Server misconfigured' }, 500);
  }

  if (pathname === '/api/auth/bootstrap') {
    return handleAuthBootstrapRequest(request, client as unknown as AuthenticatedSupabaseClient);
  }
  if (pathname === '/api/owner-usage') {
    const key = loadSupabaseServiceRoleKey();
    if (!key || !process.env.SUPABASE_URL) return Response.json({ error: 'Usage administration is not configured.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
    const admin = createClient(process.env.SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return handleOwnerUsageRequest(request, client, admin);
  }
  if(pathname==='/api/marketplace/catalog') return handleMarketplaceCatalog(request,client as unknown as SupabaseLike,process.env);
  if(pathname==='/api/marketplace/supplier-import') return handleSupplierPriceImport(request,client as unknown as SupabaseLike,process.env);
  if (/^\/api\/workspaces\/[^/]+\/estimating-catalog$/.test(pathname)) {
    return handleWorkspaceCatalogRequest(request, client as unknown as SupabaseLike);
  }
  if (pathname.startsWith('/api/pilot/')) {
    const key = loadSupabaseServiceRoleKey();
    if (!key || !process.env.SUPABASE_URL) return json({ error: 'Pilot administration is not configured.' }, 503);
    const admin = createClient(process.env.SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return handlePilotRequest(request, client as any, admin as any, process.env);
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
  if (/^\/api\/projects\/[^/]+\/(reading-quote|reading-checkout|reading-order|reading-order-checkout)$/.test(pathname)) {
    const serviceRoleKey = loadSupabaseServiceRoleKey();
    if (!serviceRoleKey || !process.env.SUPABASE_URL) return json({error:'Project billing is not configured.'},503);
    try {
      const admin = createClient(process.env.SUPABASE_URL, serviceRoleKey, {auth:{persistSession:false,autoRefreshToken:false}});
      const payments = new ProjectPayments(admin, process.env);
      if (request.method === 'GET') return handleProjectPayment(request, client as unknown as SupabaseLike, payments);
      const storage = process.env.BLOB_READ_WRITE_TOKEN
        ? new VercelBlobObjectStorage(loadVercelBlobStorageConfig(process.env))
        : new S3ObjectStorage(loadObjectStorageConfig(process.env));
      return handleProjectPayment(request,client as unknown as SupabaseLike,payments,storage);
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
      marketplaceEnabled: process.env.BILLING_MARKETPLACE_ENABLED === 'true',
      webhookSecret: stripeWebhookSecret,
      reconcileProjectPayment: event => new ProjectPayments(createClient(supabaseUrl,supabaseServiceRoleKey,{auth:{persistSession:false,autoRefreshToken:false}}),process.env).reconcile(event),
      stripe: new StripeHttpGateway(stripeSecretKey, fetch, process.env.STRIPE_MODE === 'live' ? 'live' : 'test'),
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
  if (/^\/api\/projects\/[^/]+\/(?:construction-budget|supplier-quotes)$/.test(pathname)) {
    const key=loadSupabaseServiceRoleKey(),url=process.env.SUPABASE_URL?.trim();
    if(!key||!url)return json({error:'Documented construction budgeting persistence is not configured.'},503);
    const writer=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
    return handleConstructionBudgetRequest(request,client as unknown as SupabaseLike,writer);
  }
  if (/^\/api\/projects\/[^/]+\/geometry\//.test(pathname)) {
    const key=loadSupabaseServiceRoleKey(),url=process.env.SUPABASE_URL?.trim();
    if(!key||!url)return json({error:'Geometric evidence persistence is not configured.'},503);
    let geometryQueue:GeometryQueue|undefined;
    try{
      const storage=process.env.BLOB_READ_WRITE_TOKEN?new VercelBlobObjectStorage(loadVercelBlobStorageConfig(process.env)):new S3ObjectStorage(loadObjectStorageConfig(process.env));
      let profile:ReturnType<typeof loadGeometryProfile>;
      try{profile=loadGeometryProfile(process.env);}catch{/* Saved evidence and cancellation remain readable with dispatch closed. */}
      const needsQueue=pathname.endsWith('/capability')||request.method==='POST'&&/\/runs(?:\/[^/]+\/resume)?$/.test(pathname);
      if(profile&&needsQueue&&process.env.REDIS_URL){try{geometryQueue=await createGeometryQueue(process.env.REDIS_URL);}catch{/* Intake fails closed. */}}
      const writer=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}) as unknown as DocumentDb;
      return await handleGeometryRequest(request,client as unknown as SupabaseLike,{writer,storage,...(profile?{profile}:{}),...(geometryQueue?{queue:geometryQueue}:{})});
    }catch{return json({error:'Geometric evidence is unavailable. No provider request was started on HTTP.'},503);}
    finally{await geometryQueue?.close?.().catch(()=>{});}
  }
  if (/^\/api\/projects\/[^/]+\/photos\/(?:capability|uploads|runs|quote|checkout)(?:\/[^/]+(?:\/(?:complete|download-url|cancel|resume|review))?)?$/.test(pathname)) {
    const writerKey = loadSupabaseServiceRoleKey();
    const supabaseUrl = process.env.SUPABASE_URL?.trim();
    if (!writerKey || !supabaseUrl) return json({ error: 'Private photo processing is not configured.' }, 503);
    let photoQueue: PhotoTakeoffQueue | undefined;
    try {
      const storage = process.env.BLOB_READ_WRITE_TOKEN
        ? new VercelBlobObjectStorage(loadVercelBlobStorageConfig(process.env))
        : new S3ObjectStorage(loadObjectStorageConfig(process.env));
      // Only public model/profile attestations are needed on HTTP. Credentials
      // and image-provider requests belong to the isolated photo worker.
      let config: PhotoRequestDependencies['config'];
      try { config = requirePhotoTakeoffProfile(process.env); }
      catch { /* Existing private results/cancellation remain accessible while disabled. */ }
      const needsQueue = request.method === 'POST' && /\/runs(?:\/[^/]+\/resume)?$/.test(pathname);
      if (config && needsQueue && process.env.REDIS_URL) {
        try { photoQueue = await createPhotoTakeoffQueue(process.env.REDIS_URL); }
        catch { /* Reservation/resume fails closed without its dedicated queue. */ }
      }
      const writer = createClient(supabaseUrl, writerKey, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as DocumentDb;
      return await handlePhotoRequest(request, client as unknown as SupabaseLike, {
        writer, storage, env:process.env, ...(config ? { config } : {}), ...(photoQueue ? { queue: photoQueue } : {}),
      });
    } catch { return json({ error: 'Private photo processing is not configured.' }, 503); }
    finally { await photoQueue?.close?.().catch(() => {}); }
  }
  if (/^\/api\/takeoff-runs\/[^/]+\/measurements$/.test(pathname)) {
    const writerKey=loadSupabaseServiceRoleKey(),supabaseUrl=process.env.SUPABASE_URL?.trim();
    if(!writerKey||!supabaseUrl)return json({error:'Measurement review persistence is not configured.'},503);
    let storage:MeasurementReviewDependencies['storage'];
    try { storage=process.env.BLOB_READ_WRITE_TOKEN?new VercelBlobObjectStorage(loadVercelBlobStorageConfig(process.env)):new S3ObjectStorage(loadObjectStorageConfig(process.env)); }
    catch { /* Existing manual measurements can be reviewed without vector extraction/storage. */ }
    const writer=createClient(supabaseUrl,writerKey,{auth:{persistSession:false,autoRefreshToken:false}}) as unknown as PlanReadingFindingsWriter;
    return handleMeasurementReviewRequest(request,client as unknown as SupabaseLike,{writer,...(storage?{storage}:{})});
  }
  if (/^\/api\/projects\/[^/]+\/ai-plan-readings$/.test(pathname) || /^\/api\/projects\/[^/]+\/ai-plan-entitlement$/.test(pathname) || /^\/api\/ai-plan-readings\/[^/]+$/.test(pathname) || /^\/api\/ai-plan-readings\/findings\/[^/]+$/.test(pathname) || /^\/api\/takeoff-runs\/[^/]+(?:\/(?:cancel|restart))?$/.test(pathname)) {
    const supabaseServiceRoleKey = loadSupabaseServiceRoleKey();
    const supabaseUrl = process.env.SUPABASE_URL?.trim();
    if (!supabaseServiceRoleKey || !supabaseUrl) {
      return json({ error: 'AI plan reading is not configured.' }, 503);
    }
    let durableQueue: DurableAiPlanQueue | undefined;
    let fullTakeoffV2Queue: FullTakeoffV2Queue | undefined;
    let geometryQueue:GeometryQueue|undefined;
    try {
      const storage = process.env.BLOB_READ_WRITE_TOKEN
        ? new VercelBlobObjectStorage(loadVercelBlobStorageConfig(process.env))
        : new S3ObjectStorage(loadObjectStorageConfig(process.env));
      // One paid provider set, built by the same module the durable worker uses,
      // so a provider cannot exist on one path and silently be missing on the other.
      const { ordered: readers, configured: configuredReaders } = await buildConfiguredPlanReaders(process.env);
      let platformAdminReader: AiPlanRequestDependencies['platformAdminReader'];
      try {
        const config = requirePlatformAdminPlanReadingConfig(process.env);
        platformAdminReader = new GeminiPlanReader(await createGeminiClient(config.apiKey), [config.model]);
      } catch { /* Administrator processing stays closed until explicitly enabled. */ }
      let pilotReader: PilotPlanReader | undefined;
      try {
        const config = requirePilotReaderConfig(process.env);
        pilotReader = new PilotPlanReader(await createGeminiClient(config.apiKey));
      } catch { /* Pilot calls cannot fall through to an unrestricted reader. */ }
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
      const fullV2Request = isCreateReading && (await request.clone().json().catch(() => ({})))?.mode === 'full_v2';
      if (!readers.length && !platformAdminReader && !freeReader && !pilotReader && isCreateReading && !fullV2Request) {
        return json({ error: PLAN_READING_UNAVAILABLE }, 503);
      }
      if (isCreateReading && process.env.AI_PLAN_DURABLE_ENABLED === 'true') {
        const redisUrl = process.env.REDIS_URL?.trim();
        // Only the durable paid route requires a queue. Owner and pilot routes
        // remain synchronous and must not inherit an unrelated Redis outage.
        if (redisUrl) {
          try { durableQueue = await createDurableAiPlanQueue(redisUrl); }
          catch { /* The selected durable route will fail closed without a queue. */ }
        }
      }
      // Purchase availability checks the live queue consumer as well as the
      // persisted heartbeat. Supply that dependency on the access GET too.
      const fullAccessRequest = request.method === 'GET' && pathname.endsWith('/ai-plan-entitlement');
      if ((fullV2Request || pathname.endsWith('/restart') || fullAccessRequest) && process.env.TAKEOFF_V2_ENABLED === 'true' && process.env.REDIS_URL) {
        try { fullTakeoffV2Queue = await createFullTakeoffV2Queue(process.env.REDIS_URL); }
        catch { /* Full V2 fails closed without its dedicated queue. */ }
      }
      const reader = readers.length
        ? new MultiProviderPlanReader(readers)
        : { read: async () => { throw new Error(PLAN_READING_UNAVAILABLE); } };
      const findingsWriter = createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as PlanReadingFindingsWriter;
      let automaticGeometry:AiPlanRequestDependencies['automaticGeometry'];
      try{
        const profile=loadGeometryProfile(process.env);
        // The HTTP boundary advertises a durable fanout only. It never calls
        // Kamai/APS or performs page-by-page child reservations itself.
        if(profile){
          automaticGeometry=createAutomaticGeometryCoordinator(client as unknown as DocumentDb,{writer:findingsWriter as unknown as DocumentDb,storage,profile});
        }
      }catch{/* Explicit geometry enablement/configuration remains closed. */}
      const deps: AiPlanRequestDependencies = {
        pilotEnforcement: true,
        ...(pilotReader ? { pilotReader } : {}),
        findingsWriter,
        storage,
        reader,
        freeReader,
        paidReaderAvailable: readers.length > 0,
        ...(platformAdminReader ? { platformAdminReader } : {}),
        // Only the image-native providers consume `pageImages`. Gemini reads the
        // PDF directly, so loading images for it would be wasted bandwidth.
        pageImagesEnabled: configuredReaders.has('kimi') || configuredReaders.has('deepseek'),
        ...(durableQueue ? { durableQueue } : {}),
        ...(fullTakeoffV2Queue ? { fullTakeoffV2Queue } : {}),
        ...(automaticGeometry?{automaticGeometry}:{}),
      };
      return await handleAiPlanRequest(request, client as unknown as SupabaseLike, deps);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'AI plan reading is not configured.' }, 503);
    } finally {
      await durableQueue?.close?.().catch(() => {});
      await fullTakeoffV2Queue?.close?.().catch(() => {});
      await geometryQueue?.close?.().catch(()=>{});
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
  if (/^\/api\/projects\/[^/]+\/pricing-context(?:\/address)?$/.test(pathname)) {
    return handlePricingContextRequest(request, client as unknown as SupabaseLike);
  }
  if (pathname.startsWith('/api/projects') || pathname.startsWith('/api/project-files')) {
    return handleProjectRequest(request, client as unknown as SupabaseLike);
  }

  return json({ error: 'Not found' }, 404);
}
