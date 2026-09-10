import { roughbidEmailFrom, roughbidEmailHtml } from './brand.ts';

export type WorkspaceWelcomeInput = {
  to: string;
  appUrl: string;
};

export type WorkspaceInviteEmailInput = {
  to: string;
  workspaceName: string;
  inviteUrl: string;
  role: string;
  idempotencyKey?: string;
};

export type MagicLinkEmailInput = {
  to: string;
  magicLink: string;
  appUrl: string;
  idempotencyKey?: string;
};

export type ProposalNotificationEmailInput = {
  to: string;
  proposalTitle: string;
  clientName: string;
  projectName?: string;
  proposalUrl: string;
  idempotencyKey?: string;
};

export type WorkspaceWelcomeEmail = {
  from: string;
  to: string;
  templateAlias: 'roughbid-workspace-welcome';
  variables: {
    APP_URL: string;
  };
};

export type WorkspaceInviteEmail = {
  from: string;
  to: string;
  templateAlias: 'roughbid-organization-invite';
  variables: {
    WORKSPACE_NAME: string;
    INVITE_URL: string;
    ROLE: string;
  };
};

export type ProposalNotificationEmail = {
  from: string;
  to: string;
  templateAlias: 'roughbid-proposal-opened' | 'roughbid-proposal-signed';
  variables: {
    PROPOSAL_TITLE: string;
    CLIENT_NAME: string;
    PROJECT_NAME: string;
    PROPOSAL_URL: string;
    APP_URL: string;
  };
};

type Fetch = typeof globalThis.fetch;

export type ResendServerConfig = {
  apiKey: string;
  from?: string;
};

export function loadResendServerConfig(env: NodeJS.ProcessEnv = process.env): ResendServerConfig {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error('RESEND_API_KEY is required on the server.');
  return { apiKey, from: roughbidEmailFrom(env) };
}

export function createWorkspaceWelcomeEmail(input: WorkspaceWelcomeInput): WorkspaceWelcomeEmail {
  if (!input.to.includes('@')) throw new Error('A valid recipient email is required.');
  const appUrl = new URL(input.appUrl);
  if (appUrl.protocol !== 'https:') throw new Error('App URL must use HTTPS.');
  return {
    from: roughbidEmailFrom(),
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
  const role = input.role.trim() || 'estimator';
  return {
    from: roughbidEmailFrom(),
    to: input.to,
    templateAlias: 'roughbid-organization-invite',
    variables: {
      WORKSPACE_NAME: workspaceName,
      INVITE_URL: inviteUrl.toString(),
      ROLE: role === 'viewer' ? 'viewer (read-only access to review saved projects and estimates)' : role,
    },
  };
}

export function createProposalNotificationEmail(
  templateAlias: ProposalNotificationEmail['templateAlias'],
  input: ProposalNotificationEmailInput,
): ProposalNotificationEmail {
  if (!input.to.includes('@')) throw new Error('A valid recipient email is required.');
  const proposalUrl = new URL(input.proposalUrl);
  if (proposalUrl.protocol !== 'https:') throw new Error('Proposal URL must use HTTPS.');
  const proposalTitle = input.proposalTitle.trim();
  const clientName = input.clientName.trim();
  const projectName = (input.projectName ?? input.proposalTitle).trim();
  if (!proposalTitle) throw new Error('Proposal title is required.');
  if (!clientName) throw new Error('Client name is required.');
  if (!projectName) throw new Error('Project name is required.');
  return {
    from: roughbidEmailFrom(),
    to: input.to,
    templateAlias,
    variables: {
      PROPOSAL_TITLE: proposalTitle,
      CLIENT_NAME: clientName,
      PROJECT_NAME: projectName,
      PROPOSAL_URL: proposalUrl.toString(),
      APP_URL: proposalUrl.toString(),
    },
  };
}

export function createProposalOpenedEmail(input: ProposalNotificationEmailInput): ProposalNotificationEmail {
  return createProposalNotificationEmail('roughbid-proposal-opened', input);
}

export function createProposalSignedEmail(input: ProposalNotificationEmailInput): ProposalNotificationEmail {
  return createProposalNotificationEmail('roughbid-proposal-signed', input);
}

async function sendTemplateEmail(
  config: ResendServerConfig,
  email: WorkspaceWelcomeEmail | WorkspaceInviteEmail | ProposalNotificationEmail,
  fetchImpl: Fetch,
  idempotencyKey?: string,
): Promise<{ id: string }> {
  if (!config.apiKey.trim()) throw new Error('A Resend API key is required.');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: config.from ?? email.from,
      to: [email.to],
      template: {
        id: email.templateAlias,
        variables: email.variables,
      },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Resend rejected the email (${response.status}): ${detail}`);
  }
  const result = await response.json() as { id?: unknown };
  if (typeof result.id !== 'string') throw new Error('Resend returned an invalid email response.');
  return { id: result.id };
}

export async function sendMagicLinkEmail(
  config: ResendServerConfig,
  input: MagicLinkEmailInput,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<{ id: string }> {
  if (!input.to.includes('@')) throw new Error('A valid recipient email is required.');
  const magicLink = new URL(input.magicLink);
  if (magicLink.protocol !== 'https:') throw new Error('Magic link must use HTTPS.');
  const appUrl = new URL(input.appUrl);
  if (appUrl.protocol !== 'https:') throw new Error('App URL must use HTTPS.');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: config.from ?? roughbidEmailFrom(),
      to: [input.to],
      subject: 'Sign in to RoughBid',
      text: `Open RoughBid: ${magicLink.toString()}\n\nIf you did not request this, you can ignore this email.`,
      html: roughbidEmailHtml({ title: 'Open RoughBid', paragraphs: ['Use this secure link to sign in or finish creating your RoughBid account.'], action: { label: 'Sign in to RoughBid', url: magicLink.toString() }, footer: 'If you did not request this, you can ignore this email.' }),
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Resend rejected the email (${response.status}): ${detail}`);
  }
  const result = await response.json() as { id?: unknown };
  if (typeof result.id !== 'string') throw new Error('Resend returned an invalid email response.');
  return { id: result.id };
}

export function sendWorkspaceWelcomeEmail(
  config: ResendServerConfig,
  input: WorkspaceWelcomeInput,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<{ id: string }> {
  return sendTemplateEmail(config, createWorkspaceWelcomeEmail(input), fetchImpl);
}

export function sendWorkspaceInviteEmail(
  config: ResendServerConfig,
  input: WorkspaceInviteEmailInput,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<{ id: string }> {
  return sendTemplateEmail(config, createWorkspaceInviteEmail(input), fetchImpl, input.idempotencyKey);
}

export function sendProposalOpenedEmail(
  config: ResendServerConfig,
  input: ProposalNotificationEmailInput,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<{ id: string }> {
  return sendTemplateEmail(
    config,
    createProposalOpenedEmail(input),
    fetchImpl,
    input.idempotencyKey ?? `proposal-opened-${input.proposalUrl}`,
  );
}

export function sendProposalSignedEmail(
  config: ResendServerConfig,
  input: ProposalNotificationEmailInput,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<{ id: string }> {
  return sendTemplateEmail(
    config,
    createProposalSignedEmail(input),
    fetchImpl,
    input.idempotencyKey ?? `proposal-signed-${input.proposalUrl}`,
  );
}
