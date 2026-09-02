/** The small authenticated Supabase surface used by API actions. */
export type SupabaseUser = { id: string; email?: string | null };

export type QueryResult<T> = PromiseLike<{ data: T; error: { message: string } | null }>;

export interface SupabaseQuery {
  select(columns?: string): SupabaseQuery;
  insert(values: Record<string, unknown>): SupabaseQuery;
  update(values: Record<string, unknown>): SupabaseQuery;
  delete(): SupabaseQuery;
  eq(column: string, value: string): SupabaseQuery;
  order(column: string, options?: { ascending?: boolean }): SupabaseQuery;
  single(): QueryResult<Record<string, unknown> | null>;
  then<TResult1 = { data: unknown; error: { message: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>;
}

export interface AuthenticatedSupabaseClient {
  auth: { getUser(): Promise<{ data: { user: SupabaseUser | null }; error: { message: string } | null }> };
  from(table: 'profiles' | 'workspaces' | 'workspace_members'): SupabaseQuery;
}

export class ApiActionError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiActionError';
    this.status = status;
  }
}

export async function requireUser(client: AuthenticatedSupabaseClient): Promise<SupabaseUser> {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new ApiActionError('Authentication required.', 401);
  return data.user;
}

export function throwIfError(error: { message: string } | null): void {
  if (error) throw new ApiActionError(error.message, 403);
}
