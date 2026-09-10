import type { AuthenticatedUser, BillingRepository, StripeGateway } from './endpoints.ts';
import type { HostedCheckoutRequest, PortalRequest, StripeEvent, StripeReconciliationUpdate, StripeSubscription, StripeMode } from './stripe.ts';

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

  constructor(secretKey: string, fetcher: typeof fetch = fetch, expectedMode?: StripeMode) {
    if (!secretKey.startsWith('sk_')) throw new Error('A server-side Stripe secret key is required.');
    if (expectedMode && !secretKey.startsWith(`sk_${expectedMode}_`)) throw new Error('Stripe secret key mode does not match billing configuration.');
    this.secretKey = secretKey;
    this.fetcher = fetcher;
  }

  private async create(path: string, value: HostedCheckoutRequest | PortalRequest, idempotencyKey?: string): Promise<{ url: string }> {
    const body = new URLSearchParams();
    appendForm(body, '', value);
    const response = await this.fetcher(`https://api.stripe.com/v1/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, body,
    });
    const result = await response.json() as { url?: string; error?: { message?: string } };
    if (!response.ok || !result.url) throw new Error(result.error?.message ?? 'Stripe did not create a billing session.');
    return { url: result.url };
  }

  createCheckoutSession(value: HostedCheckoutRequest, idempotencyKey?: string) { return this.create('checkout/sessions', value, idempotencyKey); }
  createPortalSession(value: PortalRequest) { return this.create('billing_portal/sessions', value); }

  async createCustomer(user: AuthenticatedUser): Promise<string> {
    const response = await this.fetcher('https://api.stripe.com/v1/customers', {
      method: 'POST', headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `roughbid-customer-${user.id}` },
      body: new URLSearchParams({ email: user.email, 'metadata[user_id]': user.id }),
    });
    const result = await response.json() as { id?: string };
    if (!response.ok || !result.id?.startsWith('cus_')) throw new Error('Unable to create billing customer.');
    return result.id;
  }

  async hasBlockingSubscription(customerId: string, priceIds: readonly string[] = [], workspaceId?: string): Promise<boolean> {
    // More than 100 subscriptions is unexpected: fail closed rather than overlook a later page.
    const response = await this.fetcher(`https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=100`, { headers: { authorization: `Bearer ${this.secretKey}` } });
    const result = await response.json() as { data?: Array<{ status: string;metadata?:{workspace_id?:string};items?:{data?:Array<{price?:{id?:string}}>} }>; has_more?: boolean };
    if (!response.ok || !Array.isArray(result.data)) throw new Error('Unable to verify existing subscriptions.');
    return result.has_more === true || result.data.some(item => !['canceled', 'incomplete_expired'].includes(item.status)
      // Marketplace subscriptions belong to a workspace. Unknown scope still blocks a possible duplicate.
      && (!workspaceId || !item.metadata?.workspace_id || item.metadata.workspace_id === workspaceId)
      && (!priceIds.length || item.items?.data?.some(line=>priceIds.includes(line.price?.id??''))));
  }

  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscription> {
    // Payment entitlement depends on the authoritative invoice state. Stripe
    // otherwise returns latest_invoice as an ID, never as proof of payment.
    const response = await this.fetcher(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}?expand%5B%5D=latest_invoice`, { headers: { authorization: `Bearer ${this.secretKey}` } });
    const result = await response.json() as StripeSubscription;
    if (!response.ok || result.id !== subscriptionId) throw new Error('Unable to read current Stripe subscription.');
    return result;
  }

  async retrieveInvoiceSubscription(invoiceId: string): Promise<string | null> {
    if (!invoiceId.startsWith('in_')) throw new Error('Invalid Stripe invoice identity.');
    const response=await this.fetcher(`https://api.stripe.com/v1/invoices/${encodeURIComponent(invoiceId)}`,{headers:{authorization:`Bearer ${this.secretKey}`}});
    const result=await response.json() as any;
    if (!response.ok || result.id!==invoiceId) throw new Error('Unable to read current Stripe invoice.');
    const subscription=result.parent?.subscription_details?.subscription ?? result.subscription;
    return typeof subscription==='string'?subscription:subscription?.id??null;
  }

  async retrieveChargeInvoice(chargeId:string):Promise<string|null>{
    if(!chargeId.startsWith('ch_'))throw new Error('Invalid Stripe charge identity.');
    const response=await this.fetcher(`https://api.stripe.com/v1/charges/${encodeURIComponent(chargeId)}`,{headers:{authorization:`Bearer ${this.secretKey}`}});
    const result=await response.json() as any;
    if(!response.ok||result.id!==chargeId)throw new Error('Unable to read current Stripe charge.');
    const invoice=result.invoice;
    return typeof invoice==='string'?invoice:invoice?.id??null;
  }
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

  async saveCustomer(userId: string, customerId: string): Promise<void> {
    const response = await this.request('rpc/save_billing_customer', { method: 'POST', body: JSON.stringify({ p_user_id: userId, p_customer_id: customerId }) });
    if (!response.ok) throw new Error('Unable to persist billing customer.');
  }

  async hasActivePilot(userId: string): Promise<boolean> {
    const response = await this.request('rpc/get_pilot_access', { method: 'POST', body: JSON.stringify({ p_user_id: userId }) });
    if (!response.ok) throw new Error('Unable to verify pilot billing access.');
    const result = await response.json() as { active?: boolean };
    if (typeof result?.active !== 'boolean') throw new Error('Invalid pilot billing state.');
    return result.active;
  }

  async claimCheckout(userId: string, priceKey: string): Promise<{ id: string; expiresAt: number }> {
    const response = await this.request('rpc/claim_billing_checkout', { method: 'POST', body: JSON.stringify({ p_user_id: userId, p_price_key: priceKey }) });
    if (!response.ok) throw new Error('A membership checkout or subscription already exists. Use the billing portal or retry after the current checkout expires.');
    const result = await response.json() as { id: string; expires_at: string };
    return { id: result.id, expiresAt: Math.floor(Date.parse(result.expires_at) / 1000) };
  }

  async claimMarketplaceCheckout(userId: string, workspaceId: string, feedId: string, priceId: string, mode: 'test'|'live'): Promise<{id:string;expiresAt:number}> {
    const response=await this.request('rpc/claim_marketplace_checkout',{method:'POST',body:JSON.stringify({
      p_user_id:userId,p_workspace_id:workspaceId,p_feed_id:feedId,p_price_id:priceId,p_mode:mode,
    })});
    if (!response.ok) throw new Error('Marketplace checkout is not authorized or another checkout is already active.');
    const result=await response.json() as {id:string;expires_at:string};
    return {id:result.id,expiresAt:Math.floor(Date.parse(result.expires_at)/1000)};
  }

  async beginSubscriptionSync(subscriptionId: string): Promise<number> {
    const response = await this.request('rpc/begin_billing_subscription_sync', { method: 'POST', body: JSON.stringify({ p_subscription_id: subscriptionId }) });
    if (!response.ok) throw new Error('Unable to begin subscription reconciliation.');
    return await response.json() as number;
  }

  async processStripeEvent(event: Pick<StripeEvent, 'id' | 'type' | 'livemode'>, update: StripeReconciliationUpdate | null): Promise<boolean> {
    const marketplace=update && 'kind' in update && update.kind==='marketplace'?update:null;
    const response = await this.request('rpc/process_stripe_event', { method: 'POST', body: JSON.stringify({
      p_event_id: event.id, p_event_type: event.type, p_livemode: event.livemode,
      p_user_id: update?.userId ?? null, p_customer_id: update?.stripeCustomerId ?? null,
      p_subscription_id: update?.stripeSubscriptionId ?? null, p_price_id: update?.stripePriceId ?? null,
      p_status: update?.subscriptionStatus ?? null, p_period_end: update?.currentPeriodEnd ?? null,
      p_invoice_paid: update?.invoicePaid ?? false, p_sync_revision: update?.syncRevision ?? null,
      p_marketplace_workspace_id:marketplace?.workspaceId??null,p_marketplace_feed_id:marketplace?.feedId??null,
      p_marketplace_invoice_id:marketplace?.invoiceId??null,p_marketplace_checkout_session_id:marketplace?.checkoutSessionId??null,
      p_marketplace_amount_paid:marketplace?.amountPaid??null,p_marketplace_currency:marketplace?.currency??null,
      p_marketplace_force_revoke:marketplace?.forceRevoke??false,
    }) });
    if (!response.ok) throw new Error('Unable to persist Stripe event.');
    return await response.json() as boolean;
  }
}
