import type { GeminiPlanReadInput } from './gemini.ts';
import type { PlanReadingResult } from './types.ts';

export interface NamedPlanReader {
  name: string;
  read(input: GeminiPlanReadInput): Promise<PlanReadingResult>;
}

/**
 * Tries each configured reader in order, stopping at the first real (non-
 * synthetic) reading. Built to put the cheaper primary provider first and a
 * fallback strictly last: Gemini primary, Claude (reads PDFs natively too)
 * only as a fallback of last resort — so the fallback is never touched
 * unless the primary path genuinely failed or isn't configured. If every
 * configured reader falls back to synthetic, returns the last one tried
 * (the most "final" attempt) rather than throwing.
 */
export class MultiProviderPlanReader {
  private readonly readers: readonly NamedPlanReader[];

  constructor(readers: readonly NamedPlanReader[]) {
    if (!readers.length) throw new Error('MultiProviderPlanReader needs at least one reader');
    this.readers = readers;
  }

  async read(input: GeminiPlanReadInput): Promise<PlanReadingResult> {
    let lastResult: PlanReadingResult | null = null;
    for (const { read } of this.readers) {
      const result = await read(input);
      if (!result.summary.synthetic) return result;
      lastResult = result;
    }
    return lastResult!;
  }
}
