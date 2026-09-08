import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('workspace AI consent is explicit, owner-only in UI, and calls the existing API', () => {
  const app = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../app/src/pages/SettingsPage.tsx', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../app/src/services/api.ts', import.meta.url), 'utf8');

  assert.match(api, /export function grantWorkspaceAiConsent\(workspaceId: string\)/);
  assert.match(app, /grantWorkspaceAiConsent/);
  assert.match(app, /const handleGrantAiConsent = async \(\) =>/);
  assert.match(app, /await grantWorkspaceAiConsent\(workspace\.id\)/);
  assert.match(app, /setWorkspace\(updatedWorkspace\)/);
  assert.match(app, /<SettingsPage[^>]*workspace=\{workspace\}[^>]*onGrantAiConsent=\{handleGrantAiConsent\}/s);

  assert.match(settings, /workspace\.createdBy === user\.id/);
  assert.match(settings, /workspace\.aiProcessingConsentedAt/);
  assert.match(settings, /Enable AI plan reading/);
  assert.match(settings, /By enabling AI plan reading, plan files in this workspace may be sent to the configured AI provider for analysis\./);
  assert.match(settings, /onClick=\{onGrantAiConsent\}/);
  assert.doesNotMatch(settings, /useEffect\([^]*onGrantAiConsent/);
});
