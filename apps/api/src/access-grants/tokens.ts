import { createHash, randomBytes } from 'node:crypto';
import { createAccessWindow } from '../../../../packages/domain/src/index.ts';

const TOKEN_PREFIX = 'rbag_';

export function hashAccessGrantToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createAccessGrantToken(): { token: string; tokenHash: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashAccessGrantToken(token) };
}

export type AccessGrantAdminStore = {
  create(input: { tokenHash: string; label: string; startsAt: string; expiresAt: string; createdBy: string | null }): Promise<void>;
  redeem(input: { tokenHash: string; workspaceName: string }): Promise<{ workspaceId: string; expiresAt: string }>;
};

/** Creates a single-use secret. Only its SHA-256 digest is persisted. */
export async function issueAccessGrant(input: {
  label: string;
  createdBy?: string | null;
  startsAt?: Date;
  durationDays?: number;
}, store: AccessGrantAdminStore): Promise<{ token: string; expiresAt: Date }> {
  const label = input.label.trim();
  if (!label || label.length > 120) throw new RangeError('Access grant label must contain between 1 and 120 characters.');
  const window = createAccessWindow(input.startsAt ?? new Date(), input.durationDays ?? 30);
  const secret = createAccessGrantToken();
  await store.create({ tokenHash: secret.tokenHash, label, startsAt: window.startsAt.toISOString(), expiresAt: window.expiresAt.toISOString(), createdBy: input.createdBy ?? null });
  return { token: secret.token, expiresAt: window.expiresAt };
}

export async function redeemAccessGrant(input: { token: string; workspaceName?: string }, store: AccessGrantAdminStore) {
  if (!input.token.startsWith(TOKEN_PREFIX) || input.token.length < 40) throw new TypeError('Invalid access grant token.');
  return store.redeem({ tokenHash: hashAccessGrantToken(input.token), workspaceName: input.workspaceName?.trim() || 'My Workspace' });
}
