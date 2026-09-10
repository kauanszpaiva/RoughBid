import { UsageAccountingError } from '../owner-usage/meter.ts';
import type { GeminiPlanReadInput } from './gemini.ts';
import type { PlanReadingResult } from './types.ts';
import { ProjectApiError } from '../projects/service.ts';
import { classifyProviderFailure, logProviderFailure } from './provider-errors.ts';

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
    let lastFailure:ProjectApiError|null=null;
    for (const { name,read } of this.readers) {
      const started=Date.now();
      try {
        const result = await read(input);
        if (!result.summary.synthetic && result.findings.length) return result;
      } catch(error) {
        if (error instanceof UsageAccountingError) throw error;
        if(error instanceof ProjectApiError)lastFailure=error;
        else {
          lastFailure=classifyProviderFailure(error,{provider:name,model:'',stage:'generate',durationMs:Date.now()-started});
          logProviderFailure(lastFailure as ReturnType<typeof classifyProviderFailure>);
        }
      }
    }
    if(lastFailure)throw lastFailure;
    throw classifyProviderFailure(null,{provider:'other',model:'',stage:'validate',durationMs:0},'provider_empty_output');
  }
}
