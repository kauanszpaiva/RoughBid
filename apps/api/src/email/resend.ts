export type WorkspaceWelcomeInput = {
  to: string;
  appUrl: string;
};

export type WorkspaceInviteEmailInput = {
  to: string;
  workspaceName: string;
  inviteUrl: string;
  role: string;
};

export type WorkspaceWelcomeEmail = {
  from: 'RoughBid <hello@mail.kspdominion.group>';
  to: string;
  templateAlias: 'roughbid-workspace-welcome';
  variables: {
    APP_URL: string;
  };
};

export type WorkspaceInviteEmail = {
  from: 'RoughBid <hello@mail.kspdominion.group>';
  to: string;
  templateAlias: 'roughbid-organization-invite';
  variables: {
    WORKSPACE_NAME: string;
    INVITE_URL: string;
    ROLE: string;
  };
};

export function createWorkspaceWelcomeEmail(input: WorkspaceWelcomeInput): WorkspaceWelcomeEmail {
  if (!input.to.includes('@')) throw new Error('A valid recipient email is required.');
  const appUrl = new URL(input.appUrl);
  if (appUrl.protocol !== 'https:') throw new Error('App URL must use HTTPS.');
  return {
    from: 'RoughBid <hello@mail.kspdominion.group>',
    to: input.to,
    templateAlias: 'roughbid-workspace-welcome',
    variables: {
      APP_URL: appUrl.toString().replace(/\/$/, ''),
    },
  };
}

export function createWorkspaceInviteEmail(input: WorkspaceInviteEmailInput): WorkspaceInviteEmail {
  if (!input.to.includes('@')) throw new Error('A valid recipient email is required.');
  const inviteUrl = new URL(input.inviteUrl);
  if (inviteUrl.protocol !== 'https:') throw new Error('Invite URL must use HTTPS.');
  const workspaceName = input.workspaceName.trim();
  if (!workspaceName) throw new Error('Workspace name is required.');
  return {
    from: 'RoughBid <hello@mail.kspdominion.group>',
    to: input.to,
    templateAlias: 'roughbid-organization-invite',
    variables: {
      WORKSPACE_NAME: workspaceName,
      INVITE_URL: inviteUrl.toString(),
      ROLE: input.role.trim() || 'estimator',
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

export async function sendWorkspaceWelcomeEmail(
  config: ResendServerConfig,
  input: WorkspaceWelcomeInput,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<{ id: string }> {
  if (!config.apiKey.trim()) throw new Error('A Resend API key is required.');
  const email = createWorkspaceWelcomeEmail(input);
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
    throw new Error(`Resend rejected the workspace welcome email (${response.status}): ${detail}`);
  }
  const result = await response.json() as { id?: unknown };
  if (typeof result.id !== 'string') throw new Error('Resend returned an invalid email response.');
  return { id: result.id };
}

export async function sendWorkspaceInviteEmail(
  config: ResendServerConfig,
  input: WorkspaceInviteEmailInput,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<{ id: string }> {
  if (!config.apiKey.trim()) throw new Error('A Resend API key is required.');
  const email = createWorkspaceInviteEmail(input);
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
    throw new Error(`Resend rejected the workspace invite email (${response.status}): ${detail}`);
  }
  const result = await response.json() as { id?: unknown };
  if (typeof result.id !== 'string') throw new Error('Resend returned an invalid email response.');
  return { id: result.id };
}
