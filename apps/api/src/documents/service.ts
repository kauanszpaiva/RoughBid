import { ProjectApiError } from '../projects/service.ts';
import type { S3ObjectStorage } from '../storage/object-storage.ts';

export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
export const PDF_PROCESS_QUEUE = 'pdf-processing';
export interface PdfJob { fileId: string; workspaceId: string; projectId: string; sourceKey: string; }
export interface JobQueue { add(name: 'process-pdf', data: PdfJob, options: { jobId: string; attempts: number; backoff: { type: 'exponential'; delay: number }; removeOnComplete: number }): Promise<unknown>; }
export interface DocumentDb { from(table: string): any; }

const safeName = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 255);

export class DocumentService {
  private db: DocumentDb;
  private storage: S3ObjectStorage;
  private queue: JobQueue;
  private userId: string;
  private workspaceId: string;
  private fetcher: typeof fetch;
  constructor(db: DocumentDb, storage: S3ObjectStorage, queue: JobQueue, userId: string, workspaceId: string, fetcher: typeof fetch = fetch) {
    this.db = db; this.storage = storage; this.queue = queue; this.userId = userId; this.workspaceId = workspaceId; this.fetcher = fetcher;
  }

  async beginUpload(projectId: string, input: { name: string; contentType: string; byteSize: number }) {
    if (input.contentType !== 'application/pdf' || !input.name.toLowerCase().endsWith('.pdf')) throw new ProjectApiError(415, 'Only PDF files are accepted');
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > MAX_DOCUMENT_BYTES) throw new ProjectApiError(413, 'PDF must be no larger than 100 MB');
    const project = await this.db.from('projects').select('id').eq('workspace_id', this.workspaceId).eq('id', projectId).maybeSingle();
    if (project.error || !project.data) throw new ProjectApiError(404, 'Project not found');
    const id = crypto.randomUUID();
    const objectKey = `${this.workspaceId}/${projectId}/${id}/source.pdf`;
    const row = await this.db.from('project_files').insert({ id, workspace_id: this.workspaceId, project_id: projectId, uploaded_by: this.userId, storage_path: objectKey, original_name: safeName(input.name), mime_type: 'application/pdf', byte_size: input.byteSize, processing_status: 'uploading' }).select('*').single();
    if (row.error) throw new ProjectApiError(500, row.error.message ?? 'Could not create upload');
    return { file: row.data, upload: this.storage.presign('PUT', objectKey, { contentType: 'application/pdf', expiresIn: 300 }) };
  }

  async completeUpload(fileId: string) {
    const result = await this.db.from('project_files').select('*').eq('workspace_id', this.workspaceId).eq('id', fileId).maybeSingle();
    if (result.error || !result.data) throw new ProjectApiError(404, 'File not found');
    if (result.data.processing_status !== 'uploading' && result.data.processing_status !== 'queued') throw new ProjectApiError(409, 'Upload has already been completed');
    const head = this.storage.presign('HEAD', result.data.storage_path, { expiresIn: 60 });
    const object = await this.fetcher(head.url, { method: 'HEAD' });
    const storedBytes = Number(object.headers.get('content-length'));
    const storedType = object.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (!object.ok) throw new ProjectApiError(409, 'Upload is not present in object storage');
    if (storedBytes !== result.data.byte_size || storedType !== 'application/pdf') throw new ProjectApiError(422, 'Uploaded object does not match the declared PDF');
    let file = result.data;
    if (result.data.processing_status === 'uploading') {
      const updated = await this.db.from('project_files').update({ processing_status: 'queued', processing_error: null }).eq('workspace_id', this.workspaceId).eq('id', fileId).eq('processing_status', 'uploading').select('*').maybeSingle();
      if (updated.error || !updated.data) throw new ProjectApiError(409, 'Upload completion conflict');
      file = updated.data;
    }
    await this.queue.add('process-pdf', { fileId, workspaceId: this.workspaceId, projectId: result.data.project_id, sourceKey: result.data.storage_path }, { jobId: fileId, attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 1000 });
    return file;
  }

  async download(fileId: string) {
    const result = await this.db.from('project_files').select('*').eq('workspace_id', this.workspaceId).eq('id', fileId).maybeSingle();
    if (result.error || !result.data) throw new ProjectApiError(404, 'File not found');
    return this.storage.presign('GET', result.data.storage_path, { expiresIn: 60, downloadName: result.data.original_name });
  }
}
