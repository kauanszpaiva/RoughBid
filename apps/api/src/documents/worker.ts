import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DocumentDb, PdfJob } from './service.ts';
import type { PresignedObjectRequest, S3ObjectStorage } from '../storage/object-storage.ts';

const exec = promisify(execFile);
export interface ExtractedPdf { pageCount: number; title: string | null; author: string | null; pages: Array<{ bytes: Uint8Array; width?: number; height?: number }>; }
export interface PdfConverter { convert(pdf: Uint8Array): Promise<ExtractedPdf>; }
export interface WorkerObjectStorage {
  presign(method: 'GET' | 'PUT' | 'HEAD', key: string, options?: { expiresIn?: number; contentType?: string; downloadName?: string }): PresignedObjectRequest | Promise<PresignedObjectRequest>;
}

/** Production converter backed by Poppler's pdfinfo and pdftoppm commands. */
export class PopplerPdfConverter implements PdfConverter {
  async convert(pdf: Uint8Array): Promise<ExtractedPdf> {
    const directory = await mkdtemp(join(tmpdir(), 'roughbid-pdf-'));
    try {
      const source = join(directory, 'source.pdf');
      await writeFile(source, pdf);
      const { stdout } = await exec('pdfinfo', [source], { maxBuffer: 1024 * 1024 });
      const metadata = Object.fromEntries(stdout.split('\n').map((line) => { const split = line.indexOf(':'); return split < 0 ? ['', ''] : [line.slice(0, split).trim(), line.slice(split + 1).trim()]; }).filter(([key]) => key));
      await exec('pdftoppm', ['-jpeg', '-jpegopt', 'quality=82,progressive=y,optimize=y', '-scale-to', '2000', source, join(directory, 'page')], { maxBuffer: 1024 * 1024 });
      const names = (await readdir(directory)).filter((name) => /^page-\d+\.jpg$/.test(name)).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
      if (!names.length) throw new Error('PDF did not contain renderable pages');
      return { pageCount: Number(metadata.Pages) || names.length, title: metadata.Title || null, author: metadata.Author || null, pages: await Promise.all(names.map(async (name) => ({ bytes: new Uint8Array(await readFile(join(directory, name))) }))) };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

export class PdfJobProcessor {
  private db: DocumentDb;
  private storage: WorkerObjectStorage;
  private converter: PdfConverter;
  private fetcher: typeof fetch;
  constructor(db: DocumentDb, storage: S3ObjectStorage | WorkerObjectStorage, converter: PdfConverter, fetcher: typeof fetch = fetch) {
    this.db = db; this.storage = storage; this.converter = converter; this.fetcher = fetcher;
  }

  async process(job: PdfJob) {
    await this.setState(job, { processing_status: 'processing', processing_error: null });
    try {
      const source = await this.storage.presign('GET', job.sourceKey, { expiresIn: 300 });
      const response = await this.fetcher(source.url);
      if (!response.ok) throw new Error(`Object download failed (${response.status})`);
      const converted = await this.converter.convert(new Uint8Array(await response.arrayBuffer()));
      const assets = [];
      for (let index = 0; index < converted.pages.length; index += 1) {
        const page = converted.pages[index]!;
        const key = `${job.workspaceId}/${job.projectId}/${job.fileId}/pages/${String(index + 1).padStart(4, '0')}.jpg`;
        const upload = await this.storage.presign('PUT', key, { expiresIn: 300, contentType: 'image/jpeg' });
        const uploaded = await this.fetcher(upload.url, { method: 'PUT', headers: upload.headers, body: page.bytes });
        if (!uploaded.ok) throw new Error(`Page ${index + 1} upload failed (${uploaded.status})`);
        assets.push({ file_id: job.fileId, page_number: index + 1, storage_path: key, mime_type: 'image/jpeg', byte_size: page.bytes.byteLength, width: page.width ?? null, height: page.height ?? null });
      }
      const inserted = await this.db.from('project_file_pages').upsert(assets, { onConflict: 'file_id,page_number' });
      if (inserted.error) throw new Error(inserted.error.message ?? 'Could not store page assets');
      await this.setState(job, { processing_status: 'ready', processing_error: null, page_count: converted.pageCount, metadata: { title: converted.title, author: converted.author } });
      return { pageCount: converted.pageCount, assets: assets.length };
    } catch (error) {
      await this.setState(job, { processing_status: 'failed', processing_error: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown processing error' });
      throw error;
    }
  }

  private async setState(job: PdfJob, changes: Record<string, unknown>) {
    const result = await this.db.from('project_files').update(changes).eq('id', job.fileId).eq('workspace_id', job.workspaceId);
    if (result.error) throw new Error(result.error.message ?? 'Could not update processing state');
  }
}

export interface BullMqModule { Queue: new (name: string, options: unknown) => unknown; Worker: new (name: string, processor: (job: { data: PdfJob }) => Promise<unknown>, options: unknown) => unknown; }

export async function createBullMqPipeline(redisUrl: string, processor: PdfJobProcessor, loader: () => Promise<BullMqModule> = () => import('bullmq') as Promise<unknown> as Promise<BullMqModule>) {
  if (!redisUrl) throw new Error('REDIS_URL is required');
  const bull = await loader();
  const connection = { url: redisUrl, maxRetriesPerRequest: null };
  return { queue: new bull.Queue('pdf-processing', { connection }), worker: new bull.Worker('pdf-processing', (job) => processor.process(job.data), { connection, concurrency: 2 }) };
}
