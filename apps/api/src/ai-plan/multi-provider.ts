import { UsageAccountingError } from '../owner-usage/meter.ts';
import type { GeminiPlanReadInput } from './gemini.ts';
import { TEXT_ONLY_READING_REFUSED, type PlanReaderVisualCapability, type PlanReadingResult } from './types.ts';
import { ProjectApiError } from '../projects/service.ts';
import { classifyProviderFailure, logProviderFailure } from './provider-errors.ts';

export interface NamedPlanReader {
  name: string;
  /** Declared ability to inspect the drawing itself. Absent means unknown. */
  visualCapability?: PlanReaderVisualCapability;
  read(input: GeminiPlanReadInput): Promise<PlanReadingResult>;
}

/**
 * Tries configured providers; all failures produce an error, never invented
 * quantities.
 *
 * A reader that only extracts PDF text is excluded from the chain: a plan
 * reading must inspect the drawing itself (line work, symbols, icons, hatch,
 * graphic scale). Set AI_PLAN_ALLOW_TEXT_ONLY_READING=true only for an
 * explicitly disclosed text-only benchmark.
 */
export class MultiProviderPlanReader {
  private readonly readers: readonly NamedPlanReader[];
  private served: PlanReaderVisualCapability = 'unknown';

  constructor(readers: readonly NamedPlanReader[], env: Record<string, string | undefined> = process.env) {
    if (!readers.length) throw new Error('MultiProviderPlanReader needs at least one reader');
    const allowTextOnly = env.AI_PLAN_ALLOW_TEXT_ONLY_READING === 'true';
    const usable = allowTextOnly ? [...readers] : readers.filter(reader => reader.visualCapability !== 'text_only');
    if (!usable.length) throw new Error(TEXT_ONLY_READING_REFUSED);
    this.readers = usable;
  }

  /** The strongest visual capability this chain can offer. Never `text_only`. */
  get visualCapability(): PlanReaderVisualCapability {
    const declared = this.readers.map(reader => reader.visualCapability ?? 'unknown');
    if (declared.includes('pdf_native')) return 'pdf_native';
    if (declared.includes('page_images')) return 'page_images';
    return 'unknown';
  }

  /** The capability of the reader that actually produced the last result. */
  get servedCapability(): PlanReaderVisualCapability { return this.served; }

  async read(input: GeminiPlanReadInput): Promise<PlanReadingResult> {
    let lastFailure:ProjectApiError|null=null;
    for (const { name,visualCapability,read } of this.readers) {
      const started=Date.now();
      try {
        const result = await read(input);
        if (!result.summary.synthetic && result.findings.length) {
          this.served = visualCapability ?? 'unknown';
          return result;
        }
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
