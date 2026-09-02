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

