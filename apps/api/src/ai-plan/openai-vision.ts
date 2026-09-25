import { ProjectApiError } from '../projects/service.ts';
import { meterOpenAiCompatibleCall, type MeteredVisionProvider, UsageAccountingError } from '../owner-usage/meter.ts';
import { sanitizePlanReadingResult, type PlanReadingFinding, type PlanProjectAddressEvidence, type PlanReadingResult } from './types.ts';
import { MAX_INLINE_PLAN_BYTES, type GeminiPlanReadInput, type PlanPageImage, systemPrompt } from './gemini.ts';
import { describePlanEvidenceDigest, describePlanEvidenceWindow } from './sheet-text.ts';
import { boundedBatchPages, boundedMaxBatches, integerFromEnv, loadPlanDocument, MAX_MAX_BATCHES, planPageWindows, slicePlanDocument, sweepBudgetFromEnv, unreadPages, type PageWindow } from './plan-batches.ts';
import {
  cropSheetRegion,
  describeRegion,
  describeRegionEvidence,
  mapNormalizedBoxFromRegion,
  planPageRegions,
  readSheetFrame,
  tileOptionsFromEnv,
  type PageRegion,
  type PageSize,
  type SheetFrame,
} from './page-tiles.ts';
import { AiProviderError, classifyProviderFailure, logProviderFailure } from './provider-errors.ts';
import { isConfiguredValue } from './readiness.ts';

export interface OpenAiVisionProviderConfig {
  provider: MeteredVisionProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxImages: number;
  /** Pages per request when a whole set must be swept. 0 disables sweeping. */
  batchPages: number;
  /** Hard cap on sweep requests, so one plan set cannot fan out unbounded. */
  maxBatches: number;
  /** Ceiling on findings kept from a whole-set sweep. */
  maxTotalFindings: number;
  /** Per-request ceiling. A multi-page PDF needs longer than a single image. */
  timeoutMs: number;
  /**
   * Output ceiling for one request. A window that exceeds it comes back with
   * finish_reason "length" and is discarded whole, so its sheets produce no
   * evidence at all. 8000 was measured as too small for a dense window on the
   * Gemini route; the same ceiling applies here.
   */
  maxOutputTokens: number;
  /** Wall-clock deadline for the whole sweep. 0 means no deadline (durable worker only). */
  budgetMs: number;
  /**
   * Regions per sheet side, so 2 cuts a sheet into 2x2 and 3 into 3x3. 1 = off.
   * A whole 1/8"=1'-0" plan cannot resolve its door swings in one provider image;
   * a region request is the same sheet, cropped, so it is displayed zoomed.
   */
  tileGrid: number;
  /** Extra width/height shared between neighbouring regions, so a seam never cuts a door. */
  tileOverlapRatio: number;
  /** A sheet whose own measured drawing is thinner than this is read whole, not cut. */
  tileMinWallStrokes: number;
  /** Cap on how many sheets a tiled read will cut, so cost stays bounded. */
  tileMaxPages: number;
}

const DEFAULT_MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function safeHttpsBaseUrl(value: string, allowedHosts: readonly string[]): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname)) {
    throw new ProjectApiError(503, 'AI provider endpoint is not an approved HTTPS host.');
  }
  return url.toString().replace(/\/$/, '');
}

function maxImagesFromEnv(env: Record<string, string | undefined>): number {
  const parsed = Number(env.LOW_COST_VISION_MAX_PAGES);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 16 ? parsed : DEFAULT_MAX_IMAGES;
}

export function requireDeepSeekVisionConfig(env: Record<string, string | undefined>): OpenAiVisionProviderConfig {
  if (env.DEEPSEEK_PLAN_READING_ENABLED !== 'true') throw new ProjectApiError(503, 'DeepSeek plan reading is disabled.');
  if (env.DEEPSEEK_PRIVATE_PLAN_DATA_APPROVED !== 'true') {
    throw new ProjectApiError(503, 'DeepSeek private-plan processing is not approved.');
  }
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  const model = env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash';
  if (!isConfiguredValue(apiKey) || !/^deepseek-[a-z0-9][a-z0-9._-]+$/i.test(model)) {
    throw new ProjectApiError(503, 'DeepSeek plan reading is not configured.');
  }
  return {
    provider: 'deepseek',
    apiKey,
    baseUrl: safeHttpsBaseUrl(env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com', ['api.deepseek.com']),
    model,
    maxImages: maxImagesFromEnv(env),
    batchPages: 0,
    maxBatches: 0,
    maxTotalFindings: 200,
    timeoutMs: 60_000,
    maxOutputTokens: 8_000,
    budgetMs: 0,
    tileGrid: 1,
    tileOverlapRatio: 0,
    tileMinWallStrokes: 0,
    tileMaxPages: 0,
  };
}

export function requireKimiVisionConfig(env: Record<string, string | undefined>): OpenAiVisionProviderConfig {
  if (env.KIMI_PLAN_READING_ENABLED !== 'true') throw new ProjectApiError(503, 'Kimi plan reading is disabled.');
  const apiKey = env.KIMI_API_KEY?.trim();
  // K2.6 is the default cost-optimized vision fallback. K3 can still be selected explicitly.
  const model = env.KIMI_MODEL?.trim() || 'kimi-k2.6';
  const baseUrl = env.KIMI_BASE_URL?.trim();
  if (!isConfiguredValue(apiKey) || !isConfiguredValue(baseUrl) || !/^kimi-[a-z0-9][a-z0-9._-]+$/i.test(model)) {
    throw new ProjectApiError(503, 'Kimi plan reading is not configured.');
  }
  return {
    provider: 'kimi',
    apiKey,
    baseUrl: safeHttpsBaseUrl(baseUrl, ['api.moonshot.ai', 'api.moonshot.cn']),
    model,
    maxImages: maxImagesFromEnv(env),
    batchPages: 0,
    maxBatches: 0,
    maxTotalFindings: 200,
    timeoutMs: 60_000,
    maxOutputTokens: 8_000,
    budgetMs: 0,
    tileGrid: 1,
    tileOverlapRatio: 0,
    tileMinWallStrokes: 0,
    tileMaxPages: 0,
  };
}

export function requireOpenAiVisionConfig(env: Record<string, string | undefined>): OpenAiVisionProviderConfig {
  if (env.OPENAI_PLAN_READING_ENABLED !== 'true') throw new ProjectApiError(503, 'OpenAI plan reading is disabled.');
  const apiKey = env.OPENAI_API_KEY?.trim();
  // Measured on a real 17-page set: gpt-5.4 with one sheet per request returned 254
  // rooms - including SHWR, TUB, TR, STRG, ELEV and STAIR, which carry no printed
  // area - plus drawn door swings as symbol findings, in 8.2 min and 154k tokens.
  // An unavailable name is still a hard failure that falls through to the next
  // configured reader rather than a silent downgrade.
  const model = env.OPENAI_MODEL?.trim() || 'gpt-5.4';
  if (!isConfiguredValue(apiKey) || !/^(?:gpt|o[0-9])[a-z0-9._-]*$/i.test(model)) {
    throw new ProjectApiError(503, 'OpenAI plan reading is not configured.');
  }
  const tiles = tileOptionsFromEnv(env);
  return {
    provider: 'openai',
    apiKey,
    baseUrl: safeHttpsBaseUrl(env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1', ['api.openai.com']),
    model,
    maxImages: maxImagesFromEnv(env),
    // Four sheets per request, not eight: a window has to be small enough that the
    // model enumerates every drawn space and door on each sheet instead of
    // skimming the window. `AI_PLAN_OPENAI_BATCH_PAGES=1` reads one sheet per
    // request, which is the slowest and most careful setting.
    // A region read is per sheet by construction: a window of four sheets cut nine
    // ways would be thirty-six requests that each see a quarter sheet.
    batchPages: tiles.grid > 1 ? 1 : env.AI_PLAN_OPENAI_SWEEP === 'false' ? 0 : boundedBatchPages(integerFromEnv(env.AI_PLAN_OPENAI_BATCH_PAGES, 4, 50)),
    maxBatches: boundedMaxBatches(integerFromEnv(env.AI_PLAN_OPENAI_MAX_BATCHES, tiles.grid > 1 ? MAX_MAX_BATCHES : 25, MAX_MAX_BATCHES)),
    // A real 17-page set reported 640 findings across its windows, so a cap of 400
    // discarded 240 that had already been read and paid for. The cap still bounds
    // storage; it must not be the thing that decides how much of a plan survived.
    maxTotalFindings: integerFromEnv(env.AI_PLAN_MAX_TOTAL_FINDINGS, 5_000, 10_000),
    // A real 4-page request took 12-20 s and one cheap model exceeded 60 s, so the
    // old hard 60 s abort turned a slow reading into a failed one. Fifteen minutes
    // is the ceiling: a single dense sheet read carefully is allowed to be slow,
    // and the sweep deadline (not this) is what protects an HTTP request.
    timeoutMs: integerFromEnv(env.AI_PLAN_OPENAI_TIMEOUT_MS, 120_000, 900_000),
    // Same reason the Gemini route uses 16000: at 8000 a dense window came back
    // with finish_reason "length" and every sheet in it produced no evidence.
    maxOutputTokens: integerFromEnv(env.AI_PLAN_OPENAI_MAX_OUTPUT_TOKENS, 16_000, 64_000),
    budgetMs: sweepBudgetFromEnv(env),
    tileGrid: tiles.grid,
    tileOverlapRatio: tiles.overlapRatio,
    tileMinWallStrokes: tiles.minWallStrokes,
    tileMaxPages: tiles.maxPages,
  };
}

export function configuredProviderOrder(env: Record<string, string | undefined>): Array<'claude' | 'deepseek' | 'gemini' | 'kimi' | 'openai'> {
  const allowed = new Set(['claude', 'deepseek', 'gemini', 'kimi', 'openai']);
  // OpenAI first: the owner-selected reader for the drawing itself. It reads the
  // plan PDF natively, so the local geometry pass and the printed-text transcript
  // are reinforcement rather than the only evidence, and it is the route whose
  // window/patience knobs are documented above. An unconfigured or disabled name
  // is skipped, so this default changes nothing on a deployment whose OpenAI gate
  // is closed: the next configured reader is tried, and a provider failure still
  // falls through in order.
  const raw = (env.AI_PLAN_PROVIDER_ORDER || 'openai,gemini,claude,kimi,deepseek')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(raw.filter(value => allowed.has(value)))] as Array<'claude' | 'deepseek' | 'gemini' | 'kimi' | 'openai'>;
  for (const provider of ['gemini', 'claude', 'openai', 'kimi', 'deepseek'] as const) if (!unique.includes(provider)) unique.push(provider);
  return unique;
}

function userPrompt(
  input: GeminiPlanReadInput,
  window?: PageWindow,
  region?: { region: PageRegion; page: PageSize },
): string {
  const localPages = window ? window.to - window.from + 1 : 1;
  // A region request is the same sheet, cropped, so the provider displays it
  // zoomed. It is the one request where door-by-door enumeration is achievable,
  // so it asks for exactly that instead of a general read.
  const source = region && window
    ? `This request contains ONE REGION of physical PDF page ${window.from}: ${describeRegion(region.region, region.page)}.
It is a crop of that sheet, so it is displayed at a much higher effective resolution than the whole sheet would be. Use that: enumerate what this region actually draws, at the level of detail a zoomed view allows.
- Every door leaf and its swing arc, every cased opening, passage, window and storefront is its own "symbol" finding, including ones with no printed tag. A doorway is a wall that stops and starts again, with the leaf and its swing.
- Every enclosed space drawn inside this region is its own "room" finding, including a closet, toilet, shaft, vestibule or corridor with no printed name.
Report page_number 1 for every finding in this request. Report geometry.bbox normalized 0..1 measured from the TOP-LEFT OF THIS REGION exactly as it is displayed; the server restores sheet coordinates. Never cite or describe a page other than this region's own sheet, and do not generalize about the rest of the set from one region.`
    : window
      ? `This request contains physical PDF pages ${window.from}-${window.to} of a larger set, in order: its first page is page 1 of this request. Report page_number 1-${localPages} for every finding in this request and cite only the pages attached here; the server restores the original physical numbering. Nothing outside this window is attached, so never cite or describe a page you were not given.`
      : input.pageImages?.length
        ? 'The images are ordered and individually labeled with their physical PDF page numbers.'
        : 'The attached document is the complete construction plan; report the physical page number of every finding.';
  return `Read this construction drawing set for takeoff preparation.
Return JSON only. Every quantity must cite a visible physical page and verbatim source excerpt.
Do not estimate prices or infer hidden dimensions. If the drawing is ambiguous, return a risk/question instead.
Locate rooms, walls, outlines and symbols from what is actually drawn on the sheet, not from typical layouts.
Project scope: ${input.scope || 'not supplied'}.
Requested trades: ${input.requestedTrades.join(', ') || 'all visible trades'}.
${source}`;
}

function findingBox(finding: PlanReadingFinding): [number,number,number,number] | null {
  const raw=(finding.geometry as {bbox?:unknown}|undefined)?.bbox;
  if(!Array.isArray(raw)||raw.length!==4||raw.some(value=>typeof value!=='number'||!Number.isFinite(value))) return null;
  const [x,y,w,h]=raw as [number,number,number,number];
  return w>0&&h>0?[x,y,w,h]:null;
}

function boxIoU(a:[number,number,number,number],b:[number,number,number,number]):number{
  const left=Math.max(a[0],b[0]), top=Math.max(a[1],b[1]);
  const right=Math.min(a[0]+a[2],b[0]+b[2]), bottom=Math.min(a[1]+a[3],b[1]+b[3]);
  if(right<=left||bottom<=top) return 0;
  const intersection=(right-left)*(bottom-top);
  const union=a[2]*a[3]+b[2]*b[3]-intersection;
  return union>0?intersection/union:0;
}

function normalizedFindingText(value:string|null|undefined):string{
  return (value||'').toLowerCase().replace(/\s+/g,' ').trim();
}

/**
 * Overlapping regions deliberately see the same seam twice. Collapse only
 * high-confidence spatial duplicates after both crop boxes have been restored
 * to physical-sheet coordinates. Findings without trustworthy boxes remain
 * separate rather than risking an undercount.
 */
export function dedupeOverlappingFindings(findings:readonly PlanReadingFinding[]):PlanReadingFinding[]{
  const output:PlanReadingFinding[]=[];
  for(const candidate of findings){
    const box=findingBox(candidate);
    const duplicateIndex=output.findIndex(existing=>{
      if(existing.page_number!==candidate.page_number||existing.finding_type!==candidate.finding_type) return false;
      const existingBox=findingBox(existing);
      if(box&&existingBox&&boxIoU(box,existingBox)>=0.72) return true;
      return !box&&!existingBox
        && normalizedFindingText(existing.label)===normalizedFindingText(candidate.label)
        && Boolean(existing.source_excerpt)
        && existing.source_excerpt===candidate.source_excerpt;
    });
    if(duplicateIndex<0){output.push(candidate);continue;}
    const existing=output[duplicateIndex]!;
    const candidateScore=candidate.confidence+(box?0.05:0)+(candidate.source_excerpt?0.02:0);
    const existingScore=existing.confidence+(findingBox(existing)?0.05:0)+(existing.source_excerpt?0.02:0);
    if(candidateScore>existingScore) output[duplicateIndex]=candidate;
  }
  return output;
}

/** A sweep never invents coverage: a failed batch is named by its classified reason only. */
function sweepFailureReason(error: unknown): string {
  if (error instanceof AiProviderError) return error.diagnostic.code;
  if (error instanceof ProjectApiError) return `status ${error.status}`;
  return 'the provider call failed';
}

type ChatCompletionResponse = {
  id?: string;
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export class OpenAiCompatibleVisionPlanReader {
  private readonly config: OpenAiVisionProviderConfig;
  private readonly fetcher: typeof fetch;

  constructor(config: OpenAiVisionProviderConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  assertReady(): void {
    if (!this.config.apiKey || !this.config.model || !this.config.baseUrl) throw new ProjectApiError(503, 'AI vision provider is not configured.');
  }

  async read(input: GeminiPlanReadInput): Promise<PlanReadingResult> {
    this.assertReady();
    const images = (input.pageImages || []).slice(0, this.config.maxImages);
    // OpenAI reads construction PDFs natively, so it needs no renderer; the
    // image-native low-cost providers still fail closed without page images.
    const attachesPdf = this.config.provider === 'openai';
    if (!images.length && !attachesPdf) {
      throw new ProjectApiError(503, `${this.config.provider} requires server-rendered plan page images. No provider request was sent.`);
    }
    const pageCount = Number.isSafeInteger(input.pageCount) && (input.pageCount as number) > 0 ? input.pageCount as number : null;
    // A whole set does not fit one honest request: the model skims it and the
    // output limit truncates the last third. Read it window by window instead —
    // one metered request per window — with physical numbering restored locally.
    // A set that fits one window still goes through the sweep when region reading
    // is configured: one sheet is exactly the case a region read is for, and
    // routing it to a single whole-sheet request would silently skip the zoom.
    if (attachesPdf && !images.length && this.config.batchPages > 0
      && pageCount !== null && (pageCount > this.config.batchPages || this.config.tileGrid > 1)) {
      return this.readWholeSet(input, pageCount);
    }
    if (!images.length && input.fileBytes.byteLength > MAX_INLINE_PLAN_BYTES) {
      throw new ProjectApiError(413, 'This plan is too large to attach as a document. No provider request was sent.');
    }
    if (images.some(image => image.bytes.byteLength < 1 || image.bytes.byteLength > MAX_IMAGE_BYTES)) {
      throw new ProjectApiError(413, 'A rendered plan page is outside the low-cost vision size limit. No provider request was sent.');
    }
    return this.readOnce(input, { fileBytes: input.fileBytes, images });
  }

  /** One provider request over one document: the whole set, one window of it, or one region of a sheet. */
  private async readOnce(
    input: GeminiPlanReadInput,
    options: { fileBytes: Uint8Array; images?: readonly PlanPageImage[]; window?: PageWindow; region?: { region: PageRegion; page: PageSize } },
  ): Promise<PlanReadingResult> {
    const images = options.images ?? [];
    if (options.fileBytes.byteLength > MAX_INLINE_PLAN_BYTES) {
      throw new ProjectApiError(413, 'This plan is too large to attach as a document. No provider request was sent.');
    }

    const evidenceDigest = options.region && options.window
      // A region request deliberately carries no sheet-level geometry: those boxes
      // are in sheet coordinates and do not describe the region the model sees.
      ? describeRegionEvidence({
          region: options.region.region,
          page: options.region.page,
          physicalPage: options.window.from,
          pageText: input.sheetText?.pages.find(page => page.pageNumber === options.window!.from)?.text ?? null,
        })
      : options.window
        ? describePlanEvidenceWindow({ linework: input.linework, sheetText: input.sheetText }, options.window)
        : describePlanEvidenceDigest({ linework: input.linework, sheetText: input.sheetText });
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: userPrompt(input, options.window, options.region) }];
    if (evidenceDigest) content.push({ type: 'text', text: evidenceDigest });
    if (!images.length) {
      content.push({
        type: 'file',
        file: {
          filename: options.window ? `plan-pages-${options.window.from}-${options.window.to}.pdf` : 'construction-plan.pdf',
          file_data: `data:${input.mimeType};base64,${Buffer.from(options.fileBytes).toString('base64')}`,
        },
      });
    }
    for (const image of images) {
      content.push({ type: 'text', text: `Physical PDF page ${image.pageNumber}:` });
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`,
          ...(this.config.provider === 'deepseek' ? { detail: 'original' } : this.config.provider === 'openai' ? { detail: 'high' } : {}),
        },
      });
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: 'system', content: systemPrompt(input.sheetName, input.requestedTrades) },
        { role: 'user', content },
      ],
      response_format: { type: 'json_object' },
      stream: false,
      ...(this.config.provider === 'deepseek'
        ? { max_tokens: 8000, thinking: { type: input.reasoningEffort === 'high' ? 'enabled' : 'disabled' },
            reasoning_effort: input.reasoningEffort === 'high' ? 'high' : 'none' }
        : {
            max_completion_tokens: this.config.maxOutputTokens,
            ...(this.config.model.startsWith('kimi-k3')
              ? { reasoning_effort: input.reasoningEffort === 'high' ? 'high' : 'low' }
              : {}),
          }),
    };

    const started = Date.now();
    let response: ChatCompletionResponse;
    try {
      response = await meterOpenAiCompatibleCall(this.config.provider, this.config.model, async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
          const http = await this.fetcher(`${this.config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          if (!http.ok) {
            const error = Object.assign(new Error('provider_http_error'), { status: http.status });
            throw error;
          }
          return await http.json() as ChatCompletionResponse;
        } finally { clearTimeout(timeout); }
      });
    } catch (error) {
      if (error instanceof UsageAccountingError || error instanceof ProjectApiError) throw error;
      const failure = classifyProviderFailure(error, {
        provider: this.config.provider,
        model: this.config.model,
        stage: 'generate',
        durationMs: Date.now() - started,
      });
      logProviderFailure(failure);
      throw failure;
    }

    const choice = response.choices?.[0];
    if (choice?.finish_reason === 'length') {
      const failure = new AiProviderError('provider_output_truncated', {
        provider: this.config.provider, model: this.config.model, stage: 'parse', durationMs: Date.now() - started,
      });
      logProviderFailure(failure);
      throw failure;
    }

    try {
      const parsed = JSON.parse(choice?.message?.content || '{}');
      // A windowed request is told how many pages it carries, so pin that count:
      // the sanitizer then validates every citation against this window's pages
      // instead of the whole set. The caller restores physical numbering.
      const normalized = options.window && parsed && typeof parsed === 'object'
        ? {
            ...(parsed as Record<string, unknown>),
            summary: {
              ...((parsed as Record<string, unknown>).summary && typeof (parsed as Record<string, unknown>).summary === 'object'
                ? (parsed as Record<string, unknown>).summary as Record<string, unknown> : {}),
              sheet_count: options.window.to - options.window.from + 1,
            },
          }
        : parsed;
      const result = sanitizePlanReadingResult(normalized);
      if (!result.findings.length) throw new Error('empty');
      return result;
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      const failure = classifyProviderFailure(error, {
        provider: this.config.provider, model: this.config.model, stage: 'parse', durationMs: Date.now() - started,
      }, 'provider_invalid_output');
      logProviderFailure(failure);
      throw failure;
    }
  }

  /**
   * The regions to read a sheet in, or null to read it whole.
   *
   * A sheet is cut only when tiling is configured, the window is exactly one
   * sheet, the sheet is inside the configured page cap, and its own measured
   * drawing is dense enough to be worth cutting. The last condition is evidence,
   * not a guess about the sheet's title: a cover, a schedule or an elevation has
   * almost no wall-like strokes, and cutting one costs requests and finds nothing.
   */
  private async croppedRegionsForSheet(
    input: GeminiPlanReadInput,
    bytes: Uint8Array,
    window: PageWindow,
  ): Promise<{ regions: PageRegion[]; frame: SheetFrame } | null> {
    if (this.config.tileGrid <= 1 || window.to !== window.from) return null;
    if (window.from > this.config.tileMaxPages) return null;
    const measured = input.linework?.pages.find(entry => entry.pageNumber === window.from);
    if (!measured) return null;
    if (measured.vertical.count + measured.horizontal.count < this.config.tileMinWallStrokes) return null;
    const frame = await readSheetFrame(bytes);
    const page: PageSize = { width: frame.width, height: frame.height };
    const regions = planPageRegions(page, this.config.tileGrid, this.config.tileOverlapRatio);
    return regions.length > 1 ? { regions, frame } : null;
  }

  /**
   * Reads every physical page of a set that is too large for one request.
   *
   * Each window's findings are renumbered to physical pages, so a downstream
   * review, takeoff or coverage report sees the real sheet. Nothing is invented
   * to cover a gap: a batch that fails, or a window the batch cap never reached,
   * is named in summary.limitations, and a sweep that produces no findings at
   * all rethrows the provider failure so the orchestrator can try another reader.
   */
  private async readWholeSet(input: GeminiPlanReadInput, pageCount: number): Promise<PlanReadingResult> {
    // A region read spends its request budget per sheet, not per window: the same
    // budget therefore covers far fewer pages, and the pages it never reached are
    // named below instead of being implied to have been read.
    const regionsPerPage = this.config.tileGrid > 1 ? this.config.tileGrid * this.config.tileGrid : 0;
    // The budget is spent on requests actually made, not reserved up front from the
    // region count: a real set mixes dense floor plans with covers, schedules and
    // elevations, and reserving nine requests for every sheet would starve the very
    // sheets that have something to zoom into. The window list is bounded only by
    // the hard page ceiling; the request budget stops the loop below.
    const windows = planPageWindows(pageCount, this.config.batchPages, MAX_MAX_BATCHES);
    const attempted: PageWindow[] = [];
    const partiallyRead: string[] = [];
    let requestsMade = 0;
    let requestCapReached = false;
    const limitations: string[] = [];
    const findings: PlanReadingFinding[] = [];
    const trades = new Set<string>();
    const batchNotes: string[] = [];
    const failed: PageWindow[] = [];
    const tiledPages: number[] = [];
    const wholePages: number[] = [];
    let address: PlanProjectAddressEvidence | undefined;
    let scaleConflict = false;
    let scaleDetected = false;
    let lastError: unknown = null;
    const sweepStartedAt = Date.now();
    let deadlineStopped = false;

    // Parsed once for the whole sweep: one window costs one page copy, not one
    // re-parse of the complete set. A file PDF.js can read but this splitter
    // cannot still gets read, as a single request, exactly as before.
    let source;
    try { source = await loadPlanDocument(input.fileBytes); }
    catch { return this.readOnce(input, { fileBytes: input.fileBytes }); }

    for (const window of windows) {
      // The sweep runs inline in the HTTP request, so the platform's function
      // timeout is a hard ceiling on the whole reading. Stop at the deadline and
      // name the pages that were not read instead of being killed mid-sweep. The
      // first window always runs.
      if (attempted.length && this.config.budgetMs > 0 && Date.now() - sweepStartedAt > this.config.budgetMs) {
        deadlineStopped = true;
        break;
      }
      if (requestsMade >= this.config.maxBatches) {
        requestCapReached = true;
        break;
      }
      attempted.push(window);
      try {
        const bytes = await slicePlanDocument(source, window);
        const cropped = await this.croppedRegionsForSheet(input, bytes, window);
        if (cropped) {
          // A dense sheet is cut into overlapping regions and each region is its
          // own metered request, which is what resolves door leaves and swings a
          // whole-sheet view merges. Every failure is named; nothing is skipped
          // silently, and a region that fails never removes the other regions.
          tiledPages.push(window.from);
          const { regions, frame } = cropped;
          const page: PageSize = { width: frame.width, height: frame.height };
          const pageText = input.sheetText?.pages.find(entry => entry.pageNumber === window.from)?.text ?? null;
          let regionsRead = 0;
          for (const region of regions) {
            if (requestsMade >= this.config.maxBatches) {
              requestCapReached = true;
              partiallyRead.push(`physical page ${window.from} was read in ${regionsRead} of ${regions.length} region(s)`);
              break;
            }
            let outcome: PlanReadingResult;
            requestsMade += 1;
            try {
              const tileBytes = await cropSheetRegion(bytes, frame, region);
              outcome = await this.readOnce(input, { fileBytes: tileBytes, window, region: { region, page } });
            } catch (error) {
              failed.push(window);
              lastError = error;
              batchNotes.push(`Physical page ${window.from}, ${describeRegion(region, page)}, could not be read: ${sweepFailureReason(error)}`);
              continue;
            }
            for (const trade of outcome.summary.detected_trade_scope) trades.add(trade);
            if (outcome.summary.scale_status === 'conflicting') scaleConflict = true;
            if (outcome.summary.scale_status === 'detected') scaleDetected = true;
            const accepted = outcome.findings.filter(finding => finding.page_number === 1);
            for (const finding of accepted) {
              const mapped = mapNormalizedBoxFromRegion((finding.geometry as { bbox?: unknown } | undefined)?.bbox, region, page);
              findings.push({
                ...finding,
                page_number: window.from,
                // A box the region cannot place is dropped rather than guessed: a
                // wrong location is worse than none, because the viewer draws it.
                geometry: mapped ? { ...finding.geometry, bbox: mapped } : {},
              });
            }
            if (outcome.findings.length > accepted.length) {
              batchNotes.push(`${outcome.findings.length - accepted.length} finding(s) from physical page ${window.from} (${describeRegion(region, page)}) cited a page outside its own sheet and were dropped.`);
            }
            for (const note of outcome.summary.limitations) {
              batchNotes.push(`Physical page ${window.from} (${describeRegion(region, page)}): ${note}`);
            }
            if (pageText === null && outcome.summary.project_address && !address) {
              address = { ...outcome.summary.project_address };
            }
            regionsRead += 1;
          }
          if (requestCapReached) break;
          continue;
        }
        wholePages.push(window.from);
        requestsMade += 1;
        const result = await this.readOnce(input, { fileBytes: bytes, window });
        const localPages = window.to - window.from + 1;
        const accepted = result.findings.filter(finding =>
          typeof finding.page_number === 'number' && finding.page_number >= 1 && finding.page_number <= localPages);
        for (const finding of accepted) findings.push({ ...finding, page_number: (finding.page_number as number) + window.from - 1 });
        for (const trade of result.summary.detected_trade_scope) trades.add(trade);
        if (!address && result.summary.project_address) {
          address = { ...result.summary.project_address, page_number: result.summary.project_address.page_number + window.from - 1 };
        }
        if (result.summary.scale_status === 'conflicting') scaleConflict = true;
        if (result.summary.scale_status === 'detected') scaleDetected = true;
        if (result.findings.length > accepted.length) {
          batchNotes.push(`${result.findings.length - accepted.length} finding(s) from the batch for physical pages ${window.from}-${window.to} cited a page outside that batch and were dropped.`);
        }
        for (const note of result.summary.limitations) batchNotes.push(`Physical pages ${window.from}-${window.to}: ${note}`);
      } catch (error) {
        failed.push(window);
        lastError = error;
        batchNotes.push(`Physical pages ${window.from}-${window.to} could not be read and produced no evidence in this reading: ${sweepFailureReason(error)}`);
      }
    }

    if (!findings.length) {
      throw lastError instanceof Error ? lastError : new ProjectApiError(502, 'No usable findings were returned for this set.');
    }

    limitations.push(`This plan was read as ${attempted.length} separate provider request(s) of at most ${this.config.batchPages} physical pages each: a ${pageCount}-page set cannot be read honestly in one request, and each request is metered on its own.`);
    if (tiledPages.length) {
      limitations.push(`Physical page(s) ${tiledPages.join(', ')} were read as ${this.config.tileGrid}x${this.config.tileGrid} overlapping region(s), one provider request each, so small drawn detail - door leaves and swings, closets, toilets - could be resolved instead of merged by a whole-sheet view. A normalized box reported inside a region was restored to sheet coordinates by the server; a box a region could not place was dropped rather than guessed.`);
    }
    if (tiledPages.length && wholePages.length) {
      limitations.push(`Physical page(s) ${wholePages.join(', ')} were read whole, not as regions: their own measured drawing has fewer than ${this.config.tileMinWallStrokes} wall-like stroke(s), so cutting them would cost requests and find nothing.`);
    }
    const unread = unreadPages(pageCount, attempted);
    if (unread.length) {
      const range = `${unread[0]}-${unread[unread.length - 1]}`;
      limitations.push(deadlineStopped
        ? `Physical pages ${range} were never read: the ${Math.max(1, Math.round(this.config.budgetMs / 1000))}-second sweep deadline was reached after ${attempted.length} request(s).`
        : requestCapReached
          ? `Physical pages ${range} were never read: the configured provider-request budget of ${this.config.maxBatches} request(s) was reached after ${requestsMade} request(s).`
          : `Physical pages ${range} were never read: the configured sweep limit of ${windows.length} request(s) was reached first.`);
    }
    // A page that ran out of budget midway is named as such: it is neither read in
    // full nor unread, and calling it either would misstate the evidence.
    for (const note of partiallyRead) limitations.push(`Partly read: ${note}; the configured provider-request budget of ${this.config.maxBatches} request(s) was reached. Findings from that page cover only the regions actually read.`);
    if (failed.length) limitations.push(`${failed.length} of ${windows.length} batch(es) failed, so this reading does not cover the whole set.`);

    const ordered = dedupeOverlappingFindings(findings)
      .sort((a, b) => (a.page_number ?? 0) - (b.page_number ?? 0));
    const capped = ordered.slice(0, this.config.maxTotalFindings);
    if (ordered.length > capped.length) {
      limitations.push(`Findings capped at ${this.config.maxTotalFindings} for this set (${ordered.length} were reported across all batches).`);
    }

    return {
      summary: {
        sheet_count: pageCount,
        detected_trade_scope: [...trades],
        scale_status: scaleConflict ? 'conflicting' : scaleDetected ? 'detected' : 'missing',
        human_review_required: true,
        limitations: [...new Set([...limitations, ...batchNotes])],
        ...(address ? { project_address: address } : {}),
      },
      findings: capped,
    };
  }
}
