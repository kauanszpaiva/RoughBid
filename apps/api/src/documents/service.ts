import { ProjectApiError, assertPlanStoragePath } from '../projects/service.ts';
import type { PresignedObjectRequest, S3ObjectStorage } from '../storage/object-storage.ts';
import { downloadPlan, inspectPdf } from '../billing/project-preflight.ts';
import { PILOT_MAX_PAGES, PILOT_MAX_PDF_BYTES } from '../ai-plan/pilot-reader.ts';

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const PDF_PROCESS_QUEUE = 'pdf-processing';
export interface PdfJob { fileId: string; workspaceId: string; projectId: string; sourceKey: string; }
export interface JobQueue {
  add(name: 'process-pdf', data: PdfJob, options: { jobId: string; attempts: number; backoff: { type: 'exponential'; delay: number }; removeOnComplete: number }): Promise<unknown>;
  close?(): Promise<void>;
  on?(event: 'error', listener: () => void): unknown;
}
export interface BullMqQueueModule { Queue: new (name: string, options: unknown) => JobQueue; }
export interface DocumentDb { from(table: string): any; rpc?(name: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: unknown }>; }
export interface DocumentObjectStorage {
  presign(method: 'GET' | 'PUT' | 'HEAD', key: string, options?: { expiresIn?: number; contentType?: string; downloadName?: string; maximumSizeInBytes?: number }): PresignedObjectRequest | Promise<PresignedObjectRequest>;
}

export async function createDocumentQueue(redisUrl: string, loader: () => Promise<BullMqQueueModule> = () => import('bullmq') as Promise<unknown> as Promise<BullMqQueueModule>) {
  if (!redisUrl) throw new Error('REDIS_URL is required');
  const bull = await loader();
  const queue = new bull.Queue(PDF_PROCESS_QUEUE, { connection: { url: redisUrl, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 5_000, retryStrategy: () => null } });
  // The rejected add() is handled as optional processing failure by the service.
  queue.on?.('error', () => {});
  return queue;
}

const safeName = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 255);

export class DocumentService {
  private db: DocumentDb;
  private storage: DocumentObjectStorage;
  private queue: JobQueue | null;
  private userId: string;
  private workspaceId: string;
  private fetcher: typeof fetch;
  private completionWriter: DocumentDb;
  constructor(db: DocumentDb, storage: S3ObjectStorage | DocumentObjectStorage, queue: JobQueue | null, userId: string, workspaceId: string, fetcher: typeof fetch = fetch, completionWriter: DocumentDb = db) {
    this.db = db; this.storage = storage; this.queue = queue; this.userId = userId; this.workspaceId = workspaceId; this.fetcher = fetcher;
    this.completionWriter = completionWriter;
  }

  private async assertWriteAccess() {
    const membership = await this.db.from('workspace_members').select('role').eq('workspace_id', this.workspaceId).eq('user_id', this.userId).maybeSingle();
    if (membership.error || !['admin', 'estimator'].includes(membership.data?.role)) throw new ProjectApiError(403, 'Your workspace role cannot upload or complete plan files.');
  }

  async beginUpload(projectId: string, input: { name: string; contentType: string; byteSize: number }) {
    await this.assertWriteAccess();
    if (input.contentType !== 'application/pdf' || !input.name.toLowerCase().endsWith('.pdf')) throw new ProjectApiError(415, 'Only PDF files are accepted');
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > MAX_DOCUMENT_BYTES) throw new ProjectApiError(413, 'PDF must be no larger than 50 MB');
    const project = await this.db.from('projects').select('id').eq('workspace_id', this.workspaceId).eq('id', projectId).maybeSingle();
    if (project.error || !project.data) throw new ProjectApiError(404, 'Project not found');
    const id = crypto.randomUUID();
    const objectKey = `${this.workspaceId}/${projectId}/${id}/source.pdf`;
    const row = await this.db.from('project_files').insert({ id, workspace_id: this.workspaceId, project_id: projectId, uploaded_by: this.userId, storage_path: objectKey, original_name: safeName(input.name), mime_type: 'application/pdf', byte_size: input.byteSize, processing_status: 'uploading' }).select('*').single();
    if (row.error) throw new ProjectApiError(500, row.error.message ?? 'Could not create upload');
    return { file: row.data, upload: await this.storage.presign('PUT', objectKey, { contentType: 'application/pdf', expiresIn: 300, maximumSizeInBytes: input.byteSize }) };
  }

  async completeUpload(fileId: string) {
    await this.assertWriteAccess();
    const result = await this.db.from('project_files').select('*').eq('workspace_id', this.workspaceId).eq('id', fileId).maybeSingle();
    if (result.error || !result.data) throw new ProjectApiError(404, 'File not found');
    if (result.data.processing_status === 'ready') return result.data;
    if (result.data.processing_status !== 'uploading' && result.data.processing_status !== 'queued') throw new ProjectApiError(409, 'Upload has already been completed');
    assertPlanStoragePath(result.data.storage_path,this.workspaceId,result.data.project_id,fileId);
    const head = await this.storage.presign('HEAD', result.data.storage_path, { expiresIn: 60 });
    const object = await this.fetcher(head.url, { method: 'HEAD' });
    const storedBytes = Number(object.headers.get('content-length'));
    const storedType = object.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (!object.ok) throw new ProjectApiError(409, 'Upload is not present in object storage');
    if (storedBytes !== result.data.byte_size || storedType !== 'application/pdf') throw new ProjectApiError(422, 'Uploaded object does not match the declared PDF');
    let pilotPages: number | undefined;
    if (this.completionWriter.rpc) {
      const access = await this.completionWriter.rpc('get_pilot_access', { p_user_id: this.userId });
      if (access.error) throw new ProjectApiError(503, 'Could not verify pilot document limits.');
      if (access.data?.active) {
        if (storedBytes > PILOT_MAX_PDF_BYTES) throw new ProjectApiError(413, 'Pilot PDFs must be 10 MB or smaller.');
        const signed = await this.storage.presign('GET', result.data.storage_path, { expiresIn: 60 });
        const bytes = await downloadPlan(signed.url, this.fetcher);
        const inspected = await inspectPdf(bytes);
        if (bytes.length > PILOT_MAX_PDF_BYTES || inspected.pages > PILOT_MAX_PAGES) throw new ProjectApiError(413, 'Pilot PDFs must have at most 10 pages and be 10 MB or smaller.');
        pilotPages = inspected.pages;
      }
    }
    let file = result.data;
    if (result.data.processing_status === 'uploading') {
      // Browser roles cannot update file metadata directly. The server writes
      // only after authenticated tenant/role checks and storage verification.
      const updated = await this.completionWriter.from('project_files').update({
        processing_status: this.queue ? 'queued' : 'ready',
        processing_error: null,
        ...(pilotPages ? { page_count: pilotPages } : {}),
        ...(!this.queue ? { metadata: { ...result.data.metadata, page_processing: 'not_requested' } } : {}),
      }).eq('workspace_id', this.workspaceId).eq('id', fileId).eq('processing_status', 'uploading').select('*').maybeSingle();
      if (updated.error) {
        console.error('document_completion_failed', { code: updated.error.code, message: updated.error.message });
        throw new ProjectApiError(500, 'Could not save upload completion. The original file remains stored.');
      }
      if (!updated.data) throw new ProjectApiError(409, 'Upload completion conflict');
      file = updated.data;
    }
    // The browser renders the original PDF. Optional server page images must
    // never make a verified upload unavailable for manual estimating.
    if (this.queue) {
      try {
        await this.queue.add('process-pdf', { fileId, workspaceId: this.workspaceId, projectId: result.data.project_id, sourceKey: result.data.storage_path }, { jobId: fileId, attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 1000 });
        return file;
      } catch {
        // Keep the verified original available if optional processing is down.
      }
    }
    if (file.processing_status === 'queued') {
      const fallback = await this.completionWriter.from('project_files').update({
        processing_status: 'ready', processing_error: null,
        metadata: { ...file.metadata, page_processing: this.queue ? 'unavailable' : 'not_requested' },
      }).eq('workspace_id', this.workspaceId).eq('id', fileId).eq('processing_status', 'queued').select('*').maybeSingle();
      if (fallback.error) throw new ProjectApiError(500, 'Could not save upload completion');
      file = fallback.data ?? file;
    }
    return file;
  }

  async download(fileId: string, options: { disposition?: 'attachment' | 'inline' } = {}) {
    const result = await this.db.from('project_files').select('*').eq('workspace_id', this.workspaceId).eq('id', fileId).maybeSingle();
    if (result.error || !result.data) throw new ProjectApiError(404, 'File not found');
    assertPlanStoragePath(result.data.storage_path,this.workspaceId,result.data.project_id,fileId);
    return this.storage.presign('GET', result.data.storage_path, {
      expiresIn: options.disposition === 'inline' ? 300 : 60,
      ...(options.disposition === 'inline' ? {} : { downloadName: result.data.original_name }),
    });
  }
}
