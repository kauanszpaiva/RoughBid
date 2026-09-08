import { bootstrapAuth } from './bootstrap.ts';
import { sendBrandedMagicLink, type MagicLinkAdminClient } from './sign-in.ts';
import { ApiActionError, type AuthenticatedSupabaseClient } from '../supabase/client.ts';
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { validateEmail } from '../../../../packages/domain/src/index.ts';

const json = (body: unknown, status = 200, headers?: Record<string, string>) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

type RateLimitedMagicLinkClient = MagicLinkAdminClient & {
  rpc?(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

/** Only the hosting platform's proxy headers are trusted; other hosts share a
 * conservative unknown-origin bucket. Origin, body fields and arbitrary proxy
 * chains never define a new identity. Vercel overwrites its forwarded headers:
 * https://vercel.com/docs/headers/request-headers#x-forwarded-for
 */
function magicLinkOrigin(request: Request, env: NodeJS.ProcessEnv): string {
  if (env.VERCEL !== '1') return 'unknown';
  const address = (request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for') ?? '').trim();
  if (isIP(address) === 4) return `ip4:${address}`;
  if (isIP(address) !== 6 || address.includes('%')) return 'unknown';
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const groups = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  // IPv4-mapped IPv6 must use the same bucket as the IPv4 spelling.
  if (groups.slice(0, 5).every(part => parseInt(part, 16) === 0) && groups[5] === 'ffff') {
    const high = parseInt(groups[6]!, 16); const low = parseInt(groups[7]!, 16);
    return `ip4:${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  }
  // A /64 resists IPv6 address rotation and stores less identifying information.
  return `ip6:${groups.slice(0, 4).map(part => parseInt(part, 16).toString(16)).join(':')}/64`;
}

async function reserveMagicLinkAttempt(request: Request, admin: RateLimitedMagicLinkClient, email: string, env: NodeJS.ProcessEnv) {
  const secret = env.AUTH_RATE_LIMIT_SECRET?.trim() || env.PILOT_INVITE_SIGNING_SECRET?.trim()
    || env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!admin.rpc || !secret || secret.length < 32) throw new Error('Magic-link rate limiting is unavailable.');
  const origin = magicLinkOrigin(request, env);
  const digest = (kind: string, value: string) => createHmac('sha256', secret).update(`roughbid-auth-rate-v1\n${kind}\n${value}`).digest('hex');
  let result: { data: unknown; error: unknown } | null;
  try {
    result = await admin.rpc('reserve_magic_link_attempt', {
      p_email_hash: digest('email', email), p_origin_hash: digest('origin', origin), p_origin_unknown: origin === 'unknown',
    });
  } catch { throw new Error('Magic-link rate limiting is unavailable.'); }
  const decision = result?.data as { allowed?: unknown; retry_after_seconds?: unknown } | null;
  if (!result || result.error || !decision || typeof decision.allowed !== 'boolean') throw new Error('Magic-link rate limiting is unavailable.');
  if (!decision.allowed) {
    const retry = Number(decision.retry_after_seconds);
    return Number.isInteger(retry) && retry >= 1 && retry <= 86_400 ? retry : 60;
  }
  return null;
}

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
  admin: RateLimitedMagicLinkClient,
  options: { appUrl: string; env?: NodeJS.ProcessEnv },
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = await request.json().catch(() => ({}));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Enter a valid email address.');
    const email = validateEmail(typeof (body as Record<string, unknown>).email === 'string' ? (body as Record<string, unknown>).email as string : '');
    const inviteToken = typeof (body as Record<string, unknown>).inviteToken === 'string'
      ? (body as Record<string, unknown>).inviteToken as string
      : null;
    const mode = (body as Record<string, unknown>).mode === 'create-account' ? 'create-account' : 'sign-in';
    const pilotInviteToken = typeof (body as Record<string, unknown>).pilotInviteToken === 'string' ? (body as Record<string, unknown>).pilotInviteToken as string : null;
    if (pilotInviteToken && !/^[A-Za-z0-9_-]{43}$/.test(pilotInviteToken)) throw new TypeError('Invalid access invitation.');
    if (inviteToken && inviteToken.length > 256) throw new TypeError('Invalid workspace invitation.');
    const env = options.env ?? process.env;
    const retryAfter = await reserveMagicLinkAttempt(request, admin, email, env);
    if (retryAfter !== null) return json({ error: 'Too many sign-in requests. Please wait and try again.' }, 429, { 'retry-after': String(retryAfter) });
    try {
      await sendBrandedMagicLink(admin, { email, appUrl: options.appUrl, inviteToken, pilotInviteToken, mode }, env);
    } catch {
      // Account existence and provider errors must not become a public lookup.
      // The reservation remains consumed even after an ambiguous delivery.
      console.warn('auth_magic_link_delivery_unconfirmed');
    }
    return json({ accepted: true, message: 'If this address can receive a sign-in link, check your inbox.' }, 202);
  } catch (error) {
    if (error instanceof ApiActionError) return json({ error: error.message }, error.status);
    if (error instanceof RangeError || error instanceof TypeError) return json({ error: error.message }, 400);
    return json({ error: 'Sign-in email is temporarily unavailable. Please try again later.' }, 503);
  }
}
