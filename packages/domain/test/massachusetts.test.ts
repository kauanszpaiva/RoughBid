import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMassachusettsContext, resolveMassachusettsTaxTreatment } from '../src/massachusetts.ts';

const adoption = { municipality: 'Boston', level: 'stretch' as const, effectiveDate: '2020-01-01', sourceDate: '2026-04-01', sourceUrl: 'https://www.mass.gov/doc/building-energy-code-adoption-by-municipality/download' };

test('Massachusetts context fails closed on municipality, project type and public-work wage ambiguity', () => {
  const context = resolveMassachusettsContext({ state: 'MA', municipality: 'Boston', addressConfirmed: true, projectType: 'unknown', publicWorks: true, prevailingWageSchedule: null, municipalityAdoption: adoption });
  assert.equal(context.buildingCode, '780 CMR 10th Edition');
  assert.equal(context.prevailingWageStatus, 'required_missing');
  assert.ok(context.blockers.some(value => /project type/i.test(value)));
  assert.ok(context.blockers.some(value => /actual DLS/i.test(value)));
  assert.ok(context.notices.some(value => value.classification === 'AHJ_CONFIRMATION_REQUIRED'));
});

test('uses the project-specific wage schedule and selects the applicable energy chapter', () => {
  const context = resolveMassachusettsContext({ state: 'MA', municipality: 'Boston', addressConfirmed: true, projectType: 'commercial_multifamily_other', publicWorks: true, prevailingWageSchedule: { projectIdentifier: 'PW-2026-123', issuedAt: '2026-08-01', classifications: 12 }, municipalityAdoption: adoption });
  assert.equal(context.energyCode, '225 CMR 23 (stretch)');
  assert.equal(context.prevailingWageStatus, 'verified_project_schedule');
  assert.deepEqual(context.blockers, []);
  assert.match(context.notices[0]!.message, /PW-2026-123/);
});

test('tax applies to applicable material purchases, never blindly to the whole contract', () => {
  assert.deepEqual(resolveMassachusettsTaxTreatment({ componentType: 'labor', realPropertyContract: true, exemptProject: false, exemptionCertificateOnFile: false }), {
    treatment: 'not_applicable_service', ratePercent: '0', reason: 'This component is not a taxable material purchase.',
  });
  assert.equal(resolveMassachusettsTaxTreatment({ componentType: 'material', realPropertyContract: true, exemptProject: false, exemptionCertificateOnFile: false }).ratePercent, '6.25');
  assert.equal(resolveMassachusettsTaxTreatment({ componentType: 'material', realPropertyContract: true, exemptProject: true, exemptionCertificateOnFile: false }).treatment, 'review_required');
});
