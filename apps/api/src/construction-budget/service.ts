import { createHash } from 'node:crypto';
import researchData from '../../../../packages/domain/data/roughbid-catalog-base.json' with { type: 'json' };
import { validateResearchConstructionCatalog, researchCatalogToConstructionCatalog, resolveResearchAssembly,
  researchUnitToCanonical } from '../../../../packages/domain/src/research-catalog.ts';
import { calculateCatalogPurchase, estimateCatalogCost, type CatalogQuantity, type ConstructionCatalog, type ConstructionCatalogItem } from '../../../../packages/domain/src/construction-catalog.ts';
import { validateDocumentedSupplierQuote, evaluateSupplierQuote, quoteLocalDate, quotePriceProvenance,
  type DocumentedSupplierQuote, type QuoteLocation } from '../../../../packages/domain/src/supplier-quotes.ts';
import { COST_SCALE, costDecimal, costDivide, costMoney, costMultiply, costNumber } from '../../../../packages/domain/src/cost-decimal.ts';
import type { ConfirmedCatalogInput } from '../../../../packages/domain/src/catalog-expressions.ts';
import { buildConstructionBudgetTax,type ConstructionBudgetTaxBinding } from '../../../../packages/domain/src/construction-budget-tax.ts';
import { isCanonicalUnit, type CanonicalUnit } from '../../../../packages/domain/src/takeoff-v2.ts';
import { ProjectApiError, type SupabaseLike } from '../projects/service.ts';
import { acceptedAutomaticGeometry } from './geometry-measurements.ts';

const research = validateResearchConstructionCatalog(researchData);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(message: string): never { throw new ProjectApiError(422, message); }
function identity(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) invalid(`A valid ${field} is required.`);
  return value;
}
function rows<T>(response: { data: T; error: unknown }, message: string): T {
  if (response.error) throw new ProjectApiError(503, message); return response.data;
}
export interface ConstructionMeasurement {
  id: string; sourceKind: 'plan' | 'photo' | 'geometry'; runId: string; label: string; quantity: number; unit: CanonicalUnit;
  reviewStatus: 'accepted'; evidenceRef: string; pageNumber?: number;
  sourceEvidence?: Record<string,unknown>;
}
export class ConstructionBudgetService {
  private readonly db: SupabaseLike;
  private readonly writer: { rpc?(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
  private readonly userId: string;
  private readonly workspaceId: string;
  private readonly now: () => string;
  constructor(db: SupabaseLike, writer: ConstructionBudgetService['writer'], userId: string, workspaceId: string, now = () => new Date().toISOString()) {
    this.db = db; this.writer = writer; this.userId = userId; this.workspaceId = workspaceId; this.now = now;
  }
  private async access(projectId: string, write = false) {
    identity(projectId, 'project');
    const membership = rows<any>(await this.db.from('workspace_members').select('role').eq('workspace_id', this.workspaceId)
      .eq('user_id', this.userId).maybeSingle(), 'Workspace authorization could not be read.');
    if (!membership || !['admin','estimator','viewer'].includes(membership.role) || (write && membership.role === 'viewer')) throw new ProjectApiError(403, 'Project estimating permission is required.');
    const project = rows<any>(await this.db.from('projects').select('id').eq('workspace_id',this.workspaceId).eq('id',projectId).maybeSingle(), 'Project authorization could not be read.');
    if (!project) throw new ProjectApiError(404, 'Project not found.');
  }
  private async rpc(name: string, args: Record<string, unknown>) {
    if (!this.writer.rpc) throw new ProjectApiError(503, 'Construction budget persistence is unavailable.');
    const result = await this.writer.rpc(name, args);
    if (result.error) throw new ProjectApiError(409, 'The saved construction record conflicted or could not be authorized. Reload before continuing.');
    return result.data;
  }
  async quotes(projectId: string) {
    await this.access(projectId);
    const found = rows<any[]>(await this.db.from('construction_supplier_quotes').select('quote,created_at')
      .eq('workspace_id',this.workspaceId).eq('project_id',projectId).order('created_at',{ascending:false}).limit(101), 'Documented quotes could not be read.');
    const quotes:DocumentedSupplierQuote[]=[];let bytes=0;
    for(const row of found.slice(0,100)){
      const size=Buffer.byteLength(JSON.stringify(row.quote));
      if(size>32_000)throw new ProjectApiError(413,'An imported quote exceeds its document bound. Use a compact source reference.');
      if(bytes+size>750_000)break;quotes.push(row.quote);bytes+=size;
    }
    return { quotes, hasMore:found.length>quotes.length, sourcePolicy: 'documented_import_only' };
  }
  async importQuotes(projectId: string, input: unknown) {
    await this.access(projectId,true);
    if (!record(input) || !Array.isArray(input.quotes) || !input.quotes.length || input.quotes.length > 100) invalid('Import 1–100 documented quotes per batch.');
    const seen = new Set<string>(), at = this.now();
    const quotes = input.quotes.map(value => {
      const quote = validateDocumentedSupplierQuote(value);
      if(Buffer.byteLength(JSON.stringify(quote))>32_000)invalid('Each documented quote must fit 32 KB. Preserve full supplier documents outside this metadata record.');
      if (!['supplier_quote','manual_quote','cache'].includes(quote.origin)) invalid('A manual import cannot attest partner API/feed access.');
      if (seen.has(quote.id)) invalid('Quote identities must be unique within the import.'); seen.add(quote.id);
      // Original evidence dates remain unchanged; a new import is not a new price.
      return { ...quote, importedAt: at, reviewedBy: this.userId, reviewedAt: at };
    });
    await this.rpc('save_construction_supplier_quotes',{ p_user_id:this.userId,p_workspace_id:this.workspaceId,p_project_id:projectId,p_quotes:quotes });
    return this.quotes(projectId);
  }
  async measurements(projectId: string): Promise<{ measurements: ConstructionMeasurement[]; hasMore: boolean; geometryAvailability:string }> {
    const plans = rows<any[]>(await this.db.from('takeoff_measurement_reviews')
      .select('id,takeoff_run_id,label,quantity,unit,physical_page_number,page_sha256,review_revision')
      .eq('workspace_id',this.workspaceId).eq('project_id',projectId).eq('review_status','accepted').limit(501), 'Reviewed plan measurements could not be read.');
    const photos = rows<any[]>(await this.db.from('photo_takeoff_runs').select('id,approved:result->approvedMeasurements')
      .eq('workspace_id',this.workspaceId).eq('project_id',projectId).eq('status','needs_review').limit(26), 'Reviewed photo measurements could not be read.');
    const measurements: ConstructionMeasurement[] = plans.slice(0,500).filter(row => typeof row.quantity === 'number' || typeof row.quantity === 'string')
      .map(row => ({ id:row.id,sourceKind:'plan',runId:row.takeoff_run_id,label:row.label,quantity:Number(row.quantity),unit:row.unit,
        reviewStatus:'accepted',evidenceRef:`plan:${row.takeoff_run_id}:${row.page_sha256}:${row.id}:v${row.review_revision}`,pageNumber:row.physical_page_number }));
    for (const run of photos.slice(0,25)) {
      if (!Array.isArray(run.approved)) continue;
      for (const value of run.approved) {
        if (!record(value) || typeof value.quantity !== 'number' || typeof value.unit !== 'string' || !isCanonicalUnit(value.unit)
          || !Array.isArray(value.reviewerIds) || !value.reviewerIds.length || !Array.isArray(value.sourceRegions) || !value.sourceRegions.length) continue;
        measurements.push({ id:identity(value.id,'photo measurement'),sourceKind:'photo',runId:run.id,label:String(value.objectIdentityKey),
          quantity:value.quantity,unit:value.unit,reviewStatus:'accepted',evidenceRef:`photo:${run.id}:${value.id}` });
      }
    }
    const automatic=await acceptedAutomaticGeometry(this.db,this.workspaceId,projectId);
    measurements.push(...automatic.measurements);
    return { measurements:measurements.slice(0,500), hasMore:measurements.length>500 || plans.length>500 || photos.length>25 || automatic.hasMore,
      geometryAvailability:automatic.availability };
  }
  async get(projectId: string, snapshotId?: string) {
    await this.access(projectId);
    const quoted = await this.quotes(projectId), measured = await this.measurements(projectId);
    const selected = snapshotId === undefined ? null : rows<any>(await this.db.from('construction_budget_snapshots')
      .select('id,result,location').eq('workspace_id',this.workspaceId).eq('project_id',projectId)
      .eq('id',identity(snapshotId,'snapshot')).maybeSingle(), 'Selected construction-budget evidence could not be read.');
    if(snapshotId !== undefined && !selected)throw new ProjectApiError(404,'Saved construction budget not found.');
    const snapshots = rows<any[]>(await this.db.from('construction_budget_snapshots')
      .select('id,source_kind,source_run_id,selection_count,summary:result->status,total:result->totalUsd,known:result->knownSubtotalUsd,location,created_at').eq('workspace_id',this.workspaceId)
      .eq('project_id',projectId).order('created_at',{ascending:false}).limit(6), 'Saved construction budgets could not be read.');
    const detail=selected ?? (snapshots[0] ? rows<any>(await this.db.from('construction_budget_snapshots').select('id,result,location')
      .eq('workspace_id',this.workspaceId).eq('project_id',projectId).eq('id',snapshots[0].id).maybeSingle(), 'Latest construction-budget evidence could not be read.') : null);
    // Shared quotes + one result stay below the HTTP response bound. Older
    // evidence is loaded explicitly, never mistaken for an empty calculation.
    const headers=snapshots.slice(0,5);
    if(detail && !headers.some(row=>row.id===detail.id)){
      const header=rows<any>(await this.db.from('construction_budget_snapshots').select('id,source_kind,source_run_id,selection_count,created_at')
        .eq('workspace_id',this.workspaceId).eq('project_id',projectId).eq('id',detail.id).maybeSingle(),'Saved construction-budget identity could not be read.');
      if(header)headers.push(header);
    }
    const state={ ...quoted,...measured,hasMoreQuotes:quoted.hasMore,hasMoreMeasurements:measured.hasMore,hasMoreSnapshots:snapshots.length>5,snapshots:headers.map(row => ({ id:row.id,sourceKind:row.source_kind,runId:row.source_run_id,
      selectionCount:row.selection_count,createdAt:row.created_at,detailLoaded:row.id===detail?.id,result:row.id===detail?.id ? detail.result : {
        status:row.summary ?? 'pending',totalUsd:row.total ?? null,knownSubtotalUsd:row.known ?? row.result?.knownSubtotalUsd,lines:[],missingInputs:[],trace:[],warnings:['Saved evidence details are not loaded. Open this snapshot to inspect its calculation.']
      },coverage:'partial',humanReviewRequired:true })),
      location:detail?.location ?? null,catalogRevision:research.revision,coverage:'partial',humanReviewRequired:true };
    if(Buffer.byteLength(JSON.stringify(state))>3_500_000)throw new ProjectApiError(413,'This documented evidence is too large for one response. Use smaller quoted source scopes; no evidence was truncated.');
    return state;
  }
  async calculate(projectId: string, input: unknown) {
    await this.access(projectId,true);
    if (!record(input) || !['plan','photo','geometry'].includes(String(input.sourceKind)) || !Array.isArray(input.selections)
      || !input.selections.length || input.selections.length>100 || !Array.isArray(input.quoteIds) || input.quoteIds.length>100) invalid('Select a saved run, 1–100 reviewed measurements and documented quotes.');
    const sourceKind=input.sourceKind as 'plan'|'photo'|'geometry', runId=identity(input.runId,'source run'), at=this.now();
    const location=input.location === undefined || input.location === null ? null : input.location as QuoteLocation;
    if (location && (location.country!=='US' || !/^\d{5}(?:-\d{4})?$/.test(location.postalCode) || !location.storeId || !location.timeZone)) invalid('Choose an explicit ZIP, store and project time zone.');
    const asOf=quoteLocalDate(at,location?.timeZone ?? 'Etc/UTC'), context={effectiveDate:asOf,place:location ? `US ${location.postalCode}` : null};
    const savedMeasurements=await this.measurements(projectId), accepted=new Map(savedMeasurements.measurements.filter(value => value.sourceKind===sourceKind && value.runId===runId).map(value => [value.id,value]));
    const base=researchCatalogToConstructionCatalog(research), catalog:ConstructionCatalog=structuredClone(base);
    if (input.catalogOverrides !== undefined) {
      if (!record(input.catalogOverrides) || input.catalogOverrides.schema!==base.schema || !Array.isArray(input.catalogOverrides.items) || input.catalogOverrides.items.length>500) invalid('Documented catalog inputs must use the construction catalog schema.');
      for(const value of input.catalogOverrides.items){
        if(!record(value)) invalid('Invalid documented catalog item.'); const id=identity(value.id,'catalog item');
        const index=catalog.items.findIndex(item => item.id===id); if(index<0 || catalog.items[index]!.kind!==value.kind || catalog.items[index]!.unit!==value.unit) invalid('Catalog inputs must preserve item identity, kind and physical unit.');
        catalog.items[index]=value as unknown as ConstructionCatalogItem;
      }
    }
    // Product price and freshness must come from a saved documented quote;
    // a browser-supplied rate/review flag cannot attest a supplier price.
    for(const item of catalog.items) if(item.kind==='material')item.rate={amount:null,source:null,reviewed:false};
    const quantities:CatalogQuantity[]=[], missing:string[]=[], trace:unknown[]=[], selected=new Set<string>(),equipmentUsageReferences=new Set<string>();
    for(const value of input.selections){
      if(!record(value)) invalid('Invalid assembly selection.');const id=identity(value.measurementId,'measurement');
      if(selected.has(id)) invalid('The same physical measurement cannot be costed twice in this snapshot.');selected.add(id);
      const measurement=accepted.get(id), assembly=research.assemblies.find(item => item.id===value.assemblyId);
      if(!measurement || !assembly || researchUnitToCanonical(assembly.unit)!==measurement.unit) invalid('A reviewed source measurement and a compatible assembly unit are required.');
      const inputs=(value.componentInputs ?? {}) as Record<string,Record<string,ConfirmedCatalogInput>>, activation=(value.activation ?? {}) as Record<string,boolean|null>;
      if(!record(inputs) || !record(activation)) invalid('Component inputs and applicability must remain scoped to their component.');
      const resolved=resolveResearchAssembly(research,assembly.id,{value:measurement.quantity,unit:assembly.unit,reviewed:true,sourceRef:measurement.evidenceRef},inputs,activation);
      quantities.push(...resolved.quantities.map(quantity => ({...quantity,id:`${id}:${quantity.id}`})));
      const labor=catalog.items.find(item => item.id===`${assembly.id}.labor`)!;
      quantities.push({id:`${id}:${labor.id}`,itemId:labor.id,quantity:measurement.quantity,unit:measurement.unit,reviewed:true,sourceRef:measurement.evidenceRef});
      const equipmentAllocations=value.equipmentAllocations??{};
      if(!record(equipmentAllocations)||Object.keys(equipmentAllocations).some(key=>!assembly.equipmentIds.includes(key)))invalid('Equipment allocations must reference this selected assembly.');
      for(const equipmentId of assembly.equipmentIds){
        const allocation=equipmentAllocations[equipmentId];
        if(allocation===undefined){quantities.push({id:`${id}:equipment:${equipmentId}`,itemId:`equipment:${equipmentId}`,quantity:null,unit:'EA',reviewed:false,sourceRef:null});continue;}
        if(!record(allocation)||allocation.unit!=='EA'||typeof allocation.reviewed!=='boolean'
          ||(allocation.quantity!==null&&(typeof allocation.quantity!=='number'||!Number.isFinite(allocation.quantity)||allocation.quantity<0||allocation.quantity>1_000_000||!/^\d+(?:\.\d{1,6})?$/.test(String(allocation.quantity))))
          ||(allocation.sourceRef!==null&&(typeof allocation.sourceRef!=='string'||!allocation.sourceRef.trim()||allocation.sourceRef.length>240)))invalid('A bounded manual equipment allocation, unit, source and review state are required.');
        const reviewed=allocation.reviewed===true&&allocation.quantity!==null&&typeof allocation.sourceRef==='string';
        if(reviewed){
          const reference=`${equipmentId}:${String(allocation.sourceRef).trim().normalize('NFKC').toLowerCase()}`;
          if(equipmentUsageReferences.has(reference))invalid('The same documented equipment usage cannot be charged twice. Allocate shared rental/use to one scope.');equipmentUsageReferences.add(reference);
        }
        quantities.push({id:`${id}:equipment:${equipmentId}`,itemId:`equipment:${equipmentId}`,quantity:allocation.quantity as number|null,unit:'EA',reviewed,
          sourceRef:reviewed?`${measurement.evidenceRef};equipment-allocation:${allocation.sourceRef}`:null});
        trace.push({kind:'manual_equipment_allocation',measurementId:id,equipmentId,allocation,physicalMeasureUnchanged:true});
      }
      missing.push(...resolved.pending.filter(reason => !reason.endsWith('labor_productivity_and_rates_pending')));
      trace.push({measurement,assemblyId:assembly.id,expressions:resolved.expressions});
    }
    const grouped=new Map<string,CatalogQuantity>();
    for(const quantity of quantities){
      const previous=grouped.get(quantity.itemId);
      if(!previous){grouped.set(quantity.itemId,{...quantity});continue;}
      if(previous.unit!==quantity.unit)invalid('A purchasing group cannot combine different physical units.');
      previous.quantity=previous.quantity===null || quantity.quantity===null ? null : costNumber(costDecimal(previous.quantity)+costDecimal(quantity.quantity));
      previous.reviewed=previous.reviewed&&quantity.reviewed;
      previous.sourceRef=previous.sourceRef&&quantity.sourceRef ? `${previous.sourceRef};${quantity.sourceRef}` : null;
    }
    const purchaseQuantities=[...grouped.values()];
    const quotes=(await this.quotes(projectId)).quotes as DocumentedSupplierQuote[], selectedQuoteIds=new Set(input.quoteIds.map(value => identity(value,'quote')));
    const quoteStates:ConstructionBudgetTaxBinding[]=[], bindings=Array.isArray(input.quoteBindings)?input.quoteBindings:[];
    if(bindings.length>100) invalid('Too many material quote bindings.');
    const bound=new Set<string>(),usedQuotes=new Set<string>();
    for(const value of bindings){
      if(!record(value)) invalid('Invalid quote binding.');const componentId=identity(value.componentId,'component'),quoteId=identity(value.quoteId,'quote');
      if(bound.has(componentId)) invalid('A material component cannot have competing quotes.');bound.add(componentId);
      const item=catalog.items.find(entry => entry.id===componentId), quote=quotes.find(entry => entry.id===quoteId);
      if(!item || item.kind!=='material' || !quote || !selectedQuoteIds.has(quoteId)) invalid('Select an imported quote and a material component.');
      if(usedQuotes.has(quoteId))invalid('One quoted purchase cannot be charged to multiple component groups without an explicit reviewed allocation.');usedQuotes.add(quoteId);
      if(value.specificationReviewed!==true || typeof value.sku!=='string' || typeof value.supplier!=='string' || !Object.hasOwn(value,'variant') || typeof value.channel!=='string')invalid('Review the exact selected product specification, SKU, supplier and purchasing channel.');
      const physical=grouped.get(componentId),pack=item.pack;
      let requiredPurchase:number|null=null;
      if(physical && physical.unit===pack.coverageUnit){
        if(pack.roundingRule==='round_up_increment')requiredPurchase=calculateCatalogPurchase({measure:physical.quantity,wasteFraction:item.wastePercent===null?null:item.wastePercent/100,
          coveragePerPackage:pack.coverageQuantity,minimumOrderPackages:pack.minimumOrderPackages,orderIncrement:pack.orderIncrement}).quantity;
        else if(pack.roundingRule==='none' && physical.quantity!==null && item.wastePercent!==null && pack.coverageQuantity!==null && pack.coverageQuantity>0)
          requiredPurchase=costNumber(costDivide(costMultiply(costDecimal(physical.quantity),COST_SCALE+costDivide(costDecimal(item.wastePercent),100n*COST_SCALE)),costDecimal(pack.coverageQuantity)));
      }
      const packagingMatches=pack.pricedUnit===quote.pricedUnit && pack.coverageQuantity===quote.coveragePerPricedUnit?.quantity
        && pack.coverageUnit===quote.coveragePerPricedUnit?.unit && pack.unitsPerPackage===quote.unitsPerPackage
        && pack.orderIncrement===quote.orderIncrement && pack.minimumOrderPackages===quote.minimumOrderPackages && pack.roundingRule===quote.roundingRule;
      const evaluated=evaluateSupplierQuote({supplier:value.supplier as DocumentedSupplierQuote['supplier'],location,sku:value.sku,variant:value.variant as string|null,channel:value.channel as DocumentedSupplierQuote['channel'],
        quantity:requiredPurchase,pricedUnit:pack.pricedUnit,mode:'documented_quote',partnerAccessVerified:false,contractEligibilityVerified:false},quote,at);
      quoteStates.push({componentId,quoteId,evaluation:evaluated});
      const provenance=quotePriceProvenance(quote,evaluated);
      if(!provenance || !packagingMatches){missing.push(`${componentId}:quote_freshness_or_purchase_unit_pending`);item.rate={amount:null,source:null,reviewed:false};}
      else item.rate={amount:quote.unitPrice,source:provenance,reviewed:true};
      missing.push(...evaluated.pending.map(reason => `${componentId}:${reason}`));
      // Freight/tax/discount are quoted per purchase, not per material unit.
      // They stay pending until allocated once to a matching purchasing group.
      if(Object.values(quote.charges).some(charge => charge.required!==false && !charge.refundable)) missing.push(`${componentId}:quote_purchase_charges_allocation_pending`);
    }
    let calculated;
    try{calculated=estimateCatalogCost(catalog,purchaseQuantities,context);}catch{invalid('Documented catalog costs, units, productivity or sources failed validation.');}
    // Fiscal reviews must eventually come from their own scoped immutable
    // persistence. No browser-supplied ledger or tax-inclusion assumption is used.
    const fiscal=buildConstructionBudgetTax({calculated,quotes:quotes.filter(quote=>selectedQuoteIds.has(quote.id)),quoteBindings:quoteStates,
      location,at,scope:{workspaceId:this.workspaceId,projectId},taxReviews:[],taxLedger:[]});
    const result={status:'pending',knownSubtotalUsd:costMoney(costDecimal(calculated.knownSubtotal)),totalUsd:null,
      lines:calculated.lines,missingInputs:[...new Set([...missing,...calculated.pending,...fiscal.pendingNodes.map(node=>node.id),'sheet_category_coverage_and_independent_review_pending'])],
      warnings:['This is a partial reviewed scope. A priced subset is not a complete construction quote.','Supplier integrations are not enabled; only documented imports are used.'],
      trace:[...trace,{kind:'construction_tax',traces:fiscal.traces}],fiscal,quoteStates,sourceQuoteEvidence:quotes.filter(quote=>selectedQuoteIds.has(quote.id)),catalogRevision:catalog.revision,calculationVersion:calculated.calculationVersion,coverage:'partial',humanReviewRequired:true};
    if(Buffer.byteLength(JSON.stringify(result))>1_000_000) invalid('The saved calculation exceeds its bound. Save a smaller documented scope; no result was truncated.');
    const requestHash=createHash('sha256').update(JSON.stringify({sourceKind,runId,input,result,asOf})).digest('hex');
    const saved=await this.rpc('save_construction_budget_snapshot',{p_user_id:this.userId,p_workspace_id:this.workspaceId,p_project_id:projectId,
      p_source_kind:sourceKind,p_source_run_id:runId,p_selection_count:input.selections.length,p_request_hash:requestHash,p_inputs:input,p_result:result,p_location:location});
    if(!record(saved))throw new ProjectApiError(503,'Saved calculation did not return its identity.');
    return {...saved,sourceKind,runId,selectionCount:input.selections.length,result,coverage:'partial',humanReviewRequired:true};
  }
}
