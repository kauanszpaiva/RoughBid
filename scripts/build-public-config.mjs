export function assertPublicBuildConfig(env) {
  let url;
  try { url = new URL(env.VITE_SUPABASE_URL ?? ''); } catch { throw new Error('VITE_SUPABASE_URL must be a real project URL; masked values cannot be built.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('VITE_SUPABASE_URL must be an HTTP(S) project URL.');
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || '';
  if (key.startsWith('sb_publishable_') && key.length > 25) return;
  try {
    const claims = JSON.parse(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString('utf8'));
    if (claims.role === 'anon') return;
  } catch { /* Reject masked values and server credentials without logging them. */ }
  throw new Error('The frontend requires a publishable or anon Supabase key. Server keys and masked values are forbidden.');
}
