import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAiCompatibleVisionPlanReader,
  requireOpenAiVisionConfig,
} from '../src/ai-plan/openai-vision.ts';
import { ClaudePlanReader, requireClaudePlanReadingConfig, type ClaudeMessagesClient } from '../src/ai-plan/claude.ts';
import { GeminiPlanReader } from '../src/ai-plan/gemini.ts';
import type { DrawingLinework } from '../src/ai-plan/drawing-linework.ts';

const linework: DrawingLinework = {
  pageLimit: 24,
  truncated: false,
  pages: [{
    pageNumber: 1,
    pageWidthPoints: 612,
    pageHeightPoints: 792,
    rotationDegrees: 0,
    paths: 5,
    segments: 11,
    curvedSegments: 0,
    strokedPaths: 3,
    filledPaths: 2,
    clippedPaths: 0,
    totalLengthPoints: 2102.34,
    horizontal: { count: 5, totalLengthPoints: 1148, longestPoints: 468 },
    vertical: { count: 5, totalLengthPoints: 860, longestPoints: 400 },
    diagonal: { count: 1, totalLengthPoints: 94.3, longestPoints: 94.3 },
    wallLikeSegments: 6,
    regions: [{ bbox: [0.3268, 0.2677, 0.3922, 0.2273], widthPoints: 240, heightPoints: 180, vertices: 4, areaPoints2: 43200 }],
    truncated: false,
  }],
};

const baseInput = {
  fileBytes: new Uint8Array([37, 80, 68, 70]),
  mimeType: 'application/pdf',
  sheetName: 'A-101',
  requestedTrades: ['Framing'],
  scope: 'Addition',
};

test('OpenAI plan reading stays closed until its key, model and enable flag are all verified', () => {
  const enabled = { OPENAI_PLAN_READING_ENABLED: 'true', OPENAI_API_KEY: 'sk-test-value' };
  assert.throws(() => requireOpenAiVisionConfig({}), /disabled/i);
  assert.throws(() => requireOpenAiVisionConfig({ OPENAI_PLAN_READING_ENABLED: 'true' }), /not configured/i);
  assert.throws(() => requireOpenAiVisionConfig({ ...enabled, OPENAI_MODEL: 'not-a-model' }), /not configured/i);
  assert.throws(() => requireOpenAiVisionConfig({ ...enabled, OPENAI_BASE_URL: 'https://evil.example/v1' }), /approved HTTPS host/i);
  assert.throws(() => requireOpenAiVisionConfig({ ...enabled, OPENAI_BASE_URL: 'http://api.openai.com/v1' }), /approved HTTPS host/i);

  const config = requireOpenAiVisionConfig(enabled);
  assert.equal(config.provider, 'openai');
  assert.equal(config.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.model, 'gpt-5.4');
  assert.equal(requireOpenAiVisionConfig({ ...enabled, OPENAI_MODEL: 'gpt-5.1', OPENAI_BASE_URL: 'https://api.openai.com/v1/' }).baseUrl, 'https://api.openai.com/v1');
});

test('Claude plan reading stays closed until its flag and an exact model are verified', () => {
  assert.throws(() => requireClaudePlanReadingConfig({ ANTHROPIC_API_KEY: 'sk-ant' }), /not configured/i);
  assert.throws(() => requireClaudePlanReadingConfig({ CLAUDE_PLAN_READING_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-ant', CLAUDE_PLAN_MODEL: 'gpt-4.1' }), /not configured/i);
  const config = requireClaudePlanReadingConfig({ CLAUDE_PLAN_READING_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-ant-test' });
  assert.equal(config.model, 'claude-sonnet-4-5');
});

test('OpenAI reads the plan document directly and receives the measured linework', async () => {
  let body: any = null;
  const reader = new OpenAiCompatibleVisionPlanReader(
    { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1', maxImages: 8 },
    async (url, init) => {
      assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
      body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({
        id: 'req_1',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: { sheet_count: 1 }, findings: [{ page_number: 1, finding_type: 'room', label: 'LIVING', quantity: null, unit: null, confidence: 0.8, source_excerpt: 'LIVING' }] }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200 });
    },
  );
  const result = await reader.read({ ...baseInput, linework });
  assert.equal(result.findings.length, 1);
  const userContent = body.messages[1].content;
  const filePart = userContent.find((part: any) => part.type === 'file');
  assert.ok(filePart, 'the plan PDF is attached directly for OpenAI');
  assert.match(filePart.file.file_data, /^data:application\/pdf;base64,/);
  const digestPart = userContent.find((part: any) => part.type === 'text' && /DETERMINISTIC VECTOR LINEWORK/.test(part.text));
  assert.ok(digestPart, 'the measured linework digest is sent with the plan');
  assert.match(digestPart.text, /1 closed region\(s\), largest 240x180pt/);
  assert.match(body.messages[0].content, /DETERMINISTIC VECTOR LINEWORK block is provided/);
});

test('OpenAI still prefers rendered page images when the renderer supplied them', async () => {
  let body: any = null;
  const reader = new OpenAiCompatibleVisionPlanReader(
    { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1', maxImages: 8 },
    async (_url, init) => {
      body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: { sheet_count: 1 }, findings: [{ page_number: 1, finding_type: 'room', label: 'LIVING', quantity: null, unit: null, confidence: 0.8, source_excerpt: 'LIVING' }] }) } }] }), { status: 200 });
    },
  );
  await reader.read({ ...baseInput, linework, pageImages: [{ pageNumber: 1, bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }] });
  const userContent = body.messages[1].content;
  assert.equal(userContent.some((part: any) => part.type === 'file'), false);
  const image = userContent.find((part: any) => part.type === 'image_url');
  assert.equal(image.image_url.detail, 'high');
});

test('image-native providers still fail closed without rendered pages or an OpenAI route', async () => {
  let called = false;
  const reader = new OpenAiCompatibleVisionPlanReader(
    { provider: 'kimi', apiKey: 'k', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k2.6', maxImages: 8 },
    async () => { called = true; throw new Error('no network expected'); },
  );
  await assert.rejects(reader.read({ ...baseInput, linework }), /requires server-rendered plan page images/i);
  assert.equal(called, false);
});

test('Gemini receives the measured linework as an extra prompt part, not as the plan itself', async () => {
  let contents: any[] = [];
  const client = {
    generateContent: async (args: { contents: unknown[] }) => {
      contents = args.contents as any[];
      return { text: JSON.stringify({ summary: { sheet_count: 1 }, findings: [{ page_number: 1, finding_type: 'room', label: 'LIVING', quantity: null, unit: null, confidence: 0.8, source_excerpt: 'LIVING' }] }) };
    },
  };
  const result = await new GeminiPlanReader(client, ['gemini-3.8-flash']).read({ ...baseInput, linework });
  assert.equal(result.findings.length, 1);
  const digest = contents.find(part => typeof part.text === 'string' && part.text.includes('DETERMINISTIC VECTOR LINEWORK'));
  assert.ok(digest, 'the digest is sent alongside the PDF');
  assert.match(digest.text, /Page 1: 612x792pt rot 0/);
  assert.ok(contents.some(part => part.inlineData?.mimeType === 'application/pdf'));
});

test('Gemini omits the linework part entirely when no linework was read', async () => {
  let contents: any[] = [];
  const client = {
    generateContent: async (args: { contents: unknown[] }) => {
      contents = args.contents as any[];
      return { text: JSON.stringify({ summary: { sheet_count: 1 }, findings: [{ page_number: 1, finding_type: 'room', label: 'LIVING', quantity: null, unit: null, confidence: 0.8, source_excerpt: 'LIVING' }] }) };
    },
  };
  await new GeminiPlanReader(client, ['gemini-3.8-flash']).read(baseInput);
  assert.equal(contents.length, 2);
});

test('Claude receives the plan document plus the measured linework and still parses its JSON', async () => {
  let content: any[] = [];
  const client: ClaudeMessagesClient = {
    createMessage: async (args) => {
      content = args.content as any[];
      return {
        text: JSON.stringify({ summary: { sheet_count: 1 }, findings: [{ page_number: 1, finding_type: 'material', label: 'Drywall', quantity: 120, unit: 'SF', confidence: 0.8, source_excerpt: 'Drywall 120 SF' }] }),
        usage: { inputTokens: 12, outputTokens: 7 },
      };
    },
  };
  const result = await new ClaudePlanReader(client, 'claude-sonnet-4-5').read({ ...baseInput, linework });
  assert.equal(result.findings.length, 1);
  assert.ok(content.some(part => part.type === 'document'), 'the PDF is sent as a document block');
  assert.ok(content.some(part => part.type === 'text' && part.text.includes('DETERMINISTIC VECTOR LINEWORK')), 'the digest is sent too');
});

test('Claude reports a classified provider failure instead of silently inventing output', async () => {
  const client: ClaudeMessagesClient = { createMessage: async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); } };
  await assert.rejects(new ClaudePlanReader(client, 'claude-sonnet-4-5').read(baseInput), (error: any) => {
    assert.match(error.message, /No quantities were generated/);
    assert.equal(error.diagnostic?.code, 'provider_quota');
    return true;
  });
  await assert.rejects(new ClaudePlanReader(null).read(baseInput), /No quantities were generated/);
});