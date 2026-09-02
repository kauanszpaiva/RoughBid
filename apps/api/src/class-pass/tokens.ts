import { createHash, randomBytes } from 'node:crypto';
import { createClassPassWindow } from '../../../../packages/domain/src/index.ts';

const TOKEN_PREFIX = 'rbcp_';

export function hashClassPassToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createClassPassToken(): { token: string; tokenHash: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashClassPassToken(token) };
}

export type ClassPassAdminStore = {
  create(input: { tokenHash: string; label: string; startsAt: string; expiresAt: string; createdBy: string | null }): Promise<void>;
  redeem(input: { tokenHash: string; workspaceName: string }): Promise<{ workspaceId: string; expiresAt: string }>;
};

/** Creates a single-use secret. Only its SHA-256 digest is persisted. */
export async function issueClassPass(input: {
  label: string;
  createdBy?: string | null;
  startsAt?: Date;
}, store: ClassPassAdminStore): Promise<{ token: string; expiresAt: Date }> {
  const label = input.label.trim();
  if (!label || label.length > 120) throw new RangeError('Class Pass label must contain between 1 and 120 characters.');
  const window = createClassPassWindow(input.startsAt ?? new Date());
  const secret = createClassPassToken();
  await store.create({ tokenHash: secret.tokenHash, label, startsAt: window.startsAt.toISOString(), expiresAt: window.expiresAt.toISOString(), createdBy: input.createdBy ?? null });
  return { token: secret.token, expiresAt: window.expiresAt };
}

export async function redeemClassPass(input: { token: string; workspaceName?: string }, store: ClassPassAdminStore) {
  if (!input.token.startsWith(TOKEN_PREFIX) || input.token.length < 40) throw new TypeError('Invalid Class Pass token.');
  return store.redeem({ tokenHash: hashClassPassToken(input.token), workspaceName: input.workspaceName?.trim() || 'My Class Workspace' });
}
