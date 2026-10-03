import { ProjectApiError, type SupabaseLike } from '../projects/service.ts';
import type { ConstructionMeasurement } from './service.ts';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** SI is the measured provider quantity. Conversion is for the catalog unit only, exactly once. */
export function geometryCatalogQuantity(quantitySI: unknown, unitSI: unknown): { quantity: number; unit: 'SF'|'LF'|'EA'; conversion: string } | null {
  if (typeof quantitySI !== 'number' || !Number.isFinite(quantitySI) || quantitySI < 0 || quantitySI > 1e9) return null;
  const divisor = unitSI === 'm2' ? 0.09290304 : unitSI === 'm' ? 0.3048 : unitSI === 'EA' ? 1 : null;
  if (divisor === null || unitSI === 'EA' && !Number.isSafeInteger(quantitySI)) return null;
  const quantity = Math.round(quantitySI / divisor * 1e6) / 1e6;
  // A positive but sub-precision source never becomes a confirmed zero.
  if (!Number.isFinite(quantity) || quantity > 1e9 || quantitySI > 0 && quantity === 0) return null;
  return { quantity, unit: unitSI === 'm2' ? 'SF' : unitSI === 'm' ? 'LF' : 'EA',
    conversion: unitSI === 'm2' ? 'm2 / 0.09290304; catalog precision 0.000001 SF' : unitSI === 'm' ? 'm / 0.3048; catalog precision 0.000001 LF' : 'individual visible object count; no area aggregation' };
}

export async function acceptedAutomaticGeometry(db: SupabaseLike, workspaceId: string, projectId: string): Promise<{
  measurements: ConstructionMeasurement[]; hasMore: boolean; availability: 'available'|'schema_not_activated';
}> {
  const found = await db.from('geometry_provider_candidates').select('id,run_id,candidate,review_revision')
    .eq('workspace_id',workspaceId).eq('project_id',projectId).eq('status','accepted').limit(501);
  if (found.error) {
    const error = found.error as { code?: string; message?: string };
    if (error.code === '42P01' || error.code === 'PGRST205' || /relation ["']?(?:public\.)?geometry_provider_candidates["']? does not exist/i.test(error.message ?? '')) {
      return { measurements: [], hasMore: false, availability: 'schema_not_activated' };
    }
    throw new ProjectApiError(503,'Accepted automatic geometric evidence could not be read. No candidate quantity was substituted.');
  }
  if (!Array.isArray(found.data)) throw new ProjectApiError(503,'Automatic geometric evidence returned an invalid collection.');
  const measurements: ConstructionMeasurement[] = [];
  for (const row of found.data.slice(0,500)) {
    if (!record(row) || typeof row.id !== 'string' || !/^[a-f0-9]{64}$/.test(row.id) || typeof row.run_id !== 'string' || !record(row.candidate)) continue;
    const candidate = row.candidate;
    const quantitySI=Object.hasOwn(candidate,'quantitySI')?candidate.quantitySI:candidate.quantity;
    const converted = geometryCatalogQuantity(quantitySI,candidate.unit);
    if (!converted || !record(candidate.source) || !Number.isSafeInteger(row.review_revision) || Number(row.review_revision)<1) continue;
    measurements.push({id:row.id,sourceKind:'geometry',runId:row.run_id,label:String(candidate.label ?? candidate.name ?? candidate.measurementKind ?? 'Automatic geometric element'),
      quantity:converted.quantity,unit:converted.unit,reviewStatus:'accepted',
      evidenceRef:`geometry:${row.run_id}:${row.id}:v${row.review_revision}`,
      ...(Number.isSafeInteger(candidate.physicalPageNumber) ? {pageNumber:Number(candidate.physicalPageNumber)} : {}),
      sourceEvidence:{method:'automatic_provider_si',quantitySI,unitSI:candidate.unit,conversion:converted.conversion,
        geometry:candidate.geometry ?? candidate.geometryGeoJSON ?? null,source:candidate.source,reviewRevision:row.review_revision}});
  }
  return { measurements, hasMore:found.data.length>500, availability:'available' };
}
