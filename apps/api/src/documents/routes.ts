import { ProjectApiError, type SupabaseLike } from '../projects/service.ts';
import { DocumentService, type DocumentObjectStorage, type JobQueue } from './service.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Authenticated HTTP boundary for direct uploads, completion, and private retrieval. */
export async function handleDocumentRequest(request: Request, db: SupabaseLike, storage: DocumentObjectStorage, queue: JobQueue | null = null): Promise<Response> {
  try {
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) throw new ProjectApiError(401, 'Authentication required');
    const workspaceId = request.headers.get('x-workspace-id');
    if (!workspaceId) throw new ProjectApiError(400, 'x-workspace-id header is required');
    const service = new DocumentService(db, storage, queue, data.user.id, workspaceId);
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

    if (request.method === 'POST' && parts[0] === 'projects' && parts[1] && parts[2] === 'documents' && parts[3] === 'upload-url') {
      return json(await service.beginUpload(parts[1], await request.json()), 201);
    }
    if (request.method === 'POST' && parts[0] === 'documents' && parts[1] && parts[2] === 'complete') {
      return json(await service.completeUpload(parts[1]), 202);
    }
    if (request.method === 'POST' && parts[0] === 'documents' && parts[1] && parts[2] === 'download-url') {
      const body = await request.json().catch(() => ({})) as { disposition?: unknown };
      return json(await service.download(parts[1], { disposition: body.disposition === 'inline' ? 'inline' : 'attachment' }));
    }
    if (request.method === 'GET' && parts[0] === 'documents' && parts[1] && parts[2] === 'preview') {
      const preview = await service.download(parts[1], { disposition: 'inline' });
      const upstream = await fetch(preview.url, { method: preview.method, headers: preview.headers });
      if (!upstream.ok || !upstream.body) throw new ProjectApiError(502, 'Could not open PDF preview');
      return new Response(upstream.body, {
        headers: {
          'content-type': upstream.headers.get('content-type') || 'application/pdf',
          'content-disposition': 'inline',
          'cache-control': 'private, no-store',
        },
      });
    }
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof ProjectApiError) return json({ error: error.message }, error.status);
    return json({ error: 'Internal server error' }, 500);
  }
}
