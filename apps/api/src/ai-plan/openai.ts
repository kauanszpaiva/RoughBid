export interface PlanPageInput {
  pageNumber: number;
  imageUrl: string;
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

const outputSchema = {
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
        human_review_required: { type: 'boolean', const: true },
      },
      required: ['sheet_count', 'detected_trade_scope', 'scale_status', 'human_review_required'],
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

  async read(pages: PlanPageInput[], scope: string | null = null): Promise<PlanReadingResult> {
    if (!pages.length) throw new Error('At least one rendered plan page is required');
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
              text: 'You are RoughBid, an estimating assistant for construction plans. Extract only evidence visible on the provided plan pages. Do not invent quantities. Mark ambiguity as questions or risks. Every finding must include page evidence, confidence, and human review should remain required.',
            }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `Read these rendered plan pages for takeoff preparation.${scope ? ` Requested scope: ${scope}` : ''}`,
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
