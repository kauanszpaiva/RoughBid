import { PDFDocument } from 'pdf-lib';
import { ProjectApiError, assertPlanStoragePath } from '../projects/service.ts';
import type { AiPlanObjectStorage } from '../ai-plan/service.ts';
import { isConfiguredValue } from '../ai-plan/readiness.ts';
import { createPlanSetManifest } from '../takeoff-v2/preflight.ts';
import { splitPhysicalPages } from '../takeoff-v2/claude-provider.ts';
import { buildPaidFullContract, hashPaidFullContract, validatePaidFullContract, type PaidFullContract } from './full-takeoff-pricing.ts';
import { downloadPlan, PROJECT_TRADES } from './project-preflight.ts';
import { databaseValue, type ServerDatabase } from './project-payments.ts';
import type { ProjectMembership } from '../../../../packages/domain/src/project-charge.ts';
import { createFullTakeoffV2Queue, ensurePaidFullRun, FULL_TAKEOFF_V2_DURABLE_VERSION } from '../takeoff-v2/durable.ts';

export const FULL_CHECKOUT_STRIPE_VERSION = '2026-08-26.dahlia';
type Env = Record<string, string | undefined>;
async function requireWorkspaceAiConsent(db: ServerDatabase, workspaceId: string): Promise<void> {
  const workspace = databaseValue(await db.from('workspaces').select('ai_processing_consented_at').eq('id', workspaceId).maybeSingle());
  if (!workspace?.ai_processing_consented_at) throw new ProjectApiError(403, 'Workspace AI processing consent is required before purchasing a Full reading.');
}
export async function startPaidFullAfterPayment(db: ServerDatabase, env: Env, quoteId: string): Promise<void> {
  if (!isConfiguredValue(env.REDIS_URL)) throw new ProjectApiError(503, 'Paid Full reading is saved; its worker is temporarily unavailable.');
  const queue = await createFullTakeoffV2Queue(env.REDIS_URL);
  try { await ensurePaidFullRun(db, queue, quoteId); }
  finally { await queue.close?.(); }
}
export async function requirePaidFullReadiness(db: ServerDatabase, env: Env): Promise<void> {
  if (!isConfiguredValue(env.REDIS_URL)) throw new ProjectApiError(503, 'A live Full reading worker is not available.');
  const live = databaseValue(await db.rpc('full_takeoff_v2_worker_available', { p_version: FULL_TAKEOFF_V2_DURABLE_VERSION }));
  if (live !== true) throw new ProjectApiError(503, 'A compatible Full reading worker is not available.');
  const queue = await createFullTakeoffV2Queue(env.REDIS_URL);
  try {
    if (!await queue.isWorkerAvailable()) throw new ProjectApiError(503, 'A live Full reading worker is not available.');
  } finally { await queue.close?.(); }
}
export async function requirePaidFullCapacity(db: ServerDatabase, reserveUsd: number, env: Env, quoteId: string | null = null): Promise<void> {
  // The total remains the immutable purchase obligation. SQL verifies the
  // configured cap can admit one call; even the first call may durably wait.
  const available = databaseValue(await db.rpc('paid_full_capacity_ready', { p_reserve_usd: reserveUsd,
    p_call_reservation_usd: Number(env.TAKEOFF_V2_CALL_RESERVATION_USD), p_quote_id: quoteId }));
  if (available !== true) throw new ProjectApiError(503, 'Full reading purchase is temporarily unavailable because the processing capacity cannot support this reading. Please contact support. No payment was started.');
}
export async function requirePaidFullScheduling(db: ServerDatabase, contract: PaidFullContract, now = Date.now()): Promise<void> {
  return requirePaidFullBatchScheduling(db, [contract], now);
}
export async function requirePaidFullBatchScheduling(db: ServerDatabase, contracts: readonly PaidFullContract[], now = Date.now()): Promise<void> {
  const policy = databaseValue(await db.rpc('paid_full_capacity_policy', {}));
  const cap = policy?.spend_cap_usd, windowSeconds = policy?.rolling_window_seconds, callReservation = policy?.call_reservation_usd;
  const maximumCalls = contracts.reduce((sum, contract) => sum + contract.maximumCalls, 0);
  const expiry = Math.min(...contracts.map(contract => Date.parse(contract.pricing.expiresAt)));
  if (!contracts.length || !Number.isFinite(now) || !Number.isFinite(expiry) || !Number.isSafeInteger(maximumCalls) || maximumCalls < 1
    || policy?.enabled !== true || typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0
    || typeof windowSeconds !== 'number' || !Number.isFinite(windowSeconds) || windowSeconds <= 0
    || typeof callReservation !== 'number' || !Number.isFinite(callReservation) || callReservation <= 0
    || contracts.some(contract => !Number.isSafeInteger(contract.maximumCalls) || contract.maximumCalls < 1
      || !Number.isFinite(contract.pricing.operatingReserveUsd) || contract.pricing.operatingReserveUsd <= 0
      || Math.abs(contract.pricing.operatingReserveUsd / contract.maximumCalls - callReservation) > .000001)) {
    throw new ProjectApiError(503, 'The Full reading processing schedule is unavailable. No payment was started.');
  }
  const callsPerWindow = Math.floor(cap / callReservation);
  const minimumWindows = Math.ceil(maximumCalls / callsPerWindow);
  const available = policy?.available_usd;
  const initialWait = typeof available !== 'number' || !Number.isFinite(available) || available < callReservation ? 1 : 0;
  const earliestFinalWindow = now + (minimumWindows - 1 + initialWait) * windowSeconds * 1000;
  // Reserve an initial full window for currently saturated or unknown capacity. Later
  // competing work can still delay completion; this bound is not a deadline.
  if (callsPerWindow < 1 || !Number.isFinite(earliestFinalWindow) || earliestFinalWindow >= expiry) {
    throw new ProjectApiError(503, 'This complete document cannot fit within the current processing schedule and price validity. Please contact support. No payment was started.');
  }
}
export async function requirePaidFullDailyCapacity(db: ServerDatabase, userId: string, quoteId: string | null = null): Promise<void> {
  const available = databaseValue(await db.rpc('paid_full_daily_capacity_ready', { p_user_id: userId, p_quote_id: quoteId }));
  if (available !== true) throw new ProjectApiError(503, 'Your current reading capacity is full. Review existing purchases or try again after capacity becomes available. No payment was started.');
}
export async function preparePaidFullQuote(input: { db: ServerDatabase; env: Env; fetcher: typeof fetch; storage: AiPlanObjectStorage;
  userId: string; workspaceId: string; projectId: string; fileId: unknown; membership: () => Promise<ProjectMembership>; ready: () => Promise<void>; newOrderChild?: boolean }) {
  const { db, env, fetcher, storage, userId, workspaceId, projectId, fileId } = input;
  if (env.PAID_FULL_ENABLED !== 'true' || env.STRIPE_MODE !== 'live') throw new ProjectApiError(503, 'Full reading purchase is not enabled.');
  await requireWorkspaceAiConsent(db, workspaceId);
  await input.ready();
  await requirePaidFullDailyCapacity(db, userId);
  if (typeof fileId !== 'string' || !fileId) throw new ProjectApiError(400, 'Select an uploaded plan.');
  const file = databaseValue(await db.from('project_files').select('id,storage_path,processing_status,page_count').eq('workspace_id', workspaceId).eq('project_id', projectId).eq('id', fileId).maybeSingle());
  if (!file) throw new ProjectApiError(404, 'Plan not found.');
  assertPlanStoragePath(file.storage_path, workspaceId, projectId, fileId);
  if (['uploading', 'failed'].includes(file.processing_status)) throw new ProjectApiError(409, 'Wait for the upload to finish.');
  const bytes = await downloadPlan((await storage.presign('GET', file.storage_path, { expiresIn: 300 })).url, fetcher);
  // Reject known provider limits before quoting. This deterministic inspection
  // never sends a PDF to an AI provider and includes every physical page.
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false }); }
  catch { throw new ProjectApiError(415, 'Upload an unlocked, readable PDF.'); }
  if (pdf.getPageCount() < 1 || pdf.getPageCount() > 200) throw new ProjectApiError(413, 'Full reading supports 1 to 200 physical pages.');
  const manifest = await createPlanSetManifest(bytes);
  if (Number.isInteger(file.page_count) && file.page_count > 0 && file.page_count !== manifest.physicalPageCount) throw new ProjectApiError(409, 'The saved page count does not match the PDF.');
  const membership = await input.membership();
  const contract = buildPaidFullContract({ manifest, membership, env });
  const pages = await splitPhysicalPages(bytes, manifest);
  if ([...pages.values()].some(page => page.byteLength > 10 * 1024 * 1024)) throw new ProjectApiError(413, 'A physical PDF page exceeds the supported reading size.');
  await requirePaidFullScheduling(db, contract);
  await requirePaidFullCapacity(db, contract.pricing.operatingReserveUsd, env);
  return databaseValue(await db.rpc('create_paid_full_quote', { p_input: {
    workspace_id: workspaceId, project_id: projectId, file_id: fileId, user_id: userId, mode: 'full_v2',
    ...(input.newOrderChild ? { new_order_child: true } : {}),
    file_sha256: manifest.fileSha256, page_count: manifest.physicalPageCount, trades: [...PROJECT_TRADES],
    scope: 'All physical pages of this saved revision; seven evidence stages and all 2 by 2 regions.',
    amount_cents: contract.pricing.amountCents, cost_cents: contract.pricing.costCents, membership,
    pricing_version: contract.pricing.version, livemode: true, full_contract: contract, full_contract_hash: hashPaidFullContract(contract),
  } }));
}
export async function openPaidFullCheckout(input: { db: ServerDatabase; env: Env; fetcher: typeof fetch;
  userId: string; workspaceId: string; projectId: string; quoteId: string; consent: unknown; ready: () => Promise<void> }) {
  const { db, env, fetcher, userId, workspaceId, projectId, quoteId } = input;
  const q = databaseValue(await db.from('project_reading_quotes').select('*').eq('id', quoteId).eq('workspace_id', workspaceId).eq('project_id', projectId).maybeSingle());
  if (!q || q.mode !== 'full_v2') throw new ProjectApiError(404, 'Full reading quote not found.');
  if (q.purchase_order_id) throw new ProjectApiError(409, 'This PDF belongs to a combined purchase. Open that purchase to continue.');
  if (q.purchase_order_id) throw new ProjectApiError(409, 'This PDF belongs to a saved purchase. Open that purchase to pay for all selected PDFs together.');
  if (q.user_id !== userId || q.livemode !== true || q.status !== 'quoted' || !Number.isFinite(Date.parse(q.expires_at)) || Date.parse(q.expires_at) <= Date.now() + 30_000) throw new ProjectApiError(409, 'Refresh the Full reading quote or check its payment status.');
  await requireWorkspaceAiConsent(db, workspaceId);
  const contract = validatePaidFullContract(q.full_contract as PaidFullContract, env);
  if (hashPaidFullContract(contract) !== q.full_contract_hash || q.amount_cents !== contract.pricing.amountCents || q.cost_cents !== contract.pricing.costCents
    || q.currency !== 'usd' || q.page_count !== contract.manifest.physicalPageCount || q.file_sha256 !== contract.manifest.fileSha256) throw new ProjectApiError(409, 'The saved Full quote does not match its execution contract.');
  // Reject a certainly invalid new Checkout before creating a capacity hold.
  // An existing session keeps its original, already accepted Stripe expiry.
  if (!q.stripe_session_id && (Date.parse(q.expires_at) < Date.now() + 30 * 60_000 || Date.parse(q.expires_at) > Date.now() + 24 * 60 * 60_000
    || Date.parse(q.expires_at) >= Date.parse(contract.pricing.expiresAt))) throw new ProjectApiError(409, 'Refresh the Full reading quote before paying.');
  const consent = input.consent as { confirmed?: unknown; contract_hash?: unknown } | null;
  if (!consent || consent.confirmed !== true || consent.contract_hash !== q.full_contract_hash) throw new ProjectApiError(400, 'Review this Full reading price and explicitly accept the current scope before paying.');
  await input.ready();
  await requirePaidFullDailyCapacity(db, userId, q.id);
  await requirePaidFullScheduling(db, contract);
  await requirePaidFullCapacity(db, contract.pricing.operatingReserveUsd, env, q.id);
  const key = env.STRIPE_SECRET_KEY;
  let appUrl: URL;
  try { appUrl = new URL(env.APP_URL ?? ''); } catch { throw new ProjectApiError(503, 'Checkout is not configured.'); }
  if (!isConfiguredValue(key) || !/^(?:sk|rk)_live_/.test(key) || !isConfiguredValue(env.STRIPE_WEBHOOK_SECRET)
    || !/^acct_[A-Za-z0-9]+$/.test(env.STRIPE_EXPECTED_ACCOUNT_ID ?? '') || appUrl.protocol !== 'https:' || appUrl.username || appUrl.password) throw new ProjectApiError(503, 'Live checkout is not configured.');
  const headers = { authorization: `Bearer ${key}`, 'Stripe-Version': FULL_CHECKOUT_STRIPE_VERSION };
  const accountResponse = await fetcher('https://api.stripe.com/v1/account', { headers, signal: AbortSignal.timeout(10_000) });
  const account = await accountResponse.json() as { id?: unknown; charges_enabled?: unknown };
  if (!accountResponse.ok || account.id !== env.STRIPE_EXPECTED_ACCOUNT_ID || account.charges_enabled !== true) {
    throw new ProjectApiError(503, 'Live checkout is not configured for this application.');
  }
  databaseValue(await db.rpc('accept_paid_full_quote', { p_quote_id: q.id, p_user_id: userId, p_workspace_id: workspaceId,
    p_project_id: projectId, p_contract_hash: q.full_contract_hash }));
  if (q.stripe_session_id) {
    const response = await fetcher(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(q.stripe_session_id)}`, { headers });
    const session = await response.json() as any;
    if (!response.ok || session.status !== 'open' || !session.url || session.livemode !== true || session.mode !== 'payment'
      || session.amount_total !== q.amount_cents || session.currency !== q.currency || session.metadata?.roughbid_quote_id !== q.id
      || session.metadata?.roughbid_contract_hash !== q.full_contract_hash) throw new ProjectApiError(409, 'Checkout has closed or changed. Check payment status in your project.');
    return { url: session.url as string };
  }
  const returnUrl = (payment: string) => {
    const url = new URL('/app/', appUrl);
    for (const [name, value] of Object.entries({ payment, workspace_id: workspaceId, project_id: projectId, file_id: q.file_id,
      quote_id: q.id, reading_mode: 'full_v2' })) url.searchParams.set(name, String(value));
    return url.href;
  };
  const params = new URLSearchParams({ mode: 'payment', integration_identifier: 'roughbid_full_qvlnsrta',
    'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(q.amount_cents),
    'line_items[0][price_data][product_data][name]': `RoughBid Full — ${q.page_count} physical pages`, 'line_items[0][quantity]': '1',
    'metadata[roughbid_quote_id]': q.id, 'metadata[roughbid_mode]': 'full_v2', 'metadata[roughbid_contract_hash]': q.full_contract_hash,
    'metadata[workspace_id]': workspaceId, 'metadata[project_id]': projectId,
    'payment_intent_data[metadata][roughbid_quote_id]': q.id, 'payment_intent_data[metadata][roughbid_mode]': 'full_v2',
    'payment_intent_data[metadata][roughbid_contract_hash]': q.full_contract_hash,
    client_reference_id: userId, expires_at: String(Math.floor(Date.parse(q.expires_at) / 1000)),
    success_url: returnUrl('returned'), cancel_url: returnUrl('canceled') });
  const response = await fetcher('https://api.stripe.com/v1/checkout/sessions', { method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `roughbid-full-quote-${q.id}` }, body: params });
  const session = await response.json() as { id?: string; url?: string; error?: { type?: unknown; code?: unknown; param?: unknown } };
  if (!response.ok || !session.id || !session.url) {
    const diagnostic = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_[\].-]{1,120}$/.test(value) ? value : null;
    console.error('Stripe Full checkout creation failed', { quoteId: q.id, status: response.status,
      requestId: diagnostic(response.headers.get('request-id')), type: diagnostic(session.error?.type), code: diagnostic(session.error?.code), param: diagnostic(session.error?.param) });
    throw new ProjectApiError(502, 'Could not open secure checkout. Please try again.');
  }
  databaseValue(await db.from('project_reading_quotes').update({ stripe_session_id: session.id }).eq('id', q.id).eq('mode', 'full_v2').eq('full_contract_hash', q.full_contract_hash));
  return { url: session.url };
}
