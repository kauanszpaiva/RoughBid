import { bootstrapAuth } from './bootstrap.ts';
import { ApiActionError, type AuthenticatedSupabaseClient } from '../supabase/client.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** GET /api/auth/bootstrap — resolves the signed-in user's profile row. */
export async function handleAuthBootstrapRequest(request: Request, client: AuthenticatedSupabaseClient): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  try {
    return json(await bootstrapAuth(client));
  } catch (error) {
    if (error instanceof ApiActionError) return json({ error: error.message }, error.status);
    return json({ error: 'Internal server error' }, 500);
  }
}
