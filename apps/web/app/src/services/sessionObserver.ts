export type SessionSnapshot<T> = { session: T | null; loading: boolean; error: string | null };

type SessionAuth<T> = {
  getSession(): Promise<{ data: { session: T | null }; error?: unknown }>;
  onAuthStateChange(callback: (event: string, session: T | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
};

const unavailable = 'We could not restore your saved session. Try again before requesting a new sign-in link.';
const timedOut = 'Restoring your saved session took too long. Check your connection and try again.';

/** A late initial lookup must never overwrite a newer sign-in or sign-out event. */
export function observeSession<T>(
  auth: SessionAuth<T>,
  update: (snapshot: SessionSnapshot<T>) => void,
  options: { timeoutMs?: number; initialSession?: T | null } = {},
): () => void {
  let active = true;
  let eventResolved = false;
  let session: T | null = options.initialSession ?? null;
  let subscription: { unsubscribe(): void } | undefined;
  const publish = (next: T | null, error: string | null = null) => {
    if (!active) return;
    session = next;
    update({ session, loading: false, error });
  };
  const timer = setTimeout(() => publish(session, timedOut), options.timeoutMs ?? 15_000);

  try {
    const result = auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      eventResolved = true;
      clearTimeout(timer);
      publish(next);
    });
    subscription = result.data.subscription;
  } catch {
    clearTimeout(timer);
    publish(session, unavailable);
  }

  void Promise.resolve().then(() => auth.getSession()).then((result) => {
    if (!active || eventResolved) return;
    publish(result.error ? session : result.data.session, result.error ? unavailable : null);
  }).catch(() => {
    if (active && !eventResolved) publish(session, unavailable);
  }).finally(() => clearTimeout(timer));

  return () => {
    active = false;
    clearTimeout(timer);
    subscription?.unsubscribe();
  };
}
