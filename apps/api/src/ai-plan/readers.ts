/**
 * One construction point for the configured plan readers.
 *
 * The HTTP request handler and the durable worker both need the same provider
 * set, and they used to build it separately: the worker knew only about Gemini,
 * so a durable reading — the only place a reading is allowed to take many
 * minutes — could not use OpenAI or Claude even when `AI_PLAN_PROVIDER_ORDER`
 * named them and their own gates passed. Building it twice is what let that drift
 * go unnoticed, so both callers now use this module.
 *
 * A provider whose own gate fails is simply absent: a key alone still never opens
 * a billable route, and an unconfigured name in the order is skipped.
 */
import {
  createGeminiClient,
  GeminiPlanReader,
  geminiSweepOptionsFromEnv,
  type GeminiPlanReadInput,
  type GeminiSweepOptions,
} from './gemini.ts';
import { ClaudePlanReader, HttpClaudeMessagesClient, requireClaudePlanReadingConfig } from './claude.ts';
import {
  OpenAiCompatibleVisionPlanReader,
  configuredProviderOrder,
  requireDeepSeekVisionConfig,
  requireKimiVisionConfig,
  requireOpenAiVisionConfig,
} from './openai-vision.ts';
import { requirePaidPlanReadingConfig } from './readiness.ts';
import type { PlanReadingResult } from './types.ts';

export interface NamedPlanReaderInput {
  name: string;
  read(input: GeminiPlanReadInput): Promise<PlanReadingResult>;
}

export interface ConfiguredPlanReaders {
  /** Configured readers, in `AI_PLAN_PROVIDER_ORDER`; unconfigured names are skipped. */
  ordered: NamedPlanReaderInput[];
  /** Names that were actually built on this server. */
  configured: ReadonlySet<string>;
}

/**
 * Builds every paid reader whose own gate passes.
 *
 * `sweepOverride.budgetMs = 0` means "no deadline", which is only correct on the
 * durable worker: it holds no HTTP request open, so a careful per-sheet reading
 * of a large set must not be cut short by a request deadline it does not have.
 * The override is applied to the OpenAI/vision routes through the environment
 * they read, so no reader can be built with a deadline the caller did not ask for.
 */
export async function buildConfiguredPlanReaders(
  env: Record<string, string | undefined>,
  sweepOverride: Partial<GeminiSweepOptions> = {},
): Promise<ConfiguredPlanReaders> {
  const effectiveEnv: Record<string, string | undefined> = sweepOverride.budgetMs === 0
    ? { ...env, AI_PLAN_SWEEP_BUDGET_MS: '0' }
    : env;
  const configured = new Map<string, NamedPlanReaderInput>();

  try {
    const readingConfig = requirePaidPlanReadingConfig(effectiveEnv);
    const geminiClient = await createGeminiClient(readingConfig.apiKey);
    const gemini = new GeminiPlanReader(geminiClient, [readingConfig.model], {
      ...geminiSweepOptionsFromEnv(effectiveEnv),
      ...sweepOverride,
    });
    configured.set('gemini', { name: 'gemini', read: input => gemini.read(input) });
  } catch { /* Paid Gemini remains disabled unless explicitly configured. */ }

  for (const [name, requireConfig] of [
    ['deepseek', requireDeepSeekVisionConfig],
    ['kimi', requireKimiVisionConfig],
    ['openai', requireOpenAiVisionConfig],
  ] as const) {
    try {
      const vision = new OpenAiCompatibleVisionPlanReader(requireConfig(effectiveEnv));
      configured.set(name, { name, read: input => vision.read(input) });
    } catch { /* Each low-cost route stays closed until its own gate passes. */ }
  }

  try {
    // Claude reads the plan PDF natively and is metered through the same company
    // spend breaker as the other paid readers.
    const claudeConfig = requireClaudePlanReadingConfig(effectiveEnv);
    const claude = new ClaudePlanReader(new HttpClaudeMessagesClient(claudeConfig.apiKey), claudeConfig.model);
    configured.set('claude', { name: 'claude', read: input => claude.read(input) });
  } catch { /* Claude stays closed until its exact model and key are verified. */ }

  const ordered = configuredProviderOrder(effectiveEnv)
    .map(name => configured.get(name))
    .filter((reader): reader is NamedPlanReaderInput => Boolean(reader));

  return { ordered, configured: new Set(configured.keys()) };
}
