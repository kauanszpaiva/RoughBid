import type { SupabaseLike } from '../projects/service.ts';
import { CatalogApiError, getWorkspaceCatalog, saveWorkspaceCatalog } from './service.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function handleWorkspaceCatalogRequest(request: Request, db: SupabaseLike): Promise<Response> {
  try {
    const match = new URL(request.url).pathname.match(/^\/api\/workspaces\/([^/]+)\/estimating-catalog$/);
    if (!match) return json({ error: 'Not found' }, 404);
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) throw new CatalogApiError(401, 'Authentication required.');
    const workspaceId = match[1] ?? '';
    if (request.method === 'GET') return json(await getWorkspaceCatalog(db, data.user.id, workspaceId));
    if (request.method === 'POST') {
      const input = await request.json().catch(() => ({}));
      return json(await saveWorkspaceCatalog(db, data.user.id, workspaceId, input as Record<string, unknown>), 201);
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    if (error instanceof CatalogApiError) return json({ error: error.message }, error.status);
    return json({ error: 'Internal server error' }, 500);
  }
}
