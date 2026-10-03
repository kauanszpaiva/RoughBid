export function normalizeAuthEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TypeError('Enter a valid email address.');
  }
  return email;
}

/** Display known safe copy; callback error descriptions may contain private values. */
export function authCallbackNotice(href: string): string | null {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const code = hash.get('error_code') ?? url.searchParams.get('error_code');
  const error = hash.get('error') ?? url.searchParams.get('error');
  if (!code && !error) return null;
  return code === 'otp_expired'
    ? 'This sign-in link has expired or has already been used. Request a new link and open the newest email.'
    : 'We could not complete sign-in from this link. Request a new link and open it on this device.';
}

export function clearAuthCallbackError(href: string): string {
  const url = new URL(href);
  for (const key of ['error', 'error_code', 'error_description']) url.searchParams.delete(key);
  // Never discard a successful callback's token/code or an invitation.
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  if (hash.has('error') || hash.has('error_code')) {
    for (const key of ['error', 'error_code', 'error_description']) hash.delete(key);
    url.hash = hash.toString();
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function signOutLocally(auth: {
  signOut(options: { scope: 'local' }): Promise<{ error: unknown }>;
} | null): Promise<void> {
  if (!auth) throw new Error('Sign-in is not configured for this environment.');
  try {
    const { error } = await auth.signOut({ scope: 'local' });
    if (error) throw error;
  } catch {
    throw new Error('We could not sign you out. Your session is still open; try again.');
  }
}
