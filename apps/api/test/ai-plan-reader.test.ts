import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCommercialPlanPageLimit,
  buildPlanReadingRequestText,
  normalizePlanReadingScope,
  OpenAiPlanReader,
  type PlanPageInput,
} from '../src/ai-plan/openai.ts';

const sixtyPages: PlanPageInput[] = Array.from({ length: 60 }, (_, index) => ({
  pageNumber: index + 1,
  imageUrl: `https://storage.roughbid.test/plans/commercial/page-${String(index + 1).padStart(4, '0')}.jpg`,
}));

test('AI plan reader accepts a 60-page commercial plan set and sends every page image', async () => {
  let requestBody: any;
  const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        summary: {
          sheet_count: 60,
          detected_trade_scope: ['architectural', 'structural', 'mep'],
          scale_status: 'detected',
          coverage: {
            pages_requested: 60,
            pages_analyzed: 60,
            requested_scope_mode: 'all_trades',
            requested_areas: [],
            requested_trades: ['architectural', 'structural', 'mep'],
            missing_or_unreadable_pages: [],
            limitations: [],
            completeness_status: 'complete',
          },
          human_review_required: true,
        },
        findings: [{
          page_number: 1,
          finding_type: 'room',
          label: 'Lobby',
          value_text: 'Lobby shown on page 1',
          quantity: null,
          unit: null,
          confidence: 0.88,
          geometry: {},
          source_excerpt: 'LOBBY',
        }],
      }),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const reader = new OpenAiPlanReader('sk-test', 'gpt-test', fetchMock as typeof fetch);
  const result = await reader.read(sixtyPages, {
    scopeMode: 'all_trades',
    trades: ['architectural', 'structural', 'mep'],
    scope: 'Commercial buildout',
  });

  assert.equal(result.summary.coverage.pages_requested, 60);
  const userContent = requestBody.input[1].content;
  assert.equal(userContent.filter((item: { type: string }) => item.type === 'input_image').length, 60);
  assert.match(userContent[0].text, /Pages requested: 60/);
  assert.match(userContent[0].text, /Scope mode: all_trades/);
  assert.match(userContent[0].text, /Do not claim completeness/);
  assert.match(requestBody.input[0].content[0].text, /Do not invent quantities, prices, code requirements, or hidden dimensions/);
});

test('AI plan reader supports selected areas and trades for nontechnical takeoff review', () => {
  const scope = normalizePlanReadingScope({
    scopeMode: 'selected_scope',
    requestedAreas: ['Lobby', 'A-201 second floor', '', ' bathrooms '],
    trades: ['architectural', 'finishes', 'unknown'],
    scope: 'Office renovation',
  });
  const text = buildPlanReadingRequestText(sixtyPages.slice(0, 2), scope);

  assert.deepEqual(scope.requestedAreas, ['Lobby', 'A-201 second floor', 'bathrooms']);
  assert.deepEqual(scope.trades, ['architectural', 'finishes']);
  assert.match(text, /Scope mode: selected_scope/);
  assert.match(text, /Focus areas\/rooms\/zones: Lobby; A-201 second floor; bathrooms/);
  assert.match(text, /Trades requested: architectural, finishes/);
});

test('AI plan reader rejects plan sets above the declared commercial page limit', () => {
  assertCommercialPlanPageLimit(sixtyPages);
  assert.throws(() => assertCommercialPlanPageLimit([...sixtyPages, { pageNumber: 61, imageUrl: 'https://example.test/61.jpg' }]), /up to 60/);
});
