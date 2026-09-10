import { readPilotCohort } from '../owner-usage/routes.ts';
import { createHash, createHmac } from 'node:crypto';
import { validateEmail } from '../../../../packages/domain/src/index.ts';
import { PILOT_PRESETS, sendPilotEmail, type PilotPreset } from './email.ts';

type Database = { auth?: { getUser(): Promise<{ data: { user: { id: string } | null }; error: unknown }> }; from(table: string): any; rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: any; error: { message?: string } | null }> };
type Invitation = { id: string; email: string; preset: PilotPreset; expires_at: string; accepted_at?: string | null; revoked_at?: string | null; delivery_status?: string; provider_message_id?: string | null; [key: string]: unknown };
class PilotRequestError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const unwrap = (result: { data: any; error: { message?: string } | null }) => {
  if (result.error) throw new PilotRequestError(409, result.error.message ?? 'Pilot access could not be updated.');
  return result.data;
};

export function pilotToken(email: string, secret: string): string {
  if (secret.trim().length < 32) throw new PilotRequestError(503, 'Pilot invitation signing is not configured.');
  return createHmac('sha256', secret).update(`roughbid-pilot-v1\n${validateEmail(email)}`).digest('base64url');
}
export function pilotInviteUrl(appUrl: string, email: string, secret: string): string {
  const url = new URL('/app/', appUrl);
  if (url.protocol !== 'https:') throw new PilotRequestError(503, 'Pilot invitation URL is not configured.');
  url.searchParams.set('pilot_invite', pilotToken(email, secret));
  return url.toString();
}
export function normalizePilotBatch(body: Record<string, unknown>): { emails: string[]; preset: PilotPreset } {
  if (!Array.isArray(body.emails) || body.emails.length < 1 || body.emails.length > 25) throw new PilotRequestError(400, 'Enter between 1 and 25 email addresses.');
  const emails = [...new Set(body.emails.map((email) => validateEmail(typeof email === 'string' ? email : '')))];
  const preset = body.preset ?? 'pilot60';
  if (typeof preset !== 'string' || !(preset in PILOT_PRESETS) || !Object.hasOwn(PILOT_PRESETS, preset)) throw new PilotRequestError(400, 'Select an available access preset.');
  return { emails, preset: preset as PilotPreset };
}

export async function handlePilotRequest(request: Request, client: Database, admin: Database, env: NodeJS.ProcessEnv = process.env, deliver: typeof sendPilotEmail = sendPilotEmail): Promise<Response> {
  try {
    const auth = await client.auth?.getUser();
    if (auth?.error || !auth?.data.user) return json({ error: 'Sign in to continue.' }, 401);
    const userId = auth.data.user.id;
    const path = new URL(request.url).pathname;
    if (path === '/api/pilot/access' && request.method === 'GET') return json(unwrap(await admin.rpc('get_pilot_access', { p_user_id: userId })));
    if (path === '/api/pilot/redeem' && request.method === 'POST') {
      const body = await request.json() as Record<string, unknown>;
      if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) throw new PilotRequestError(400, 'Invalid access invitation.');
      return json(unwrap(await client.rpc('redeem_pilot_invitation', { p_token_digest: createHash('sha256').update(body.token).digest('hex'), p_workspace_name: 'My RoughBid Workspace' })));
    }
    if (path !== '/api/pilot/invitations') return json({ error: 'Not found.' }, 404);
    const profile = await admin.from('profiles').select('is_platform_admin').eq('id', userId).maybeSingle();
    if (profile.error) return json({ error: 'Unable to verify owner access.' }, 503);
    if (profile.data?.is_platform_admin !== true) return json({ error: 'Only the platform owner can manage access invitations.' }, 403);
    const secret = env.PILOT_INVITE_SIGNING_SECRET ?? '';
    const appUrl = env.APP_URL?.trim() || 'https://roughbid.vercel.app';
    const redact = (row: Invitation) => {
      const { token_hash: _tokenHash, ...safe } = row;
      const access = row.access && typeof row.access === 'object' ? row.access as Record<string, unknown> : null;
      return { ...safe, enrollment_expires_at: access?.expires_at ?? null, reserved_cents: access?.reserved_cents ?? (row.accepted_at ? undefined : 0), budget_cents: access?.budget_cents ?? 500, ...(secret.length >= 32 && !row.accepted_at && !row.revoked_at && Date.parse(row.expires_at) > Date.now() ? { invite_url: pilotInviteUrl(appUrl, row.email, secret) } : {}) };
    };
    if (request.method === 'GET') {
      const cohort = await readPilotCohort(admin);
      const invitations = unwrap(await admin.rpc('list_pilot_invitations', { p_admin_user_id: userId }));
      return json({ invitations: (Array.isArray(invitations) ? invitations : []).map(redact), sendingConfigured: secret.trim().length >= 32 && Boolean(env.RESEND_API_KEY?.trim()), remindersConfigured: Boolean(env.CRON_SECRET?.trim() && env.RESEND_API_KEY?.trim()), deliveryTrackingConfigured: Boolean(env.RESEND_WEBHOOK_SECRET?.trim()), capacity: cohort.capacity, cohortBudgetCents: cohort.budget_cents });
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    const body = await request.json() as Record<string, unknown>;
    if (body.action === 'revoke') {
      if (typeof body.invitationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.invitationId)) throw new PilotRequestError(400, 'Select a valid access invitation.');
      unwrap(await admin.rpc('revoke_pilot_invitation', { p_admin_user_id: userId, p_invitation_id: body.invitationId }));
      return json({ revoked: true });
    }
    if (!env.RESEND_API_KEY?.trim()) throw new PilotRequestError(503, 'Pilot email delivery is not configured.');
    pilotToken('configuration-check@example.invalid', secret);
    const batch = normalizePilotBatch(body);
    const results: Array<Record<string, unknown>> = [];
    for (const email of batch.emails) {
      let issued: Invitation;
      try {
        const result = unwrap(await admin.rpc('issue_pilot_invitation', { p_admin_user_id: userId, p_email: email, p_token_hash: createHash('sha256').update(pilotToken(email, secret)).digest('hex'), p_preset: batch.preset }));
        issued = (Array.isArray(result) ? result[0] : result) as Invitation;
        if (!issued?.id) throw new PilotRequestError(503, 'Invitation could not be created.');
        if (issued.accepted_at || issued.revoked_at || Date.parse(issued.expires_at) <= Date.now() || issued.email_status === 'sent' || issued.delivery_status === 'sent' || issued.email_message_id || issued.provider_message_id) {
          results.push({ ...redact(issued), skipped: true });
          continue;
        }
      } catch (error) {
        results.push({ email, delivery_status: 'failed', error: error instanceof Error ? error.message : 'Invitation could not be created.' });
        continue;
      }
      let messageId: string | null = null;
      let deliveryError: string | null = null;
      try {
        messageId = await deliver({ to: email, inviteUrl: pilotInviteUrl(appUrl, email, secret), invitationId: issued.id, preset: issued.preset ?? batch.preset, expiresAt: issued.expires_at }, env.RESEND_API_KEY);
      } catch (error) { deliveryError = error instanceof Error ? error.message : 'Email was not confirmed.'; }
      try {
        unwrap(await admin.rpc('mark_pilot_invitation_delivery', { p_admin_user_id: userId, p_invitation_id: issued.id, p_message_id: messageId, p_error: deliveryError }));
        results.push({ ...redact(issued), email_status: messageId ? 'sent' : 'failed', email_message_id: messageId, ...(deliveryError ? { error: deliveryError } : {}) });
      } catch {
        results.push({ email, delivery_status: messageId ? 'unconfirmed' : 'failed', error: messageId ? 'Email accepted by provider, but delivery tracking could not be saved. Refresh before retrying.' : 'Email and tracking were not confirmed. Refresh before retrying.' });
      }
    }
    return json({ invitations: results });
  } catch (error) {
    if (error instanceof PilotRequestError) return json({ error: error.message }, error.status);
    if (error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError) return json({ error: error.message }, 400);
    return json({ error: 'Pilot access could not be loaded. Please retry.' }, 503);
  }
}
