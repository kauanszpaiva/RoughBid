import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { presentAiPlanStatus } from '../app/src/utils/aiPlanStatus.ts';

test('queued and processing readings are pending, never presented as complete', () => {
  const queued = presentAiPlanStatus('queued');
  assert.equal(queued.finished, false);
  assert.match(queued.notice, /queued/i);
  assert.match(queued.notice, /background/i);
  assert.equal(queued.revisionNote, undefined);

  const processing = presentAiPlanStatus('processing');
  assert.equal(processing.finished, false);
  assert.match(processing.notice, /processing/i);
  assert.equal(processing.revisionNote, undefined);
});

test('only persisted review-ready states are presented as complete', () => {
  for (const status of ['needs_review', 'ready'] as const) {
    const presented = presentAiPlanStatus(status);
    assert.equal(presented.finished, true);
    assert.match(presented.notice, /ready to review/i);
    assert.match(presented.revisionNote ?? '', /complete/i);
  }

  const failed = presentAiPlanStatus('failed');
  assert.equal(failed.finished, false);
  assert.match(failed.notice, /failed/i);
  assert.equal(failed.revisionNote, undefined);
});

test('Plans page content polls an in-flight AI reading and syncs terminal status instead of leaving stale processing UI', () => {
  const plans = readFileSync(new URL('../app/src/pages/PlansPageContent.tsx', import.meta.url), 'utf8');
  assert.match(plans, /const pollAiPlanReading = async \(\) =>/);
  assert.match(plans, /setTimeout\(pollAiPlanReading,\s*4000\)/);
  assert.match(plans, /aiPlanStatus:\s*polledJob\.status/);
  assert.match(plans, /polledJob\.processing_error/);
});

test('platform-owner AI testing keeps workspace consent explicit and billing complimentary', () => {
  const settings = readFileSync(new URL('../app/src/pages/SettingsPage.tsx', import.meta.url), 'utf8');
  const billing = readFileSync(new URL('../app/src/pages/BillingPage.tsx', import.meta.url), 'utf8');

  assert.match(settings, /onClick=\{handleGrantAiConsent\}/);
  assert.match(settings, /Enable AI plan reading/);
  assert.match(settings, /Only the workspace owner can enable AI plan reading/);
  assert.match(billing, /Complimentary full access/);
  assert.match(billing, /disabled=\{platformAdmin \|\| busy \|\| !memberships\[tier\]\}/);
  assert.match(billing, /starter: capabilities\.membershipStarter, pro: capabilities\.membershipPro, team: capabilities\.membershipTeam/);
});