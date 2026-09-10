import { roughbidEmailFrom, roughbidEmailHtml } from '../email/brand.ts';

export const PILOT_PRESETS = {
  sample1: { label: 'Single-project sample', days: 7, projects: '1 project total' },
  month1: { label: '30-day limited access', days: 30, projects: '1 new project per rolling 7 days' },
  pilot60: { label: '60-day limited pilot', days: 60, projects: '2 new projects per rolling 7 days' },
} as const;
export type PilotPreset = keyof typeof PILOT_PRESETS;

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
    from: roughbidEmailFrom(), to: [input.to],
    subject: `Your RoughBid invitation — ${preset.label}`, text,
    html: roughbidEmailHtml({ title: 'Your private RoughBid workspace', paragraphs: [terms, next, `Sign in with ${input.to}. Activate before ${expiry.toISOString().slice(0, 10)}.`], action: { label: 'Activate my access', url: url.toString() }, footer: 'If you did not expect this invitation, ignore this email.' }),
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
  const subject = input.daysRemaining > 0 ? `Your RoughBid access ends in ${input.daysRemaining} days` : 'Your RoughBid limited access has ended';
  const expiryText = `Your limited RoughBid access ends at ${input.expiresAt}. Your projects remain yours.`;
  const terms = 'Future paid use follows normal RoughBid pricing and requires your checkout approval; no automatic charge is scheduled.';
  return {
    subject,
    text: `${expiryText} ${terms} Open RoughBid: ${url.toString()}`,
    html: roughbidEmailHtml({ title: subject, paragraphs: [expiryText, terms], action: { label: 'Open RoughBid', url: url.toString() }, footer: 'This is an account notice about your limited RoughBid access.' }),
  };
}
