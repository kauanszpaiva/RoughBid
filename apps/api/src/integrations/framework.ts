export type IntegrationProvider = 'quickbooks' | 'xero' | 'procore';
export type IntegrationConnection = {
  id: string;
  workspaceId: string;
  provider: IntegrationProvider;
  externalTenantId: string;
  status: 'active' | 'revoked';
  createdAt: Date;
};

export type ExportResult = { externalId: string; url?: string };

/** Provider adapters isolate third-party SDKs from the public API. */
export interface IntegrationAdapter {
  provider: IntegrationProvider;
  getAuthorizationUrl(state: string, redirectUri: string): Promise<string>;
  exchangeCode(code: string, redirectUri: string): Promise<{ externalTenantId: string; credentials: unknown }>;
  exportEstimate(credentials: unknown, estimate: unknown, idempotencyKey: string): Promise<ExportResult>;
  revoke(credentials: unknown): Promise<void>;
}

export interface CredentialVault {
  put(connectionId: string, credentials: unknown): Promise<void>;
  get(connectionId: string): Promise<unknown>;
  delete(connectionId: string): Promise<void>;
}

export class IntegrationService {
  readonly connections = new Map<string, IntegrationConnection>();
  readonly exports = new Map<string, ExportResult>();
  private readonly pendingStates = new Map<string, { workspaceId: string; provider: IntegrationProvider; expiresAt: number }>();
  #sequence = 0;
  private readonly adapters: readonly IntegrationAdapter[];
  private readonly vault: CredentialVault;

  constructor(adapters: readonly IntegrationAdapter[], vault: CredentialVault) {
    this.adapters = adapters;
    this.vault = vault;
  }

  async authorizationUrl(provider: IntegrationProvider, workspaceId: string, redirectUri: string): Promise<{ url: string; state: string }> {
    const state = crypto.randomUUID();
    this.pendingStates.set(state, { workspaceId, provider, expiresAt: Date.now() + 10 * 60 * 1000 });
    return { url: await this.adapter(provider).getAuthorizationUrl(state, redirectUri), state };
  }

  async connect(provider: IntegrationProvider, workspaceId: string, code: string, state: string, redirectUri: string): Promise<IntegrationConnection> {
    const pending = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    if (!pending || pending.workspaceId !== workspaceId || pending.provider !== provider || pending.expiresAt < Date.now()) {
      throw new Error('Invalid or expired OAuth state.');
    }
    const result = await this.adapter(provider).exchangeCode(code, redirectUri);
    const connection: IntegrationConnection = { id: `connection-${++this.#sequence}`, workspaceId, provider, externalTenantId: result.externalTenantId, status: 'active', createdAt: new Date() };
    await this.vault.put(connection.id, result.credentials);
    this.connections.set(connection.id, connection);
    return { ...connection };
  }

  list(workspaceId: string): IntegrationConnection[] {
    return [...this.connections.values()].filter((item) => item.workspaceId === workspaceId).map((item) => ({ ...item }));
  }

  async exportEstimate(connectionId: string, workspaceId: string, estimateId: string, estimate: unknown): Promise<ExportResult> {
    const connection = this.requireConnection(connectionId, workspaceId);
    if (connection.status !== 'active') throw new Error('Integration connection is revoked.');
    const key = `${connectionId}:${estimateId}`;
    const previous = this.exports.get(key);
    if (previous) return previous;
    const result = await this.adapter(connection.provider).exportEstimate(await this.vault.get(connection.id), estimate, key);
    this.exports.set(key, result);
    return result;
  }

  async disconnect(connectionId: string, workspaceId: string): Promise<void> {
    const connection = this.requireConnection(connectionId, workspaceId);
    await this.adapter(connection.provider).revoke(await this.vault.get(connection.id));
    await this.vault.delete(connection.id);
    connection.status = 'revoked';
  }

  private requireConnection(id: string, workspaceId: string): IntegrationConnection {
    const connection = this.connections.get(id);
    if (!connection || connection.workspaceId !== workspaceId) throw new Error('Integration connection not found.');
    return connection;
  }

  private adapter(provider: IntegrationProvider): IntegrationAdapter {
    const adapter = this.adapters.find((item) => item.provider === provider);
    if (!adapter) throw new Error(`Integration provider is not configured: ${provider}`);
    return adapter;
  }
}
