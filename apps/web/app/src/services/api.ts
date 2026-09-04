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
 *   upload/download protegido de documentos/PDF (TODO, see below)
 *
 * Requests default to same-origin relative paths, since /api and /app are
 * built and deployed together (see scripts/build.mjs, vercel.json). Set
 * VITE_API_BASE_URL only to point this app at a *different* deployment (e.g.
 * a preview backend) — it's a public, non-secret value.
 *
 * Every call attaches the signed-in user's Supabase session token, when one
 * exists (see services/supabaseClient.ts). Callers are responsible for
 * checking `useSession()` first and falling back to local mock data (see
 * ./storage.ts and ./calculations.ts) when there's no session — this module
 * does not invent a fake "success" response from the backend.
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
    throw new ApiError(response.status, detail || `${method} ${path} failed with ${response.status}`);
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

/** GET /api/projects — requires a real workspace id (see apps/api/src/projects/routes.ts). */
export function listProjects(workspaceId: string) {
  return request<unknown[]>("/api/projects", { workspaceId });
}

/** POST /api/projects */
export function createProject(workspaceId: string, project: unknown) {
  return request<unknown>("/api/projects", { method: "POST", workspaceId, body: project });
}

/** GET /api/projects/:id */
export function getProject(workspaceId: string, id: string) {
  return request<unknown>(`/api/projects/${id}`, { workspaceId });
}

/** PATCH /api/projects/:id */
export function updateProject(workspaceId: string, id: string, patch: unknown) {
  return request<unknown>(`/api/projects/${id}`, { method: "PATCH", workspaceId, body: patch });
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

// TODO(joshua-backend): wire document upload/download once this app can reach
// POST /api/projects/:id/files and POST /api/project-files/:id/download (see
// apps/api/src/projects/routes.ts). The Plans step currently keeps uploaded
// plan PDFs as in-memory object URLs via StorageService — no server round trip.
