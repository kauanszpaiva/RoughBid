type Session = { access_token: string; user: { id: string } };
type SessionResult = { data: { session: Session | null }; error: unknown };
type Auth = {
  getSession(): Promise<SessionResult>;
  refreshSession(): Promise<SessionResult>;
  signOut(options: { scope: 'local' }): Promise<{ error: unknown }>;
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const signInAgain = () => new ApiError(401, 'Your session is no longer valid. Please sign in again.');
const temporarilyUnavailable = () => new ApiError(503, 'Your session could not be renewed right now. Please try again.');

function invalidRefresh(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === 'AuthSessionMissingError' || [
    'session_not_found', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used',
  ].includes(typeof code === 'string' ? code : '');
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ApiError(408, 'Your session took too long to load. Please try again.')), 15_000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Retry one authenticated read after a rejected cached JWT. Never replay a mutation. */
export function createAuthenticatedFetch(auth: Auth | null, fetcher: typeof fetch = fetch) {
  const refreshes = new Map<string, Promise<SessionResult>>();

  async function currentSession() {
    if (!auth) return null;
    const result = await bounded(auth.getSession());
    if (result.error) throw invalidRefresh(result.error) ? signInAgain() : temporarilyUnavailable();
    return result.data.session;
  }

  async function refresh(session: Session) {
    let pending = refreshes.get(session.access_token);
    if (!pending) {
      pending = bounded(auth!.refreshSession());
      refreshes.set(session.access_token, pending);
      void pending.finally(() => refreshes.delete(session.access_token)).catch(() => {});
    }
    return pending;
  }

  async function clearRejectedSession(rejected: Session) {
    // A different login or a successful refresh must never be signed out by an older request.
    const current = await bounded(auth!.getSession());
    if (!current.error && current.data.session?.user.id === rejected.user.id
      && current.data.session.access_token === rejected.access_token) {
      await bounded(auth!.signOut({ scope: 'local' }));
    }
  }

  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    const initial = await currentSession();
    const send = (session: Session | null) => {
      const headers = new Headers(init.headers);
      if (session) headers.set('Authorization', `Bearer ${session.access_token}`);
      return fetcher(input, { ...init, headers });
    };
    const response = await send(initial);
    if (response.status !== 401 || (init.method ?? 'GET').toUpperCase() !== 'GET' || !auth || !initial) return response;

    let latest = await currentSession();
    if (!latest || latest.user.id !== initial.user.id) throw signInAgain();
    if (latest.access_token === initial.access_token) {
      let result: SessionResult;
      try { result = await refresh(latest); }
      catch (error) { throw error instanceof ApiError ? error : temporarilyUnavailable(); }
      if (result.error || !result.data.session) {
        if (invalidRefresh(result.error) || (!result.error && !result.data.session)) {
          await clearRejectedSession(latest);
          throw signInAgain();
        }
        throw temporarilyUnavailable();
      }
      if (result.data.session.user.id !== initial.user.id) throw signInAgain();
      latest = await currentSession();
      if (!latest || latest.user.id !== initial.user.id) throw signInAgain();
    }
    const retried = await send(latest);
    if (retried.status === 401) throw new ApiError(401, 'Your session could not be verified. Open Account, sign out, and sign in again.');
    return retried;
  };
}
