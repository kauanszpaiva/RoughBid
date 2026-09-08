export const PILOT_PRESETS = {
  sample1: { label: 'Single-project sample', days: 7, projects: '1 project total' },
  month1: { label: '30-day limited access', days: 30, projects: '1 new project per rolling 7 days' },
  pilot60: { label: '60-day limited pilot', days: 60, projects: '2 new projects per rolling 7 days' },
} as const;
export type PilotPreset = keyof typeof PILOT_PRESETS;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function composePilotEmail(input: { to: string; inviteUrl: string; preset: PilotPreset; expiresAt: string }) {
  const url = new URL(input.inviteUrl);
  if (url.protocol !== 'https:') throw new TypeError('Pilot invitation links must use HTTPS.');
  const preset = PILOT_PRESETS[input.preset];
  if (!preset) throw new TypeError('Unknown access preset.');
  const expiry = new Date(input.expiresAt);
  if (!Number.isFinite(expiry.getTime())) throw new TypeError('Invalid invitation expiry.');
  const terms = `${preset.days} days from activation. ${preset.projects}; one PDF per project, up to 10 MiB and 10 pages; one AI attempt per project. AI access is subject to the pilot usage budget and service availability.`;
  const next = 'No credit card is needed. Your access is tied to this email address. When the access period ends, normal RoughBid pricing applies to future paid use. You will not be charged automatically; any purchase requires checkout.';
  const text = `You are invited to RoughBid\n\n${terms}\n\n${next}\n\nOpen your invitation: ${url.toString()}\nSign in with ${input.to} to activate your private workspace.\nActivate before ${expiry.toISOString()}.\n\nIf you did not expect this invitation, ignore this email.`;
  return {
    from: 'RoughBid <hello@mail.kspdominion.group>', to: [input.to],
    subject: `Your RoughBid invitation — ${preset.label}`, text,
    html: `<html><body style="margin:0;background:#f8fafc;font-family:Arial,sans-serif;color:#0f172a"><table role="presentation" width="100%"><tr><td align="center" style="padding:32px 16px"><table role="presentation" style="max-width:600px;background:white;border:1px solid #e2e8f0" width="100%"><tr><td style="padding:28px"><h1 style="font-size:24px">Your private RoughBid workspace</h1><p style="line-height:1.7">${escapeHtml(terms)}</p><p style="line-height:1.7">${escapeHtml(next)}</p><p style="padding:12px 0"><a href="${escapeHtml(url.toString())}" style="background:#2563eb;color:white;padding:14px 20px;text-decoration:none;border-radius:6px">Activate my access</a></p><p style="font-size:13px;color:#475569">Sign in with ${escapeHtml(input.to)}. Activate before ${escapeHtml(expiry.toISOString().slice(0, 10))}.</p><p style="font-size:12px;color:#64748b">If you did not expect this invitation, ignore this email.</p></td></tr></table></td></tr></table></body></html>`,
  };
}

export async function sendPilotEmail(input: Parameters<typeof composePilotEmail>[0] & { invitationId: string }, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!apiKey.trim()) throw new Error('Pilot email delivery is not configured.');
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `roughbid-pilot-invite/${input.invitationId}` },
    body: JSON.stringify(composePilotEmail(input)),
  });
  if (!response.ok) throw new Error(`Email provider rejected delivery (${response.status}).`);
  const body = await response.json() as { id?: unknown };
  if (typeof body.id !== 'string') throw new Error('Email provider did not confirm acceptance.');
  return body.id;
}

export function composePilotReminder(input: { daysRemaining: number; appUrl: string; expiresAt: string }) {
  const url = new URL('/app/', input.appUrl);
  if (url.protocol !== 'https:') throw new TypeError('App URL must use HTTPS.');
  return {
    subject: input.daysRemaining > 0 ? `Your RoughBid access ends in ${input.daysRemaining} days` : 'Your RoughBid limited access has ended',
    text: `Your limited RoughBid access ends at ${input.expiresAt}. Your projects remain yours. Future paid use follows normal RoughBid pricing and requires your checkout approval; no automatic charge is scheduled. Open RoughBid: ${url.toString()}`,
  };
}
