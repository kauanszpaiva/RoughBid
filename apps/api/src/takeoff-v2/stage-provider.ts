import { AiProviderError, runProviderOperation } from '../ai-plan/provider-errors.ts';
import { assertUsageMeterContext, meterAnthropicCall, meterGeminiCall, meterOpenAiCompatibleCall,
  UsageAccountingError, ProviderSpendLimitError } from '../owner-usage/meter.ts';
import { FullTakeoffBudgetWait, FullTakeoffRunBudgetExhausted } from './budget-wait.ts';
import { ProjectApiError } from '../projects/service.ts';
import { extractSheetText } from '../ai-plan/sheet-text.ts';
import { assertRenderedVisionRequestSize, renderedVisionGenerationOptions } from '../ai-plan/vision-capabilities.ts';
import type { PageRegion } from '../ai-plan/page-tiles.ts';
import { deepPassSystemPrompt, MAX_OBSERVATIONS, MAX_BLOCKERS, parseDeepPassCheckpoint, splitPhysicalPages } from './claude-provider.ts';
import { deriveDeterministicScaleEvidence } from './scale-evidence.ts';
import { requireStageDeepPassConfig, STAGE_MODEL_REGISTRY, type ConfiguredEvidenceStage, type StageDeepPassConfig } from './stage-config.ts';
import { deepPassOutputSchema } from './stage-schema.ts';
import { isolateStageRegions, stageRegionIdentity, type RegionCheckpointStore, type StageRegion } from './stage-regions.ts';
import type { FullTakeoffV2ProviderFactory } from './service.ts';
import type { DeepPassProvider, DeepPassRequest, DeepPassResult } from './types.ts';
import { buildPriorEvidenceContext,priorEvidenceNeedsReview } from './prior-context.ts';

const MAX_RESPONSE_BYTES = 500_000;
const MAX_PAGE_BYTES = 10 * 1024 * 1024;
type Json = Record<string, unknown>;
type FactoryInput = Parameters<FullTakeoffV2ProviderFactory['create']>[0];
export type ProviderResponse = { raw: Json; usage?: { inputTokens?: number; outputTokens?: number }; id?: string;
  bridgeSource?:{inputKind:'pdf'|'images'|'text';textTruncated:boolean;contextTruncated:boolean;priorReviewRequired?:boolean} };
export interface StageSourceImage {
  dataUrl: string;
  label?: string;
  pageNumber?: number;
  widthPixels?: number;
  heightPixels?: number;
  region?: PageRegion;
  rotationDegrees?: number;
  displayRegion?: StageRegion['displayRegion'];
}
export interface StageRuntimeSources {
  evidenceTransport?(input: FactoryInput, request: DeepPassRequest, evidence: StageEvidenceInput,
    beforeCheckpoint?: (eventId: string) => Promise<void>): Promise<ProviderResponse>;
  prepareRun?(input: FactoryInput, config: StageDeepPassConfig): Promise<void>;
  loadPageImages?(input: FactoryInput, pageNumber: number): Promise<readonly StageSourceImage[]>;
  loadSheetText?(input: FactoryInput, pageNumber: number): Promise<string | null>;
  regionCheckpoints?: RegionCheckpointStore;
  renderRegion?(input: FactoryInput, request: DeepPassRequest, region: StageRegion): Promise<StageSourceImage>;
  loadPriorEvidence?(input: FactoryInput): Promise<readonly DeepPassResult[]>;
  loadGeometryMeasurements?(input: FactoryInput, request: DeepPassRequest): Promise<Record<string, unknown>>;
}
export type StageEvidenceInput = { kind: 'pdf'; page: Uint8Array; region?: StageRegion } | { kind: 'images'; images: readonly StageSourceImage[] }
  | { kind: 'text'; text: string; truncated: boolean };
const record = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const tokens = (value: unknown): number | undefined => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
function normalizedUsage(input: unknown, output: unknown): { inputTokens?: number; outputTokens?: number } {
  const inputTokens = tokens(input), outputTokens = tokens(output);
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) };
}

/** Fixed vendor URLs, bounded body, no retries, and no upstream body in diagnostics. */
async function postJson(fetcher: typeof fetch, url: string, headers: Record<string, string>, body: Json, timeoutMs: number, signal?: AbortSignal): Promise<Json> {
  signal?.throwIfAborted();
  const response = await fetcher(url, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), redirect: 'error',
  });
  if (!response.ok) throw Object.assign(new Error('Configured provider request was rejected.'), { status: response.status });
  if (!response.body) throw new SyntaxError('Provider response body is missing.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new SyntaxError('Provider response exceeds its bound.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(combined));
  if (!record(parsed)) throw new SyntaxError('Provider response must be an object.');
  return parsed;
}
function providerFailure(code: 'provider_output_truncated' | 'provider_empty_output' | 'provider_invalid_output', stage: ConfiguredEvidenceStage): never {
  throw new AiProviderError(code, { provider: stage.provider, model: stage.model, stage: 'validate', durationMs: 0 });
}
function outputText(response: ProviderResponse, stage: ConfiguredEvidenceStage): string {
  const raw = response.raw;
  if (stage.provider === 'kimi' || stage.provider === 'deepseek') {
    if (!Array.isArray(raw.choices) || raw.choices.length !== 1 || !record(raw.choices[0])) providerFailure('provider_invalid_output', stage);
    const choice = raw.choices[0];
    if (choice.finish_reason === 'length') providerFailure('provider_output_truncated', stage);
    if (choice.finish_reason !== 'stop' || !record(choice.message) || typeof choice.message.content !== 'string') providerFailure('provider_invalid_output', stage);
    if (!choice.message.content.trim()) providerFailure('provider_empty_output', stage);
    return choice.message.content;
  }
  if (stage.provider === 'openai') {
    if (raw.status === 'incomplete') providerFailure('provider_output_truncated', stage);
    if (raw.status !== 'completed' || !Array.isArray(raw.output)) providerFailure('provider_invalid_output', stage);
    const text = raw.output.flatMap(item => record(item) && item.type === 'message' && Array.isArray(item.content)
      ? item.content.flatMap(block => record(block) && block.type === 'output_text' && typeof block.text === 'string' ? [block.text] : []) : []).join('');
    if (!text) providerFailure('provider_empty_output', stage);
    return text;
  }
  if (stage.provider === 'claude') {
    if (raw.stop_reason === 'max_tokens') providerFailure('provider_output_truncated', stage);
    if (raw.stop_reason !== 'end_turn' || !Array.isArray(raw.content)) providerFailure('provider_invalid_output', stage);
    const text = raw.content.flatMap(block => record(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('');
    if (!text) providerFailure('provider_empty_output', stage);
    return text;
  }
  if (!Array.isArray(raw.candidates) || raw.candidates.length !== 1 || !record(raw.candidates[0])) providerFailure('provider_empty_output', stage);
  const candidate = raw.candidates[0];
  if (candidate.finishReason === 'MAX_TOKENS') providerFailure('provider_output_truncated', stage);
  if (candidate.finishReason !== 'STOP' || !record(candidate.content) || !Array.isArray(candidate.content.parts)) providerFailure('provider_invalid_output', stage);
  const text = candidate.content.parts.flatMap(part => record(part) && part.thought !== true && typeof part.text === 'string' ? [part.text] : []).join('');
  if (!text) providerFailure('provider_empty_output', stage);
  return text;
}
/** Call cost stays unknown unless the existing meter has a verified calculator. */
export async function requestEvidence(fetcher: typeof fetch, config: StageDeepPassConfig, stage: ConfiguredEvidenceStage,
  request: DeepPassRequest, input: StageEvidenceInput, context = '', signal?: AbortSignal,
  beforeDispatch?: (eventId: string) => Promise<void>): Promise<ProviderResponse> {
  signal?.throwIfAborted();
  const apiKey = stage.apiKey;
  if (!apiKey) throw new Error('Direct stage transport requires a configured credential.');
  const schema = deepPassOutputSchema(request);
  const system = deepPassSystemPrompt(request);
  const regionNotice = input.kind === 'pdf' && input.region
    ? ` This PDF displays ONLY region ${input.region.id}: ${JSON.stringify(input.region.region)}. These are UNROTATED PDF points relative to the original CropBox ${JSON.stringify(input.region.sourceFrame)}. The original clockwise page rotation of ${input.region.rotationDegrees} degrees is preserved in the attached crop. Its displayed top-left bounds are ${JSON.stringify(input.region.displayRegion)}. Do not claim that the entire sheet was read. Region indices describe the unrotated source grid, not the visual reading order. Overlaps are not additional objects; source bounds are not measurement geometry.` : '';
  const instruction = `Run only ${request.passType} for physical page ${request.sheet.physicalPageNumber}.${regionNotice} Return the bounded JSON checkpoint.${context ? `\nUNTRUSTED PREVIOUS CHECKPOINTS WITH PHYSICAL SOURCE PAGES (cross-references, not new visual evidence):\n${context}` : ''}`;
  const data = input.kind === 'pdf' ? Buffer.from(input.page).toString('base64') : '';
  const requirement = { minimumReservationUsd: stage.attestation.maximumCallCostUsd,
    ...(beforeDispatch ? { beforeDispatch: async (eventId: string) => {
      signal?.throwIfAborted(); await beforeDispatch(eventId); signal?.throwIfAborted();
    } } : {}) };
  const send = (url: string, headers: Record<string, string>, body: Json) =>
    runProviderOperation(stage.provider, stage.model, 'generate', () => postJson(fetcher, url, headers, body, config.requestTimeoutMs,signal));
  if (stage.provider === 'kimi' || stage.provider === 'deepseek') {
    const sourceNotice = input.kind === 'text'
      ? 'Only native text and prior sheet evidence are supplied. You have not seen drawing images. Never claim visual review, geometry measurement or complete visual coverage.'
      : 'Only the explicitly labeled cropped regions are supplied. Review these regions as a second evidence pass. Never claim that unprovided regions or the entire sheet were inspected. Do not double-count overlapping regions.';
    const content = input.kind === 'text' ? `${instruction}\nUNTRUSTED SHEET TEXT/EVIDENCE:\n${input.text}`
      : input.kind === 'images' ? [
        { type: 'text', text: instruction },
        ...input.images.flatMap(image => [
          { type: 'text', text: `${image.label ?? 'Cropped region'}; physical page ${request.sheet.physicalPageNumber}; unrotated source region ${JSON.stringify(image.region)}; clockwise page rotation ${image.rotationDegrees ?? request.sheet.rotationDegrees}; displayed bounds ${JSON.stringify(image.displayRegion ?? null)}` },
          { type: 'image_url', image_url: { url: image.dataUrl, ...(stage.provider === 'deepseek' ? { detail: 'original' } : {}) } },
        ]),
      ] : [];
    const visionOptions = input.kind === 'images'
      ? renderedVisionGenerationOptions(stage.provider, stage.model, stage.maxOutputTokens, stage.reasoningEffort === 'low' ? 'low' : 'high')
      : { max_tokens: stage.maxOutputTokens, thinking: { type: 'enabled' } };
    const body: Json = {
      model: stage.model,
      messages: [{ role: 'system', content: `${system}\n${sourceNotice}\nReturn a JSON object matching this schema: ${JSON.stringify(schema)}` }, { role: 'user', content }],
      ...visionOptions,
      ...(stage.model === 'kimi-k3' || stage.provider === 'deepseek' && stage.reasoningEffort !== 'low' || input.kind === 'text'
        ? { reasoning_effort: stage.reasoningEffort } : {}),
      response_format: stage.provider === 'kimi' ? { type: 'json_schema', json_schema: { name: 'roughbid_deep_checkpoint', strict: true, schema } } : { type: 'json_object' },
      stream: false,
    };
    assertRenderedVisionRequestSize(stage.provider, JSON.stringify(body));
    const response = await meterOpenAiCompatibleCall(stage.provider, stage.model, async () => {
      const raw = await send(`${stage.baseUrl}/chat/completions`, { authorization: `Bearer ${apiKey}` }, body);
      const usage = record(raw.usage) ? raw.usage : {};
      const inputTokens = tokens(usage.prompt_tokens), outputTokens = tokens(usage.completion_tokens);
      return { raw, ...(typeof raw.id === 'string' ? { id: raw.id } : {}), usage: {
        ...(inputTokens === undefined ? {} : { prompt_tokens: inputTokens }), ...(outputTokens === undefined ? {} : { completion_tokens: outputTokens }),
      } };
    }, requirement);
    return { raw: response.raw, ...(response.id ? { id: response.id } : {}),
      usage: normalizedUsage(response.usage.prompt_tokens, response.usage.completion_tokens) };
  }
  if (stage.provider === 'openai') {
    const response = await meterOpenAiCompatibleCall('openai', stage.model, async () => {
      const raw = await send('https://api.openai.com/v1/responses', { authorization: `Bearer ${apiKey}` }, {
        model: stage.model, instructions: system, max_output_tokens: stage.maxOutputTokens,
        ...(stage.requestPolicy==='explicit-cache-default-v1'?{prompt_cache_options:{mode:'explicit'},service_tier:'default'}:{}),
        reasoning: { effort: stage.reasoningEffort }, store: false,
        text: { format: { type: 'json_schema', name: 'roughbid_deep_checkpoint', strict: true, schema } },
        input: [{ role: 'user', content: [
          { type: 'input_file', filename: `physical-page-${request.sheet.physicalPageNumber}.pdf`, file_data: `data:application/pdf;base64,${data}` },
          { type: 'input_text', text: instruction },
        ] }],
      });
      const usage = record(raw.usage) ? raw.usage : {};
      const input = tokens(usage.input_tokens), output = tokens(usage.output_tokens);
      return { raw, ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
        usage: { ...(input === undefined ? {} : { prompt_tokens: input }), ...(output === undefined ? {} : { completion_tokens: output }) } };
    }, requirement);
    return { raw: response.raw, ...(response.id === undefined ? {} : { id: response.id }),
      usage: normalizedUsage(response.usage.prompt_tokens, response.usage.completion_tokens) };
  }
  if (stage.provider === 'claude') {
    return meterAnthropicCall('claude', stage.model, async () => {
      const raw = await send('https://api.anthropic.com/v1/messages', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, {
        model: stage.model, system, max_tokens: stage.maxOutputTokens,
        thinking: { type: 'adaptive' }, output_config: { effort: stage.reasoningEffort, format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }, { type: 'text', text: instruction },
        ] }],
      });
      const usage = record(raw.usage) ? raw.usage : {};
      return { raw, ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
        usage: normalizedUsage(usage.input_tokens, usage.output_tokens) };
    }, requirement);
  }
  const raw = await meterGeminiCall(stage.model, 'generate', () => send(
    `https://generativelanguage.googleapis.com/v1beta/models/${stage.model}:generateContent`, { 'x-goog-api-key': apiKey }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data } }, { text: instruction }] }],
      generationConfig: {
        // generateContent uses REST enum names, unlike the Interactions API.
        maxOutputTokens: stage.maxOutputTokens, thinkingConfig: { thinkingLevel: stage.reasoningEffort.toUpperCase() },
        responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema } },
      },
    }), requirement);
  const usage = record(raw.usageMetadata) ? raw.usageMetadata : {};
  const candidates = tokens(usage.candidatesTokenCount), thoughts = tokens(usage.thoughtsTokenCount ?? 0);
  const outputTokens = candidates !== undefined && thoughts !== undefined && Number.isSafeInteger(candidates + thoughts) ? candidates + thoughts : undefined;
  return { raw, ...(typeof raw.responseId === 'string' ? { id: raw.responseId } : {}),
    usage: normalizedUsage(usage.promptTokenCount, outputTokens) };
}

/** Deterministic evidence is not a claim that quantities or prices were calculated. */
export function localStageCheckpoint(request: DeepPassRequest): DeepPassResult {
  let reason: string;
  let detail: Record<string, unknown> = {};
  if (request.passType === 'geometry') {
    const scale = deriveDeterministicScaleEvidence({}, request.sheet.nativeScaleCandidates ?? []);
    detail = { deterministic_scale: scale };
    reason = 'Scale evidence was derived locally; calibrated measurement geometry must be supplied before quantities can be accepted.';
  } else if (request.passType === 'arithmetic_qa') {
    reason = 'Arithmetic requires deterministic measured quantities and assembly inputs; no model-generated quantity was substituted.';
  } else if (request.passType === 'pricing_assemblies') {
    reason = 'Pricing requires sourced compositions, dated unit prices and verified quantities; no price or cost was generated.';
  } else {
    reason = `The ${request.passType} evidence stage is disabled or not explicitly configured.`;
  }
  return { status: 'blocked', provider: 'roughbid', model: 'deterministic-v1', checkpoint: {
    version: 'roughbid-local-v1', physical_page_number: request.sheet.physicalPageNumber,
    pass_type: request.passType, observations: [], blockers: [reason], ...detail,
  } };
}
function blockedSource(request: DeepPassRequest, reason: string): DeepPassResult {
  const result = localStageCheckpoint(request);
  return { ...result, checkpoint: { ...result.checkpoint, blockers: [reason] } };
}
function validRegionImage(image: StageSourceImage, request: DeepPassRequest, provider: 'kimi' | 'deepseek'): boolean {
  if (!record(image) || image.pageNumber !== request.sheet.physicalPageNumber
    || typeof image.dataUrl !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl)
    || image.dataUrl.length > 16 * 1024 * 1024
    || image.label !== undefined && (typeof image.label !== 'string' || image.label.length > 200)
    || !Number.isSafeInteger(image.widthPixels) || !Number.isSafeInteger(image.heightPixels)
    || (image.widthPixels ?? 0) <= 0 || (image.heightPixels ?? 0) <= 0) return false;
  if (provider === 'deepseek' && Math.max(image.widthPixels!, image.heightPixels!) > 1300) return false;
  const region = image.region;
  if (!region || ![region.x, region.y, region.width, region.height].every(value => typeof value === 'number' && Number.isFinite(value))
    || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0
    || region.x + region.width > request.sheet.widthPoints || region.y + region.height > request.sheet.heightPoints
    || ![region.column, region.row, region.columns, region.rows].every(value => Number.isSafeInteger(value) && value > 0 && value <= 3)
    || region.column > region.columns || region.row > region.rows || region.columns * region.rows <= 1) return false;
  return true;
}

class StageDeepPassProvider implements DeepPassProvider {
  private readonly config: StageDeepPassConfig;
  private readonly input: FactoryInput;
  private readonly pages: ReadonlyMap<number, Uint8Array>;
  private readonly fetcher: typeof fetch;
  private readonly sources: StageRuntimeSources;
  private readonly priorEvidence = new Map<string, DeepPassResult>();
  private readonly textCache = new Map<number, { text: string; truncated: boolean }>();
  private terminalFailure: Error | null = null;
  private priorLoaded = false;
  private spendingPaused = false;
  constructor(config: StageDeepPassConfig, input: FactoryInput, pages: ReadonlyMap<number, Uint8Array>, fetcher: typeof fetch, sources: StageRuntimeSources) {
    this.config = config; this.input = input; this.pages = pages; this.fetcher = fetcher; this.sources = sources;
  }
  private async previousContext(request: DeepPassRequest): Promise<string> {
    if (!this.priorLoaded) {
      const stored = await this.sources.loadPriorEvidence?.(this.input) ?? [];
      for (const value of stored) {
        if (!record(value.checkpoint) || !Number.isSafeInteger(value.checkpoint.physical_page_number)
          || !this.input.manifest.sheets.some(sheet => sheet.physicalPageNumber === value.checkpoint.physical_page_number)
          || typeof value.checkpoint.pass_type !== 'string') continue;
        this.priorEvidence.set(`${value.checkpoint.physical_page_number}:${value.checkpoint.pass_type}`, value);
      }
      this.priorLoaded = true;
    }
    const entries = [...this.priorEvidence.values()].filter(value =>
      ['classification', 'legends_schedules'].includes(String(value.checkpoint.pass_type))
      || value.checkpoint.physical_page_number === request.sheet.physicalPageNumber);
    return buildPriorEvidenceContext(entries);
  }
  private async dispatch(stage: ConfiguredEvidenceStage, request: DeepPassRequest, evidence: StageEvidenceInput, context: string,
    beforeDispatch?: (eventId: string) => Promise<void>): Promise<DeepPassResult> {
    this.input.signal?.throwIfAborted();
    const response = this.sources.evidenceTransport
      ? await this.sources.evidenceTransport(this.input, request, evidence, beforeDispatch)
      : await requestEvidence(this.fetcher, this.config, stage, request, evidence, context,this.input.signal,beforeDispatch);
    const parsed = await runProviderOperation(stage.provider, stage.model, 'parse', async () =>
      parseDeepPassCheckpoint(outputText(response, stage), request));
    const observations = parsed.checkpoint.observations as unknown[];
    const reasons = [...parsed.checkpoint.blockers as string[]];
    if (observations.length === MAX_OBSERVATIONS) reasons.push('capacity_more_regional_review_required');
    if (evidence.kind === 'text' && (evidence.truncated||response.bridgeSource?.textTruncated)) reasons.push('Source transcript/evidence was truncated; omitted text requires review.');
    if ((context.includes('context_capacity_reached')||response.bridgeSource?.contextTruncated) && ['reconciliation', 'conflict_detection', 'completeness','risk_review'].includes(request.passType)) {
      reasons.push('Cross-sheet reference context needs directed review; whole-set reconciliation is incomplete.');
    }
    if(request.passType==='risk_review'&&(response.bridgeSource?.priorReviewRequired===true||priorEvidenceNeedsReview(context,request.sheet.physicalPageNumber))){
      reasons.push('Prior checkpoints retain unresolved blockers, incomplete coverage, or geometry/human-review requirements. Risk review does not close them.');
    }
    if (evidence.kind !== 'pdf' && request.passType === 'completeness') reasons.push('Selected regions or text-only evidence cannot establish complete visual sheet coverage.');
    return { ...parsed, status: reasons.length ? 'blocked' : parsed.status,
      checkpoint: { ...parsed.checkpoint, blockers: reasons.slice(0, MAX_BLOCKERS),
        capacity: { max_observations: MAX_OBSERVATIONS, max_blockers: MAX_BLOCKERS, max_checkpoint_bytes: 250_000,
          output_token_budget: stage.maxOutputTokens, reached_observation_limit: observations.length === MAX_OBSERVATIONS },
        source_coverage: { input_kind: evidence.kind, physical_page_number: request.sheet.physicalPageNumber,
          rotation_degrees:request.sheet.rotationDegrees,
          ...(evidence.kind === 'pdf' && evidence.region ? { visual_coverage: 'selected_region', region_key: evidence.region.id,
            region: evidence.region.region,coordinate_space:'unrotated_cropbox_bottom_left_points',
            source_frame:evidence.region.sourceFrame,rotation_degrees:evidence.region.rotationDegrees,display_region:evidence.region.displayRegion } : {}),
          ...(evidence.kind === 'images' ? { visual_coverage: 'selected_regions', regions: evidence.images.map(image => ({
            region: image.region,rotation_degrees:image.rotationDegrees??request.sheet.rotationDegrees,display_region:image.displayRegion??null,
            width_pixels: image.widthPixels, height_pixels: image.heightPixels })) } : {}),
          ...(evidence.kind === 'text' ? { visual_coverage: 'not_observed', truncated: evidence.truncated } : {}) },
        reasoning_effort: stage.reasoningEffort }, provider: stage.provider, model: stage.model,
      ...(response.usage?.inputTokens === undefined ? {} : { inputTokens: response.usage.inputTokens }),
      ...(response.usage?.outputTokens === undefined ? {} : { outputTokens: response.usage.outputTokens }) };
  }
  private async regionalPass(stage: ConfiguredEvidenceStage, request: DeepPassRequest, page: Uint8Array, context: string,
    beforeDispatch?: (eventId?: string) => Promise<void>): Promise<DeepPassResult> {
    const store = this.sources.regionCheckpoints;
    if (!store || !this.input.leaseId) return blockedSource(request, 'Detailed regional review requires its durable checkpoint store and active lease. No provider request was sent.');
    const kind = STAGE_MODEL_REGISTRY[stage.model].inputKind;
    if (kind === 'text') return blockedSource(request, 'A text-only model cannot inspect visual regions. Select an explicitly verified visual stage.');
    const regions = await isolateStageRegions(page, this.config.regionalReview.grid);
    if(regions.some(region=>region.rotationDegrees!==request.sheet.rotationDegrees))throw new Error('Regional source orientation changed.');
    const results: Array<{ region: StageRegion; result: DeepPassResult }> = [];
    for (const region of regions) {
      const identity = await stageRegionIdentity(request, region, stage.provider, stage.model);
      if (beforeDispatch && !store.inspect) throw new Error('Regional review requires admission-aware checkpoints.');
      const prior = await (beforeDispatch ? store.inspect!(this.input, request, region, identity) : store.begin(this.input, request, region, identity));
      let result: DeepPassResult;
      if (prior.disposition === 'saved') result = prior.result;
      else {
        let evidence: StageEvidenceInput;
        if (kind === 'pdf') evidence = { kind: 'pdf', page: region.pdfBytes, region };
        else {
          const image = await this.sources.renderRegion?.(this.input, request, region);
          if (!image || !validRegionImage(image, request, stage.provider as 'kimi' | 'deepseek')) {
            result = blockedSource(request, 'A measured local image crop was unavailable; this region was not sent to a provider.');
            if (beforeDispatch) { await beforeDispatch(); await store.begin(this.input, request, region, identity); }
            await store.save(this.input, request, region, identity, result);
            results.push({ region, result }); continue;
          }
          evidence = { kind: 'images', images: [image] };
        }
        try { result = await this.dispatch(stage, request, evidence, context, beforeDispatch ? async eventId => {
          await beforeDispatch(eventId);
          const claimed = await store.begin(this.input, request, region, identity, eventId);
          if (claimed.disposition !== 'run') throw new Error('Regional checkpoint changed before dispatch.');
        } : undefined); }
        catch (error) {
          if (!(error instanceof ProviderSpendLimitError)) throw error;
          if (beforeDispatch && error.scope === 'company' && error.eventId) throw new FullTakeoffBudgetWait(request,error.eventId);
          if (beforeDispatch) throw new FullTakeoffRunBudgetExhausted();
          this.spendingPaused = true;
          result = blockedSource(request, `The ${error.scope} spending authorization is exhausted. This region was not sent; remaining regions are pending.`);
          await store.save(this.input, request, region, identity, result);
          results.push({ region, result }); break;
        }
        await store.save(this.input, request, region, identity, result);
      }
      results.push({ region, result });
    }
    const observations = results.flatMap(({ region, result }) => (Array.isArray(result.checkpoint.observations)
      ? result.checkpoint.observations : []).map(value => ({ ...(record(value) ? value : {}), region_key: region.id })));
    const blockedRegions = results.filter(({ result }) => result.status !== 'succeeded').map(({ region }) => region.id);
    const checkpoint: Record<string, unknown> = { version: 'roughbid-regional-v1', physical_page_number: request.sheet.physicalPageNumber,
      pass_type: request.passType, observations, blockers: blockedRegions.length || results.length < regions.length ? ['One or more regions require further review; unvisited regions remain pending.'] : [],
      source_coverage: { visual_coverage: 'grid_regions_visited', completed_regions: results.length, total_regions: regions.length,
        coordinate_space:'unrotated_cropbox_bottom_left_points',rotation_degrees:request.sheet.rotationDegrees,
        regions: results.map(({ region, result }) => ({ region_key: region.id, region: region.region,
          source_frame:region.sourceFrame,display_region:region.displayRegion,status:result.status,
          blockers:result.checkpoint.blockers,source_coverage:result.checkpoint.source_coverage,capacity:result.checkpoint.capacity })),
        blocked_regions: blockedRegions, completeness_verified: false, overlap_deduplication: 'human_review_required' },
      human_review_required: true, reasoning_effort: stage.reasoningEffort };
    if (Buffer.byteLength(JSON.stringify(checkpoint)) > 750_000) {
      checkpoint.observations = [];
      checkpoint.blockers = ['Aggregate evidence exceeds the response bound. Individual regional checkpoints are saved; inspect them separately.'];
    }
    return { status: (checkpoint.blockers as string[]).length ? 'blocked' : 'succeeded', checkpoint,
      provider: stage.provider, model: stage.model,
      ...(results.every(entry => entry.result.inputTokens !== undefined) ? { inputTokens: results.reduce((sum, entry) => sum + entry.result.inputTokens!, 0) } : {}),
      ...(results.every(entry => entry.result.outputTokens !== undefined) ? { outputTokens: results.reduce((sum, entry) => sum + entry.result.outputTokens!, 0) } : {}) };
  }
  private async evidenceInput(stage: ConfiguredEvidenceStage, request: DeepPassRequest, page: Uint8Array): Promise<StageEvidenceInput | DeepPassResult> {
    const kind = STAGE_MODEL_REGISTRY[stage.model].inputKind;
    if (kind === 'pdf') return { kind: 'pdf', page };
    if (kind === 'images') {
      let images: readonly StageSourceImage[];
      try { images = await this.sources.loadPageImages?.(this.input, request.sheet.physicalPageNumber) ?? []; }
      catch { return blockedSource(request, 'Rendered cropped regions could not be loaded; no provider request was sent.'); }
      if (!images.length || images.length > 9 || !images.every(image => validRegionImage(image, request, stage.provider as 'kimi' | 'deepseek'))) {
        return blockedSource(request, 'This image stage requires 1–9 identified cropped regions with measured pixel dimensions and PDF-region coordinates. DeepSeek regions must fit within 1300 pixels per side; no provider request was sent.');
      }
      return { kind: 'images', images };
    }
    let transcript = this.textCache.get(request.sheet.physicalPageNumber);
    if (!transcript) {
      try {
        if (this.sources.loadSheetText) {
          const text = await this.sources.loadSheetText(this.input, request.sheet.physicalPageNumber);
          transcript = { text: typeof text === 'string' ? text.slice(0, 6_000) : '', truncated: typeof text === 'string' && text.length > 6_000 };
        } else {
          const text = await extractSheetText(page, { maxPages: 1, maxCharacters: 6_000, maxCharactersPerPage: 6_000 });
          transcript = { text: text.pages[0]?.text ?? '', truncated: text.truncated || text.pages[0]?.truncated === true };
        }
      } catch { transcript = { text: '', truncated: false }; }
      this.textCache.set(request.sheet.physicalPageNumber, transcript);
    }
    const previous = [...this.priorEvidence.values()].filter(value => value.checkpoint.physical_page_number === request.sheet.physicalPageNumber);
    const previousText = previous.length ? JSON.stringify(previous.map(value => ({ pass: value.checkpoint.pass_type,
      status: value.status, observations: value.checkpoint.observations, blockers: value.checkpoint.blockers }))) : '';
    if (!transcript.text.trim() && !previousText) return blockedSource(request, 'DeepSeek Pro has no native text or previous sheet evidence to reconcile. It cannot read plan images or a PDF; no provider request was sent.');
    return { kind: 'text', text: `NATIVE TRANSCRIPT:\n${transcript.text}\nPRIOR UNTRUSTED SHEET EVIDENCE:\n${previousText.slice(0, 20_000)}`,
      truncated: transcript.truncated || previousText.length > 20_000 };
  }
  readonly defersCheckpointClaim = true;
  async runPass(request: DeepPassRequest, beforeDispatch?: (eventId?: string) => Promise<void>): Promise<DeepPassResult> {
    this.input.signal?.throwIfAborted();
    if (this.terminalFailure) throw this.terminalFailure;
    if (this.spendingPaused) return blockedSource(request, 'Further provider stages are paused because spending authorization was exhausted. No provider request was sent.');
    const sheet = this.input.manifest.sheets.find(item => item.physicalPageNumber === request.sheet.physicalPageNumber);
    if (request.runId !== this.input.runId || !sheet || sheet.pageSha256 !== request.sheet.pageSha256) {
      throw new ProjectApiError(409, 'Stage checkpoint identity does not match its deterministic manifest.');
    }
    const stage = this.config.stages[request.passType];
    if (!stage) {
      let result=localStageCheckpoint(request);
      if (request.passType === 'geometry' && this.sources.loadGeometryMeasurements) {
        const geometry = await this.sources.loadGeometryMeasurements(this.input, request);
        result={ status: 'blocked', provider: 'roughbid', model: 'deterministic-v1', checkpoint: {
          ...result.checkpoint, ...geometry, human_review_required: true,
          blockers: [...(Array.isArray(geometry.blockers)?geometry.blockers:[]),'Reviewed measurements are preserved. Whole-sheet/category coverage and unresolved geometry still require review.'] } };
      }
      this.priorEvidence.set(`${request.sheet.physicalPageNumber}:${request.passType}`,result);
      return result;
    }
    const page = this.pages.get(request.sheet.physicalPageNumber);
    if (!page || page.byteLength > MAX_PAGE_BYTES) throw new ProjectApiError(422, 'The isolated stage PDF is unavailable or exceeds its bound.');
    try {
      assertUsageMeterContext({ jobId: this.input.runId, workspaceId: this.input.workspaceId, projectId: this.input.projectId });
      const context = await this.previousContext(request);
      if (this.config.regionalReview.enabled && ['discipline', 'conflict_detection', 'completeness'].includes(request.passType)) {
        const regional = await this.regionalPass(stage, request, page, context,beforeDispatch);
        this.priorEvidence.set(`${request.sheet.physicalPageNumber}:${request.passType}`, regional);
        return regional;
      }
      const evidence = await this.evidenceInput(stage, request, page);
      if ('status' in evidence) return evidence;
      const result = await this.dispatch(stage, request, evidence, context,beforeDispatch);
      this.priorEvidence.set(`${request.sheet.physicalPageNumber}:${request.passType}`, result);
      return result;
    } catch (error) {
      if (error instanceof FullTakeoffBudgetWait || error instanceof FullTakeoffRunBudgetExhausted) throw error;
      if (error instanceof ProviderSpendLimitError) {
        if (beforeDispatch && error.scope === 'company' && error.eventId) throw new FullTakeoffBudgetWait(request,error.eventId);
        if (beforeDispatch) throw new FullTakeoffRunBudgetExhausted();
        this.spendingPaused = true;
        return blockedSource(request, `The ${error.scope} spending authorization is exhausted. The stage was not dispatched; review is required.`);
      }
      // A dispatched call may have consumed credit. Never retry or switch models automatically.
      if (error instanceof Error) this.terminalFailure = error;
      else this.terminalFailure = new UsageAccountingError();
      throw this.terminalFailure;
    }
  }
}

export class StageDeepPassProviderFactory implements FullTakeoffV2ProviderFactory {
  private readonly config: StageDeepPassConfig;
  private readonly fetcher: typeof fetch;
  private readonly sources: StageRuntimeSources;
  constructor(config: StageDeepPassConfig, fetcher: typeof fetch = fetch, sources: StageRuntimeSources = {}) { this.config = config; this.fetcher = fetcher; this.sources = sources; }
  async create(input: FactoryInput): Promise<DeepPassProvider> {
    input.signal?.throwIfAborted();
    await this.sources.prepareRun?.(input, this.config);
    input.signal?.throwIfAborted();
    return new StageDeepPassProvider(this.config, input, await splitPhysicalPages(input.fileBytes, input.manifest), this.fetcher, this.sources);
  }
}
export function createStageDeepPassProviderFactory(env: Record<string, string | undefined>, fetcher: typeof fetch = fetch, runtimeSources: StageRuntimeSources = {}): StageDeepPassProviderFactory {
  return new StageDeepPassProviderFactory(requireStageDeepPassConfig(env), fetcher, runtimeSources);
}
