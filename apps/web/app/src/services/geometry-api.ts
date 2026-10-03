export type GeometryCandidate = {
  id: string; provider: 'kamai' | 'aps'; sourceElementId: string; label: string; semanticClass: string;
  measurementKind: 'area' | 'perimeter' | 'length' | 'opening_width' | 'count'; quantity: number | null; unit: 'm2' | 'm' | 'EA';
  status: 'candidate' | 'blocked' | 'accepted' | 'rejected'; geometry: Record<string, unknown> | null;
  coordinateFrame: 'provider_blueprint' | 'native_model'; physicalPageNumber: number | null; fileSha256: string;
  source: { providerProjectId?: string; jobId?: string; uploadId?: string; blueprintId?: string; revision?: string }; reviewReasons: string[]; reviewRevision: number;
};
export type GeometryRunSummary = { id: string; provider: string; file_id: string; physical_page_number: number | null;
  file_sha256: string; status: string; error_code: string | null; created_at: string; profile_hash: string };
export type GeometryRunDetail = { run: GeometryRunSummary & { checkpoint?: Record<string, unknown> }; candidates: GeometryCandidate[];
  hasMore?: boolean; coverage: { expectedPages: number | null; verifiedPages: number[]; complete: false; reasons?: string[] } };
export type GeometryCapability = { enabled: boolean; workerReady: boolean; providerAvailability: { kamai: boolean; aps: boolean }; reason?: string };
export type GeometryReviewInput = { candidateId: string; decision: 'accepted' | 'rejected'; expectedRevision: number; requestKey: string;
  identityReviewed: true; geometryReviewed: true; duplicateReviewComplete: true; reviewNote: string };
export type GeometryRequest = <T>(path: string, options: { workspaceId: string; method?: 'POST'; body?: unknown }) => Promise<T>;
async function authenticatedGeometryRequest<T>(path: string, options: Parameters<GeometryRequest>[1]): Promise<T> {
  const { request } = await import('./api.ts'); return request<T>(path, options);
}
export function createGeometryApi(requester: GeometryRequest = authenticatedGeometryRequest) {
  const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/geometry`;
  return {
    capability: (workspaceId: string, projectId: string) => requester<GeometryCapability>(`${base(projectId)}/capability`, { workspaceId }),
    list: (workspaceId: string, projectId: string, fileId: string, pageNumber: number) => requester<{ runs: GeometryRunSummary[]; hasMore: boolean }>(
      `${base(projectId)}/runs?file_id=${encodeURIComponent(fileId)}&physical_page_number=${pageNumber}`, { workspaceId }),
    get: (workspaceId: string, projectId: string, runId: string) => requester<GeometryRunDetail>(`${base(projectId)}/runs/${encodeURIComponent(runId)}`, { workspaceId }),
    review: (workspaceId: string, projectId: string, runId: string, input: GeometryReviewInput) => requester<{ candidate: GeometryCandidate; replayed: boolean }>(
      `${base(projectId)}/runs/${encodeURIComponent(runId)}/review`, { workspaceId, method: 'POST', body: input }),
  };
}
export const geometryApi = createGeometryApi();
