export type ClassPassWelcomeInput = {
  to: string;
  appUrl: string;
};

export type ClassPassWelcomeEmail = {
  from: 'RoughBid <hello@mail.kspdominion.group>';
  to: string;
  templateAlias: 'roughbid-class-pass-welcome';
  variables: {
    APP_URL: string;
    CLASS_PASS_DAYS: 60;
  };
};

export function createClassPassWelcomeEmail(input: ClassPassWelcomeInput): ClassPassWelcomeEmail {
  if (!input.to.includes('@')) throw new Error('A valid recipient email is required.');
  const appUrl = new URL(input.appUrl);
  if (appUrl.protocol !== 'https:') throw new Error('App URL must use HTTPS.');
  return {
    from: 'RoughBid <hello@mail.kspdominion.group>',
    to: input.to,
    templateAlias: 'roughbid-class-pass-welcome',
    variables: {
      APP_URL: appUrl.toString().replace(/\/$/, ''),
      CLASS_PASS_DAYS: 60,
    },
  };
}

type Fetch = typeof globalThis.fetch;

export type ResendServerConfig = {
  apiKey: string;
};

export function loadResendServerConfig(env: NodeJS.ProcessEnv = process.env): ResendServerConfig {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error('RESEND_API_KEY is required on the server.');
  return { apiKey };
}

export async function sendClassPassWelcomeEmail(
  config: ResendServerConfig,
  input: ClassPassWelcomeInput,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<{ id: string }> {
  if (!config.apiKey.trim()) throw new Error('A Resend API key is required.');
  const email = createClassPassWelcomeEmail(input);
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: email.from,
      to: [email.to],
      template: {
        id: email.templateAlias,
        variables: email.variables,
      },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Resend rejected the Class Pass welcome email (${response.status}): ${detail}`);
  }
  const result = await response.json() as { id?: unknown };
  if (typeof result.id !== 'string') throw new Error('Resend returned an invalid email response.');
  return { id: result.id };
}
