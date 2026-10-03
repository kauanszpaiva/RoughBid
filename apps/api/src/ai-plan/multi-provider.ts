import { UsageAccountingError } from '../owner-usage/meter.ts';
import type { GeminiPlanReadInput } from './gemini.ts';
import type { PlanReadingResult } from './types.ts';
import { ProjectApiError } from '../projects/service.ts';
import { classifyProviderFailure, logProviderFailure } from './provider-errors.ts';

export interface NamedPlanReader {
  name: string;
  read(input: GeminiPlanReadInput): Promise<PlanReadingResult>;
}

/** Uses the selected first provider. Failure never silently switches vendors/cost. */
export class MultiProviderPlanReader {
  private readonly readers: readonly NamedPlanReader[];

  constructor(readers: readonly NamedPlanReader[]) {
    if (!readers.length) throw new Error('MultiProviderPlanReader needs at least one reader');
    this.readers = readers;
  }

  async read(input: GeminiPlanReadInput): Promise<PlanReadingResult> {
    const { name, read } = this.readers[0]!;
      const started=Date.now();
      try {
        const result = await read(input);
        if (!result.summary.synthetic && result.findings.length) return result;
      } catch(error) {
        if (error instanceof UsageAccountingError) throw error;
        if(error instanceof ProjectApiError) throw error;
        const failure=classifyProviderFailure(error,{provider:name,model:'',stage:'generate',durationMs:Date.now()-started});
        logProviderFailure(failure);
        throw failure;
      }
    throw classifyProviderFailure(null,{provider:name,model:'',stage:'validate',durationMs:Date.now()-started},'provider_empty_output');
  }
}
