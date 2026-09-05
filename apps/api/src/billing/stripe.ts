import { createHmac, timingSafeEqual } from 'node:crypto';

export type StripeMode = 'test' | 'live';

export type BillingPriceKey =
  | 'plan_starter'
  | 'plan_pro'
  | 'plan_team'
  | 'project_small'
  | 'project_standard'
  | 'project_large'
  | 'project_complex'
  | 'marketplace_new_england_codes'
  | 'marketplace_regional_material_prices'
  | 'marketplace_labor_benchmarks'
  | 'marketplace_supplier_import';

export const BILLING_PRICE_KEYS: readonly BillingPriceKey[] = [
  'plan_starter',
  'plan_pro',
  'plan_team',
  'project_small',
  'project_standard',
  'project_large',
  'project_complex',
  'marketplace_new_england_codes',
  'marketplace_regional_material_prices',
  'marketplace_labor_benchmarks',
  'marketplace_supplier_import',
];

export function isBillingPriceKey(value: unknown): value is BillingPriceKey {
  return typeof value === 'string' && (BILLING_PRICE_KEYS as readonly string[]).includes(value);
}

export type BillingConfigInput = {
  stripeMode: StripeMode;
  productId: string;
  priceId?: string;
  priceIds?: Partial<Record<BillingPriceKey, string>>;
};
export type BillingConfig = {
  mode: StripeMode;
  productId: string;
  priceId: string | null;
  priceIds: Partial<Record<BillingPriceKey, string>>;
};
export type CheckoutInput = {
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  userId?: string;
  customerId?: string | null;
  priceKey?: BillingPriceKey;
};
export type PortalInput = { customerId: string; returnUrl: string };

export type HostedCheckoutRequest = {
  mode: 'subscription' | 'payment'; ui_mode: 'hosted'; customer_email?: string;
  customer?: string; line_items: Array<{ price: string; quantity: 1 }>;
  success_url: string; cancel_url: string; client_reference_id?: string;
  subscription_data?: { metadata: { user_id: string } };
  metadata?: { user_id?: string; price_key?: string };
};

export type PortalRequest = { customer: string; return_url: string };

export function createBillingConfig(input: BillingConfigInput): BillingConfig {
  if (!input.productId.trim()) throw new Error('Stripe product ID is required.');
  const priceIds = Object.fromEntries(
    Object.entries(input.priceIds ?? {}).filter(([, value]) => typeof value === 'string' && value.trim()).map(([key, value]) => [key, String(value).trim()]),
  ) as Partial<Record<BillingPriceKey, string>>;
  return { mode: input.stripeMode, productId: input.productId.trim(), priceId: input.priceId?.trim() || null, priceIds };
}

export function createBillingConfigFromEnv(env: Record<string, string | undefined>): BillingConfig {
  const priceIds: Partial<Record<BillingPriceKey, string>> = {};
  for (const [key, value] of Object.entries({
    plan_starter: env.STRIPE_PRICE_PLAN_STARTER,
    plan_pro: env.STRIPE_PRICE_PLAN_PRO,
    plan_team: env.STRIPE_PRICE_PLAN_TEAM,
    project_small: env.STRIPE_PRICE_PROJECT_SMALL,
    project_standard: env.STRIPE_PRICE_PROJECT_STANDARD,
    project_large: env.STRIPE_PRICE_PROJECT_LARGE,
    project_complex: env.STRIPE_PRICE_PROJECT_COMPLEX,
    marketplace_new_england_codes: env.STRIPE_PRICE_MARKETPLACE_NEW_ENGLAND_CODES,
    marketplace_regional_material_prices: env.STRIPE_PRICE_MARKETPLACE_REGIONAL_MATERIAL_PRICES,
    marketplace_labor_benchmarks: env.STRIPE_PRICE_MARKETPLACE_LABOR_BENCHMARKS,
    marketplace_supplier_import: env.STRIPE_PRICE_MARKETPLACE_SUPPLIER_IMPORT,
  }) as Array<[BillingPriceKey, string | undefined]>) {
    if (value?.trim()) priceIds[key] = value.trim();
  }
  return createBillingConfig({
    stripeMode: env.STRIPE_MODE === 'live' ? 'live' : 'test',
    productId: env.STRIPE_PRODUCT_ID ?? '',
    priceId: env.STRIPE_PRICE_ID ?? '',
    priceIds,
  });
}

function requireHttps(value: string, label: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`);
  return value;
}

export function createCheckoutRequest(config: BillingConfig, input: CheckoutInput): HostedCheckoutRequest {
  const selectedPriceId = input.priceKey ? config.priceIds[input.priceKey] : config.priceId;
  if (!selectedPriceId) throw new Error('Checkout is disabled until an approved Stripe price is configured.');
  if (!input.customerId && !input.customerEmail.includes('@')) throw new Error('A valid customer email is required.');
  const checkoutMode = input.priceKey?.startsWith('project_') ? 'payment' : 'subscription';
  const request: HostedCheckoutRequest = {
    mode: checkoutMode, ui_mode: 'hosted', line_items: [{ price: selectedPriceId, quantity: 1 }],
    success_url: requireHttps(input.successUrl, 'success URL'), cancel_url: requireHttps(input.cancelUrl, 'cancel URL'),
  };
  if (input.customerId) request.customer = input.customerId;
  else request.customer_email = input.customerEmail;
  if (input.userId) {
    request.client_reference_id = input.userId;
    if (checkoutMode === 'subscription') request.subscription_data = { metadata: { user_id: input.userId } };
    else request.metadata = { user_id: input.userId, ...(input.priceKey ? { price_key: input.priceKey } : {}) };
  }
  return request;
}

export function createPortalRequest(input: PortalInput): PortalRequest {
  if (!input.customerId.startsWith('cus_')) throw new Error('A Stripe customer is required.');
  return { customer: input.customerId, return_url: requireHttps(input.returnUrl, 'return URL') };
}

export type StripeEvent = { id: string; type: string; livemode: boolean; data: { object: unknown } };

/** Verify Stripe's v1 HMAC signature against the unmodified request bytes. */
export function verifyStripeWebhook(rawBody: string | Uint8Array, signature: string | null, secret: string, now = Date.now(), toleranceSeconds = 300): void {
  if (!signature || !secret) throw new Error('Missing Stripe webhook signature or secret.');
  const parts = signature.split(',').map((part) => part.split('=', 2));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value).filter((value): value is string => Boolean(value));
  if (!timestamp || signatures.length === 0 || !/^\d+$/.test(timestamp)) throw new Error('Malformed Stripe webhook signature.');
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) throw new Error('Stripe webhook signature is too old.');
  const body = typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody);
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  const valid = signatures.some((candidate) => {
    if (!/^[\da-f]{64}$/i.test(candidate)) return false;
    return timingSafeEqual(expected, Buffer.from(candidate, 'hex'));
  });
  if (!valid) throw new Error('Invalid Stripe webhook signature.');
}

export type BillingCustomerUpdate = {
  userId: string; stripeCustomerId: string; stripeSubscriptionId: string;
  stripePriceId: string | null; subscriptionStatus: string; currentPeriodEnd: string | null;
};

type StripeSubscription = {
  id: string; customer: string | { id: string }; status: string; current_period_end?: number;
  metadata?: { user_id?: string }; items?: { data?: Array<{ price?: { id?: string } }> };
};

const SUBSCRIPTION_EVENTS = new Set(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']);

/** Convert only authoritative subscription webhooks into the billing row shape. */
export function subscriptionUpdateFromEvent(event: StripeEvent): BillingCustomerUpdate | null {
  if (!SUBSCRIPTION_EVENTS.has(event.type)) return null;
  const subscription = event.data.object as StripeSubscription;
  const userId = subscription.metadata?.user_id;
  if (!userId) throw new Error('Stripe subscription is missing metadata.user_id.');
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  return {
    userId, stripeCustomerId: customerId, stripeSubscriptionId: subscription.id,
    stripePriceId: subscription.items?.data?.[0]?.price?.id ?? null,
    subscriptionStatus: subscription.status,
    currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
  };
}
