import type { AuthBootstrap, UserProfile } from '../../../../packages/domain/src/index.ts';
import { ApiActionError, requireUser, throwIfError, type AuthenticatedSupabaseClient } from '../supabase/client.ts';

function profileFromRow(row: Record<string, unknown>): UserProfile {
  return {
    id: String(row.id),
    displayName: row.display_name == null ? null : String(row.display_name),
    isPlatformAdmin: row.is_platform_admin === true,
    createdAt: String(row.created_at),
  };
}

/**
 * Resolves the profile created by the auth.users database trigger. This action
 * deliberately uses the caller's Supabase client, so profile RLS remains the
 * authorization boundary; it never uses a service-role key.
 */
export async function bootstrapAuth(client: AuthenticatedSupabaseClient): Promise<AuthBootstrap> {
  const user = await requireUser(client);
  const { data, error } = await client.from('profiles').select('*').eq('id', user.id).single();
  throwIfError(error);
  if (!data) {
    throw new ApiActionError('Your profile is still being created. Please retry.', 409);
  }
  return { userId: user.id, email: user.email ?? null, profile: profileFromRow(data) };
}

