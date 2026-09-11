import type { SupabaseLike } from '../projects/service.ts';

const UNITS = new Set(['SF', 'LF', 'EA', 'CY', 'SY', 'HR', 'LS']);
const MAX_MATERIALS = 2_000;
const MAX_ASSEMBLIES = 1_000;
const MAX_PAYLOAD_BYTES = 2_000_000;

export class CatalogApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CatalogApiError';
    this.status = status;
  }
}

export type WorkspaceCatalog = {
  id: string | null;
  workspaceId: string;
  revision: number;
  materials: Record<string, unknown>[];
  assemblies: Record<string, unknown>[];
  contentSha256: string | null;
  createdBy: string | null;
  createdAt: string | null;
};

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new CatalogApiError(400, `${label} is required and must be at most ${max} characters`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value == null || value === '') return undefined;
  return requiredText(value, label, max);
}

function unit(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 2).toUpperCase();
  if (!UNITS.has(normalized)) throw new CatalogApiError(400, `${label} is not a supported estimating unit`);
  return normalized;
}

function nonNegativeNumber(value: unknown, label: string, optional = false): number | undefined {
  if (optional && value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
    throw new CatalogApiError(400, `${label} must be a finite non-negative number`);
  }
  return value;
}

function validateMaterials(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new CatalogApiError(400, 'materials must be an array');
  if (value.length > MAX_MATERIALS) throw new CatalogApiError(413, `materials cannot exceed ${MAX_MATERIALS} items`);
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new CatalogApiError(400, `materials[${index}] must be an object`);
    const item = candidate as Record<string, unknown>;
    const id = requiredText(item.id, `materials[${index}].id`, 120);
    if (seen.has(id)) throw new CatalogApiError(400, `materials contains duplicate id ${id}`);
    seen.add(id);
    const unitCost = nonNegativeNumber(item.unitCost, `materials[${index}].unitCost`, true);
    const unitPrice = nonNegativeNumber(item.unitPrice, `materials[${index}].unitPrice`, true);
    if (unitCost == null && unitPrice == null) throw new CatalogApiError(400, `materials[${index}] requires unitCost or unitPrice`);
    const supplier = optionalText(item.supplier, `materials[${index}].supplier`, 200);
    return {
      id,
      name: requiredText(item.name, `materials[${index}].name`, 200),
      category: requiredText(item.category, `materials[${index}].category`, 120),
      unit: unit(item.unit, `materials[${index}].unit`),
      ...(unitCost == null ? {} : { unitCost }),
      ...(unitPrice == null ? {} : { unitPrice }),
      ...(supplier ? { supplier } : {}),
      lastUpdated: requiredText(item.lastUpdated, `materials[${index}].lastUpdated`, 40),
    };
  });
}

function validateAssemblies(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new CatalogApiError(400, 'assemblies must be an array');
  if (value.length > MAX_ASSEMBLIES) throw new CatalogApiError(413, `assemblies cannot exceed ${MAX_ASSEMBLIES} items`);
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new CatalogApiError(400, `assemblies[${index}] must be an object`);
    const item = candidate as Record<string, unknown>;
    const id = requiredText(item.id, `assemblies[${index}].id`, 120);
    if (seen.has(id)) throw new CatalogApiError(400, `assemblies contains duplicate id ${id}`);
    seen.add(id);
    return {
      id,
      name: requiredText(item.name, `assemblies[${index}].name`, 200),
      category: requiredText(item.category, `assemblies[${index}].category`, 120),
      description: requiredText(item.description, `assemblies[${index}].description`, 1_000),
      unit: unit(item.unit, `assemblies[${index}].unit`),
      materialCostPerUnit: nonNegativeNumber(item.materialCostPerUnit, `assemblies[${index}].materialCostPerUnit`),
      laborCostPerUnit: nonNegativeNumber(item.laborCostPerUnit, `assemblies[${index}].laborCostPerUnit`),
      equipmentCostPerUnit: nonNegativeNumber(item.equipmentCostPerUnit, `assemblies[${index}].equipmentCostPerUnit`),
    };
  });
}

function mapCatalog(row: Record<string, unknown>, workspaceId: string): WorkspaceCatalog {
  return {
    id: String(row.id),
    workspaceId,
    revision: Number(row.revision),
    materials: row.materials as Record<string, unknown>[],
    assemblies: row.assemblies as Record<string, unknown>[],
    contentSha256: String(row.content_sha256),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  };
}

export async function getWorkspaceCatalog(db: SupabaseLike, userId: string, workspaceId: string): Promise<WorkspaceCatalog> {
  if (!userId || !workspaceId) throw new CatalogApiError(401, 'Authentication and workspace are required');
  const { data, error } = await db.from('workspace_catalog_versions').select('*').eq('workspace_id', workspaceId).order('revision', { ascending: false }).limit(1);
  if (error) throw new CatalogApiError(403, error.message ?? 'Catalog is unavailable');
  const row = Array.isArray(data) ? data[0] : null;
  return row ? mapCatalog(row, workspaceId) : { id: null, workspaceId, revision: 0, materials: [], assemblies: [], contentSha256: null, createdBy: null, createdAt: null };
}

export async function saveWorkspaceCatalog(db: SupabaseLike, userId: string, workspaceId: string, input: Record<string, unknown>): Promise<WorkspaceCatalog> {
  if (!userId || !workspaceId) throw new CatalogApiError(401, 'Authentication and workspace are required');
  const materials = validateMaterials(input.materials);
  const assemblies = validateAssemblies(input.assemblies);
  const expectedRevision = input.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) throw new CatalogApiError(400, 'expectedRevision must be a non-negative integer');
  if (Buffer.byteLength(JSON.stringify({ materials, assemblies }), 'utf8') > MAX_PAYLOAD_BYTES) throw new CatalogApiError(413, 'catalog payload is too large');
  if (!db.rpc) throw new CatalogApiError(503, 'Catalog persistence is unavailable');
  const { data, error } = await db.rpc('save_workspace_catalog_version', {
    p_workspace_id: workspaceId,
    p_materials: materials,
    p_assemblies: assemblies,
    p_expected_revision: expectedRevision,
  });
  if (error) {
    const conflict = error.code === '40001' || /catalog revision conflict/i.test(error.message ?? '');
    throw new CatalogApiError(conflict ? 409 : 403, error.message ?? 'Catalog could not be saved');
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') throw new CatalogApiError(500, 'Catalog save returned no revision');
  return mapCatalog(row as Record<string, unknown>, workspaceId);
}
