import { isConfiguredValue } from '../ai-plan/readiness.ts';
import type { SupabaseLike } from '../projects/service.ts';

export const MARKETPLACE_PRICING_VERSION='2026-09-10-marketplace-v1';

const catalog=[
  {id:'supplier_import',priceKey:'marketplace_supplier_import',name:'Supplier Price Import',priceCents:4900,
    cadence:'month',description:'Import your own supplier CSV into the workspace price-book workflow.',availability:'available'},
  {id:'new_england_codes',priceKey:'marketplace_new_england_codes',name:'New England Code Assistant',priceCents:900,
    cadence:'month',description:'State-code reference feed. Not available until the source dataset and update process are verified.',availability:'coming_soon'},
  {id:'regional_material_prices',priceKey:'marketplace_regional_material_prices',name:'Regional Material Price Tables',priceCents:1900,
    cadence:'month',description:'Regional material pricing. Not available until licensed current data is connected.',availability:'coming_soon'},
  {id:'labor_benchmarks',priceKey:'marketplace_labor_benchmarks',name:'Local Labor Benchmarks',priceCents:2900,
    cadence:'month',description:'Local labor benchmarks. Not available until the methodology and coverage are verified.',availability:'coming_soon'},
] as const;

export async function handleMarketplaceCatalog(request:Request,db:SupabaseLike,env:Record<string,string|undefined>):Promise<Response>{
  if(request.method!=='GET') return Response.json({error:'Method not allowed'},{status:405});
  const {data,error}=await db.auth.getUser();
  if(error||!data.user) return Response.json({error:'Sign in to view the Marketplace.'},{status:401});
  const workspaceId=request.headers.get('x-workspace-id')?.trim();
  if(!workspaceId) return Response.json({error:'Select a company.'},{status:400});
  const member=await db.from('workspace_members').select('role').eq('workspace_id',workspaceId).eq('user_id',data.user.id).maybeSingle();
  if(member.error) return Response.json({error:'Unable to verify Marketplace access.'},{status:503});
  if(!member.data) return Response.json({error:'Workspace not found.'},{status:404});
  const profile=await db.from('profiles').select('is_platform_admin').eq('id',data.user.id).maybeSingle();
  if(profile.error) return Response.json({error:'Unable to verify Marketplace access.'},{status:503});
  const platformAdmin=profile.data?.is_platform_admin===true;
  const entitlementResult=await db.from('marketplace_entitlements').select('feed_id,status,invoice_paid,current_period_end,mode')
    .eq('workspace_id',workspaceId).eq('feed_id','supplier_import').maybeSingle();
  if(entitlementResult.error) return Response.json({error:'Unable to read Marketplace access.'},{status:503});
  const entitlement=entitlementResult.data as any;
  const currentMode=env.STRIPE_MODE==='live'?'live':'test';
  const entitled=platformAdmin||Boolean(entitlement&&['active','trialing'].includes(entitlement.status)&&entitlement.invoice_paid===true
    && entitlement.mode===currentMode&&entitlement.current_period_end&&Date.parse(entitlement.current_period_end)>Date.now());
  const checkoutConfigured=env.BILLING_MARKETPLACE_ENABLED==='true'
    && isConfiguredValue(env.STRIPE_PRICE_MARKETPLACE_SUPPLIER_IMPORT)
    && /^price_[A-Za-z0-9]+$/.test(env.STRIPE_PRICE_MARKETPLACE_SUPPLIER_IMPORT!);
  return Response.json({pricingVersion:MARKETPLACE_PRICING_VERSION,items:catalog.map(item=>({
    ...item,entitled:item.id==='supplier_import'&&entitled,
    checkoutAvailable:!platformAdmin&&!entitled&&item.id==='supplier_import'&&item.availability==='available'&&checkoutConfigured&&member.data.role==='admin',
  }))},{headers:{'cache-control':'private, no-store'}});
}
