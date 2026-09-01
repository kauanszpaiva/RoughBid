export type StripeMode = 'test' | 'live';

export type BillingConfigInput = {
  stripeMode: StripeMode;
  productId: string;
  priceId: string;
};

export type BillingConfig = {
  mode: StripeMode;
  productId: string;
  priceId: string | null;
};

export type CheckoutInput = {
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
};

export type HostedCheckoutRequest = {
  mode: 'subscription';
  ui_mode: 'hosted';
  customer_email: string;
  line_items: Array<{ price: string; quantity: 1 }>;
  success_url: string;
  cancel_url: string;
};

export function createBillingConfig(input: BillingConfigInput): BillingConfig {
  if (!input.productId.trim()) throw new Error('Stripe product ID is required.');
  return {
    mode: input.stripeMode,
    productId: input.productId.trim(),
    priceId: input.priceId.trim() || null,
  };
}

export function createCheckoutRequest(config: BillingConfig, input: CheckoutInput): HostedCheckoutRequest {
  if (!config.priceId) {
    throw new Error('Checkout is disabled until an approved Stripe price is configured.');
  }
  if (!input.customerEmail.includes('@')) throw new Error('A valid customer email is required.');
  for (const [label, value] of [['success URL', input.successUrl], ['cancel URL', input.cancelUrl]] as const) {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`);
  }
  return {
    mode: 'subscription',
    ui_mode: 'hosted',
    customer_email: input.customerEmail,
    line_items: [{ price: config.priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  };
}
