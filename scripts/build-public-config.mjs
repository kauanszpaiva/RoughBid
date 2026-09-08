const ROUGHBID_PREVIEW_SUPABASE_URL = 'https://piasgpciojstjalaqazu.supabase.co';
const ROUGHBID_PREVIEW_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_breiUGYv8jaumI80U2xoCQ_2BHm33d9';
const PREVIEW_MASKED_VALUES = new Set(['', '[SENSITIVE]', '[REDACTED]', '***', '********']);

function isPreviewMaskedOrMissing(value) {
  return PREVIEW_MASKED_VALUES.has(String(value ?? '').trim());
}

function validatePublicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('VITE_SUPABASE_URL must be a real project URL; masked values cannot be built.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('VITE_SUPABASE_URL must be an HTTP(S) project URL.');
  }
  return value;
}

function validatePublicKey(value) {
  if (value.startsWith('sb_publishable_') && value.length > 25) return value;
  try {
    const claims = JSON.parse(Buffer.from(value.split('.')[1] ?? '', 'base64url').toString('utf8'));
    if (claims.role === 'anon') return value;
  } catch { /* Reject masked values and server credentials without logging them. */ }
  throw new Error('The frontend requires a publishable or anon Supabase key. Server keys and masked values are forbidden.');
}

export function resolvePublicBuildConfig(env) {
  const isVercelPreview = env.VERCEL_ENV === 'preview';
  const configuredUrl = String(env.VITE_SUPABASE_URL ?? '').trim();
  const configuredKey = String(env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || '').trim();

  const url = isVercelPreview && isPreviewMaskedOrMissing(configuredUrl)
    ? ROUGHBID_PREVIEW_SUPABASE_URL
    : configuredUrl;
  const publishableKey = isVercelPreview && isPreviewMaskedOrMissing(configuredKey)
    ? ROUGHBID_PREVIEW_SUPABASE_PUBLISHABLE_KEY
    : configuredKey;

  return {
    url: validatePublicUrl(url),
    publishableKey: validatePublicKey(publishableKey),
  };
}

export function assertPublicBuildConfig(env) {
  resolvePublicBuildConfig(env);
}
