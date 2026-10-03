import { cropSheetRegion, planPageRegions, readSheetFrame, type PageRegion } from '../ai-plan/page-tiles.ts';
import type { DeepPassRequest, DeepPassResult } from './types.ts';
import type { FullTakeoffV2ProviderFactory } from './service.ts';

export type StageFactoryInput = Parameters<FullTakeoffV2ProviderFactory['create']>[0];
export interface StageRegion {
  id: string;
  region: PageRegion;
  pdfBytes: Uint8Array;
  pageWidthPoints: number;
  pageHeightPoints: number;
}
export interface RegionCheckpointStore {
  begin(input: StageFactoryInput, request: DeepPassRequest, region: StageRegion, identity: string): Promise<
    { disposition: 'run' } | { disposition: 'saved'; result: DeepPassResult }>;
  save(input: StageFactoryInput, request: DeepPassRequest, region: StageRegion, identity: string, result: DeepPassResult): Promise<void>;
}
export async function isolateStageRegions(bytes: Uint8Array, grid: 2 | 3): Promise<StageRegion[]> {
  const frame = await readSheetFrame(bytes);
  const regions = planPageRegions(frame, grid);
  return Promise.all(regions.map(async region => ({ id: `r${region.row}c${region.column}g${grid}`,
    region, pdfBytes: await cropSheetRegion(bytes, frame, region), pageWidthPoints: frame.width, pageHeightPoints: frame.height })));
}
export async function stageRegionIdentity(request: DeepPassRequest, region: StageRegion, provider: string, model: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ run: request.runId, page: request.sheet.physicalPageNumber,
    pageHash: request.sheet.pageSha256, pass: request.passType, region: region.id, rectangle: region.region, provider, model, version: 1 }));
  return Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
}

/** The current SQL worker lease fences every region before and after dispatch. */
export class SqlRegionCheckpointStore implements RegionCheckpointStore {
  private readonly rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
  constructor(rpc: SqlRegionCheckpointStore['rpc']) { this.rpc = rpc; }
  private identity(input: StageFactoryInput, request: DeepPassRequest, region: StageRegion, identity: string) {
    if (!input.leaseId || input.runId !== request.runId) throw new Error('Regional checkpoint requires the active worker lease.');
    return { p_run_id: input.runId, p_lease_id: input.leaseId, p_page_number: request.sheet.physicalPageNumber,
      p_page_sha256: request.sheet.pageSha256, p_pass_type: request.passType, p_region_key: region.id,
      p_region: region.region, p_idempotency_key: identity };
  }
  async begin(input: StageFactoryInput, request: DeepPassRequest, region: StageRegion, identity: string) {
    const result = await this.rpc('begin_full_takeoff_region', this.identity(input, request, region, identity));
    if (result.error || !result.data || typeof result.data !== 'object') throw new Error('Regional dispatch requires saved identity reconciliation.');
    const data = result.data as Record<string, unknown>;
    if (data.disposition === 'run') return { disposition: 'run' as const };
    if (data.disposition !== 'saved' || !data.result || typeof data.result !== 'object') throw new Error('Regional dispatch cannot repeat an uncertain result.');
    return { disposition: 'saved' as const, result: data.result as DeepPassResult };
  }
  async save(input: StageFactoryInput, request: DeepPassRequest, region: StageRegion, identity: string, result: DeepPassResult) {
    const saved = await this.rpc('save_full_takeoff_region', { ...this.identity(input, request, region, identity), p_result: result });
    if (saved.error || saved.data !== true) throw new Error('Regional checkpoint could not be saved by its active lease.');
  }
}
