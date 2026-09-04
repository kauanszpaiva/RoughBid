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
 *   POST /api/estimates/recalculate
 *   POST /api/projects/:id/documents/upload-url
 *   POST /api/documents/:id/complete
 *   POST /api/documents/:id/download-url
 *   POST /api/projects/:id/ai-plan-readings
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

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  workspaceId?: string;
  body?: unknown;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", workspaceId, body } = options;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (workspaceId) headers["x-workspace-id"] = workspaceId;
  const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined;
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

/** GET /api/health */
export function getHealth() {
  return request<{ status: string; service: string }>("/api/health");
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

export type Workspace = { id: string; name: string; createdBy: string; createdAt: string };
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

export function createAiPlanReading(workspaceId: string, projectId: string, input: { file_id: string; mode?: "quick" | "detailed"; scope?: string }) {
  return request<{ id: string; status: "queued" | "processing" | "needs_review" | "ready" | "failed" }>(`/api/projects/${projectId}/ai-plan-readings`, {
    method: "POST",
    workspaceId,
    body: input,
  });
}

export function createDocumentDownloadUrl(workspaceId: string, fileId: string) {
  return request<{ url: string; method: "GET"; headers: Record<string, string>; expiresAt: string }>(`/api/documents/${fileId}/download-url`, {
    method: "POST",
    workspaceId,
  });
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
