export const ROUGHBID_PLATFORM_OWNER_USER_ID = 'c6453b85-f0e2-4af0-aad7-dcecb6fbb487';
export const ROUGHBID_PLATFORM_OWNER_WORKSPACE_ID = '60d9e2bc-06f6-4f2b-a648-aee6bdf4fb72';
export const ROUGHBID_HYGG_PROJECT_ID = '1b70ecc8-3797-40f2-849b-764aa022e4dc';

export function isPlatformOwnerUserId(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return userId.trim().toLowerCase() === ROUGHBID_PLATFORM_OWNER_USER_ID;
}

export type UserProfile = {
  id: string;
  displayName: string | null;
  isPlatformAdmin: boolean;
  isAdmGod: boolean;
  createdAt: string;
};

export type AuthBootstrap = {
  userId: string;
  email: string | null;
  profile: UserProfile;
};

export const AUTH_PROVIDERS = ['google', 'azure', 'okta'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export function validateEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new TypeError('A valid email address is required.');
  }
  return normalized;
}
