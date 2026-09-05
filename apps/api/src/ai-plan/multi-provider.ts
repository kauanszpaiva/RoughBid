import type { GeminiPlanReadInput } from './gemini.ts';
import type { PlanReadingResult } from './types.ts';

export interface NamedPlanReader {
  name: string;
  read(input: GeminiPlanReadInput): Promise<PlanReadingResult>;
}

/** Tries configured providers; all failures produce an error, never invented quantities. */
export class MultiProviderPlanReader {
  private readonly readers: readonly NamedPlanReader[];

  constructor(readers: readonly NamedPlanReader[]) {
    if (!readers.length) throw new Error('MultiProviderPlanReader needs at least one reader');
    this.readers = readers;
  }

  async read(input: GeminiPlanReadInput): Promise<PlanReadingResult> {
    for (const { read } of this.readers) {
      try {
        const result = await read(input);
        if (!result.summary.synthetic && result.findings.length) return result;
      } catch { /* Try the next explicitly configured provider. */ }
    }
    throw new Error('AI could not read this plan. No quantities were generated. Please retry or contact support.');
  }
}
