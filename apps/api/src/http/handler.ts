import { createClient } from '@supabase/supabase-js';
import { handleAuthBootstrapRequest } from '../auth/routes.ts';
import { handleWorkspacesRequest } from '../workspaces/routes.ts';
import { handleProjectRequest } from '../projects/routes.ts';
import { createEstimateCalculationHandler } from '../estimates/routes.ts';
import type { AuthenticatedSupabaseClient } from '../supabase/client.ts';
import type { SupabaseLike } from '../projects/service.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * Builds a real Supabase client scoped to one request's Authorization header —
 * never the service-role key. Row-level security (see supabase/migrations/)
 * is the authorization boundary; this client only proves *who* is calling.
 */
function clientForRequest(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be configured on the server.');
  }
  const authorization = request.headers.get('authorization');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: authorization ? { headers: { Authorization: authorization } } : {},
  });
}

/**
 * Single entrypoint for every RoughBid API route, mounted at the repo root by
 * /api/[...path].ts (a thin Vercel Edge Function adapter — see that file).
 * Framework-neutral on purpose: apps/api's handlers only know Request/Response.
 */
export async function handleApiRequest(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === '/api/health') {
    return json({ status: 'ok', service: 'RoughBid API' });
  }

  let client: ReturnType<typeof clientForRequest>;
  try {
    client = clientForRequest(request);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Server misconfigured' }, 500);
  }

  if (pathname === '/api/auth/bootstrap') {
    return handleAuthBootstrapRequest(request, client as unknown as AuthenticatedSupabaseClient);
  }
  if (pathname === '/api/workspaces') {
    return handleWorkspacesRequest(request, client as unknown as AuthenticatedSupabaseClient);
  }
  if (pathname === '/api/estimates/recalculate') {
    const recalculate = createEstimateCalculationHandler({
      authenticate: async () => {
        const { data } = await client.auth.getUser();
        return data.user ? { id: data.user.id } : null;
      },
    });
    return recalculate(request);
  }
  if (pathname.startsWith('/api/projects') || pathname.startsWith('/api/project-files')) {
    return handleProjectRequest(request, client as unknown as SupabaseLike);
  }

  return json({ error: 'Not found' }, 404);
}
