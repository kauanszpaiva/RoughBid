import { ProjectApiError } from '../projects/service.ts';
import type { PlanProjectAddressEvidence } from '../ai-plan/types.ts';

export type PricingAddressStatus = 'missing' | 'clear' | 'needs_resolution' | 'resolved';
export type PricingAddressSource = 'plan' | 'project' | 'confirmed_override';

export type PricingAddressValue = { formatted: string };

export type PricingAddressDecision = {
  status: Exclude<PricingAddressStatus, 'resolved'>;
  source: Extract<PricingAddressSource, 'plan' | 'project'> | null;
  pricingAddress: PricingAddressValue | null;
  normalizedPlanAddress: string | null;
  normalizedProjectAddress: string | null;
};

const STREET_SUFFIXES: Readonly<Record<string, string>> = {
  STREET: 'ST',
  ROAD: 'RD',
  AVENUE: 'AVE',
  BOULEVARD: 'BLVD',
  DRIVE: 'DR',
  LANE: 'LN',
  COURT: 'CT',
  PLACE: 'PL',
  TERRACE: 'TER',
  HIGHWAY: 'HWY',
  PARKWAY: 'PKWY',
  CIRCLE: 'CIR',
};

/**
 * Deterministic syntax normalization only. This deliberately does not geocode,
 * fuzzy-match, or ask a model whether two addresses are "probably" the same.
 * A pricing authorization boundary must fail closed when equality cannot be
 * proven from stable text normalization.
 */
export function normalizeAddressText(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[.,;:()]/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(token => STREET_SUFFIXES[token] ?? token)
    .join(' ');
}

function planAddressText(plan: PlanProjectAddressEvidence | null): string | null {
  if (!plan) return null;
  const parts = [
    plan.street_address,
    plan.building_lot_unit,
    plan.city,
    plan.state,
    plan.postal_code,
  ].map(value => value?.trim()).filter((value): value is string => Boolean(value));
  return parts.length ? parts.join(', ') : null;
}

function cleanProjectAddress(projectAddress: string | null): string | null {
  const value = projectAddress?.trim();
  return value ? value : null;
}

/**
 * Chooses a pricing address only when the available evidence is unambiguous.
 * When both sources exist they must normalize to exact equality; otherwise the
 * caller receives needs_resolution with no usable pricing address.
 */
export function comparePricingAddresses(
  plan: PlanProjectAddressEvidence | null,
  projectAddress: string | null,
): PricingAddressDecision {
  const planText = planAddressText(plan);
  const projectText = cleanProjectAddress(projectAddress);
  const normalizedPlanAddress = planText ? normalizeAddressText(planText) : null;
  const normalizedProjectAddress = projectText ? normalizeAddressText(projectText) : null;

  if (!normalizedPlanAddress && !normalizedProjectAddress) {
    return { status: 'missing', source: null, pricingAddress: null, normalizedPlanAddress, normalizedProjectAddress };
  }
  if (normalizedPlanAddress && !normalizedProjectAddress) {
    return {
      status: 'clear', source: 'plan', pricingAddress: { formatted: planText! },
      normalizedPlanAddress, normalizedProjectAddress,
    };
  }
  if (!normalizedPlanAddress && normalizedProjectAddress) {
    return {
      status: 'clear', source: 'project', pricingAddress: { formatted: projectText! },
      normalizedPlanAddress, normalizedProjectAddress,
    };
  }
  if (normalizedPlanAddress === normalizedProjectAddress) {
    // The persisted project address remains the operational pricing input; the
    // plan evidence corroborates it and remains separately auditable.
    return {
      status: 'clear', source: 'project', pricingAddress: { formatted: projectText! },
      normalizedPlanAddress, normalizedProjectAddress,
    };
  }
  return {
    status: 'needs_resolution', source: null, pricingAddress: null,
    normalizedPlanAddress, normalizedProjectAddress,
  };
}

function dbValue<T>(result: { data: T; error: { message?: string } | null }, action: string): T {
  if (result.error) throw new ProjectApiError(500, result.error.message ?? `Could not ${action}.`);
  return result.data;
}

function normalizedPlanIdentity(plan: PlanProjectAddressEvidence | null): string | null {
  const text = planAddressText(plan);
  return text ? normalizeAddressText(text) : null;
}

/**
 * Persists only sanitized plan evidence through the trusted server writer.
 * A prior human resolution survives a reread when the underlying plan and
 * project addresses are materially unchanged. New evidence that changes either
 * address reopens deterministic resolution instead of silently preserving a
 * stale choice.
 */
export async function persistPlanPricingContext(input: {
  writer: { from(table: string): any };
  workspaceId: string;
  projectId: string;
  projectAddressText: string | null;
  planAddress: PlanProjectAddressEvidence | null;
  fileId: string;
  jobId: string;
}): Promise<void> {
  const existing = dbValue<any>(
    await input.writer.from('project_pricing_contexts').select('*')
      .eq('workspace_id', input.workspaceId).eq('project_id', input.projectId).maybeSingle(),
    'read pricing context',
  );

  const existingPlan = (existing?.plan_address ?? null) as PlanProjectAddressEvidence | null;
  const effectivePlan = input.planAddress ?? existingPlan;
  const projectAddressText = cleanProjectAddress(input.projectAddressText);
  const decision = comparePricingAddresses(effectivePlan, projectAddressText);

  const existingPlanIdentity = normalizedPlanIdentity(existingPlan);
  const nextPlanIdentity = normalizedPlanIdentity(effectivePlan);
  const existingProjectIdentity = cleanProjectAddress(existing?.project_address_text ?? null);
  const normalizedExistingProject = existingProjectIdentity ? normalizeAddressText(existingProjectIdentity) : null;
  const normalizedNextProject = projectAddressText ? normalizeAddressText(projectAddressText) : null;
  const evidenceUnchanged = existingPlanIdentity === nextPlanIdentity
    && normalizedExistingProject === normalizedNextProject;
  const preserveHumanResolution = existing?.address_status === 'resolved'
    && existing?.address_source === 'confirmed_override'
    && existing?.pricing_address
    && existing?.resolved_by
    && existing?.resolved_at
    && evidenceUnchanged;

  const hasFreshPlanEvidence = Boolean(input.planAddress);
  const row = {
    project_id: input.projectId,
    workspace_id: input.workspaceId,
    project_address_text: projectAddressText,
    plan_address: effectivePlan,
    pricing_address: preserveHumanResolution ? existing.pricing_address : decision.pricingAddress,
    address_source: preserveHumanResolution ? 'confirmed_override' : decision.source,
    address_status: preserveHumanResolution ? 'resolved' : decision.status,
    plan_file_id: hasFreshPlanEvidence ? input.fileId : (existing?.plan_file_id ?? input.fileId),
    plan_job_id: hasFreshPlanEvidence ? input.jobId : (existing?.plan_job_id ?? input.jobId),
    resolved_by: preserveHumanResolution ? existing.resolved_by : null,
    resolved_at: preserveHumanResolution ? existing.resolved_at : null,
    updated_at: new Date().toISOString(),
  };

  dbValue(
    await input.writer.from('project_pricing_contexts').upsert(row, { onConflict: 'project_id' }),
    'save pricing context',
  );
}

/** Every future pricing path calls this before any market lookup or rate application. */
export function assertPricingAddressResolved(context: {
  address_status: PricingAddressStatus;
  pricing_address?: unknown;
}): void {
  if (context.address_status === 'needs_resolution') {
    throw new ProjectApiError(409, 'Resolve the project and plan address conflict before pricing.');
  }
  if (context.address_status === 'missing') {
    throw new ProjectApiError(409, 'A project pricing address is required before pricing.');
  }
  if (!context.pricing_address || typeof context.pricing_address !== 'object' || Array.isArray(context.pricing_address)) {
    throw new ProjectApiError(409, 'A usable project pricing address is required before pricing.');
  }
}
