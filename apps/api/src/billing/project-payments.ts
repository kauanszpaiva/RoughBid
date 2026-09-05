import { ProjectApiError, assertPlanStoragePath, type SupabaseLike } from '../projects/service.ts';
import type { AiPlanObjectStorage } from '../ai-plan/service.ts';
import { downloadPlan, inspectPdf, normalizeScope, quoteProject } from './project-preflight.ts';
import { isConfiguredValue, requirePaidPlanReadingConfig } from '../ai-plan/readiness.ts';
import type { ProjectMembership } from '../../../../packages/domain/src/project-charge.ts';
import type { StripeEvent } from './stripe.ts';
export interface ServerDatabase { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: any }> }
export function databaseValue(result: { data: any; error: any }) {
  if (result.error) throw new ProjectApiError(503, 'Unable to save payment or processing state. Please try again.');
  return result.data;
}
const publicQuote = (q: any) => ({ id: q.id, project_id: q.project_id, file_id: q.file_id, amount_cents: q.amount_cents, currency: q.currency,
  page_count: q.page_count, trades: q.trades, scope: q.scope, status: q.status, attempts: q.attempts,
  job_id: q.job_id, expires_at: q.expires_at, membership: q.membership, max_attempts: 2 });
export class ProjectPayments {
  private db: ServerDatabase;
  private env: Record<string,string|undefined>;
  private fetcher: typeof fetch;
  constructor(db: ServerDatabase, env: Record<string,string|undefined>, fetcher: typeof fetch = fetch) {
    this.db=db; this.env=env; this.fetcher=fetcher;
  }
  async access(userId: string, workspaceId: string, projectId: string) {
    const member = databaseValue(await this.db.from('workspace_members').select('role').eq('workspace_id',workspaceId).eq('user_id',userId).maybeSingle());
    if (!member || !['admin','estimator'].includes(member.role)) throw new ProjectApiError(403,'Only company administrators and estimators can purchase or start a reading.');
    const project = databaseValue(await this.db.from('projects').select('id').eq('workspace_id',workspaceId).eq('id',projectId).maybeSingle());
    if (!project) throw new ProjectApiError(404,'Project not found.');
  }
  async membership(workspaceId: string): Promise<ProjectMembership> {
    const workspace = databaseValue(await this.db.from('workspaces').select('created_by').eq('id',workspaceId).single());
    const bill = databaseValue(await this.db.from('billing_customers').select('stripe_price_id,subscription_status,current_period_end').eq('user_id',workspace.created_by).maybeSingle());
    if (!bill || bill.subscription_status !== 'active' || !bill.current_period_end || Date.parse(bill.current_period_end) <= Date.now()) return 'standard';
    for (const tier of ['starter','pro','team','enterprise'] as const) {
      const id = this.env[`STRIPE_PRICE_PLAN_${tier.toUpperCase()}`];
      if (id && id === bill.stripe_price_id) return tier;
    }
    return 'standard';
  }
  async quote(userId: string, workspaceId: string, projectId: string, input: Record<string,unknown>, storage: AiPlanObjectStorage) {
    await this.access(userId,workspaceId,projectId);
    requirePaidPlanReadingConfig(this.env);
    const fileId = input.file_id;
    if (typeof fileId !== 'string') throw new ProjectApiError(400,'Select an uploaded plan.');
    const file = databaseValue(await this.db.from('project_files').select('id,storage_path,processing_status').eq('workspace_id',workspaceId).eq('project_id',projectId).eq('id',fileId).maybeSingle());
    if (!file) throw new ProjectApiError(404,'Plan not found.');
    assertPlanStoragePath(file.storage_path,workspaceId,projectId,fileId);
    if (['uploading','failed'].includes(file.processing_status)) throw new ProjectApiError(409,'Wait for the upload to finish.');
    const scope = normalizeScope(input);
    const bytes = await downloadPlan((await storage.presign('GET',file.storage_path,{expiresIn:300})).url,this.fetcher);
    const fileInfo = await inspectPdf(bytes);
    const membership = await this.membership(workspaceId);
    const price = quoteProject(fileInfo.pages,scope.trades.length,membership,this.env);
    const row = databaseValue(await this.db.rpc('create_project_reading_quote', { p_input: { workspace_id:workspaceId,project_id:projectId,file_id:fileId,user_id:userId,
      file_sha256:fileInfo.sha256,page_count:fileInfo.pages,trades:scope.trades,scope:scope.scope,amount_cents:price.amountCents,cost_cents:price.costCents,
      membership,pricing_version:price.version,livemode:this.env.STRIPE_MODE === 'live' } }));
    return publicQuote(row);
  }
  async checkout(userId: string, workspaceId: string, projectId: string, quoteId: string) {
    await this.access(userId,workspaceId,projectId);
    requirePaidPlanReadingConfig(this.env);
    const q = databaseValue(await this.db.from('project_reading_quotes').select('*').eq('id',quoteId).eq('project_id',projectId).eq('workspace_id',workspaceId).maybeSingle());
    if (!q) throw new ProjectApiError(404,'Quote not found.');
    if (q.status !== 'quoted' || Date.parse(q.expires_at) <= Date.now()+30_000) throw new ProjectApiError(409,'Refresh the project price or check its payment status.');
    const key = this.env.STRIPE_SECRET_KEY;
    const appUrl = this.env.APP_URL;
    if (!isConfiguredValue(key) || !key.startsWith(q.livemode ? 'sk_live_' : 'sk_test_') || !isConfiguredValue(this.env.STRIPE_WEBHOOK_SECRET) || !isConfiguredValue(appUrl) || new URL(appUrl).protocol !== 'https:') throw new ProjectApiError(503,'Checkout is not configured.');
    if (q.stripe_session_id) {
      const response = await this.fetcher(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(q.stripe_session_id)}`,{headers:{authorization:`Bearer ${key}`}});
      const session = await response.json() as {url?:string;status?:string};
      if (!response.ok || !session.url || session.status !== 'open') throw new ProjectApiError(409,'Checkout has closed. Check payment status in your project.');
      return {url:session.url};
    }
    if (Date.parse(q.expires_at) < Date.now()+30*60_000) throw new ProjectApiError(409,'Refresh the project price before paying.');
    const params = new URLSearchParams({ mode:'payment', 'payment_method_types[0]':'card',
      'line_items[0][price_data][currency]':q.currency, 'line_items[0][price_data][unit_amount]':String(q.amount_cents),
      'line_items[0][price_data][product_data][name]':`RoughBid — ${q.page_count} page plan reading`, 'line_items[0][quantity]':'1',
      'metadata[roughbid_quote_id]':q.id, 'metadata[workspace_id]':workspaceId, 'metadata[project_id]':projectId,
      'payment_intent_data[metadata][roughbid_quote_id]':q.id,
      expires_at:String(Math.floor(Date.parse(q.expires_at)/1000)),
      client_reference_id:q.user_id, success_url:new URL('/app/?payment=returned',appUrl).href, cancel_url:new URL('/app/?payment=canceled',appUrl).href,
    });
    // One Stripe session per immutable quote, with matching expiry and no hidden retries.
    const response = await this.fetcher('https://api.stripe.com/v1/checkout/sessions',{method:'POST',
      headers:{authorization:`Bearer ${key}`,'content-type':'application/x-www-form-urlencoded','idempotency-key':`roughbid-quote-${q.id}`},body:params});
    const session = await response.json() as { id?: string; url?: string };
    if (!response.ok || !session.id || !session.url) throw new ProjectApiError(502,'Could not open secure checkout. Please try again.');
    databaseValue(await this.db.from('project_reading_quotes').update({stripe_session_id:session.id}).eq('id',q.id));
    return { url:session.url };
  }
  async reconcile(event: StripeEvent): Promise<void> {
    const obj = event.data.object as any;
    if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const intent = obj.payment_intent;
      if (typeof intent !== 'string' || (event.type === 'charge.refunded' && !(obj.amount_refunded > 0))) return;
      const quote = databaseValue(await this.db.from('project_reading_quotes').select('id').eq('payment_intent_id',intent).maybeSingle());
      const quoteId = quote?.id ?? obj.metadata?.roughbid_quote_id;
      if (quoteId) databaseValue(await this.db.rpc('revoke_project_reading_payment',{p_event_id:event.id,p_quote_id:quoteId,p_payment_intent:intent,p_livemode:event.livemode}));
      return;
    }
    if (!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) return;
    const quoteId = obj.metadata?.roughbid_quote_id;
    if (!quoteId || obj.mode !== 'payment' || obj.payment_status !== 'paid') return;
    if (typeof obj.payment_intent !== 'string' || !Number.isSafeInteger(obj.amount_total) || typeof obj.currency !== 'string') throw new Error('Invalid project payment event');
    databaseValue(await this.db.rpc('confirm_project_reading_payment',{p_event_id:event.id,p_quote_id:quoteId,p_session_id:obj.id,
      p_payment_intent:obj.payment_intent,p_amount:obj.amount_total,p_currency:obj.currency,p_livemode:event.livemode}));
  }
}
export async function handleProjectPayment(request: Request, db: SupabaseLike, payments: ProjectPayments, storage: AiPlanObjectStorage): Promise<Response> {
  try {
    if (request.method !== 'POST') return Response.json({error:'Method not allowed'},{status:405});
    const {data,error} = await db.auth.getUser();
    if (error || !data.user) throw new ProjectApiError(401,'Sign in to continue.');
    const workspaceId = request.headers.get('x-workspace-id');
    if (!workspaceId) throw new ProjectApiError(400,'Select a company.');
    const parts = new URL(request.url).pathname.split('/');
    const projectId = parts[3]!;
    const input = await request.json();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProjectApiError(400,'Invalid request.');
    const result = parts[4] === 'reading-quote'
      ? await payments.quote(data.user.id,workspaceId,projectId,input,storage)
      : await payments.checkout(data.user.id,workspaceId,projectId,String(input.quote_id ?? ''));
    return Response.json(result);
  } catch(error) {
    return Response.json({error:error instanceof ProjectApiError ? error.message : 'Unable to prepare this project.'},{status:error instanceof ProjectApiError ? error.status : 500});
  }
}
