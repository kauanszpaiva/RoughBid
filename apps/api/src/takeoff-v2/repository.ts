import { isCanonicalUnit } from '../../../../packages/domain/src/takeoff-v2.ts';
import type { PlanSheetManifestEntry } from './types.ts';

export type DecimalInput = string | number;

export type TakeoffV2Database = {
  auth?: {
    getUser(): Promise<{
      data: { user: { id: string } | null };
      error: { message?: string } | null;
    }>;
  };
  from(table: string): any;
  rpc?(name: string, args?: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message?: string } | null;
  }>;
};

export class TakeoffV2PersistenceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TakeoffV2PersistenceError';
    this.status = status;
  }
}

export type EstimateLineInput = {
  takeoffItemId?: string | null;
  assemblyVersionId?: string | null;
  priceSnapshotId?: string | null;
  description: string;
  unit: string;
  rawQuantity: DecimalInput;
  wastePercent?: DecimalInput;
  packageSize?: DecimalInput;
  roundingRule?: 'none' | 'round_up_package';
  materialRate?: DecimalInput;
  materialFreight?: DecimalInput;
  materialTax?: DecimalInput;
  laborHours?: DecimalInput;
  laborHourlyCost?: DecimalInput;
  equipmentTotal?: DecimalInput;
  subcontractTotal?: DecimalInput;
  otherDirectTotal?: DecimalInput;
  pricingStatus: 'priced' | 'unpriced' | 'provisional' | 'expired' | 'review_required';
};

const SCALE = 1_000_000n;

function decimal(value: DecimalInput | undefined, field: string, fallback = '0'): bigint {
  const candidate = value ?? fallback;
  if (typeof candidate !== 'string' && typeof candidate !== 'number') {
    throw new TakeoffV2PersistenceError(400, `${field} must be a decimal.`);
  }
  if (typeof candidate === 'number' && !Number.isFinite(candidate)) {
    throw new TakeoffV2PersistenceError(400, `${field} must be finite.`);
  }
  const text = String(candidate).trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) throw new TakeoffV2PersistenceError(400, `${field} must be a non-negative decimal with at most 6 decimal places.`);
  return BigInt(match[1]!) * SCALE + BigInt((match[2] ?? '').padEnd(6, '0') || '0');
}

function roundDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function multiply(left: bigint, right: bigint): bigint {
  return roundDivide(left * right, SCALE);
}

function format(value: bigint): string {
  const whole = value / SCALE;
  const fraction = String(value % SCALE).padStart(6, '0');
  return `${whole}.${fraction}`;
}

function inputFromStoredLine(line: Record<string, unknown>): EstimateLineInput {
  return {
    takeoffItemId: line.takeoff_item_id as string | null,
    assemblyVersionId: line.assembly_version_id as string | null,
    priceSnapshotId: line.price_snapshot_id as string | null,
    description: String(line.description ?? ''),
    unit: String(line.unit ?? ''),
    rawQuantity: String(line.raw_quantity ?? ''),
    wastePercent: String(line.waste_percent ?? '0'),
    packageSize: String(line.package_size ?? '1'),
    roundingRule: line.rounding_rule === 'round_up_package' ? 'round_up_package' : 'none',
    materialRate: String(line.material_rate ?? '0'),
    materialFreight: String(line.material_freight ?? '0'),
    materialTax: String(line.material_tax ?? '0'),
    laborHours: String(line.labor_hours ?? '0'),
    laborHourlyCost: String(line.labor_hourly_cost ?? '0'),
    equipmentTotal: String(line.equipment_total ?? '0'),
    subcontractTotal: String(line.subcontract_total ?? '0'),
    otherDirectTotal: String(line.other_direct_total ?? '0'),
    pricingStatus: line.pricing_status as EstimateLineInput['pricingStatus'],
  };
}

/**
 * Recomputes every derived line value with fixed-point decimal arithmetic.
 * Callers provide rates and explicit tax/freight amounts, never totals.
 */
export function calculateEstimateLine(input: EstimateLineInput) {
  const rawQuantity = decimal(input.rawQuantity, 'rawQuantity');
  const wastePercent = decimal(input.wastePercent, 'wastePercent');
  if (wastePercent > 100n * SCALE) throw new TakeoffV2PersistenceError(400, 'wastePercent must be between 0 and 100.');
  const packageSize = decimal(input.packageSize, 'packageSize', '1');
  if (packageSize === 0n) throw new TakeoffV2PersistenceError(400, 'packageSize must be greater than zero.');

  const wasteQuantity = roundDivide(rawQuantity * wastePercent, 100n * SCALE);
  const unroundedPurchase = rawQuantity + wasteQuantity;
  const roundingRule = input.roundingRule ?? 'none';
  const purchasingQuantity = roundingRule === 'round_up_package'
    ? ((unroundedPurchase + packageSize - 1n) / packageSize) * packageSize
    : unroundedPurchase;

  const materialRate = decimal(input.materialRate, 'materialRate');
  const materialFreight = decimal(input.materialFreight, 'materialFreight');
  const materialTax = decimal(input.materialTax, 'materialTax');
  const laborHours = decimal(input.laborHours, 'laborHours');
  const laborHourlyCost = decimal(input.laborHourlyCost, 'laborHourlyCost');
  const equipmentTotal = decimal(input.equipmentTotal, 'equipmentTotal');
  const subcontractTotal = decimal(input.subcontractTotal, 'subcontractTotal');
  const otherDirectTotal = decimal(input.otherDirectTotal, 'otherDirectTotal');
  const materialTotal = multiply(purchasingQuantity, materialRate) + materialFreight + materialTax;
  const laborTotal = multiply(laborHours, laborHourlyCost);
  const directTotal = materialTotal + laborTotal + equipmentTotal + subcontractTotal + otherDirectTotal;

  const description = input.description.trim();
  const unit = input.unit.trim().toUpperCase();
  if (!description) throw new TakeoffV2PersistenceError(400, 'description is required.');
  if (!isCanonicalUnit(unit)) throw new TakeoffV2PersistenceError(400, 'unit must be canonical.');
  if (roundingRule !== 'none' && roundingRule !== 'round_up_package') {
    throw new TakeoffV2PersistenceError(400, 'roundingRule is invalid.');
  }

  return {
    takeoff_item_id: input.takeoffItemId ?? null,
    assembly_version_id: input.assemblyVersionId ?? null,
    price_snapshot_id: input.priceSnapshotId ?? null,
    description,
    unit,
    raw_quantity: format(rawQuantity),
    waste_percent: format(wastePercent),
    waste_quantity: format(wasteQuantity),
    purchasing_quantity: format(purchasingQuantity),
    package_size: format(packageSize),
    rounding_rule: roundingRule,
    material_rate: format(materialRate),
    material_freight: format(materialFreight),
    material_tax: format(materialTax),
    material_total: format(materialTotal),
    labor_hours: format(laborHours),
    labor_hourly_cost: format(laborHourlyCost),
    labor_total: format(laborTotal),
    equipment_total: format(equipmentTotal),
    subcontract_total: format(subcontractTotal),
    other_direct_total: format(otherDirectTotal),
    direct_total: format(directTotal),
    pricing_status: input.pricingStatus,
  };
}

function result<T>(response: { data: T; error: { message?: string } | null }, notFoundMessage?: string): T {
  if (response.error) throw new TakeoffV2PersistenceError(500, response.error.message ?? 'Takeoff V2 persistence failed.');
  if (notFoundMessage && !response.data) throw new TakeoffV2PersistenceError(404, notFoundMessage);
  return response.data;
}

export class SupabaseTakeoffV2Repository {
  private readonly actorDb: TakeoffV2Database;
  private readonly serviceDb: TakeoffV2Database;

  constructor(
    actorDb: TakeoffV2Database,
    serviceDb: TakeoffV2Database,
  ) {
    this.actorDb = actorDb;
    this.serviceDb = serviceDb;
  }

  private async authorize(workspaceId: string, projectId: string): Promise<string> {
    if (!this.actorDb.auth) throw new TakeoffV2PersistenceError(401, 'Authentication required.');
    const auth = await this.actorDb.auth.getUser();
    if (auth.error || !auth.data.user) throw new TakeoffV2PersistenceError(401, 'Authentication required.');
    const membership = result<any>(await this.actorDb.from('workspace_members').select('role')
      .eq('workspace_id', workspaceId).eq('user_id', auth.data.user.id).maybeSingle());
    if (!membership || !['admin', 'estimator'].includes(membership.role)) {
      throw new TakeoffV2PersistenceError(403, 'Admin or estimator access is required.');
    }
    const project = result<any>(await this.actorDb.from('projects').select('id')
      .eq('workspace_id', workspaceId).eq('id', projectId).maybeSingle());
    if (!project) throw new TakeoffV2PersistenceError(404, 'Project not found.');
    return auth.data.user.id;
  }

  async createRun(input: {
    workspaceId: string;
    projectId: string;
    fileId: string;
    mode: 'deep' | 'full';
    fileSha256: string;
    orchestratorVersion: string;
  }): Promise<Record<string, unknown>> {
    const actorId = await this.authorize(input.workspaceId, input.projectId);
    const file = result<any>(await this.actorDb.from('project_files').select('id')
      .eq('workspace_id', input.workspaceId).eq('project_id', input.projectId)
      .eq('id', input.fileId).maybeSingle());
    if (!file) throw new TakeoffV2PersistenceError(404, 'Plan file not found.');
    return result<any>(await this.serviceDb.from('takeoff_runs').insert({
      workspace_id: input.workspaceId,
      project_id: input.projectId,
      file_id: input.fileId,
      mode: input.mode,
      file_sha256: input.fileSha256,
      orchestrator_version: input.orchestratorVersion,
      requested_by: actorId,
    }).select('*').single());
  }

  /** Worker-only persistence: scope is loaded from the run, never from provider output. */
  async persistPlanSheets(runId: string, sheets: readonly PlanSheetManifestEntry[]): Promise<unknown> {
    const run = result<any>(await this.serviceDb.from('takeoff_runs').select('id,workspace_id,project_id,file_id')
      .eq('id', runId).maybeSingle(), 'Takeoff run not found.');
    const rows = sheets.map(sheet => ({
      takeoff_run_id: run.id,
      workspace_id: run.workspace_id,
      project_id: run.project_id,
      file_id: run.file_id,
      physical_page_number: sheet.physicalPageNumber,
      page_sha256: sheet.pageSha256,
      width_points: sheet.widthPoints,
      height_points: sheet.heightPoints,
      rotation_degrees: sheet.rotationDegrees,
      content_kind: sheet.contentKind,
      text_quality: sheet.textQuality,
      status: sheet.status,
      status_reason: sheet.statusReason,
      metadata: { orientation: sheet.orientation },
    }));
    return result<any>(await this.serviceDb.from('plan_sheets').insert(rows).select('*'));
  }

  async addEstimateLine(
    workspaceId: string,
    projectId: string,
    estimateId: string,
    input: EstimateLineInput,
  ): Promise<Record<string, unknown>> {
    await this.authorize(workspaceId, projectId);
    const estimate = result<any>(await this.actorDb.from('estimate_versions_v2').select('id,status')
      .eq('workspace_id', workspaceId).eq('project_id', projectId).eq('id', estimateId).maybeSingle(), 'Estimate not found.');
    if (estimate.status !== 'draft' && estimate.status !== 'needs_review') {
      throw new TakeoffV2PersistenceError(409, 'Released estimates are immutable.');
    }
    const calculated = calculateEstimateLine(input);
    return result<any>(await this.serviceDb.from('estimate_line_items_v2').insert({
      estimate_id: estimateId,
      workspace_id: workspaceId,
      project_id: projectId,
      ...calculated,
    }).select('*').single());
  }

  async reviewTakeoffItem(
    workspaceId: string,
    projectId: string,
    takeoffItemId: string,
    status: 'accepted' | 'rejected' | 'blocked' | 'needs_review',
  ): Promise<Record<string, unknown>> {
    await this.authorize(workspaceId, projectId);
    if (!this.actorDb.rpc) throw new TakeoffV2PersistenceError(503, 'Takeoff review is unavailable.');
    const rpc = await this.actorDb.rpc('set_takeoff_item_review_status', {
      p_takeoff_item_id: takeoffItemId,
      p_status: status,
    });
    if (rpc.error) throw new TakeoffV2PersistenceError(/authoriz/i.test(rpc.error.message ?? '') ? 403 : 409, rpc.error.message ?? 'Takeoff review failed.');
    // Re-read through tenant RLS; never trust a privileged function response.
    return result<any>(await this.actorDb.from('takeoff_items').select('*')
      .eq('workspace_id', workspaceId).eq('project_id', projectId)
      .eq('id', takeoffItemId).maybeSingle(), 'Takeoff item not found.');
  }

  /** Reconciles persisted inputs before any release transition; no total is accepted from a caller. */
  async recalculateEstimate(
    workspaceId: string,
    projectId: string,
    estimateId: string,
    nextStatus: 'draft' | 'needs_review' | 'estimate_ready' | 'final' = 'draft',
  ): Promise<Record<string, unknown>> {
    const actorId = await this.authorize(workspaceId, projectId);
    const estimate = result<any>(await this.actorDb.from('estimate_versions_v2').select('id,status')
      .eq('workspace_id', workspaceId).eq('project_id', projectId).eq('id', estimateId).maybeSingle(), 'Estimate not found.');
    if (estimate.status === 'final') throw new TakeoffV2PersistenceError(409, 'Final estimates are immutable.');

    const lines = result<any[]>(await this.actorDb.from('estimate_line_items_v2').select('*')
      .eq('workspace_id', workspaceId).eq('project_id', projectId).eq('estimate_id', estimateId));
    if ((nextStatus === 'estimate_ready' || nextStatus === 'final') && lines.length === 0) {
      throw new TakeoffV2PersistenceError(409, 'An estimate cannot be released without line items.');
    }
    const calculated = lines.map(line => ({ source: line, row: calculateEstimateLine(inputFromStoredLine(line)) }));
    if ((nextStatus === 'estimate_ready' || nextStatus === 'final')
      && calculated.some(({ row }) => row.pricing_status !== 'priced')) {
      throw new TakeoffV2PersistenceError(409, 'Every estimate line must have reviewed pricing before release.');
    }

    let direct = 0n;
    for (const { source, row } of calculated) {
      direct += decimal(row.direct_total, 'directTotal');
      result<any>(await this.serviceDb.from('estimate_line_items_v2').update({
        waste_quantity: row.waste_quantity,
        purchasing_quantity: row.purchasing_quantity,
        material_total: row.material_total,
        labor_total: row.labor_total,
        direct_total: row.direct_total,
      }).eq('id', String(source.id)).eq('estimate_id', estimateId)
        .eq('workspace_id', workspaceId).eq('project_id', projectId));
    }

    const adjustments = result<any[]>(await this.actorDb.from('estimate_adjustments_v2').select('adjustment_type,amount')
      .eq('workspace_id', workspaceId).eq('project_id', projectId).eq('estimate_id', estimateId));
    const adjustmentTotals: Record<string, bigint> = {};
    let adjustmentTotal = 0n;
    for (const adjustment of adjustments) {
      const amount = decimal(String(adjustment.amount ?? ''), 'adjustment.amount');
      const type = String(adjustment.adjustment_type);
      adjustmentTotals[type] = (adjustmentTotals[type] ?? 0n) + amount;
      adjustmentTotal += amount;
    }
    const totals = {
      calculation_version: 'takeoff-v2-fixed-6',
      direct_cost: format(direct),
      adjustments: Object.fromEntries(Object.entries(adjustmentTotals).map(([key, value]) => [key, format(value)])),
      adjustment_total: format(adjustmentTotal),
      final_bid: format(direct + adjustmentTotal),
    };
    const changes: Record<string, unknown> = { totals, status: nextStatus, updated_at: new Date().toISOString() };
    if (nextStatus === 'final') {
      changes.finalized_by = actorId;
      changes.finalized_at = new Date().toISOString();
    }
    return result<any>(await this.serviceDb.from('estimate_versions_v2').update(changes)
      .eq('id', estimateId).eq('workspace_id', workspaceId).eq('project_id', projectId).select('*').single());
  }
}
