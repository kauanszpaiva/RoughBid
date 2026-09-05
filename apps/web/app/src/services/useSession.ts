import { useEffect, useState } from "react";
import { supabase, type Session } from "./supabaseClient";

/**
 * Tracks the current Supabase Auth session (null when signed out, or when
 * auth isn't configured in this environment — see supabaseClient.ts).
 */
export function useSession(): { session: Session | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(supabase !== null);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    let sessionResolved = false;
    const timer = setTimeout(() => { if (active) setLoading(false); }, 15_000);

    supabase.auth.getSession().then(({ data }) => {
      if (active && !sessionResolved) {
        setSession(data.session);
        setLoading(false);
      }
    }).catch(() => { if (active) setLoading(false); }).finally(() => clearTimeout(timer));

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      if (active) { sessionResolved = true; setSession(next); setLoading(false); clearTimeout(timer); }
    });

    return () => {
      active = false;
      clearTimeout(timer);
      subscription.subscription.unsubscribe();
    };
  }, []);

  return { session, loading };
}
