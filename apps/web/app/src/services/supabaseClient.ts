import { createClient, type Session } from "@supabase/supabase-js";

export type { Session };

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/**
 * Real Supabase Auth client for the browser (magic link sign-in). Both env
 * vars are public, RLS-gated values — never put a secret or service-role key
 * here (see docs/integrations/auth-access.md). `supabase` is null when they
 * aren't set (e.g. this environment hasn't been configured yet), so callers
 * must fall back to demo mode instead of crashing — see AuthModal.tsx.
 */
export const supabase = url && publishableKey ? createClient(url, publishableKey) : null;

export const isAuthConfigured = supabase !== null;
