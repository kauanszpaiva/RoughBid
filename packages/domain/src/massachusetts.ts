export const MASSACHUSETTS_RULESET = {
  version: 'ma-2026-09-10',
  buildingCode: '780 CMR 10th Edition',
  buildingCodeBasis: 'Massachusetts-amended 2021 I-Codes',
  energyResidential: '225 CMR 22',
  energyCommercial: '225 CMR 23',
  stateSalesUseTaxPercent: '6.25',
  sources: {
    buildingCode: 'https://www.mass.gov/handbook/tenth-edition-of-the-ma-state-building-code-780',
    energyCode: 'https://www.mass.gov/info-details/massachusetts-building-energy-codes',
    municipalityAdoption: 'https://www.mass.gov/doc/building-energy-code-adoption-by-municipality/download',
    prevailingWage: 'https://prevailingwage.mass.gov/',
    salesUseTax: 'https://www.mass.gov/guides/sales-and-use-tax',
  },
} as const;

export type EnergyCodeLevel = 'base' | 'stretch' | 'specialized';
export interface MunicipalityAdoptionRecord {
  municipality: string;
  level: EnergyCodeLevel;
  effectiveDate: string;
  sourceDate: string;
  sourceUrl: string;
}

export interface MassachusettsProjectContextInput {
  state: string | null;
  municipality: string | null;
  addressConfirmed: boolean;
  projectType: 'low_rise_residential' | 'commercial_multifamily_other' | 'unknown';
  publicWorks: boolean | null;
  prevailingWageSchedule: { projectIdentifier: string; issuedAt: string; classifications: number } | null;
  municipalityAdoption: MunicipalityAdoptionRecord | null;
}

export interface MassachusettsProjectContext {
  rulesetVersion: string;
  buildingCode: string;
  energyCode: string | null;
  energyCodeLevel: EnergyCodeLevel | null;
  prevailingWageStatus: 'not_applicable' | 'verified_project_schedule' | 'required_missing' | 'project_setting_unresolved';
  blockers: string[];
  notices: Array<{ classification: 'PLAN_REQUIREMENT' | 'CODE_RELATED_RISK' | 'ESTIMATING_ASSUMPTION' | 'AHJ_CONFIRMATION_REQUIRED'; message: string }>;
}

export function resolveMassachusettsContext(input: MassachusettsProjectContextInput): MassachusettsProjectContext {
  const blockers: string[] = [];
  const notices: MassachusettsProjectContext['notices'] = [];
  if (input.state?.trim().toUpperCase() !== 'MA') blockers.push('Confirmed Massachusetts project state is required.');
  if (!input.addressConfirmed || !input.municipality?.trim()) blockers.push('Confirmed pricing address and municipality are required for code-dependent assumptions.');
  if (!input.municipalityAdoption || input.municipalityAdoption.municipality.trim().toLowerCase() !== input.municipality?.trim().toLowerCase()) {
    blockers.push('Municipality energy-code adoption is not verified from the official DOER dataset.');
  }
  if (input.projectType === 'unknown') blockers.push('Project type is required to select 225 CMR 22 versus 225 CMR 23.');

  let wageStatus: MassachusettsProjectContext['prevailingWageStatus'];
  if (input.publicWorks === null) {
    wageStatus = 'project_setting_unresolved';
    blockers.push('Public versus private project setting is unresolved.');
  } else if (!input.publicWorks) {
    wageStatus = 'not_applicable';
  } else if (!input.prevailingWageSchedule || input.prevailingWageSchedule.classifications < 1) {
    wageStatus = 'required_missing';
    blockers.push('The actual DLS prevailing-wage schedule for this public project is required.');
  } else {
    wageStatus = 'verified_project_schedule';
    notices.push({ classification: 'PLAN_REQUIREMENT', message: `Labor must use DLS schedule ${input.prevailingWageSchedule.projectIdentifier} and its effective dates.` });
  }

  notices.push({ classification: 'AHJ_CONFIRMATION_REQUIRED', message: 'RoughBid identifies estimating risk; the authority having jurisdiction determines code compliance.' });
  const level = input.municipalityAdoption?.level ?? null;
  const energyCode = input.projectType === 'low_rise_residential'
    ? `${MASSACHUSETTS_RULESET.energyResidential}${level ? ` (${level})` : ''}`
    : input.projectType === 'commercial_multifamily_other'
      ? `${MASSACHUSETTS_RULESET.energyCommercial}${level ? ` (${level})` : ''}`
      : null;
  return { rulesetVersion: MASSACHUSETTS_RULESET.version, buildingCode: MASSACHUSETTS_RULESET.buildingCode, energyCode, energyCodeLevel: level, prevailingWageStatus: wageStatus, blockers, notices };
}

export type MassachusettsTaxTreatment = 'taxable_material_purchase' | 'exempt_documented' | 'not_applicable_service' | 'review_required';

export function resolveMassachusettsTaxTreatment(input: {
  componentType: 'material' | 'labor' | 'equipment' | 'subcontract' | 'other';
  realPropertyContract: boolean;
  exemptProject: boolean;
  exemptionCertificateOnFile: boolean;
}): { treatment: MassachusettsTaxTreatment; ratePercent: string; reason: string } {
  if (input.componentType !== 'material') return { treatment: 'not_applicable_service', ratePercent: '0', reason: 'This component is not a taxable material purchase.' };
  if (!input.realPropertyContract) return { treatment: 'review_required', ratePercent: '0', reason: 'Retail/standard-item installation treatment requires project-specific tax review.' };
  if (input.exemptProject && input.exemptionCertificateOnFile) return { treatment: 'exempt_documented', ratePercent: '0', reason: 'A qualifying exemption is documented for this material purchase.' };
  if (input.exemptProject) return { treatment: 'review_required', ratePercent: '0', reason: 'Exempt treatment cannot be applied until the required certificate evidence is on file.' };
  return { treatment: 'taxable_material_purchase', ratePercent: MASSACHUSETTS_RULESET.stateSalesUseTaxPercent, reason: 'Contractor is modeled as consumer of building materials for real-property work.' };
}
