import { createHmac, timingSafeEqual } from 'node:crypto';

export type StripeEvent = { id: string; type: string; data: unknown };

function signatureParts(header: string): { timestamp: number; signatures: string[] } {
  const fields = header.split(',').map((part) => part.split('=', 2));
  const timestamp = Number(fields.find(([key]) => key === 't')?.[1]);
  const signatures = fields.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!Number.isFinite(timestamp) || signatures.length === 0) throw new Error('Invalid Stripe signature.');
  return { timestamp, signatures };
}

export function verifyStripeSignature(rawBody: string, header: string, secret: string, now = Date.now()): void {
  if (!secret) throw new Error('Stripe webhook secret is required.');
  const { timestamp, signatures } = signatureParts(header);
  if (Math.abs(Math.floor(now / 1000) - timestamp) > 300) throw new Error('Stripe signature timestamp is outside tolerance.');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const valid = signatures.some((signature) => {
    if (!/^[a-f\d]{64}$/i.test(signature)) return false;
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  });
  if (!valid) throw new Error('Invalid Stripe signature.');
}

export class StripeWebhookHandler {
  readonly processedEventIds = new Set<string>();
  readonly #inFlight = new Map<string, Promise<void>>();
  private readonly secret: string;
  private readonly processEvent: (event: StripeEvent) => void | Promise<void>;

  constructor(secret: string, processEvent: (event: StripeEvent) => void | Promise<void>) {
    this.secret = secret;
    this.processEvent = processEvent;
  }

  async handle(rawBody: string, signature: string, now = Date.now()): Promise<{ duplicate: boolean }> {
    verifyStripeSignature(rawBody, signature, this.secret, now);
    const event = JSON.parse(rawBody) as StripeEvent;
    if (!event.id || !event.type) throw new Error('Invalid Stripe event payload.');
    if (this.processedEventIds.has(event.id)) return { duplicate: true };
    const existing = this.#inFlight.get(event.id);
    if (existing) {
      await existing;
      return { duplicate: true };
    }
    const processing = Promise.resolve(this.processEvent(event)).then(() => {
      this.processedEventIds.add(event.id);
    });
    this.#inFlight.set(event.id, processing);
    try {
      await processing;
    } finally {
      this.#inFlight.delete(event.id);
    }
    return { duplicate: false };
  }
}
