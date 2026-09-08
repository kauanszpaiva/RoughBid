import type { BillingRepository, StripeGateway } from './endpoints.ts';
import type { BillingCustomerUpdate, HostedCheckoutRequest, PortalRequest, StripeEvent } from './stripe.ts';

function appendForm(form: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined) return;
  if (Array.isArray(value)) return value.forEach((item, index) => appendForm(form, `${key}[${index}]`, item));
  if (value && typeof value === 'object') return Object.entries(value).forEach(([child, item]) => appendForm(form, key ? `${key}[${child}]` : child, item));
  form.set(key, String(value));
}

/** Server-only Stripe REST adapter. Never expose its secret key to a browser bundle. */
export class StripeHttpGateway implements StripeGateway {
  private readonly secretKey: string;
  private readonly fetcher: typeof fetch;

  constructor(secretKey: string, fetcher: typeof fetch = fetch) {
    if (!secretKey.startsWith('sk_')) throw new Error('A server-side Stripe secret key is required.');
    this.secretKey = secretKey;
    this.fetcher = fetcher;
  }

  private async create(path: string, value: HostedCheckoutRequest | PortalRequest): Promise<{ url: string }> {
    const body = new URLSearchParams();
    appendForm(body, '', value);
    const response = await this.fetcher(`https://api.stripe.com/v1/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' }, body,
    });
    const result = await response.json() as { url?: string; error?: { message?: string } };
    if (!response.ok || !result.url) throw new Error(result.error?.message ?? 'Stripe did not create a billing session.');
    return { url: result.url };
  }

  createCheckoutSession(value: HostedCheckoutRequest) { return this.create('checkout/sessions', value); }
  createPortalSession(value: PortalRequest) { return this.create('billing_portal/sessions', value); }
}

/** Service-role Supabase adapter; the RPC atomically claims the event and updates billing state. */
export class SupabaseBillingRepository implements BillingRepository {
  private readonly url: string;
  private readonly serviceRoleKey: string;
  private readonly fetcher: typeof fetch;

  constructor(url: string, serviceRoleKey: string, fetcher: typeof fetch = fetch) {
    if (!url || !serviceRoleKey) throw new Error('Supabase server credentials are required.');
    this.url = url;
    this.serviceRoleKey = serviceRoleKey;
    this.fetcher = fetcher;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    return this.fetcher(`${this.url.replace(/\/$/, '')}/rest/v1/${path}`, {
      ...init, headers: { apikey: this.serviceRoleKey, authorization: `Bearer ${this.serviceRoleKey}`, 'content-type': 'application/json', ...init.headers },
    });
  }

  async customerIdForUser(userId: string): Promise<string | null> {
    const response = await this.request(`billing_customers?select=stripe_customer_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`, { method: 'GET' });
    if (!response.ok) throw new Error('Unable to read billing customer.');
    const rows = await response.json() as Array<{ stripe_customer_id: string | null }>;
    return rows[0]?.stripe_customer_id ?? null;
  }

  async isPlatformAdminForUser(userId: string): Promise<boolean> {
    const response = await this.request(`profiles?select=is_platform_admin&id=eq.${encodeURIComponent(userId)}&limit=1`, { method: 'GET' });
    if (!response.ok) throw new Error('Unable to verify platform owner billing access.');
    const rows = await response.json() as Array<{ is_platform_admin: boolean | null }>;
    return rows[0]?.is_platform_admin === true;
  }

  async processStripeEvent(event: Pick<StripeEvent, 'id' | 'type' | 'livemode'>, update: BillingCustomerUpdate | null): Promise<boolean> {
    const response = await this.request('rpc/process_stripe_event', { method: 'POST', body: JSON.stringify({
      p_event_id: event.id, p_event_type: event.type, p_livemode: event.livemode,
      p_user_id: update?.userId ?? null, p_customer_id: update?.stripeCustomerId ?? null,
      p_subscription_id: update?.stripeSubscriptionId ?? null, p_price_id: update?.stripePriceId ?? null,
      p_status: update?.subscriptionStatus ?? null, p_period_end: update?.currentPeriodEnd ?? null,
    }) });
    if (!response.ok) throw new Error('Unable to persist Stripe event.');
    return await response.json() as boolean;
  }
}
