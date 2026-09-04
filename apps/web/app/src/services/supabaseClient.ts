import { createClient, type Session } from "@supabase/supabase-js";

export type { Session };

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/**
 * Real Supabase Auth client for the browser (magic link sign-in). Both env
 * vars are public, RLS-gated values — never put a secret or service-role key
 * here (see docs/integrations/auth-access.md). `supabase` is null when they
 * aren't set, so callers keep the authenticated app locked instead of
 * opening workspace screens without login.
 */
export const supabase = url && publishableKey ? createClient(url, publishableKey) : null;

export const isAuthConfigured = supabase !== null;
