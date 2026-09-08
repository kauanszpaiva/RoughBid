import {
  type BillingConfig, type BillingCustomerUpdate, type StripeEvent,
  createCheckoutRequest, createPortalRequest, isBillingPriceKey, subscriptionUpdateFromEvent, verifyStripeWebhook,
} from './stripe.ts';

export type AuthenticatedUser = { id: string; email: string; isPlatformAdmin?: boolean };
export interface StripeGateway {
  createCheckoutSession(input: ReturnType<typeof createCheckoutRequest>): Promise<{ url: string }>;
  createPortalSession(input: ReturnType<typeof createPortalRequest>): Promise<{ url: string }>;
}
export interface BillingRepository {
  customerIdForUser(userId: string): Promise<string | null>;
  isPlatformAdminForUser?(userId: string): Promise<boolean>;
  /** Must insert stripe_events and apply update in one transaction; false means event_id already exists. */
  processStripeEvent(event: Pick<StripeEvent, 'id' | 'type' | 'livemode'>, update: BillingCustomerUpdate | null): Promise<boolean>;
}
export type BillingEndpointDependencies = {
  config: BillingConfig; webhookSecret: string; stripe: StripeGateway; repository: BillingRepository;
  membershipsEnabled?: boolean;
  reconcileProjectPayment?(event: StripeEvent): Promise<void>;
  authenticate(request: Request): Promise<AuthenticatedUser | null>;
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function input(request: Request): Promise<Record<string, unknown>> { return await request.json() as Record<string, unknown>; }

/** Framework-neutral server route handler for Checkout, Portal, and /api/webhooks/stripe. */
export function createBillingEndpointHandler(deps: BillingEndpointDependencies) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
    if (path === '/api/webhooks/stripe') {
      const rawBody = await request.text();
      try {
        verifyStripeWebhook(rawBody, request.headers.get('stripe-signature'), deps.webhookSecret);
        const event = JSON.parse(rawBody) as StripeEvent;
        if (!event.id || !event.type || typeof event.livemode !== 'boolean') throw new Error('Malformed Stripe event.');
        if (event.livemode !== (deps.config.mode === 'live')) throw new Error('Stripe mode mismatch.');
        await deps.reconcileProjectPayment?.(event);
        const processed = await deps.repository.processStripeEvent(event, subscriptionUpdateFromEvent(event));
        return json(200, { received: true, duplicate: !processed });
      } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : 'Invalid webhook' });
      }
    }

    let user: AuthenticatedUser | null;
    try {
      user = await deps.authenticate(request);
    } catch {
      return json(503, { error: 'Unable to verify account billing access. Please try again.' });
    }
    if (!user) return json(401, { error: 'Unauthorized' });
    try {
      const body = await input(request);
      // Check with the server-side repository even when the auth adapter does
      // not carry profile metadata. Billing fails closed: inability to verify
      // the complimentary flag never falls through into an accidental charge.
      const isPlatformAdmin = user.isPlatformAdmin === true
        || (deps.repository.isPlatformAdminForUser ? await deps.repository.isPlatformAdminForUser(user.id) : false);
      if (path === '/api/billing/checkout' && isPlatformAdmin) {
        return json(409, { error: 'Platform owner access is complimentary. No checkout is required for this account.' });
      }
      const customerId = await deps.repository.customerIdForUser(user.id);
      if (path === '/api/billing/checkout') {
        const priceKey = isBillingPriceKey(body.priceKey) ? body.priceKey : undefined;
        if (priceKey?.startsWith('project_')) return json(409, {error:'Open the project to get its price and pay for the uploaded plan.'});
        if (priceKey ? !deps.config.priceIds[priceKey] : !deps.config.priceId) return json(503, { error: 'Checkout is not configured.' });
        if (!priceKey) return json(400, {error:'Select an available membership or open a project for its price.'});
        if (priceKey?.startsWith('plan_') && !deps.membershipsEnabled) return json(503, {error:'Membership prices are not available yet.'});
        const checkoutInput = {
          customerEmail: user.email, customerId, userId: user.id,
          successUrl: String(body.successUrl ?? ''), cancelUrl: String(body.cancelUrl ?? ''),
        };
        const session = await deps.stripe.createCheckoutSession(createCheckoutRequest(deps.config, {
          ...checkoutInput,
          ...(priceKey ? { priceKey } : {}),
        }));
        return json(200, { url: session.url });
      }
      if (path === '/api/billing/portal') {
        if (!customerId) return json(409, { error: 'No Stripe customer exists for this account.' });
        const session = await deps.stripe.createPortalSession(createPortalRequest({ customerId, returnUrl: String(body.returnUrl ?? '') }));
        return json(200, { url: session.url });
      }
      return json(404, { error: 'Not found' });
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
  };
}
