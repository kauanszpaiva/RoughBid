export const MAX_PLAN_BYTES = 50 * 1024 * 1024;
export const PLAN_BUCKET = 'plan-files';

export type ProjectStatus = 'draft' | 'active' | 'archived';
export const NEW_ENGLAND_STATES = ['CT', 'MA', 'ME', 'NH', 'RI', 'VT'] as const;
export type NewEnglandState = typeof NEW_ENGLAND_STATES[number];

type DbError = { message?: string; code?: string } | null;

export interface SupabaseLike {
  auth: { getUser(): Promise<{ data: { user: { id: string } | null }; error: unknown }> };
  from(table: string): any;
  storage: { from(bucket: string): any };
  rpc?(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: DbError }>;
}

export class ProjectApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Validate a database path before using a privileged storage signer. */
export function assertPlanStoragePath(path: unknown, workspaceId: string, projectId: string, fileId: string): void {
  const prefix = `${workspaceId}/${projectId}/${fileId}`;
  if (path !== `${prefix}.pdf` && path !== `${prefix}/source.pdf`) throw new ProjectApiError(403, 'Plan storage does not belong to this project.');
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new ProjectApiError(400, `${label} is required and must be at most ${max} characters`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) {
    throw new ProjectApiError(400, `${label} must be at most ${max} characters`);
  }
  return value.trim() || null;
}

function newEnglandState(value: unknown): NewEnglandState {
  const state = requiredText(value, 'jurisdiction_state', 2).toUpperCase();
  if (!NEW_ENGLAND_STATES.includes(state as NewEnglandState)) {
    throw new ProjectApiError(400, 'jurisdiction_state must be CT, MA, ME, NH, RI, or VT');
  }
  return state as NewEnglandState;
}

function postalCode(value: unknown): string {
  const postal = requiredText(value, 'postal_code', 10);
  if (!/^\d{5}(?:-\d{4})?$/.test(postal)) throw new ProjectApiError(400, 'postal_code must be a US ZIP code');
  return postal;
}

function permitDate(value: unknown): string {
  const date = requiredText(value, 'permit_date', 10);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new ProjectApiError(400, 'permit_date must be a valid YYYY-MM-DD date');
  }
  return date;
}

function status(value: unknown): ProjectStatus {
  if (value !== 'draft' && value !== 'active' && value !== 'archived') {
    throw new ProjectApiError(400, 'status must be draft, active, or archived');
  }
  return value;
}

function appState(input: Record<string, unknown>): Record<string, unknown> {
  const value = input.app_state ?? input.appState;
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectApiError(400, 'appState must be an object');
  }
  const encoded = JSON.stringify(value);
  if (encoded.length > 250_000) throw new ProjectApiError(413, 'appState is too large');
  return value as Record<string, unknown>;
}

export async function validatePlanFile(file: File): Promise<void> {
  if (!(file instanceof Blob) || file.type.toLowerCase() !== 'application/pdf' || !file.name.toLowerCase().endsWith('.pdf')) {
    throw new ProjectApiError(415, 'Only PDF files are accepted');
  }
  if (file.size < 1 || file.size > MAX_PLAN_BYTES) throw new ProjectApiError(413, 'PDF must be no larger than 50 MB');
  const signature = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (new TextDecoder().decode(signature) !== '%PDF-') throw new ProjectApiError(415, 'File content is not a valid PDF');
}

function dbResult<T>(result: { data: T; error: DbError }, notFound = false): T {
  if (result.error) {
    const httpStatus = result.error.code === '23503' ? 409 : 500;
    throw new ProjectApiError(httpStatus, result.error.message ?? 'Database operation failed');
  }
  if (notFound && !result.data) throw new ProjectApiError(404, 'Resource not found');
  return result.data;
}

export class ProjectService {
  private db: SupabaseLike;
  private userId: string;
  private workspaceId: string;

  constructor(db: SupabaseLike, userId: string, workspaceId: string) {
    if (!userId || !workspaceId) throw new ProjectApiError(401, 'Authentication and workspace are required');
    this.db = db;
    this.userId = userId;
    this.workspaceId = workspaceId;
  }

  async list() {
    return dbResult(await this.db.from('projects').select('*').eq('workspace_id', this.workspaceId).order('updated_at', { ascending: false }));
  }

  async get(projectId: string) {
    return dbResult(await this.db.from('projects').select('*').eq('workspace_id', this.workspaceId).eq('id', projectId).maybeSingle(), true);
  }

  async listEstimateVersions(projectId: string) {
    await this.get(projectId);
    return dbResult(await this.db.from('project_estimate_versions')
      .select('id, project_id, revision, state_sha256, calculation_version, created_by, created_at')
      .eq('workspace_id', this.workspaceId).eq('project_id', projectId)
      .order('revision', { ascending: false }));
  }

  async getEstimateVersion(projectId: string, revision: unknown) {
    const parsed = typeof revision === 'string' && /^\d+$/.test(revision) ? Number(revision) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new ProjectApiError(400, 'revision must be a positive integer');
    await this.get(projectId);
    return dbResult(await this.db.from('project_estimate_versions')
      .select('id, project_id, revision, state, state_sha256, calculation_version, created_by, created_at')
      .eq('workspace_id', this.workspaceId).eq('project_id', projectId).eq('revision', parsed)
      .maybeSingle(), true);
  }

  async create(input: Record<string, unknown>) {
    const row = {
      workspace_id: this.workspaceId,
      created_by: this.userId,
      name: requiredText(input.name, 'name', 160),
      client_name: requiredText(input.client_name ?? input.clientName, 'client_name', 160),
      project_type: requiredText(input.project_type ?? input.projectType, 'project_type', 120),
      project_number: optionalText(input.project_number, 'project_number', 80),
      address_text: optionalText(input.address, 'address', 500),
      jurisdiction_state: newEnglandState(input.jurisdiction_state ?? input.jurisdictionState),
      municipality: requiredText(input.municipality, 'municipality', 120),
      postal_code: postalCode(input.postal_code ?? input.postalCode),
      permit_date: permitDate(input.permit_date ?? input.permitDate),
      status: input.status == null ? 'draft' : status(input.status),
      app_state: appState(input),
    };
    const result = await this.db.from('projects').insert(row).select('*').single();
    if (result.error?.code === 'P0001' && result.error.message === 'Pilot project limit reached') {
      throw new ProjectApiError(429, 'Pilot project limit reached');
    }
    return dbResult(result);
  }

  async update(projectId: string, input: Record<string, unknown>) {
    const changes: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if ('name' in input) changes.name = requiredText(input.name, 'name', 160);
    if ('client_name' in input || 'clientName' in input) changes.client_name = requiredText(input.client_name ?? input.clientName, 'client_name', 160);
    if ('project_type' in input || 'projectType' in input) changes.project_type = requiredText(input.project_type ?? input.projectType, 'project_type', 120);
    if ('project_number' in input) changes.project_number = optionalText(input.project_number, 'project_number', 80);
    if ('address' in input) changes.address_text = optionalText(input.address, 'address', 500);
    if ('jurisdiction_state' in input || 'jurisdictionState' in input) changes.jurisdiction_state = newEnglandState(input.jurisdiction_state ?? input.jurisdictionState);
    if ('municipality' in input) changes.municipality = requiredText(input.municipality, 'municipality', 120);
    if ('postal_code' in input || 'postalCode' in input) changes.postal_code = postalCode(input.postal_code ?? input.postalCode);
    if ('permit_date' in input || 'permitDate' in input) changes.permit_date = permitDate(input.permit_date ?? input.permitDate);
    if ('status' in input) changes.status = status(input.status);
    if ('app_state' in input || 'appState' in input) changes.app_state = appState(input);
    return dbResult(await this.db.from('projects').update(changes).eq('workspace_id', this.workspaceId).eq('id', projectId).select('*').maybeSingle(), true);
  }

  async remove(projectId: string) {
    const project = await this.get(projectId);
    const files = dbResult<any[]>(await this.db.from('project_files').select('storage_path').eq('workspace_id', this.workspaceId).eq('project_id', projectId));
    const paths = files.map((file) => file.storage_path);

    // Commit the relational delete before touching object storage. The database
    // deliberately protects quote/audit history with restrictive foreign keys;
    // a blocked delete must never destroy the source PDF while leaving the
    // project record behind.
    dbResult(await this.db.from('projects').delete().eq('workspace_id', this.workspaceId).eq('id', projectId));

    if (paths.length) {
      const removed = await this.db.storage.from(PLAN_BUCKET).remove(paths);
      if (removed.error) {
        // The project deletion is already committed. Returning HTTP 500 here
        // would falsely imply the delete failed and invite unsafe retries. The
        // orphaned blob is no longer addressable through project/file records;
        // keep the deletion truthful and surface cleanup failure in runtime logs.
        console.error('Project storage cleanup failed after committed database delete', {
          projectId,
          pathCount: paths.length,
          error: removed.error.message ?? 'unknown storage error',
        });
      }
    }
    return project;
  }

  async upload(projectId: string, file: File) {
    await this.get(projectId);
    await validatePlanFile(file);

    const id = crypto.randomUUID();
    const path = `${this.workspaceId}/${projectId}/${id}.pdf`;
    const uploaded = await this.db.storage.from(PLAN_BUCKET).upload(path, file, { contentType: 'application/pdf', upsert: false });
    if (uploaded.error) throw new ProjectApiError(500, uploaded.error.message ?? 'Upload failed');
    try {
      return dbResult(await this.db.from('project_files').insert({
        id, workspace_id: this.workspaceId, project_id: projectId, uploaded_by: this.userId,
        storage_path: path, original_name: file.name, mime_type: 'application/pdf', byte_size: file.size,
      }).select('*').single());
    } catch (error) {
      await this.db.storage.from(PLAN_BUCKET).remove([path]);
      throw error;
    }
  }

  async createDownloadUrl(fileId: string, expiresIn = 60) {
    const file = dbResult<any>(await this.db.from('project_files').select('*').eq('workspace_id', this.workspaceId).eq('id', fileId).maybeSingle(), true);
    const signed = await this.db.storage.from(PLAN_BUCKET).createSignedUrl(file.storage_path, Math.min(Math.max(expiresIn, 1), 300), { download: file.original_name });
    if (signed.error || !signed.data?.signedUrl) throw new ProjectApiError(500, signed.error?.message ?? 'Could not authorize download');
    return { url: signed.data.signedUrl, expires_in: Math.min(Math.max(expiresIn, 1), 300) };
  }
}
