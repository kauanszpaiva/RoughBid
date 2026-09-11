import test from 'node:test';
import assert from 'node:assert/strict';

import { getDocuSignConfig, docusignStatus } from '../server/contracts/docusignConfig.ts';
import {
  determineSignatureRouting,
  resolveDocuSignAccount,
  prepareAndSendDocuSignEnvelope,
} from '../server/contracts/docusign.ts';

const SAMPLE_CANONICAL_HASH = 'abc123canonicalhash9876543210';
const MOCK_TEMPLATE_ID_ACC_A = 'template-uuid-account-a-1111';
const MOCK_TEMPLATE_ID_ACC_B = 'template-uuid-account-b-2222';

test('1. Account ID and Base URI are not hardcoded and parse dynamically from env', () => {
  const envAccountA = {
    DOCUSIGN_ACCOUNT_ID: 'acc-1111-aaaa',
    DOCUSIGN_BASE_URI: 'https://demo.docusign.net/restapi/v2.1/accounts/acc-1111-aaaa',
  };

  const envAccountB = {
    DOCUSIGN_ACCOUNT_ID: 'acc-2222-bbbb',
    DOCUSIGN_BASE_URI: 'https://na3.docusign.net/restapi/v2.1/accounts/acc-2222-bbbb',
  };

  const configA = getDocuSignConfig({ env: envAccountA });
  const configB = getDocuSignConfig({ env: envAccountB });

  assert.equal(configA.accountId, 'acc-1111-aaaa');
  assert.equal(configA.baseUri, 'https://demo.docusign.net/restapi/v2.1/accounts/acc-1111-aaaa');
  assert.equal(configA.accountResolution.isExplicit, true);

  assert.equal(configB.accountId, 'acc-2222-bbbb');
  assert.equal(configB.baseUri, 'https://na3.docusign.net/restapi/v2.1/accounts/acc-2222-bbbb');
  assert.equal(configB.accountResolution.isExplicit, true);

  assert.notEqual(configA.accountId, configB.accountId);
  assert.notEqual(configA.baseUri, configB.baseUri);
});

test('2. Secure account discovery works from /oauth/userinfo when explicit config is omitted', async () => {
  const envWithoutAccount = {
    DOCUSIGN_INTEGRATION_KEY: 'test-key',
    DOCUSIGN_USER_ID: 'user-123',
    DOCUSIGN_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
  };

  const mockUserInfoFetcher = async () => ({
    sub: 'user-123',
    accounts: [
      {
        account_id: 'discovered-acc-9999',
        is_default: true,
        base_uri: 'https://na4.docusign.net',
        account_name: 'BEZ Production Account B',
      },
    ],
  });

  const accountRes = await resolveDocuSignAccount({ env: envWithoutAccount }, mockUserInfoFetcher);

  assert.equal(accountRes.isExplicit, false);
  assert.equal(accountRes.discovered, true);
  assert.equal(accountRes.accountId, 'discovered-acc-9999');
  assert.equal(accountRes.baseUri, 'https://na4.docusign.net');
});

test('3. Missing configuration fails closed gracefully', async () => {
  const emptyEnv = {};

  const status = docusignStatus({ env: emptyEnv });
  assert.equal(status.credentialsConfigured, false);
  assert.equal(status.accountResolved, false);
  assert.equal(status.prepareAllowed, false);
  assert.equal(status.realSendAllowed, false);
  assert.ok(status.missingConfigurations.includes('DOCUSIGN_INTEGRATION_KEY'));
  assert.ok(status.missingConfigurations.includes('DOCUSIGN_USER_ID'));
  assert.ok(status.missingConfigurations.includes('DOCUSIGN_PRIVATE_KEY'));

  const sendResult = await prepareAndSendDocuSignEnvelope(
    {
      contractType: 'CUSTOM',
      templateContentHash: SAMPLE_CANONICAL_HASH,
      memberEmail: 'member@example.com',
      memberName: 'John Member',
    },
    { env: emptyEnv }
  );

  assert.equal(sendResult.success, false);
  assert.ok(sendResult.error?.includes('mapping invalid or missing'));
});

test('4. Malformed template map JSON fails closed', async () => {
  const malformedEnv = {
    DOCUSIGN_BEZ_TEMPLATE_MAP_JSON: '{ bad json syntax ',
  };

  const status = docusignStatus({ env: malformedEnv });
  assert.equal(status.canonicalTemplateMappingConfigured, false);
  assert.ok(status.missingConfigurations.some((msg) => msg.includes('invalid JSON object')));

  const sendResult = await prepareAndSendDocuSignEnvelope(
    {
      contractType: 'CUSTOM',
      templateContentHash: SAMPLE_CANONICAL_HASH,
      memberEmail: 'member@example.com',
      memberName: 'John Member',
    },
    { env: malformedEnv }
  );

  assert.equal(sendResult.success, false);
  assert.ok(sendResult.error?.includes('mapping invalid or missing'));
});

test('5. DocuSign account swap does NOT alter canonical BEZ contract hash', async () => {
  const envAccountA = {
    DOCUSIGN_BEZ_TEMPLATE_MAP_JSON: JSON.stringify({
      [SAMPLE_CANONICAL_HASH]: MOCK_TEMPLATE_ID_ACC_A,
    }),
  };

  const envAccountB = {
    DOCUSIGN_BEZ_TEMPLATE_MAP_JSON: JSON.stringify({
      [SAMPLE_CANONICAL_HASH]: MOCK_TEMPLATE_ID_ACC_B,
    }),
  };

  const configA = getDocuSignConfig({ env: envAccountA });
  const configB = getDocuSignConfig({ env: envAccountB });

  // Hash keys are identical
  assert.ok(SAMPLE_CANONICAL_HASH in configA.templateMap);
  assert.ok(SAMPLE_CANONICAL_HASH in configB.templateMap);

  // DocuSign template mirrors differ, but the canonical hash key remains unchanged
  assert.equal(configA.templateMap[SAMPLE_CANONICAL_HASH], MOCK_TEMPLATE_ID_ACC_A);
  assert.equal(configB.templateMap[SAMPLE_CANONICAL_HASH], MOCK_TEMPLATE_ID_ACC_B);
});

test('6. Signer policy is enforced and separates DocuSign account identity from BEZ legal signer identity', () => {
  const env = {
    DOCUSIGN_USER_ID: 'docusign-api-user-id-001',
    BEZ_LEGAL_SIGNER_NAME: 'Jane Counsel',
    BEZ_LEGAL_SIGNER_EMAIL: 'legal@bezdomain.com',
    DOCUSIGN_MEMBER_ROLE_NAME: 'Member',
    DOCUSIGN_BEZ_SIGNER_ROLE_NAME: 'BEZ Legal Signer',
  };

  const config = getDocuSignConfig({ env });
  const status = docusignStatus({ env });

  assert.equal(config.userId, 'docusign-api-user-id-001');
  assert.equal(config.bezLegalSignerName, 'Jane Counsel');
  assert.equal(config.bezLegalSignerEmail, 'legal@bezdomain.com');

  assert.notEqual(config.userId, config.bezLegalSignerEmail);
  assert.equal(status.legalSignerConfigured, true);
  assert.equal(status.rolesConfigured, true);
});

test('7. Secrets and private keys are NEVER exposed in docusignStatus output', () => {
  const SECRET_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nSUPER_SECRET_KEY_DATA\n-----END RSA PRIVATE KEY-----';
  const SECRET_HMAC = 'super_secret_hmac_key_999';

  const envWithSecrets = {
    DOCUSIGN_INTEGRATION_KEY: 'test-key',
    DOCUSIGN_USER_ID: 'test-user',
    DOCUSIGN_PRIVATE_KEY: SECRET_PRIVATE_KEY,
    DOCUSIGN_HMAC_SECRET_KEY: SECRET_HMAC,
  };

  const status = docusignStatus({ env: envWithSecrets });
  const statusJson = JSON.stringify(status);

  assert.equal(statusJson.includes('SUPER_SECRET_KEY_DATA'), false);
  assert.equal(statusJson.includes('super_secret_hmac_key_999'), false);
  assert.equal(status.credentialsConfigured, true);
  assert.equal(status.hmacConfigured, true);
});

test('8. Real-send remains blocked without explicit legal-send authorization (DOCUSIGN_ALLOW_REAL_SEND)', async () => {
  const fullEnvWithoutSend = {
    DOCUSIGN_INTEGRATION_KEY: 'test-key',
    DOCUSIGN_USER_ID: 'test-user',
    DOCUSIGN_PRIVATE_KEY: 'key',
    DOCUSIGN_ACCOUNT_ID: 'acc-123',
    DOCUSIGN_BASE_URI: 'https://demo.docusign.net',
    DOCUSIGN_BEZ_TEMPLATE_MAP_JSON: JSON.stringify({ [SAMPLE_CANONICAL_HASH]: 'tmpl-123' }),
    BEZ_LEGAL_SIGNER_NAME: 'Signer',
    BEZ_LEGAL_SIGNER_EMAIL: 'signer@bez.com',
    DOCUSIGN_TEMPLATES_CERTIFIED: 'true',
    DOCUSIGN_ALLOW_REAL_SEND: 'false',
  };

  const status = docusignStatus({ env: fullEnvWithoutSend });
  assert.equal(status.prepareAllowed, true);
  assert.equal(status.realSendAllowed, false);
  assert.ok(status.missingConfigurations.includes('DOCUSIGN_ALLOW_REAL_SEND'));

  const result = await prepareAndSendDocuSignEnvelope(
    {
      contractType: 'CUSTOM',
      templateContentHash: SAMPLE_CANONICAL_HASH,
      memberEmail: 'member@example.com',
      memberName: 'Member',
    },
    { env: fullEnvWithoutSend }
  );

  assert.equal(result.success, false);
  assert.ok(result.error?.includes('DOCUSIGN_ALLOW_REAL_SEND=false'));
});

test('9. STANDARD agreements use internal BEZ signing flow and do NOT depend on DocuSign', async () => {
  const standardRouting = determineSignatureRouting({
    contractType: 'STANDARD',
    templateContentHash: SAMPLE_CANONICAL_HASH,
  });

  assert.equal(standardRouting.provider, 'BEZ_INTERNAL');
  assert.equal(standardRouting.isCustom, false);

  const customRouting = determineSignatureRouting({
    contractType: 'CUSTOM',
    templateContentHash: SAMPLE_CANONICAL_HASH,
  });

  assert.equal(customRouting.provider, 'DOCUSIGN');
  assert.equal(customRouting.isCustom, true);

  // Attempting to route STANDARD agreement to DocuSign send function fails closed safely
  const result = await prepareAndSendDocuSignEnvelope(
    {
      contractType: 'STANDARD',
      templateContentHash: SAMPLE_CANONICAL_HASH,
      memberEmail: 'member@example.com',
      memberName: 'Member',
    },
    { env: {} }
  );

  assert.equal(result.success, false);
  assert.equal(result.routing.provider, 'BEZ_INTERNAL');
  assert.ok(result.error?.includes('BEZ internal signing flow'));
});
