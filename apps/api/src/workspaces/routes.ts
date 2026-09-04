import { acceptWorkspaceInvite, createWorkspace, createWorkspaceInvite, listWorkspaces } from './actions.ts';
import { ApiActionError, type AuthenticatedSupabaseClient } from '../supabase/client.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * GET /api/workspaces — list the signed-in user's workspaces (RLS-scoped).
 * POST /api/workspaces — create one; the frontend calls this once, the first
 * time a signed-in user has zero workspaces (see apps/web/app/src/App.tsx).
 */
export async function handleWorkspacesRequest(request: Request, client: AuthenticatedSupabaseClient): Promise<Response> {
  try {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/workspaces' && request.method === 'GET') return json(await listWorkspaces(client));
    if (pathname === '/api/workspaces' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const name = typeof (body as Record<string, unknown>)?.name === 'string' ? (body as Record<string, unknown>).name as string : '';
      return json(await createWorkspace(client, { name }), 201);
    }
    const inviteMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/invites$/);
    if (inviteMatch && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return json(await createWorkspaceInvite(client, inviteMatch[1] ?? '', body as never), 201);
    }
    if (pathname === '/api/workspace-invites/accept' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const token = typeof (body as Record<string, unknown>)?.token === 'string' ? (body as Record<string, unknown>).token as string : '';
      return json(await acceptWorkspaceInvite(client, token));
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    if (error instanceof ApiActionError) return json({ error: error.message }, error.status);
    if (error instanceof RangeError || error instanceof TypeError) return json({ error: error.message }, 400);
    return json({ error: 'Internal server error' }, 500);
  }
}
