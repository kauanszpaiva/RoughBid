import {
  assertEntitled,
  type AccessEntitlement,
  type EntitledOperation,
} from '../../../../packages/domain/src/index.ts';

export type EntitlementReader = {
  findForUser(userId: string): Promise<readonly AccessEntitlement[]>;
};

/** Server-side authorization boundary for every protected resource operation. */
export async function authorizeResourceOperation(
  reader: EntitlementReader,
  userId: string,
  operation: EntitledOperation,
  at: Date = new Date(),
): Promise<void> {
  if (!userId.trim()) throw new Error('An authenticated user is required.');
  const entitlements = await reader.findForUser(userId);
  assertEntitled(operation, entitlements, at);
}
