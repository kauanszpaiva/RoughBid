import test from 'node:test';
import assert from 'node:assert/strict';
import { AiPlanReadingProcessor } from '../src/ai-plan/processor.ts';

test('AI plan processor reads rendered pages, stores findings, and requires review', async () => {
  const updates: Array<Record<string, unknown>> = [];
  let insertedFindings: Array<Record<string, unknown>> = [];
  const db = {
    from(table: string) {
      if (table === 'plan_reading_jobs') {
        return {
          select() { return this; },
          update(changes: Record<string, unknown>) { updates.push(changes); return this; },
          eq() { return this; },
          maybeSingle: async () => ({
            data: {
              id: 'job-1',
              workspace_id: 'workspace-1',
              project_id: 'project-1',
              file_id: 'file-1',
              input_summary: { scope_mode: 'selected_scope', requested_areas: ['Lobby'], requested_trades: ['architectural'] },
            },
            error: null,
          }),
        };
      }
      if (table === 'project_file_pages') {
        return {
          select() { return this; },
          eq() { return this; },
          order: async () => ({
            data: [
              { page_number: 1, storage_path: 'workspace-1/project-1/file-1/pages/0001.jpg' },
              { page_number: 2, storage_path: 'workspace-1/project-1/file-1/pages/0002.jpg' },
            ],
            error: null,
          }),
        };
      }
      assert.equal(table, 'plan_reading_findings');
      return {
        insert: async (rows: Array<Record<string, unknown>>) => {
          insertedFindings = rows;
          return { data: rows, error: null };
        },
      };
    },
  };
  const storage = {
    presign: async (_method: 'GET', key: string) => ({ url: `https://signed.roughbid.test/${key}`, method: 'GET' as const, headers: {}, expiresAt: new Date().toISOString() }),
  };
  const reader = {
    read: async (pages: unknown[], scope: unknown) => {
      assert.equal(pages.length, 2);
      assert.deepEqual(scope, { scope_mode: 'selected_scope', requested_areas: ['Lobby'], requested_trades: ['architectural'] });
      return {
        summary: {
          sheet_count: 2,
          detected_trade_scope: ['architectural'],
          scale_status: 'detected' as const,
          coverage: {
            pages_requested: 2,
            pages_analyzed: 2,
            requested_scope_mode: 'selected_scope' as const,
            requested_areas: ['Lobby'],
            requested_trades: ['architectural'],
            missing_or_unreadable_pages: [],
            limitations: [],
            completeness_status: 'complete' as const,
          },
          human_review_required: true as const,
        },
        findings: [{
          page_number: 1,
          finding_type: 'room' as const,
          label: 'Lobby',
          value_text: 'Lobby identified',
          quantity: null,
          unit: null,
          confidence: 0.9,
          geometry: {},
          source_excerpt: 'LOBBY',
        }],
      };
    },
  };

  const result = await new AiPlanReadingProcessor(db as never, storage, reader, 'workspace-1').process('job-1');
  assert.equal(result.status, 'needs_review');
  assert.equal(result.findingsStored, 1);
  assert.equal(insertedFindings[0]?.workspace_id, 'workspace-1');
  assert.equal(insertedFindings[0]?.label, 'Lobby');
  assert.equal(updates[0]?.status, 'processing');
  assert.equal(updates.at(-1)?.status, 'needs_review');
});
