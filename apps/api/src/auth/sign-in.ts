import { AUTH_PROVIDERS, validateEmail, type AuthProvider } from '../../../../packages/domain/src/index.ts';
import { loadResendServerConfig, sendMagicLinkEmail } from '../email/resend.ts';
import { randomBytes } from 'node:crypto';

export type SignInAuthClient = {
  signInWithOtp(input: { email: string; options: { emailRedirectTo: string; shouldCreateUser: boolean } }): Promise<{ error: { message: string } | null }>;
  signInWithOAuth(input: { provider: AuthProvider; options: { redirectTo: string } }): Promise<{ data: { url?: string | null }; error: { message: string } | null }>;
  signInWithSSO?(input: { domain: string; options: { redirectTo: string } }): Promise<{ data: { url?: string | null }; error: { message: string } | null }>;
};

function trustedRedirect(appUrl: string, path = '/auth/callback'): string {
  const base = new URL(appUrl);
  if (!['https:', 'http:'].includes(base.protocol) || (base.protocol === 'http:' && base.hostname !== 'localhost')) {
    throw new TypeError('APP_URL must use HTTPS (or localhost HTTP).');
  }
  return new URL(path, base).toString();
}

export type MagicLinkAdminClient = {
  auth: {
    admin: {
      generateLink(input: {
        type: 'magiclink';
        email: string;
        options: { redirectTo: string };
      } | {
        type: 'signup';
        email: string;
        password: string;
        options: { redirectTo: string };
      }): Promise<{ data: { properties?: { action_link?: string | null } | null }; error: { message: string } | null }>;
    };
  };
};

export async function sendMagicLink(auth: SignInAuthClient, input: { email: string; appUrl: string }): Promise<void> {
  const { error } = await auth.signInWithOtp({
    email: validateEmail(input.email),
    options: { emailRedirectTo: trustedRedirect(input.appUrl), shouldCreateUser: true },
  });
  if (error) throw new Error(`Unable to send magic link: ${error.message}`);
}

export async function sendBrandedMagicLink(
  admin: MagicLinkAdminClient,
  input: { email: string; appUrl: string; inviteToken?: string | null; mode?: 'sign-in' | 'create-account' },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ sent: true }> {
  const email = validateEmail(input.email);
  const redirectUrl = new URL('/app/', input.appUrl);
  if (input.inviteToken) redirectUrl.searchParams.set('invite', input.inviteToken);
  if (redirectUrl.protocol !== 'https:' && redirectUrl.hostname !== 'localhost') {
    throw new TypeError('APP_URL must use HTTPS (or localhost HTTP).');
  }
  const linkInput = input.mode === 'create-account'
    ? { type: 'signup' as const, email, password: randomBytes(32).toString('base64url'), options: { redirectTo: redirectUrl.toString() } }
    : { type: 'magiclink' as const, email, options: { redirectTo: redirectUrl.toString() } };
  const { data, error } = await admin.auth.admin.generateLink(linkInput);
  if (error) throw new Error(`Unable to create RoughBid sign-in link: ${error.message}`);
  const actionLink = data.properties?.action_link;
  if (!actionLink) throw new Error('Supabase did not return a sign-in link.');
  await sendMagicLinkEmail(loadResendServerConfig(env), {
    to: email,
    magicLink: actionLink,
    appUrl: input.appUrl,
    idempotencyKey: `roughbid-magic-link/${email}/${Date.now()}`,
  });
  return { sent: true };
}

export async function beginSso(auth: SignInAuthClient, input: { provider: AuthProvider; appUrl: string }): Promise<string> {
  if (!AUTH_PROVIDERS.includes(input.provider)) throw new TypeError('Unsupported SSO provider.');
  const { data, error } = await auth.signInWithOAuth({
    provider: input.provider,
    options: { redirectTo: trustedRedirect(input.appUrl) },
  });
  if (error || !data.url) throw new Error(`Unable to start SSO: ${error?.message ?? 'No redirect URL returned.'}`);
  return data.url;
}

/** Starts SAML SSO discovery for an organization configured in Supabase Auth. */
export async function beginEnterpriseSso(auth: SignInAuthClient, input: { domain: string; appUrl: string }): Promise<string> {
  const domain = input.domain.trim().toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new TypeError('A valid organization domain is required.');
  }
  if (!auth.signInWithSSO) throw new Error('Enterprise SSO is not configured.');
  const { data, error } = await auth.signInWithSSO({ domain, options: { redirectTo: trustedRedirect(input.appUrl) } });
  if (error || !data.url) throw new Error(`Unable to start enterprise SSO: ${error?.message ?? 'No redirect URL returned.'}`);
  return data.url;
}
