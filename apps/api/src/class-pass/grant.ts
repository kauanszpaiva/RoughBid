import { createClassPassWindow } from '../../../../packages/domain/src/index.ts';

export type ClassPassGrant = {
  userId: string;
  kind: 'class_pass';
  startsAt: Date;
  expiresAt: Date;
  paymentProvider: null;
  paymentMethodRequired: false;
};

export type ClassPassGrantStore = {
  insert(grant: ClassPassGrant): Promise<ClassPassGrant>;
};

export type WelcomeEmailSender = (input: { to: string; appUrl: string }) => Promise<unknown>;

export async function grantClassPass(input: {
  userId: string;
  email: string;
  appUrl: string;
  startsAt?: Date;
}, dependencies: {
  store: ClassPassGrantStore;
  sendWelcomeEmail: WelcomeEmailSender;
  now?: () => Date;
}): Promise<ClassPassGrant> {
  if (!input.userId.trim()) throw new Error('A user ID is required.');
  const startsAt = input.startsAt ?? dependencies.now?.() ?? new Date();
  const window = createClassPassWindow(startsAt);
  const grant = await dependencies.store.insert({
    userId: input.userId,
    kind: 'class_pass',
    startsAt: window.startsAt,
    expiresAt: window.expiresAt,
    paymentProvider: null,
    paymentMethodRequired: false,
  });

  await dependencies.sendWelcomeEmail({ to: input.email, appUrl: input.appUrl });
  return grant;
}
