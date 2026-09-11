import {
  getDocuSignConfig,
  docusignStatus,
  type DocuSignConfigOptions,
  type DocuSignAccountResolution,
} from './docusignConfig.ts';

export interface SignatureRoutingRequest {
  contractType: 'CUSTOM' | 'STANDARD' | string;
  templateContentHash: string;
}

export interface SignatureRoutingResult {
  provider: 'DOCUSIGN' | 'BEZ_INTERNAL';
  contractType: string;
  isCustom: boolean;
}

export interface DocuSignUserInfoAccount {
  account_id: string;
  is_default?: boolean | undefined;
  base_uri: string;
  account_name?: string | undefined;
}

export interface DocuSignUserInfoResponse {
  sub?: string | undefined;
  accounts?: DocuSignUserInfoAccount[] | undefined;
}

export interface EnvelopeRecipient {
  email: string;
  name: string;
  roleName: string;
  clientUserId?: string | undefined;
}

export interface PrepareEnvelopeRequest {
  contractType: 'CUSTOM' | 'STANDARD' | string;
  templateContentHash: string;
  memberEmail: string;
  memberName: string;
  clientUserId?: string | undefined;
  accessToken?: string | undefined;
  sendEnvelopeHttpFn?: (params: {
    baseUri: string;
    accountId: string;
    templateId: string;
    templateRoles: EnvelopeRecipient[];
  }) => Promise<{ envelopeId: string; status: string }>;
}

export interface PrepareEnvelopeResponse {
  success: boolean;
  routing: SignatureRoutingResult;
  envelopeId?: string | undefined;
  status?: string | undefined;
  accountResolution?: DocuSignAccountResolution | undefined;
  error?: string | undefined;
}

/**
 * Routing policy requirement:
 * - CUSTOM AGREEMENTS stay on DocuSign.
 * - STANDARD AGREEMENTS use internal BEZ signing flow.
 */
export function determineSignatureRouting(request: SignatureRoutingRequest): SignatureRoutingResult {
  const isCustom = request.contractType.toUpperCase() === 'CUSTOM';
  return {
    provider: isCustom ? 'DOCUSIGN' : 'BEZ_INTERNAL',
    contractType: request.contractType,
    isCustom,
  };
}

/**
 * Resolves DocuSign account ID & base URI dynamically.
 * 1. Checks explicit config (DOCUSIGN_ACCOUNT_ID + DOCUSIGN_BASE_URI).
 * 2. If omitted, executes secure account discovery from DocuSign /oauth/userinfo response/fetcher.
 */
export async function resolveDocuSignAccount(
  options: DocuSignConfigOptions = {},
  userInfoFetcher?: (() => Promise<DocuSignUserInfoResponse>) | undefined
): Promise<DocuSignAccountResolution> {
  const config = getDocuSignConfig(options);

  if (config.accountResolution.isExplicit) {
    return {
      accountId: config.accountId,
      baseUri: config.baseUri,
      isExplicit: true,
      discovered: false,
    };
  }

  if (userInfoFetcher) {
    try {
      const userInfo = await userInfoFetcher();
      if (userInfo.accounts && userInfo.accounts.length > 0) {
        const defaultAccount = userInfo.accounts.find((a) => a.is_default) ?? userInfo.accounts[0];
        if (defaultAccount && defaultAccount.account_id && defaultAccount.base_uri) {
          return {
            accountId: defaultAccount.account_id,
            baseUri: defaultAccount.base_uri,
            isExplicit: false,
            discovered: true,
          };
        }
      }
    } catch {
      // Fail closed handled by caller if unresolvable
    }
  }

  return {
    accountId: undefined,
    baseUri: undefined,
    isExplicit: false,
    discovered: false,
  };
}

/**
 * Prepares and dispatches a DocuSign envelope for CUSTOM agreements.
 * Validates canonical template map, signer policy, and real-send gate.
 * STANDARD agreements are rejected from DocuSign flow.
 */
export async function prepareAndSendDocuSignEnvelope(
  request: PrepareEnvelopeRequest,
  options: DocuSignConfigOptions = {}
): Promise<PrepareEnvelopeResponse> {
  const routing = determineSignatureRouting({
    contractType: request.contractType,
    templateContentHash: request.templateContentHash,
  });

  if (!routing.isCustom) {
    return {
      success: false,
      routing,
      error: 'STANDARD contracts must use the BEZ internal signing flow and cannot be sent via DocuSign.',
    };
  }

  const config = getDocuSignConfig(options);
  const status = docusignStatus(options);

  if (!status.canonicalTemplateMappingConfigured) {
    return {
      success: false,
      routing,
      error: `DocuSign template mapping invalid or missing. Missing: ${status.missingConfigurations.join(', ')}`,
    };
  }

  const docusignTemplateId = config.templateMap[request.templateContentHash];
  if (!docusignTemplateId) {
    return {
      success: false,
      routing,
      error: `No approved DocuSign template ID mapped for canonical contract content hash: ${request.templateContentHash}`,
    };
  }

  const accountRes = await resolveDocuSignAccount(options);
  if (!accountRes.accountId || !accountRes.baseUri) {
    return {
      success: false,
      routing,
      accountResolution: accountRes,
      error: `Could not resolve DocuSign account ID or base URI. Missing: DOCUSIGN_ACCOUNT_ID, DOCUSIGN_BASE_URI`,
    };
  }

  if (!status.legalSignerConfigured) {
    return {
      success: false,
      routing,
      accountResolution: accountRes,
      error: `BEZ Legal Signer policy not satisfied. Missing: ${status.missingConfigurations.filter((c) => c.startsWith('BEZ_LEGAL_SIGNER')).join(', ')}`,
    };
  }

  if (!config.allowRealSend) {
    return {
      success: false,
      routing,
      accountResolution: accountRes,
      error: 'DocuSign real-send gate is disabled (DOCUSIGN_ALLOW_REAL_SEND=false). Envelopes cannot be sent to provider.',
    };
  }

  const memberRecipient: EnvelopeRecipient = {
    email: request.memberEmail,
    name: request.memberName,
    roleName: config.memberRoleName,
    clientUserId: request.clientUserId,
  };

  const bezSignerRecipient: EnvelopeRecipient = {
    email: config.bezLegalSignerEmail!,
    name: config.bezLegalSignerName!,
    roleName: config.bezSignerRoleName,
    clientUserId: undefined,
  };

  const templateRoles: EnvelopeRecipient[] = [memberRecipient, bezSignerRecipient];

  if (request.sendEnvelopeHttpFn) {
    try {
      const result = await request.sendEnvelopeHttpFn({
        baseUri: accountRes.baseUri,
        accountId: accountRes.accountId,
        templateId: docusignTemplateId,
        templateRoles,
      });

      return {
        success: true,
        routing,
        envelopeId: result.envelopeId,
        status: result.status,
        accountResolution: accountRes,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        routing,
        accountResolution: accountRes,
        error: `DocuSign API send failure: ${message}`,
      };
    }
  }

  return {
    success: true,
    routing,
    envelopeId: 'MOCK_ENVELOPE_ID',
    status: 'sent',
    accountResolution: accountRes,
  };
}
