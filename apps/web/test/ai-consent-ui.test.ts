import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('workspace AI consent is explicit, owner-only in UI, and calls the existing API', () => {
  const settings = readFileSync(new URL('../app/src/pages/SettingsPage.tsx', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../app/src/services/api.ts', import.meta.url), 'utf8');

  assert.match(api, /export function grantWorkspaceAiConsent\(workspaceId: string\)/);
  assert.match(settings, /grantWorkspaceAiConsent/);
  assert.match(settings, /listWorkspaces/);
  assert.match(settings, /roughbid_selected_workspace_v1:/);
  assert.match(settings, /currentWorkspace\?\.createdBy === user\.id/);
  assert.match(settings, /currentWorkspace\?\.aiProcessingConsentedAt/);
  assert.match(settings, /Enable AI plan reading/);
  assert.match(settings, /By enabling AI plan reading, plan files in this workspace may be sent to the configured AI provider for analysis\./);
  assert.match(settings, /await grantWorkspaceAiConsent\(currentWorkspace\.id\)/);
  assert.doesNotMatch(settings, /useEffect\([^]*grantWorkspaceAiConsent\(/);
});

test('platform owner billing UI shows complimentary access instead of inviting a checkout', () => {
  const billing = readFileSync(new URL('../app/src/pages/BillingPage.tsx', import.meta.url), 'utf8');
  assert.match(billing, /bootstrapAuth/);
  assert.match(billing, /isPlatformAdmin/);
  assert.match(billing, /Complimentary full access/);
  assert.match(billing, /platformAdmin \? 'Included' :/);
  assert.match(billing, /disabled=\{platformAdmin \|\| busy \|\| !billingAvailable\}/);
});
