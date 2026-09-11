export interface DocuSignConfigOptions {
  env?: Record<string, string | undefined>;
}

export interface DocuSignTemplateMapping {
  [canonicalHash: string]: string; // canonical contract content hash -> approved DocuSign template ID
}

export interface DocuSignAccountResolution {
  accountId?: string | undefined;
  baseUri?: string | undefined;
  isExplicit: boolean;
  discovered: boolean;
}

export interface DocuSignStatus {
  credentialsConfigured: boolean;
  accountResolved: boolean;
  canonicalTemplateMappingConfigured: boolean;
  legalSignerConfigured: boolean;
  rolesConfigured: boolean;
  webhookConfigured: boolean;
  hmacConfigured: boolean;
  tabsCertified: boolean;
  prepareAllowed: boolean;
  realSendAllowed: boolean;
  missingConfigurations: string[];
}

export interface DocuSignResolvedConfig {
  environment: 'demo' | 'production';
  integrationKey?: string | undefined;
  userId?: string | undefined;
  hasPrivateKey: boolean;
  privateKey?: string | undefined;
  authServer: string;
  accountId?: string | undefined;
  baseUri?: string | undefined;
  accountResolution: DocuSignAccountResolution;
  templateMap: DocuSignTemplateMapping;
  templateMapRaw?: string | undefined;
  templateMapValid: boolean;
  webhookUrl?: string | undefined;
  hasHmacSecret: boolean;
  memberRoleName: string;
  bezSignerRoleName: string;
  bezLegalSignerName?: string | undefined;
  bezLegalSignerEmail?: string | undefined;
  templatesCertified: boolean;
  allowRealSend: boolean;
}

/**
 * Parses and returns the centralized DocuSign provider configuration.
 * Decouples DocuSign account & environment setup from contract business logic.
 */
export function getDocuSignConfig(options: DocuSignConfigOptions = {}): DocuSignResolvedConfig {
  const env = options.env || process.env;

  const rawEnv = (env.DOCUSIGN_ENVIRONMENT || 'demo').toLowerCase().trim();
  const environment: 'demo' | 'production' = rawEnv === 'production' || rawEnv === 'prod' ? 'production' : 'demo';

  const integrationKey = env.DOCUSIGN_INTEGRATION_KEY?.trim() || undefined;
  const userId = env.DOCUSIGN_USER_ID?.trim() || undefined;

  const rawPrivateKey = env.DOCUSIGN_PRIVATE_KEY || env.DOCUSIGN_RSA_PRIVATE_KEY;
  const privateKey = rawPrivateKey ? rawPrivateKey.trim().replace(/\\n/g, '\n') : undefined;
  const hasPrivateKey = Boolean(privateKey && privateKey.length > 0);

  const defaultAuthServer = environment === 'production' ? 'account.docusign.com' : 'account-d.docusign.com';
  const authServer = env.DOCUSIGN_AUTH_SERVER?.trim() || defaultAuthServer;

  const accountId = env.DOCUSIGN_ACCOUNT_ID?.trim() || undefined;
  const baseUri = env.DOCUSIGN_BASE_URI?.trim() || undefined;

  const isExplicit = Boolean(accountId && baseUri);
  const accountResolution: DocuSignAccountResolution = {
    accountId,
    baseUri,
    isExplicit,
    discovered: false,
  };

  const templateMapRaw = env.DOCUSIGN_BEZ_TEMPLATE_MAP_JSON?.trim() || undefined;
  let templateMap: DocuSignTemplateMapping = {};
  let templateMapValid = false;

  if (templateMapRaw) {
    try {
      const parsed = JSON.parse(templateMapRaw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        templateMap = parsed as DocuSignTemplateMapping;
        templateMapValid = true;
      }
    } catch {
      templateMapValid = false;
    }
  }

  const webhookUrl = env.DOCUSIGN_WEBHOOK_URL?.trim() || undefined;
  const hmacSecret = env.DOCUSIGN_HMAC_SECRET_KEY?.trim() || undefined;
  const hasHmacSecret = Boolean(hmacSecret && hmacSecret.length > 0);

  const memberRoleName = env.DOCUSIGN_MEMBER_ROLE_NAME?.trim() || 'Member';
  const bezSignerRoleName = env.DOCUSIGN_BEZ_SIGNER_ROLE_NAME?.trim() || 'BEZ Authorized Signer';

  const bezLegalSignerName = env.BEZ_LEGAL_SIGNER_NAME?.trim() || undefined;
  const bezLegalSignerEmail = env.BEZ_LEGAL_SIGNER_EMAIL?.trim() || undefined;

  const rawCertified = env.DOCUSIGN_TEMPLATES_CERTIFIED?.toLowerCase().trim();
  const templatesCertified = rawCertified === 'true' || rawCertified === '1';

  const rawAllowRealSend = env.DOCUSIGN_ALLOW_REAL_SEND?.toLowerCase().trim();
  const allowRealSend = rawAllowRealSend === 'true' || rawAllowRealSend === '1';

  return {
    environment,
    integrationKey,
    userId,
    hasPrivateKey,
    privateKey,
    authServer,
    accountId,
    baseUri,
    accountResolution,
    templateMap,
    templateMapRaw,
    templateMapValid,
    webhookUrl,
    hasHmacSecret,
    memberRoleName,
    bezSignerRoleName,
    bezLegalSignerName,
    bezLegalSignerEmail,
    templatesCertified,
    allowRealSend,
  };
}

/**
 * Admin health diagnostics for the DocuSign provider.
 * Does NOT return private keys, OAuth tokens, HMAC secrets, or raw credentials.
 * Lists missing configuration NAMES when incomplete.
 */
export function docusignStatus(options: DocuSignConfigOptions = {}): DocuSignStatus {
  const config = getDocuSignConfig(options);
  const missing: string[] = [];

  if (!config.integrationKey) missing.push('DOCUSIGN_INTEGRATION_KEY');
  if (!config.userId) missing.push('DOCUSIGN_USER_ID');
  if (!config.hasPrivateKey) missing.push('DOCUSIGN_PRIVATE_KEY');

  const credentialsConfigured = Boolean(config.integrationKey && config.userId && config.hasPrivateKey);

  const accountResolved = Boolean(config.accountId && config.baseUri);
  if (!config.accountId) missing.push('DOCUSIGN_ACCOUNT_ID (or discovery via /oauth/userinfo)');
  if (!config.baseUri) missing.push('DOCUSIGN_BASE_URI (or discovery via /oauth/userinfo)');

  const canonicalTemplateMappingConfigured = config.templateMapValid && Object.keys(config.templateMap).length > 0;
  if (!config.templateMapRaw) {
    missing.push('DOCUSIGN_BEZ_TEMPLATE_MAP_JSON');
  } else if (!config.templateMapValid) {
    missing.push('DOCUSIGN_BEZ_TEMPLATE_MAP_JSON (invalid JSON object)');
  } else if (Object.keys(config.templateMap).length === 0) {
    missing.push('DOCUSIGN_BEZ_TEMPLATE_MAP_JSON (empty mapping)');
  }

  const legalSignerConfigured = Boolean(config.bezLegalSignerName && config.bezLegalSignerEmail);
  if (!config.bezLegalSignerName) missing.push('BEZ_LEGAL_SIGNER_NAME');
  if (!config.bezLegalSignerEmail) missing.push('BEZ_LEGAL_SIGNER_EMAIL');

  const rolesConfigured = Boolean(config.memberRoleName && config.bezSignerRoleName);

  const webhookConfigured = Boolean(config.webhookUrl);
  if (!config.webhookUrl) missing.push('DOCUSIGN_WEBHOOK_URL');

  const hmacConfigured = config.hasHmacSecret;
  if (!config.hasHmacSecret) missing.push('DOCUSIGN_HMAC_SECRET_KEY');

  const tabsCertified = config.templatesCertified;
  if (!config.templatesCertified) missing.push('DOCUSIGN_TEMPLATES_CERTIFIED');

  const prepareAllowed = credentialsConfigured && canonicalTemplateMappingConfigured && rolesConfigured;
  const realSendAllowed = prepareAllowed && accountResolved && legalSignerConfigured && tabsCertified && config.allowRealSend;

  if (!config.allowRealSend) missing.push('DOCUSIGN_ALLOW_REAL_SEND');

  return {
    credentialsConfigured,
    accountResolved,
    canonicalTemplateMappingConfigured,
    legalSignerConfigured,
    rolesConfigured,
    webhookConfigured,
    hmacConfigured,
    tabsCertified,
    prepareAllowed,
    realSendAllowed,
    missingConfigurations: missing,
  };
}
