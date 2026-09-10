import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { HttpClaudeMessagesClient, type ClaudeMessagesClient } from '../src/ai-plan/claude.ts';
import { AiProviderError } from '../src/ai-plan/provider-errors.ts';
import {
  ClaudeDeepPassProviderFactory,
  requireClaudeDeepPassConfig,
} from '../src/takeoff-v2/claude-provider.ts';
import { createPlanSetManifest } from '../src/takeoff-v2/preflight.ts';
import type { DeepPassRequest, DeepPassType } from '../src/takeoff-v2/types.ts';

const configured = {
  TAKEOFF_V2_ENABLED: 'true',
  TAKEOFF_V2_WORKER_ENABLED: 'true',
  TAKEOFF_V2_SCHEMA_VERSION: 'takeoff-v2-foundation-v1',
  TAKEOFF_V2_CLAUDE_ENABLED: 'true',
  TAKEOFF_V2_CLAUDE_ADAPTIVE_HIGH_VERIFIED: 'true',
  ANTHROPIC_API_KEY: 'sk-ant-unit-credential',
  TAKEOFF_V2_CLAUDE_MODEL: 'claude-sonnet-4-6',
};

function checkpoint(page: number, passType: DeepPassType, status: 'succeeded' | 'blocked' = 'succeeded') {
  return JSON.stringify({
    status,
    checkpoint: {
      version: 'claude-deep-v1', physical_page_number: page, pass_type: passType,
      observations: [{ kind: 'sheet_title', description: 'Architectural plan', source_excerpt: 'A-101 FLOOR PLAN', confidence: 0.97 }],
      blockers: status === 'blocked' ? ['Printed scale is marked NTS.'] : [],
    },
  });
}

async function fixture() {
  const pdf = await PDFDocument.create(); pdf.addPage([612, 792]); pdf.addPage([792, 612]);
  const bytes = new Uint8Array(await pdf.save());
  const manifest = await createPlanSetManifest(bytes);
  const request = (page: number, passType: DeepPassType = 'classification'): DeepPassRequest => ({
    runId: 'run-1', sheet: manifest.sheets[page - 1]!, passType, attempt: 1,
    idempotencyKey: `${page}-${passType}`, reasoningEffort: 'high',
  });
  return { bytes, manifest, request };
}

test('Claude Deep configuration is closed unless every worker/schema/model attestation is explicit', () => {
  for (const key of Object.keys(configured)) {
    assert.throws(() => requireClaudeDeepPassConfig({ ...configured, [key]: '' }), /unavailable/);
  }
  assert.throws(() => requireClaudeDeepPassConfig({ ...configured, TAKEOFF_V2_SCHEMA_VERSION: '20260910225937' }), /unavailable/);
  assert.throws(() => requireClaudeDeepPassConfig({ ...configured, TAKEOFF_V2_CLAUDE_MODEL: 'claude-placeholder' }), /unavailable/);
  assert.deepEqual(requireClaudeDeepPassConfig(configured), {
    apiKey: configured.ANTHROPIC_API_KEY,
    model: configured.TAKEOFF_V2_CLAUDE_MODEL,
  });
});

test('Claude Deep sends exactly one physical sheet with adaptive high effort and explicit metadata', async () => {
  const { bytes, manifest, request } = await fixture();
  let isolatedPages = 0;
  const client: ClaudeMessagesClient = { createMessage: async args => {
    assert.equal(args.model, 'claude-sonnet-4-6');
    assert.deepEqual(args.thinking, { type: 'adaptive' });
    assert.deepEqual(args.outputConfig, { effort: 'high' });
    assert.match(args.system, /physical page 2/i);
    const block = args.content.find((entry: any) => entry.type === 'document') as any;
    const isolated = await PDFDocument.load(Buffer.from(block.source.data, 'base64'));
    isolatedPages = isolated.getPageCount();
    return { text: checkpoint(2, 'classification'), stopReason: 'end_turn', usage: { inputTokens: 123, outputTokens: 45 } };
  } };
  const provider = await new ClaudeDeepPassProviderFactory(client, 'claude-sonnet-4-6').create({
    fileBytes: bytes, manifest, runId: 'run-1', workspaceId: 'workspace-1', projectId: 'project-1', fileId: 'file-1',
  });
  const result = await provider.runPass(request(2));
  assert.equal(isolatedPages, 1);
  assert.equal(result.provider, 'claude');
  assert.equal(result.model, 'claude-sonnet-4-6');
  assert.equal(result.inputTokens, 123);
  assert.equal(result.outputTokens, 45);
  assert.equal(result.checkpoint.physical_page_number, 2);
});

test('Claude Deep rejects cross-sheet/pass JSON and truncated output instead of checkpointing it', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { bytes, manifest, request } = await fixture();
  for (const response of [
    { text: checkpoint(1, 'classification') },
    { text: checkpoint(2, 'geometry'), stopReason: 'max_tokens' },
    { text: '{"status":"succeeded","checkpoint":[]}' },
  ]) {
    const provider = await new ClaudeDeepPassProviderFactory({ createMessage: async () => response }, 'claude-sonnet-4-6').create({
      fileBytes: bytes, manifest, runId: 'run-1', workspaceId: 'workspace-1', projectId: 'project-1', fileId: 'file-1',
    });
    await assert.rejects(provider.runPass(request(2)), (error: unknown) => error instanceof AiProviderError
      && ['provider_invalid_output', 'provider_output_truncated'].includes(error.diagnostic.code));
  }
});

test('Claude Deep makes no further provider requests after credential/quota/payment-class failures', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { bytes, manifest, request } = await fixture();
  for (const status of [401, 402, 403, 429]) {
    let calls = 0;
    const provider = await new ClaudeDeepPassProviderFactory({ createMessage: async () => {
      calls += 1;
      throw Object.assign(new Error('private upstream detail'), { status });
    } }, 'claude-sonnet-4-6').create({
      fileBytes: bytes, manifest, runId: 'run-1', workspaceId: 'workspace-1', projectId: 'project-1', fileId: 'file-1',
    });
    await assert.rejects(provider.runPass(request(1)), AiProviderError);
    await assert.rejects(provider.runPass(request(2)), AiProviderError);
    assert.equal(calls, 1);
  }
});

test('Anthropic HTTP transport sends adaptive effort and exposes only bounded status/usage metadata', async () => {
  let body: any;
  const client = new HttpClaudeMessagesClient('server-secret', (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } });
  }) as typeof fetch);
  const result = await client.createMessage({
    model: 'claude-sonnet-4-6', system: 'system', maxTokens: 100, content: [{ type: 'text', text: 'request' }],
    thinking: { type: 'adaptive' }, outputConfig: { effort: 'high' },
  });
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, { effort: 'high' });
  assert.deepEqual(result, { text: '{}', stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 3 } });

  const denied = new HttpClaudeMessagesClient('server-secret', (async () => new Response('private', { status: 402 })) as typeof fetch);
  await assert.rejects(denied.createMessage({ model: 'claude-sonnet-4-6', system: 's', maxTokens: 1, content: [] }),
    (error: any) => error.status === 402 && !error.message.includes('private'));
});
