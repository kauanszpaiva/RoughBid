/**
 * Single integration point between this app (apps/web/app) and the real
 * backend (apps/api, deployed as Vercel Edge Functions under /api — see
 * /api/[...path].ts and apps/api/src/http/handler.ts). Nothing else in this
 * app should call `fetch` against the backend directly — funnel every call
 * through here so headers and error handling stay in one place, per the
 * integration contract:
 *
 *   GET  /api/health
 *   GET  /api/auth/bootstrap
 *   GET  /api/workspaces           POST /api/workspaces
 *   GET  /api/projects             POST /api/projects
 *   GET  /api/projects/:id         PATCH /api/projects/:id
 *   GET  /api/projects/:id/pricing-context
 *   PATCH /api/projects/:id/pricing-context/address
 *   POST /api/estimates/recalculate
 *   POST /api/projects/:id/documents/upload-url
 *   POST /api/documents/:id/complete
 *   POST /api/documents/:id/download-url
 *   POST /api/projects/:id/ai-plan-readings
 *   GET  /api/ai-plan-readings/:id
 *   PATCH /api/ai-plan-readings/findings/:id
 *   POST /api/workspaces/:id/ai-consent
 *
 * Requests default to same-origin relative paths, since /api and /app are
 * built and deployed together (see scripts/build.mjs, vercel.json). Set
 * VITE_API_BASE_URL only to point this app at a *different* deployment (e.g.
 * a preview backend) — it's a public, non-secret value.
 *
 * Every call attaches the signed-in user's Supabase session token, when one
 * exists (see services/supabaseClient.ts). App routes check `useSession()`
 * before rendering workspace screens; local UI state is only used after the
 * login gate and this module never invents a fake backend success response.
 */
import { supabase } from "./supabaseClient";
import { ApiError, createAuthenticatedFetch } from "./authenticatedFetch";
import type { TakeoffV2Coverage } from "../utils/takeoffCoverage";
export { ApiError } from "./authenticatedFetch";

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

const authenticatedFetch = createAuthenticatedFetch(supabase?.auth ?? null);

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  workspaceId?: string;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", workspaceId, body, rawBody, contentType = "application/json" } = options;

  const headers: Record<string, string> = { "Content-Type": contentType };
  if (workspaceId) headers["x-workspace-id"] = workspaceId;
  const response = await authenticatedFetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(path.includes("ai-plan-readings") ? 170_000 : path.endsWith("/complete") ? 120_000 : 30_000),
    ...(rawBody !== undefined ? { body: rawBody } : body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    let message = detail;
    try {
      const parsed = JSON.parse(detail) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      // Keep the raw text for non-JSON errors.
    }
    throw new ApiError(response.status, message || `${method} ${path} failed with ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function requestBlob(path: string, options: Pick<RequestOptions, "workspaceId"> = {}): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (options.workspaceId) headers["x-workspace-id"] = options.workspaceId;
  const response = await authenticatedFetch(`${API_BASE_URL}${path}`, { method: "GET", headers, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    let message = detail;
    try {
      const parsed = JSON.parse(detail) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      // Keep the raw text for non-JSON errors.
    }
    throw new ApiError(response.status, message || `GET ${path} failed with ${response.status}`);
  }
  return response.blob();
}

/** GET /api/health */
export function getHealth() {
  return request<{ status: string; service: string }>("/api/health");
}

export function getCapabilities() {
  return request<{ aiReadingAvailable: boolean; fullTakeoffV2: boolean; billing: boolean; membershipStarter: boolean; membershipPro: boolean; membershipTeam: boolean; billingPortal: boolean; marketplaceSupplierImport: boolean }>("/api/capabilities");
}

export type AuthBootstrap = {
  userId: string;
  email: string | null;
  profile: { id: string; displayName: string | null; isPlatformAdmin: boolean; createdAt: string };
};

/** GET /api/auth/bootstrap — the signed-in user's profile row. */
export function bootstrapAuth() {
  return request<AuthBootstrap>("/api/auth/bootstrap");
}

export function requestMagicLink(input: { email: string; inviteToken?: string | null; pilotInviteToken?: string | null; mode?: "sign-in" | "create-account" }) {
  return request<{ sent: true }>("/api/auth/magic-link", { method: "POST", body: input });
}

export type PilotPreset = 'sample1' | 'month1' | 'pilot60';
export type PilotAccess = {
  enrolled: boolean; active: boolean; status?: string; preset?: PilotPreset;
  workspace_id?: string; starts_at?: string; expires_at?: string;
  projects_used_7d?: number; projects_used_total?: number; projects_remaining_this_week?: number;
  reserved_cents?: number; budget_cents?: number; cohort_reserved_cents?: number; cohort_budget_cents?: number;
  limits?: { projects_per_week: number; total_projects?: number | null; max_pdf_bytes: number; max_pages: number; max_files: number; ai_attempts_per_project: number };
};
export type PilotInvitation = {
  id?: string; email: string; preset?: PilotPreset; expires_at?: string; accepted_at?: string | null; revoked_at?: string | null;
  email_status?: string; delivery_status?: string; email_sent_at?: string | null; email_error?: string | null;
  email_delivery_status?: string | null;
  enrollment_expires_at?: string | null; reserved_cents?: number; budget_cents?: number;
  invite_url?: string; skipped?: boolean; error?: string;
};
export function getPilotAccess() { return request<PilotAccess>('/api/pilot/access'); }
export function redeemPilotInvitation(token: string) { return request<{ workspace_id: string; starts_at: string; expires_at: string }>('/api/pilot/redeem', { method: 'POST', body: { token } }); }
export function listPilotInvitations() { return request<{ invitations: PilotInvitation[]; sendingConfigured: boolean; remindersConfigured: boolean; deliveryTrackingConfigured: boolean; capacity: number; cohortBudgetCents: number }>('/api/pilot/invitations'); }
export function sendPilotInvitations(emails: string[], preset: PilotPreset) { return request<{ invitations: PilotInvitation[] }>('/api/pilot/invitations', { method: 'POST', body: { emails, preset } }); }
export function revokePilotInvitation(invitationId: string) { return request<{ revoked: true }>('/api/pilot/invitations', { method: 'POST', body: { action: 'revoke', invitationId } }); }

export type Workspace = { id: string; name: string; createdBy: string; createdAt: string; aiProcessingConsentedAt: string | null; role: WorkspaceRole | null };
export type WorkspaceRole = "admin" | "estimator" | "viewer";
export type WorkspaceInvite = {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  token: string;
  emailSent?: boolean;
  emailError?: string;
};

/** GET /api/workspaces */
export function listWorkspaces() {
  return request<Workspace[]>("/api/workspaces");
}

/** POST /api/workspaces */
export function createWorkspace(name: string) {
  return request<Workspace>("/api/workspaces", { method: "POST", body: { name } });
}

/** POST /api/workspaces/:id/invites */
export function createWorkspaceInvite(workspaceId: string, input: { email: string; role: "estimator" | "viewer" }) {
  return request<WorkspaceInvite>(`/api/workspaces/${workspaceId}/invites`, { method: "POST", body: input });
}

/** POST /api/workspace-invites/accept */
export function acceptWorkspaceInvite(token: string) {
  return request<{ workspaceId: string; role: WorkspaceRole }>("/api/workspace-invites/accept", { method: "POST", body: { token } });
}

export type RemoteProject = {
  id: string;
  name: string;
  status?: "draft" | "active" | "archived";
  project_number?: string | null;
  address_text?: string | null;
  client_name?: string | null;
  project_type?: string | null;
  jurisdiction_state?: "CT" | "MA" | "ME" | "NH" | "RI" | "VT" | null;
  municipality?: string | null;
  postal_code?: string | null;
  permit_date?: string | null;
  app_state?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
};

/** GET /api/projects — requires a real workspace id (see apps/api/src/projects/routes.ts). */
export function listProjects(workspaceId: string) {
  return request<RemoteProject[]>("/api/projects", { workspaceId });
}

/** POST /api/projects */
export function createProject(workspaceId: string, project: unknown) {
  return request<RemoteProject>("/api/projects", { method: "POST", workspaceId, body: project });
}

/** GET /api/projects/:id */
export function getProject(workspaceId: string, id: string) {
  return request<RemoteProject>(`/api/projects/${id}`, { workspaceId });
}

/** PATCH /api/projects/:id */
export function updateProject(workspaceId: string, id: string, patch: unknown) {
  return request<RemoteProject>(`/api/projects/${id}`, { method: "PATCH", workspaceId, body: patch });
}

/** DELETE /api/projects/:id */
export function deleteProject(workspaceId: string, id: string) {
  return request<RemoteProject>(`/api/projects/${id}`, { method: "DELETE", workspaceId });
}

export type PlanProjectAddressEvidence = {
  project_name: string | null;
  street_address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  building_lot_unit: string | null;
  page_number: number;
  source_excerpt: string;
  confidence: number;
};

export type PricingContext = {
  project_id: string;
  workspace_id: string;
  project_address_text: string | null;
  plan_address: PlanProjectAddressEvidence | null;
  pricing_address: Record<string, unknown> | null;
  address_source: "plan" | "project" | "confirmed_override" | null;
  address_status: "missing" | "clear" | "needs_resolution" | "resolved";
  plan_file_id?: string | null;
  plan_job_id?: string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
};

export function getPricingContext(workspaceId: string, projectId: string) {
  return request<PricingContext>(`/api/projects/${projectId}/pricing-context`, { workspaceId });
}

export function resolvePricingAddress(workspaceId: string, projectId: string, choice: "plan" | "project") {
  return request<PricingContext>(`/api/projects/${projectId}/pricing-context/address`, {
    method: "PATCH",
    workspaceId,
    body: { choice },
  });
}

/**
 * POST /api/estimates/recalculate — the authoritative, server-verified totals.
 * `input` matches ProjectCalculationInput from packages/domain/src/calculation.ts.
 * calculations.ts#calculateProjectFinancials runs the same engine locally today
 * so every screen has real numbers immediately; prefer this call once a
 * screen needs a server-verified total instead of the local computation.
 */
export function recalculateEstimate(input: unknown) {
  return request<unknown>("/api/estimates/recalculate", { method: "POST", body: input });
}

export type RemoteProjectFile = {
  id: string;
  original_name: string;
  byte_size: number;
  processing_status: "uploading" | "queued" | "processing" | "ready" | "failed";
  page_count?: number | null;
};
export type PresignedUpload = { url: string; method: "PUT"; headers: Record<string, string>; expiresAt: string };

export function beginDocumentUpload(workspaceId: string, projectId: string, input: { name: string; contentType: string; byteSize: number }) {
  return request<{ file: RemoteProjectFile; upload: PresignedUpload }>(`/api/projects/${projectId}/documents/upload-url`, {
    method: "POST",
    workspaceId,
    body: input,
  });
}

export function completeDocumentUpload(workspaceId: string, fileId: string) {
  return request<RemoteProjectFile>(`/api/documents/${fileId}/complete`, { method: "POST", workspaceId });
}

export type PlanReadingJobStatus = "queued" | "processing" | "needs_review" | "ready" | "failed";
export type PlanReadingFindingType = "measurement" | "symbol" | "room" | "scope_note" | "risk" | "question" | "material" | "labor";
export type PlanReadingFindingStatus = "needs_review" | "accepted" | "rejected";

export type PricedComponent = {
  category: "material" | "labor";
  quantity: number;
  unit: string;
  unitRate: number;
  cost: number;
};

export type PlanReadingFinding = {
  id: string;
  page_number: number | null;
  finding_type: PlanReadingFindingType;
  label: string;
  value_text: string | null;
  quantity: number | null;
  unit: string | null;
  confidence: number;
  geometry: { pricing?: PricedComponent[] } & Record<string, unknown>;
  source_excerpt: string | null;
  status: PlanReadingFindingStatus;
};

export type PlanReadingJob = {
  id: string;
  status: PlanReadingJobStatus;
  processing_error: string | null;
  output_summary: {
    page_strategy?: 'sheet-v1';
    physical_page_number?: number;
    physical_page_count?: number;
    sheet_count?: number;
    detected_trade_scope?: string[];
    scale_status?: "detected" | "missing" | "conflicting";
    pricing?: { materialCost: number; laborCost: number; directCost: number; pricedFindings: number; unpricedFindings: number };
    takeoff_v2?: TakeoffV2Coverage;
  };
  plan_reading_findings: PlanReadingFinding[];
};

/**
 * POST /api/projects/:id/ai-plan-readings — extracts evidence from a paid plan
 * synchronously; the response already carries the finished job (status
 * needs_review/failed) and every finding. There is nothing to poll for in
 * the common case, but getAiPlanReading below still works for reloading a
 * past job.
 */
/**
 * GET /api/projects/:id/ai-plan-entitlement — whether THIS workspace may run a
 * free reading. Authenticated and workspace-scoped: a customer workspace always
 * receives false, and the POST route re-checks the allowlist server-side.
 */
export function getAiPlanEntitlement(workspaceId: string, projectId: string) {
  return request<{ freeReadingAvailable: boolean; pilotActive?: boolean }>(`/api/projects/${projectId}/ai-plan-entitlement`, { workspaceId });
}

export function createAiPlanReading(workspaceId: string, projectId: string, input: { file_id: string; quote_id?: string; mode?: "quick" | "detailed" | "full_v2"; trades?: string[]; scope?: string }) {
  return request<PlanReadingJob>(`/api/projects/${projectId}/ai-plan-readings`, {
    method: "POST",
    workspaceId,
    body: input,
  });
}

/** GET /api/ai-plan-readings/:id — job status plus every finding recorded so far. */
export function getAiPlanReading(workspaceId: string, jobId: string) {
  return request<PlanReadingJob>(`/api/ai-plan-readings/${jobId}`, { workspaceId });
}

/** PATCH /api/ai-plan-readings/findings/:id — accept or reject one finding. */
export function setPlanReadingFindingStatus(workspaceId: string, findingId: string, status: PlanReadingFindingStatus) {
  return request<PlanReadingFinding>(`/api/ai-plan-readings/findings/${findingId}`, {
    method: "PATCH",
    workspaceId,
    body: { status },
  });
}

/** POST /api/workspaces/:id/ai-consent — owner accepts sending plan files to AI. */
export function grantWorkspaceAiConsent(workspaceId: string) {
  return request<Workspace>(`/api/workspaces/${workspaceId}/ai-consent`, { method: "POST" });
}

export function createDocumentDownloadUrl(workspaceId: string, fileId: string) {
  return request<{ url: string; method: "GET"; headers: Record<string, string>; expiresAt: string }>(`/api/documents/${fileId}/download-url`, {
    method: "POST",
    workspaceId,
  });
}

export function createDocumentPreviewUrl(workspaceId: string, fileId: string) {
  return request<{ url: string; method: "GET"; headers: Record<string, string>; expiresAt: string }>(`/api/documents/${fileId}/download-url`, {
    method: "POST",
    workspaceId,
    body: { disposition: "inline" },
  });
}

export async function createDocumentPreviewObjectUrl(workspaceId: string, fileId: string) {
  const preview = await createDocumentPreviewUrl(workspaceId, fileId);
  const response = await fetch(preview.url, { method: preview.method, headers: preview.headers, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new ApiError(response.status, `PDF preview failed with ${response.status}`);
  }
  const pdf = await response.blob();
  return URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
}

export type ClientProposalPayload = {
  projectName: string;
  projectAddress?: string;
  projectType?: string;
  clientName: string;
  totalAmount: number;
  validForDays: number;
  lineItems: Array<{ name: string; quantity: number; unit: string; price: number }>;
  terms: string[];
};

export type CreatedClientProposal = {
  id: string;
  token: string;
  title: string;
  client_name: string;
  total_amount: number;
  status: string;
  expires_at: string;
};

export type PublicClientProposal = {
  proposal_id: string;
  title: string;
  client_name: string;
  client_email: string | null;
  total_amount: number;
  status: "sent" | "viewed" | "signed";
  expires_at: string;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  signed_at: string | null;
  signature_name: string | null;
  public_payload: ClientProposalPayload;
};

export function createClientProposal(workspaceId: string, projectId: string, input: {
  title: string;
  clientName: string;
  clientEmail?: string | null;
  totalAmount: number;
  publicPayload: ClientProposalPayload;
  expiresInDays?: number;
}) {
  return request<CreatedClientProposal>(`/api/projects/${projectId}/client-proposals`, {
    method: "POST",
    workspaceId,
    body: input,
  });
}

export function getClientProposal(token: string) {
  return request<PublicClientProposal>(`/api/client-proposals/${encodeURIComponent(token)}`);
}

export function signClientProposal(token: string, signerName: string) {
  return request<{ proposal_id: string; proposal_status: "signed"; signed_at: string; signature_name: string }>(
    `/api/client-proposals/${encodeURIComponent(token)}/sign`,
    { method: "POST", body: { signerName } },
  );
}

export type BillingPriceKey =
  | "plan_starter"
  | "plan_pro"
  | "plan_team"
  | "project_small"
  | "project_standard"
  | "project_large"
  | "project_complex"
  | "marketplace_new_england_codes"
  | "marketplace_regional_material_prices"
  | "marketplace_labor_benchmarks"
  | "marketplace_supplier_import";

export function createBillingCheckout(priceKey: BillingPriceKey, workspaceId?: string) {
  return request<{ url: string }>("/api/billing/checkout", {
    method: "POST",
    ...(workspaceId ? { workspaceId } : {}),
    body: {
      priceKey,
      successUrl: `${window.location.origin}/app/`,
      cancelUrl: `${window.location.origin}/app/`,
    },
  });
}

export type MarketplaceCatalogItem={id:string;priceKey:BillingPriceKey;name:string;priceCents:number;cadence:'month';description:string;
  availability:'available'|'coming_soon';entitled:boolean;checkoutAvailable:boolean};
export type MarketplaceCatalog={pricingVersion:string;items:MarketplaceCatalogItem[]};
export function getMarketplaceCatalog(workspaceId:string){return request<MarketplaceCatalog>('/api/marketplace/catalog',{workspaceId});}

export function importSupplierPrices(workspaceId: string, csv: string) {
  return request<{ materials: import('../types').MaterialItem[] }>('/api/marketplace/supplier-import', {
    method: 'POST', workspaceId, rawBody: csv, contentType: 'text/csv;charset=utf-8',
  });
}

export function createBillingPortal() {
  return request<{ url: string }>("/api/billing/portal", { method: "POST", body: { returnUrl: `${window.location.origin}/app/` } });
}

export type ReadingQuote = { id: string; project_id: string; file_id: string; amount_cents: number; currency: string;
  page_count: number; trades: string[]; scope: string; status: 'quoted'|'paid'|'processing'|'complete'|'failed'|'revoked';
  attempts: number; max_attempts: number; job_id: string|null; expires_at: string; membership: string };
export function getReadingQuote(workspaceId: string, projectId: string, fileId: string, scope: string, trades?: string[]) {
  return request<ReadingQuote>(`/api/projects/${projectId}/reading-quote`,{method:'POST',workspaceId,body:{file_id:fileId,scope,...(trades ? {trades} : {})}});
}
export function getSavedReadingQuote(workspaceId: string, projectId: string, fileId: string, quoteId?: string) {
  const query = new URLSearchParams({ file_id: fileId, ...(quoteId ? { quote_id: quoteId } : {}) });
  return request<ReadingQuote | null>(`/api/projects/${projectId}/reading-quote?${query}`, { workspaceId });
}
export function payForReading(workspaceId: string, projectId: string, quoteId: string) {
  return request<{url:string}>(`/api/projects/${projectId}/reading-checkout`,{method:'POST',workspaceId,body:{quote_id:quoteId}});
}

export type PageReviewInventory = {
  strategy: 'sheet-v1'; fileId: string; sourceSha256: string; totalPages: number;
  scope: string; trades: string[]; completeTakeoffVerified: false;
  pages: Array<{ pageNumber: number; jobId: string | null; status: PlanReadingJobStatus | 'not_started'; processingError: string | null; findingCount: number | null }>;
};
/** Read-only: checks the actual PDF and restores persisted page reviews. */
export function getPageReviewInventory(workspaceId: string, projectId: string, fileId: string, scope: string, trades: string[]) {
  const query = new URLSearchParams({ file_id: fileId, scope });
  trades.forEach(trade => query.append('trade', trade));
  return request<PageReviewInventory>(`/api/projects/${projectId}/ai-plan-readings?${query}`, { workspaceId });
}
/** One explicit, metered physical-page request. No automatic POST retry. */
export function startPhysicalPageReading(workspaceId: string, projectId: string, inventory: PageReviewInventory, pageNumber: number) {
  return request<PlanReadingJob>(`/api/projects/${projectId}/ai-plan-readings`, { method: 'POST', workspaceId,
    body: { file_id: inventory.fileId, source_sha256: inventory.sourceSha256, page_number: pageNumber,
      mode: 'detailed', scope: inventory.scope, trades: inventory.trades } });
}
