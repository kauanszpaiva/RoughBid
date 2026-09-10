import {
  type BillingConfig, type StripeEvent,
  chargeIdFromDisputeEvent, createCheckoutRequest, createPortalRequest, invoiceIdFromRevocationEvent, isBillingPriceKey, subscriptionIdFromEvent,
  verifiedMarketplaceUpdate, verifiedSubscriptionUpdate, verifyStripeWebhook,
  type StripeReconciliationUpdate, type StripeSubscription,
} from './stripe.ts';

export type AuthenticatedUser = { id: string; email: string; isPlatformAdmin?: boolean };
export interface StripeGateway {
  createCheckoutSession(input: ReturnType<typeof createCheckoutRequest>, idempotencyKey?: string): Promise<{ url: string }>;
  createPortalSession(input: ReturnType<typeof createPortalRequest>): Promise<{ url: string }>;
  createCustomer?(user: AuthenticatedUser): Promise<string>;
  hasBlockingSubscription?(customerId: string, priceIds: readonly string[], workspaceId?: string): Promise<boolean>;
  retrieveSubscription?(subscriptionId: string): Promise<StripeSubscription>;
  retrieveInvoiceSubscription?(invoiceId: string): Promise<string | null>;
  retrieveChargeInvoice?(chargeId:string):Promise<string|null>;
}
export interface BillingRepository {
  customerIdForUser(userId: string): Promise<string | null>;
  isPlatformAdminForUser?(userId: string): Promise<boolean>;
  hasActivePilot?(userId: string): Promise<boolean>;
  saveCustomer?(userId: string, customerId: string): Promise<void>;
  claimCheckout?(userId: string, priceKey: string): Promise<{ id: string; expiresAt: number }>;
  claimMarketplaceCheckout?(userId: string, workspaceId: string, feedId: string, priceId: string, mode: 'test'|'live'): Promise<{ id: string; expiresAt: number }>;
  beginSubscriptionSync?(subscriptionId: string): Promise<number>;
  /** Must insert stripe_events and apply update in one transaction; false means event_id already exists. */
  processStripeEvent(event: Pick<StripeEvent, 'id' | 'type' | 'livemode'>, update: StripeReconciliationUpdate | null): Promise<boolean>;
}
export type BillingEndpointDependencies = {
  config: BillingConfig; webhookSecret: string; stripe: StripeGateway; repository: BillingRepository;
  membershipsEnabled?: boolean;
  marketplaceEnabled?: boolean;
  reconcileProjectPayment?(event: StripeEvent): Promise<void>;
  authenticate(request: Request): Promise<AuthenticatedUser | null>;
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function input(request: Request): Promise<Record<string, unknown>> { return await request.json() as Record<string, unknown>; }

function approvedReturnUrl(value: unknown, appUrl: string | undefined): string {
  if (!appUrl) throw new Error('The application billing return URL is not configured.');
  const approved = new URL(appUrl);
  const requested = new URL(String(value ?? ''));
  if (approved.protocol !== 'https:' || requested.origin !== approved.origin || requested.username || requested.password) {
    throw new Error('Billing return URL must use the approved application origin.');
  }
  return requested.href;
}

/** Framework-neutral server route handler for Checkout, Portal, and /api/webhooks/stripe. */
export function createBillingEndpointHandler(deps: BillingEndpointDependencies) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
    if (path === '/api/webhooks/stripe') {
      const rawBody = await request.text();
      let event: StripeEvent;
      let validationStage: 'signature' | 'event' | 'mode' = 'signature';
      try {
        verifyStripeWebhook(rawBody, request.headers.get('stripe-signature'), deps.webhookSecret);
        validationStage = 'event';
        event = JSON.parse(rawBody) as StripeEvent;
        if (!event.id || !event.type || typeof event.livemode !== 'boolean') throw new Error('Malformed Stripe event.');
        validationStage = 'mode';
        if (event.livemode !== (deps.config.mode === 'live')) throw new Error('Stripe mode mismatch.');
      } catch {
        // Fixed enum only: never expose payloads, signature headers or secrets.
        console.warn('Stripe webhook validation failed', { stage: validationStage });
        return json(400, { error: 'Invalid Stripe webhook.' });
      }
      try {
        await deps.reconcileProjectPayment?.(event);
        let subscriptionId = subscriptionIdFromEvent(event);
        let revocationInvoiceId=invoiceIdFromRevocationEvent(event);
        const disputeChargeId=chargeIdFromDisputeEvent(event);
        if(!revocationInvoiceId&&disputeChargeId){
          if(!deps.stripe.retrieveChargeInvoice)throw new Error('Charge reconciliation is unavailable.');
          revocationInvoiceId=await deps.stripe.retrieveChargeInvoice(disputeChargeId);
        }
        if (!subscriptionId && revocationInvoiceId) {
          if (!deps.stripe.retrieveInvoiceSubscription) throw new Error('Invoice reconciliation is unavailable.');
          subscriptionId=await deps.stripe.retrieveInvoiceSubscription(revocationInvoiceId);
        }
        let update: StripeReconciliationUpdate | null = null;
        if (subscriptionId) {
          if (!deps.stripe.retrieveSubscription || !deps.repository.beginSubscriptionSync) throw new Error('Subscription reconciliation is unavailable.');
          const revision = await deps.repository.beginSubscriptionSync(subscriptionId);
          const subscription = await deps.stripe.retrieveSubscription(subscriptionId);
          if (subscription.id !== subscriptionId) throw new Error('Stripe subscription identity mismatch.');
          const membershipPrices = Object.entries(deps.config.priceIds).filter(([key]) => key.startsWith('plan_')).map(([, price]) => price!);
          const marketplacePrices = Object.entries(deps.config.priceIds)
            .filter(([key,price]) => key.startsWith('marketplace_') && Boolean(price))
            .map(([priceKey,priceId])=>({priceKey:priceKey as any,priceId:priceId!,feedId:priceKey.replace(/^marketplace_/, '')}));
          update = verifiedMarketplaceUpdate(subscription, marketplacePrices, revision, event, Boolean(revocationInvoiceId))
            ?? verifiedSubscriptionUpdate(subscription, membershipPrices, revision);
        }
        const processed = await deps.repository.processStripeEvent(event, update);
        return json(200, { received: true, duplicate: !processed });
      } catch {
        // Delivery must be retried when Stripe or the database is unavailable.
        return json(503, { error: 'Stripe reconciliation is temporarily unavailable.' });
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
      let customerId = await deps.repository.customerIdForUser(user.id);
      if (path === '/api/billing/checkout') {
        const priceKey = isBillingPriceKey(body.priceKey) ? body.priceKey : undefined;
        if (priceKey?.startsWith('project_')) return json(409, {error:'Open the project to get its price and pay for the uploaded plan.'});
        if (priceKey ? !deps.config.priceIds[priceKey] : !deps.config.priceId) return json(503, { error: 'Checkout is not configured.' });
        if (!priceKey) return json(400, {error:'Select an available membership or open a project for its price.'});
        const marketplace=priceKey.startsWith('marketplace_');
        if (!marketplace && !priceKey.startsWith('plan_')) return json(400, {error:'Select an available RoughBid product.'});
        if (marketplace && !deps.marketplaceEnabled) return json(503, { error: 'Marketplace checkout is not enabled.' });
        if (marketplace && priceKey!=='marketplace_supplier_import') return json(503,{error:'This Marketplace feed is not available yet.'});
        if (!marketplace && !deps.membershipsEnabled) return json(503, {error:'Membership prices are not available yet.'});
        if (!deps.repository.hasActivePilot) return json(503, { error: 'Pilot billing verification is not configured.' });
        let activePilot: boolean;
        try { activePilot = await deps.repository.hasActivePilot(user.id); }
        catch { return json(503, { error: 'Unable to verify pilot billing access. Please try again.' }); }
        if (activePilot) return json(409, { error: 'Your sponsored pilot is active. Membership purchases become available when it ends.' });
        const successUrl = approvedReturnUrl(body.successUrl, deps.config.appUrl);
        const cancelUrl = approvedReturnUrl(body.cancelUrl, deps.config.appUrl);
        if (!deps.repository.saveCustomer || !deps.stripe.createCustomer || !deps.stripe.hasBlockingSubscription) {
          return json(503, { error: 'Checkout safeguards are not configured.' });
        }
        const selectedPrice=deps.config.priceIds[priceKey]!;
        const workspaceId=request.headers.get('x-workspace-id')?.trim() || '';
        let attempt:{id:string;expiresAt:number};
        if (marketplace) {
          if (!workspaceId || !deps.repository.claimMarketplaceCheckout) return json(503,{error:'Marketplace workspace checkout is not configured.'});
          attempt=await deps.repository.claimMarketplaceCheckout(user.id,workspaceId,'supplier_import',selectedPrice,deps.config.mode);
        } else {
          if (!deps.repository.claimCheckout) return json(503,{error:'Membership checkout safeguards are not configured.'});
          attempt=await deps.repository.claimCheckout(user.id,priceKey);
        }
        if (!customerId) {
          customerId = await deps.stripe.createCustomer(user);
          await deps.repository.saveCustomer(user.id, customerId);
        }
        const conflictingPrices=marketplace?[selectedPrice]:Object.entries(deps.config.priceIds).filter(([key])=>key.startsWith('plan_')).map(([,value])=>value!);
        if (await deps.stripe.hasBlockingSubscription(customerId,conflictingPrices,marketplace?workspaceId:undefined)) {
          return json(409, { error: marketplace?'This Marketplace add-on already has a subscription. Manage it in the billing portal.':'This account already has a membership. Manage it in the billing portal.' });
        }
        const checkoutInput = {
          customerEmail: user.email, customerId, userId: user.id,
          successUrl, cancelUrl, expiresAt: attempt.expiresAt,
          ...(marketplace?{workspaceId,marketplaceFeedId:'supplier_import'}:{}),
        };
        const session = await deps.stripe.createCheckoutSession(createCheckoutRequest(deps.config, {
          ...checkoutInput,
          ...(priceKey ? { priceKey } : {}),
        }), `roughbid-${marketplace?'marketplace':'membership'}-${attempt.id}`);
        return json(200, { url: session.url });
      }
      if (path === '/api/billing/portal') {
        if (!customerId) return json(409, { error: 'No Stripe customer exists for this account.' });
        const session = await deps.stripe.createPortalSession(createPortalRequest({ customerId, returnUrl: approvedReturnUrl(body.returnUrl, deps.config.appUrl) }));
        return json(200, { url: session.url });
      }
      return json(404, { error: 'Not found' });
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
  };
}
