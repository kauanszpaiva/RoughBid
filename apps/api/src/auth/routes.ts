import { bootstrapAuth } from './bootstrap.ts';
import { sendBrandedMagicLink, type MagicLinkAdminClient } from './sign-in.ts';
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

export async function handleMagicLinkRequest(
  request: Request,
  admin: MagicLinkAdminClient,
  options: { appUrl: string; env?: NodeJS.ProcessEnv },
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = await request.json().catch(() => ({}));
    const email = typeof (body as Record<string, unknown>).email === 'string' ? (body as Record<string, unknown>).email as string : '';
    const inviteToken = typeof (body as Record<string, unknown>).inviteToken === 'string'
      ? (body as Record<string, unknown>).inviteToken as string
      : null;
    const mode = (body as Record<string, unknown>).mode === 'create-account' ? 'create-account' : 'sign-in';
    return json(await sendBrandedMagicLink(admin, { email, appUrl: options.appUrl, inviteToken, mode }, options.env));
  } catch (error) {
    if (error instanceof ApiActionError) return json({ error: error.message }, error.status);
    if (error instanceof RangeError || error instanceof TypeError) return json({ error: error.message }, 400);
    return json({ error: error instanceof Error ? error.message : 'Could not send sign-in email.' }, 503);
  }
}
