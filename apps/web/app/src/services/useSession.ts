import { useCallback, useEffect, useState } from "react";
import { supabase, type Session } from "./supabaseClient";
import { observeSession, type SessionSnapshot } from "./sessionObserver";

/**
 * Tracks the current Supabase Auth session (null when signed out, or when
 * auth isn't configured in this environment — see supabaseClient.ts).
 */
export function useSession(): SessionSnapshot<Session> & { retry: () => void } {
  const [snapshot, setSnapshot] = useState<SessionSnapshot<Session>>({ session: null, loading: supabase !== null, error: null });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    if (!supabase) return;
    setSnapshot((current) => ({ ...current, loading: true, error: null }));
    return observeSession<Session>(supabase.auth, setSnapshot);
  }, [attempt]);

  return { ...snapshot, retry };
}
