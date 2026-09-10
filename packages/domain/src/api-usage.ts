/** Public, credential-free usage contract. Unknown telemetry must never mean $0. */
export const USAGE_OWNER_ID = '86fb7719-0d1f-44fc-b68c-869b56ba74bd';
export const USAGE_OWNER_EMAIL = 'kauan@kspdominion.group';
export type UsageRow = Record<string, any>;
const number = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const token = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const rounded = (n: number) => Math.round(n * 1e6) / 1e6;
export function measureGeminiUsage(usage: unknown, model: string, at = new Date()) {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as UsageRow;
  const input = token(u.promptTokenCount), candidates = token(u.candidatesTokenCount);
  const thoughts = u.thoughtsTokenCount === undefined ? 0 : token(u.thoughtsTokenCount);
  const cached = u.cachedContentTokenCount === undefined ? 0 : token(u.cachedContentTokenCount);
  if (input === null || candidates === null || thoughts === null || cached === null || cached > input || !Number.isSafeInteger(candidates + thoughts)) return null;
  // Standard Developer API tariff verified from Google's official pricing page.
  // Fail closed for estimates after review expiry. Cache storage/tools are not used.
  const tariffKnown = model === 'gemini-3.8-flash' && at >= new Date('2026-09-02T00:00:00Z') && at < new Date('2026-12-01T00:00:00Z');
  return { inputTokens: input, outputTokens: candidates + thoughts, thinkingTokens: thoughts,
    estimatedCostUsd: tariffKnown ? rounded(((input - cached) * 0.75 + cached * 0.075 + (candidates + thoughts) * 3.75) / 1e6) : null };
}
export function decodeUsageOperation(operation: unknown) {
  const match = typeof operation === 'string' ? /^rb1:([^:]+):(generate|count_tokens):(pending|measured|tokens_only|verified_free|counted|unknown|failed_unknown)$/.exec(operation) : null;
  return match ? { jobId: match[1]!, kind: match[2]!, state: match[3]! } : null;
}
export interface UsageDataset { events: UsageRow[]; jobs: UsageRow[]; profiles: UsageRow[]; enrollments: UsageRow[]; invitations: UsageRow[]; cohorts: UsageRow[]; projects: UsageRow[] }
export interface UsageTotals {
  events: number; generationCalls: number; tokenCountCalls: number; jobs: number; failedJobs: number; unmeteredJobs: number;
  inputTokens: number | null; outputTokens: number | null; estimatedCostUsd: number | null; actualCostUsd: number | null;
  measuredEvents: number; actualCostEvents: number; unknownCostEvents: number; pendingEvents: number;
}
function totals(events: UsageRow[], jobs: UsageRow[]): UsageTotals {
  let input = 0, output = 0, estimate = 0, actual = 0, measured = 0, estimates = 0, actuals = 0, unknown = 0, pending = 0, generations = 0, counts = 0;
  const linkedJobs = new Set<string>();
  for (const e of events) {
    const op = decodeUsageOperation(e.operation);
    if (op?.kind === 'count_tokens') { counts++; continue; }
    if (op?.kind === 'generate') { generations++; linkedJobs.add(op.jobId); }
    const hasTokens = op && ['measured', 'tokens_only', 'verified_free'].includes(op.state) && number(e.input_tokens) !== null && number(e.output_tokens) !== null;
    if (hasTokens) { input += number(e.input_tokens)!; output += number(e.output_tokens)!; measured++; }
    if (op?.state === 'pending') pending++;
    const est = op && ['measured', 'verified_free'].includes(op.state) ? number(e.estimated_cost_usd) : null;
    const real = number(e.actual_cost_usd);
    if (est !== null) { estimate += est; estimates++; }
    if (real !== null) { actual += real; actuals++; }
    if (est === null && real === null) unknown++;
  }
  return { events: events.length, generationCalls: generations, tokenCountCalls: counts, jobs: jobs.length,
    failedJobs: jobs.filter(j => j.status === 'failed').length, unmeteredJobs: jobs.filter(j => !linkedJobs.has(j.id)).length,
    inputTokens: measured ? input : null, outputTokens: measured ? output : null,
    estimatedCostUsd: estimates ? rounded(estimate) : null, actualCostUsd: actuals ? rounded(actual) : null,
    measuredEvents: measured, actualCostEvents: actuals, unknownCostEvents: unknown, pendingEvents: pending };
}
export function buildUsageReport(data: UsageDataset, now = new Date()) {
  const ids = new Set<string>();
  for (const row of [...data.events, ...data.enrollments]) if (row.user_id) ids.add(row.user_id);
  for (const j of data.jobs) if (j.requested_by) ids.add(j.requested_by);
  for (const p of data.profiles) if (p.id) ids.add(p.id);
  const users = [...ids].map(userId => {
    const profile = data.profiles.find(p => p.id === userId);
    const enrollment = data.enrollments.find(e => e.user_id === userId);
    const cohort = enrollment ? data.cohorts.find(c => c.id === enrollment.cohort_id) : undefined;
    const invite = enrollment ? data.invitations.find(i => i.id === enrollment.invitation_id) : undefined;
    const events = data.events.filter(e => e.user_id === userId);
    const jobs = data.jobs.filter(j => j.requested_by === userId);
    const weekly = data.projects.filter(p => p.user_id === userId && Date.parse(p.created_at) > +now - 7 * 864e5).length;
    return { userId, name: String(profile?.display_name || invite?.email || userId),
      email: userId === USAGE_OWNER_ID ? USAGE_OWNER_EMAIL : typeof invite?.email === 'string' ? invite.email : null,
      ...totals(events, jobs), projectsUsed7d: weekly,
      projectsLimit7d: enrollment ? enrollment.preset === 'pilot60' ? 2 : 1 : null,
      reservedCents: enrollment ? number(enrollment.reserved_cents) : null,
      expiresAt: typeof enrollment?.expires_at === 'string' ? enrollment.expires_at : null,
      accessStatus: !enrollment ? 'not_enrolled' : enrollment.revoked_at || cohort?.enabled === false ? 'revoked' : Date.parse(enrollment.expires_at) <= +now ? 'expired' : Date.parse(enrollment.starts_at) > +now ? 'pending' : 'active' };
  }).sort((a, b) => (b.estimatedCostUsd ?? 0) - (a.estimatedCostUsd ?? 0) || a.name.localeCompare(b.name));
  const cohorts = data.cohorts.map(c => {
    const capacity = number(c.capacity) ?? 0, budget = number(c.budget_cents) ?? 0, reserved = number(c.reserved_cents) ?? 0;
    // Up to 18 projects in 60 days with 2 projects in each rolling seven-day window.
    const maximum = capacity * 18 * 25;
    return { code: String(c.code), capacity, enabled: c.enabled === true, budgetCents: budget, reservedCents: reserved,
      remainingCents: Math.max(0, budget - reserved), maximumReservationCents: maximum, reservationShortfallCents: Math.max(0, maximum - budget) };
  });
  const providerKeys = new Set(data.events.map(e => `${e.provider}\n${e.model}`));
  const providers = [...providerKeys].map(key => {
    const [provider, model] = key.split('\n');
    return { provider: provider!, model: model!, ...totals(data.events.filter(e => e.provider === provider && e.model === model), []) };
  });
  return { generatedAt: now.toISOString(), totals: totals(data.events, data.jobs), users, cohorts, providers,
    coverage: { providerBalanceConnected: false as const, historicalSpendReconciled: false as const,
      scope: 'RoughBid instrumented Gemini calls only. Infrastructure, other applications, and provider invoice adjustments are excluded.' },
    pilotPolicy: { days: 60, projectsPerRollingWeek: 2, maxProjectsPer60Days: 18, maxPdfMiB: 10, maxPages: 10,
      aiAttemptsPerProject: 1, reservationCentsPerAttempt: 25, userReservationCapCents: 500 } };
}
export type OwnerUsageReport = ReturnType<typeof buildUsageReport>;
