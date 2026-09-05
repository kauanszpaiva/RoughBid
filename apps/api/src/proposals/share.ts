export interface ProposalDb {
  auth: { getUser(): Promise<{ data: { user: { id: string; email?: string | null } | null }; error: unknown }> };
  from(table: string): any;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

export class ProposalApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type CreateProposalInput = {
  title?: unknown;
  clientName?: unknown;
  clientEmail?: unknown;
  totalAmount?: unknown;
  estimateId?: unknown;
  publicPayload?: unknown;
  expiresInDays?: unknown;
};

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new ProposalApiError(400, `${label} is required and must be at most ${max} characters`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) throw new ProposalApiError(400, `${label} must be at most ${max} characters`);
  return value.trim() || null;
}

function amount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100_000_000) throw new ProposalApiError(400, 'totalAmount must be a positive number');
  return Math.round(parsed * 100) / 100;
}

function expiresInDays(value: unknown): number {
  if (value == null) return 30;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) throw new ProposalApiError(400, 'expiresInDays must be between 1 and 90');
  return parsed;
}

function publicPayload(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new ProposalApiError(400, 'publicPayload is required');
  const encoded = JSON.stringify(value);
  if (encoded.length > 100_000) throw new ProposalApiError(413, 'publicPayload is too large');
  return value as Record<string, unknown>;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function tokenHash(token: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{32,160}$/.test(token)) throw new ProposalApiError(404, 'Proposal not found');
  return sha256Hex(token);
}

function eventMetadata(request: Request): Record<string, unknown> {
  const userAgent = request.headers.get('user-agent') ?? '';
  return {
    user_agent: userAgent.slice(0, 500),
  };
}

export async function createClientProposal(db: ProposalDb, workspaceId: string, projectId: string, input: CreateProposalInput) {
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) throw new ProposalApiError(401, 'Authentication required');
  if (!workspaceId) throw new ProposalApiError(400, 'x-workspace-id header is required');

  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = bytesToBase64Url(tokenBytes);
  const row = {
    workspace_id: workspaceId,
    project_id: projectId,
    estimate_id: optionalText(input.estimateId, 'estimateId', 80),
    token_hash: await sha256Hex(token),
    title: text(input.title, 'title', 160),
    client_name: text(input.clientName, 'clientName', 160),
    client_email: optionalText(input.clientEmail, 'clientEmail', 254),
    total_amount: amount(input.totalAmount),
    public_payload: publicPayload(input.publicPayload),
    expires_at: new Date(Date.now() + expiresInDays(input.expiresInDays) * 24 * 60 * 60 * 1000).toISOString(),
    created_by: data.user.id,
  };

  const inserted = await db.from('client_proposals').insert(row).select('id, title, client_name, client_email, total_amount, status, expires_at, created_at').single();
  if (inserted.error) throw new ProposalApiError(403, inserted.error.message ?? 'Could not create proposal');
  return { ...(inserted.data as Record<string, unknown>), token };
}

export async function getClientProposal(db: ProposalDb, request: Request, token: string) {
  const result = await db.rpc('get_client_proposal', {
    proposal_token_hash: await tokenHash(token),
    event_metadata: eventMetadata(request),
  });
  if (result.error) throw new ProposalApiError(404, 'Proposal not found');
  const rows = Array.isArray(result.data) ? result.data : [];
  if (!rows[0]) throw new ProposalApiError(404, 'Proposal not found');
  return rows[0] as Record<string, unknown>;
}

export async function signClientProposal(db: ProposalDb, request: Request, token: string, input: Record<string, unknown>) {
  const result = await db.rpc('sign_client_proposal', {
    proposal_token_hash: await tokenHash(token),
    signer_name: text(input.signerName, 'signerName', 160),
    event_metadata: eventMetadata(request),
  });
  if (result.error) throw new ProposalApiError(400, result.error.message ?? 'Could not sign proposal');
  const rows = Array.isArray(result.data) ? result.data : [];
  if (!rows[0]) throw new ProposalApiError(404, 'Proposal not found');
  return rows[0] as Record<string, unknown>;
}
