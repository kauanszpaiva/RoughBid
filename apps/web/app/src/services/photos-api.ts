import { ApiError, request } from './api';
import type { PhotoDimensionReference, PhotoEvidenceReview, PhotoObservation, PhotoReviewDecision, PhotoSourceAsset } from '../../../../api/src/photo-evidence.ts';
export type { PhotoEvidenceReview, PhotoObservation, PhotoSourceAsset };
export type PhotoReferenceInput = Omit<PhotoDimensionReference, 'reviewerId'>;
export type PhotoReviewInput = Omit<PhotoReviewDecision, 'reviewerId'>;
export type PhotoRunStatus = 'queued' | 'processing' | 'needs_review' | 'blocked' | 'cancelled';
export type PhotoCapability = { enabled: boolean; ownerAccess: boolean; workerReady: boolean; provider?: string; model?: string; stages?: Array<{ stage: string; provider?: string; model?: string; state: string }> };
export type PhotoRun = {
  id: string; status: PhotoRunStatus; progress: { completed: number; total: number } | null;
  error_code?: string | null; reconciliation_required?: boolean; cancel_requested?: boolean;
  request_key?: string; asset_ids?: string[]; created_at?: string; updated_at?: string;
  review_revision?: number;
  result: (PhotoEvidenceReview & { independentReview?: string; stageStatus?: Record<string, string>; photoQuality?: Array<{ sourceAssetId: string; usable: boolean; limitations: string[]; additionalViewsNeeded: boolean }>; references?: PhotoReferenceInput[]; decisions?: PhotoReviewInput[] }) | null;
};
export type PhotoRunDetail = {
  run: PhotoRun; assets: PhotoSourceAsset[]; references: PhotoReferenceInput[];
  steps: Array<{ photo_asset_id: string; status: 'pending' | 'processing' | 'completed'; result?: {
    observations: PhotoObservation[]; quality: { usable: boolean; limitations: string[]; additionalViewsNeeded: boolean };
    blockers: string[]; independentReview: string;
  } | null; completed_at?: string | null }>;
};
export type PhotoCheckpoint = { runId: string; photo_asset_id: string; status: 'pending' | 'processing' | 'completed'; completed_at?: string | null;
  checkpoint: NonNullable<PhotoRunDetail['steps'][number]['result']> | null; asset: PhotoSourceAsset };

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/photos`;
export const getPhotoCapability = (workspaceId: string, projectId: string) => request<PhotoCapability>(`${base(projectId)}/capability`, { workspaceId });
export const listPhotoRuns = (workspaceId: string, projectId: string) => request<{ runs: Array<Omit<PhotoRun, 'result'>> }>(`${base(projectId)}/runs`, { workspaceId });
export const getPhotoRun = (workspaceId: string, projectId: string, runId: string) => request<PhotoRunDetail>(`${base(projectId)}/runs/${encodeURIComponent(runId)}`, { workspaceId });
export const getPhotoCheckpoint = (workspaceId: string, projectId: string, runId: string, assetId: string) =>
  request<PhotoCheckpoint>(`${base(projectId)}/runs/${encodeURIComponent(runId)}?asset_id=${encodeURIComponent(assetId)}`, { workspaceId });
export const beginPhotoUpload = (workspaceId: string, projectId: string, file: Pick<File, 'name' | 'type' | 'size'>) =>
  request<{ asset: { id: string; original_name: string }; upload: { url: string; method: 'PUT'; headers: Record<string, string> } }>(`${base(projectId)}/uploads`, {
    method: 'POST', workspaceId, body: { name: file.name, contentType: file.type, byteSize: file.size },
  });
export const completePhotoUpload = (workspaceId: string, projectId: string, assetId: string) =>
  request<{ asset: PhotoSourceAsset }>(`${base(projectId)}/uploads/${encodeURIComponent(assetId)}/complete`, { method: 'POST', workspaceId });
export const createPhotoRun = (workspaceId: string, projectId: string, input: { assetIds: string[]; requestKey: string; references?: PhotoReferenceInput[] }) =>
  request<{ run: PhotoRun; enqueued: boolean }>(`${base(projectId)}/runs`, { method: 'POST', workspaceId, body: input });
export const cancelPhotoRun = (workspaceId: string, projectId: string, runId: string) =>
  request<{ id: string; status: PhotoRunStatus }>(`${base(projectId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', workspaceId });
export const resumePhotoRun = (workspaceId: string, projectId: string, runId: string) =>
  request<{ id: string; status: PhotoRunStatus; enqueued: boolean }>(`${base(projectId)}/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST', workspaceId });
export type PhotoReviewRequest = { expectedReviewRevision: number; reviewRequestKey: string; references: PhotoReferenceInput[]; decisions: PhotoReviewInput[] };
export const savePhotoReview = (workspaceId: string, projectId: string, runId: string, input: PhotoReviewRequest) =>
  request<{ review: NonNullable<PhotoRun['result']>; reviewRevision: number; reused: boolean }>(`${base(projectId)}/runs/${encodeURIComponent(runId)}/review`, { method: 'POST', workspaceId, body: input });

/** Read only the authorized private source. Expiring signed URLs are never persisted. */
export async function createPhotoPreview(workspaceId: string, projectId: string, assetId: string, expectedSha256: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new ApiError(409, 'A verified photo revision is required for preview.');
  const signed = await request<{ url: string; method: 'GET'; headers: Record<string, string> }>(`${base(projectId)}/uploads/${encodeURIComponent(assetId)}/download-url`, { method: 'POST', workspaceId });
  const response = await fetch(signed.url, { method: signed.method, headers: signed.headers, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new ApiError(response.status, 'The private photo preview could not be loaded.');
  const type = response.headers.get('content-type')?.split(';')[0]?.trim();
  if (!type || !['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new ApiError(415, 'Photo preview content is not a supported image.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > 20 * 1024 * 1024) { await reader.cancel(); throw new ApiError(413, 'Photo preview exceeds 20 MB.'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (actual !== expectedSha256) throw new ApiError(409, 'The source photo differs from its saved evidence revision. Upload a new source before review.');
  return URL.createObjectURL(new Blob([bytes], { type }));
}
