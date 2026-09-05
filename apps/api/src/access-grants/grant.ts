import { createAccessWindow } from '../../../../packages/domain/src/index.ts';

export type AccessGrant = {
  userId: string;
  kind: 'access_grant';
  startsAt: Date;
  expiresAt: Date;
  paymentProvider: null;
  paymentMethodRequired: false;
};

export type AccessGrantStore = {
  insert(grant: AccessGrant): Promise<AccessGrant>;
};

export type WelcomeEmailSender = (input: { to: string; appUrl: string }) => Promise<unknown>;

export async function grantWorkspaceAccess(input: {
  userId: string;
  email: string;
  appUrl: string;
  startsAt?: Date;
  durationDays?: number;
}, dependencies: {
  store: AccessGrantStore;
  sendWelcomeEmail: WelcomeEmailSender;
  now?: () => Date;
}): Promise<AccessGrant> {
  if (!input.userId.trim()) throw new Error('A user ID is required.');
  const startsAt = input.startsAt ?? dependencies.now?.() ?? new Date();
  const window = createAccessWindow(startsAt, input.durationDays ?? 30);
  const grant = await dependencies.store.insert({
    userId: input.userId,
    kind: 'access_grant',
    startsAt: window.startsAt,
    expiresAt: window.expiresAt,
    paymentProvider: null,
    paymentMethodRequired: false,
  });

  await dependencies.sendWelcomeEmail({ to: input.email, appUrl: input.appUrl });
  return grant;
}
