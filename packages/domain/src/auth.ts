export type UserProfile = {
  id: string;
  displayName: string | null;
  isPlatformAdmin: boolean;
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
