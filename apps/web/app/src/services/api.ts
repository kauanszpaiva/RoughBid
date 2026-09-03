/**
 * Single integration point between this app (apps/web/app) and the real
 * backend (apps/api). Nothing else in this app should call `fetch` against
 * the backend directly — funnel every call through here so API_BASE_URL,
 * headers and error handling stay in one place, per the integration contract:
 *
 *   GET  /api/health
 *   GET  /api/projects            POST /api/projects
 *   GET  /api/projects/:id        PATCH /api/projects/:id
 *   POST /api/estimates/recalculate
 *   upload/download protegido de documentos/PDF (TODO, see below)
 *
 * VITE_API_BASE_URL is a public, non-secret value (no keys/passwords). When
 * it is unset, every call below throws ApiNotConfiguredError so callers can
 * fall back to the local mock in ./storage.ts and ./calculations.ts — this
 * app does not invent a fake "success" response from the backend.
 */

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Thrown when VITE_API_BASE_URL isn't set yet — callers should use mock data. */
export class ApiNotConfiguredError extends Error {
  constructor(path: string) {
    super(`VITE_API_BASE_URL is not set; cannot call ${path}. Falling back to local mock data.`);
    this.name = "ApiNotConfiguredError";
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  workspaceId?: string;
  body?: unknown;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!API_BASE_URL) throw new ApiNotConfiguredError(path);
  const { method = "GET", workspaceId, body } = options;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (workspaceId) headers["x-workspace-id"] = workspaceId;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    credentials: "include",
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
 * (mock/offline path); prefer this once the app carries a real session.
 */
export function recalculateEstimate(input: unknown) {
  return request<unknown>("/api/estimates/recalculate", { method: "POST", body: input });
}

// TODO(joshua-backend): wire document upload/download once this app can reach
// POST /api/projects/:id/files and POST /api/project-files/:id/download (see
// apps/api/src/projects/routes.ts). The Plans step currently keeps uploaded
// plan PDFs as in-memory object URLs via StorageService — no server round trip.
