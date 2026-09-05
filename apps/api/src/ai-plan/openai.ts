export interface PlanPageInput {
  pageNumber: number;
  imageUrl: string;
}

export type PlanReadingScopeMode = 'all_trades' | 'selected_scope';
export type PlanReadingTrade =
  | 'architectural'
  | 'structural'
  | 'mep'
  | 'electrical'
  | 'plumbing'
  | 'hvac'
  | 'fire_protection'
  | 'sitework'
  | 'finishes'
  | 'general';

export interface PlanReadingScopeInput {
  mode: PlanReadingScopeMode;
  requestedAreas: string[];
  trades: PlanReadingTrade[];
  legacyScope: string | null;
}

export interface PlanReadingFinding {
  page_number: number | null;
  finding_type: 'measurement' | 'symbol' | 'room' | 'scope_note' | 'risk' | 'question' | 'material';
  label: string;
  value_text: string | null;
  quantity: number | null;
  unit: string | null;
  confidence: number;
  geometry: Record<string, unknown>;
  source_excerpt: string | null;
}

export interface PlanReadingResult {
  summary: {
    sheet_count: number;
    detected_trade_scope: string[];
    scale_status: 'detected' | 'missing' | 'conflicting';
    coverage: {
      pages_requested: number;
      pages_analyzed: number;
      requested_scope_mode: PlanReadingScopeMode;
      requested_areas: string[];
      requested_trades: string[];
      missing_or_unreadable_pages: number[];
      limitations: string[];
      completeness_status: 'complete' | 'partial' | 'blocked';
    };
    human_review_required: true;
  };
  findings: PlanReadingFinding[];
}

const findingSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page_number: { type: ['integer', 'null'] },
    finding_type: { type: 'string', enum: ['measurement', 'symbol', 'room', 'scope_note', 'risk', 'question', 'material'] },
    label: { type: 'string' },
    value_text: { type: ['string', 'null'] },
    quantity: { type: ['number', 'null'] },
    unit: { type: ['string', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    geometry: { type: 'object', additionalProperties: true },
    source_excerpt: { type: ['string', 'null'] },
  },
  required: ['page_number', 'finding_type', 'label', 'value_text', 'quantity', 'unit', 'confidence', 'geometry', 'source_excerpt'],
};

export const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sheet_count: { type: 'integer' },
        detected_trade_scope: { type: 'array', items: { type: 'string' } },
        scale_status: { type: 'string', enum: ['detected', 'missing', 'conflicting'] },
        coverage: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pages_requested: { type: 'integer' },
            pages_analyzed: { type: 'integer' },
            requested_scope_mode: { type: 'string', enum: ['all_trades', 'selected_scope'] },
            requested_areas: { type: 'array', items: { type: 'string' } },
            requested_trades: { type: 'array', items: { type: 'string' } },
            missing_or_unreadable_pages: { type: 'array', items: { type: 'integer' } },
            limitations: { type: 'array', items: { type: 'string' } },
            completeness_status: { type: 'string', enum: ['complete', 'partial', 'blocked'] },
          },
          required: ['pages_requested', 'pages_analyzed', 'requested_scope_mode', 'requested_areas', 'requested_trades', 'missing_or_unreadable_pages', 'limitations', 'completeness_status'],
        },
        human_review_required: { type: 'boolean', const: true },
      },
      required: ['sheet_count', 'detected_trade_scope', 'scale_status', 'coverage', 'human_review_required'],
    },
    findings: { type: 'array', items: findingSchema },
  },
  required: ['summary', 'findings'],
};

function extractOutputText(payload: any): string {
  if (typeof payload.output_text === 'string') return payload.output_text;
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  throw new Error('OpenAI response did not contain output text');
}

export const MAX_COMMERCIAL_PLAN_PAGES = 60;

const planReadingTrades: PlanReadingTrade[] = ['architectural', 'structural', 'mep', 'electrical', 'plumbing', 'hvac', 'fire_protection', 'sitework', 'finishes', 'general'];

export function normalizePlanReadingScope(input: unknown): PlanReadingScopeInput {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const mode = (record.scopeMode ?? record.scope_mode) === 'selected_scope' ? 'selected_scope' : 'all_trades';
  const areas = record.requestedAreas ?? record.requested_areas;
  const trades = record.trades ?? record.requested_trades;
  const requestedAreas = Array.isArray(areas)
    ? areas.filter((area): area is string => typeof area === 'string').map((area) => area.trim().slice(0, 200)).filter(Boolean).slice(0, 20)
    : [];
  const requestedTrades = Array.isArray(trades)
    ? trades.filter((trade): trade is PlanReadingTrade => typeof trade === 'string' && planReadingTrades.includes(trade as PlanReadingTrade)).slice(0, 10)
    : [];
  const context = record.scope ?? record.requested_scope;
  const legacyScope = typeof context === 'string' && context.trim() ? context.trim().slice(0, 500) : null;
  return {
    mode,
    requestedAreas: mode === 'selected_scope' ? requestedAreas : [],
    trades: requestedTrades.length ? requestedTrades : planReadingTrades,
    legacyScope,
  };
}

export function assertCommercialPlanPageLimit(pages: PlanPageInput[]) {
  if (!pages.length) throw new Error('At least one rendered plan page is required');
  if (pages.length > MAX_COMMERCIAL_PLAN_PAGES) throw new Error(`RoughBid currently supports up to ${MAX_COMMERCIAL_PLAN_PAGES} rendered plan pages per AI reading job`);
}

export function buildPlanReadingRequestText(pages: PlanPageInput[], scope: PlanReadingScopeInput): string {
  const requestedPages = pages.map((page) => page.pageNumber).join(', ');
  const areaText = scope.mode === 'selected_scope' && scope.requestedAreas.length
    ? `Focus areas/rooms/zones: ${scope.requestedAreas.join('; ')}.`
    : 'Analyze all visible areas, rooms, sheets, schedules, notes, symbols, and construction scopes.';
  return [
    `Read this commercial construction plan set for takeoff preparation. Pages requested: ${pages.length} (${requestedPages}).`,
    `Scope mode: ${scope.mode}. ${areaText}`,
    `Trades requested: ${scope.trades.join(', ')}.`,
    scope.legacyScope ? `Legacy project context: ${scope.legacyScope}.` : '',
    'Return every material, room, schedule, measurement, symbol, scope note, risk, and question that is visible and relevant to the requested scope.',
    'For a 60-page plan set, maintain page-level coverage. If any page is unreadable, missing, low confidence, lacks scale, or has conflicting evidence, list it in coverage.missing_or_unreadable_pages and coverage.limitations.',
    'Do not claim completeness unless each requested page was inspected and every requested trade or selected area has evidence or an explicit no-visible-evidence note.',
  ].filter(Boolean).join('\n');
}

export class OpenAiPlanReader {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetcher: typeof fetch;

  constructor(apiKey: string, model = 'gpt-4.1', fetcher: typeof fetch = fetch) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is required');
    this.apiKey = apiKey;
    this.model = model;
    this.fetcher = fetcher;
  }

  async read(pages: PlanPageInput[], scopeInput: unknown = null): Promise<PlanReadingResult> {
    assertCommercialPlanPageLimit(pages);
    const scope = normalizePlanReadingScope(scopeInput);
    const response = await this.fetcher('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          {
            role: 'system',
            content: [{
              type: 'input_text',
              text: 'You are RoughBid, an estimating assistant for US commercial construction plans. Extract only evidence visible on the provided plan pages. Do not invent quantities, prices, code requirements, or hidden dimensions. Mark ambiguity as questions or risks. Every finding must include page evidence, confidence, geometry when possible, and human review should remain required.',
            }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: buildPlanReadingRequestText(pages, scope),
              },
              ...pages.map((page) => ({
                type: 'input_image',
                image_url: page.imageUrl,
                detail: 'high',
              })),
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'roughbid_plan_reading',
            strict: true,
            schema: outputSchema,
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`OpenAI plan reading failed (${response.status})`);
    return JSON.parse(extractOutputText(await response.json())) as PlanReadingResult;
  }
}
