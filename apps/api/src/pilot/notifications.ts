import { createHmac, timingSafeEqual } from 'node:crypto';
import { composePilotReminder } from './email.ts';

type Database = { rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: any; error: unknown }> };
type Notice = { id: string; lease_id: string; email: string; kind: 'expires_7d' | 'expires_1d' | 'expired'; expires_at: string };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const same = (a: string, b: string) => { const first = Buffer.from(a); const second = Buffer.from(b); return first.length === second.length && timingSafeEqual(first, second); };

export async function handlePilotReminders(request: Request, admin: Database, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  if (!env.CRON_SECRET?.trim() || !env.RESEND_API_KEY?.trim()) return json({ error: 'Expiry notifications are not configured.' }, 503);
  if (!same(request.headers.get('authorization') ?? '', `Bearer ${env.CRON_SECRET}`)) return json({ error: 'Unauthorized.' }, 401);
  let claimed: { data: any; error: unknown };
  try { claimed = await admin.rpc('claim_pilot_notifications', { p_limit: 10 }); }
  catch { return json({ error: 'Notification outbox is unavailable.' }, 503); }
  if (claimed.error || !Array.isArray(claimed.data)) return json({ error: 'Notification outbox is unavailable.' }, 503);
  let sent = 0; let failed = 0;
  for (const notice of claimed.data as Notice[]) {
    let messageId: string | null = null; let error: string | null = null;
    try {
      const daysRemaining = notice.kind === 'expired' ? 0 : Math.max(1, Math.ceil((Date.parse(notice.expires_at) - Date.now()) / 86_400_000));
      const composed = composePilotReminder({ daysRemaining, appUrl: env.APP_URL ?? 'https://roughbid.vercel.app', expiresAt: notice.expires_at });
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `roughbid-pilot-notice/${notice.id}` },
        body: JSON.stringify({ from: 'RoughBid <hello@mail.kspdominion.group>', to: [notice.email], ...composed }),
      });
      if (!response.ok) throw new Error(`Email provider rejected delivery (${response.status}).`);
      const result = await response.json() as { id?: unknown };
      if (typeof result.id !== 'string') throw new Error('Provider acceptance was not confirmed.');
      messageId = result.id;
    } catch (caught) { error = caught instanceof Error ? caught.message : 'Email acceptance was not confirmed.'; }
    try {
      const result = await admin.rpc('finish_pilot_notification', { p_notification_id: notice.id, p_lease_id: notice.lease_id, p_message_id: messageId, p_error: error });
      if (result.error) failed += 1;
      else if (messageId) sent += 1;
      else failed += 1;
    } catch { failed += 1; }
  }
  return json({ claimed: claimed.data.length, sent, failed }, failed ? 503 : 200);
}

export function verifyResendWebhook(raw: string, headers: Headers, secret: string, nowMs = Date.now()): { eventId: string; event: Record<string, any> } {
  if (!secret.startsWith('whsec_')) throw new Error('Webhook secret is not configured.');
  const id = headers.get('svix-id'); const timestamp = headers.get('svix-timestamp'); const signatures = headers.get('svix-signature');
  if (!id || id.length > 200 || !timestamp || !/^\d+$/.test(timestamp) || !signatures || Math.abs(nowMs / 1000 - Number(timestamp)) > 300) throw new Error('Invalid webhook signature.');
  const key = Buffer.from(secret.slice(6), 'base64');
  if (key.length < 16) throw new Error('Webhook secret is not configured.');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest('base64');
  if (!signatures.split(' ').some((signature) => signature.startsWith('v1,') && same(signature.slice(3), expected))) throw new Error('Invalid webhook signature.');
  return { eventId: id, event: JSON.parse(raw) as Record<string, any> };
}

export async function handleResendWebhook(request: Request, admin: Database, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!env.RESEND_WEBHOOK_SECRET?.trim()) return json({ error: 'Email delivery tracking is not configured.' }, 503);
  let verified: ReturnType<typeof verifyResendWebhook>;
  try {
    const raw = await request.text();
    if (raw.length > 100_000) return json({ error: 'Event too large.' }, 413);
    verified = verifyResendWebhook(raw, request.headers, env.RESEND_WEBHOOK_SECRET);
  } catch { return json({ error: 'Invalid webhook signature.' }, 400); }
  const { eventId, event } = verified;
  if (!['email.sent', 'email.delivered', 'email.delivery_delayed', 'email.bounced', 'email.complained', 'email.failed', 'email.suppressed'].includes(event.type)) return json({ received: true, ignored: true });
  if (typeof event.data?.email_id !== 'string' || event.data.email_id.length > 200 || typeof event.created_at !== 'string' || !Number.isFinite(Date.parse(event.created_at))) return json({ error: 'Invalid delivery event.' }, 400);
  try {
    const result = await admin.rpc('record_pilot_email_event', { p_event_id: eventId, p_message_id: event.data.email_id, p_event_type: event.type, p_occurred_at: event.created_at });
    if (result.error) return json({ error: 'Delivery event could not be recorded.' }, 503);
    return json({ received: true, ...result.data });
  } catch { return json({ error: 'Delivery event could not be recorded.' }, 503); }
}
