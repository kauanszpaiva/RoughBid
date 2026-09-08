import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { AiPlanReadingService } from '../src/ai-plan/service.ts';
import { ProjectApiError } from '../src/projects/service.ts';

const workspaceId = 'workspace-1';
const jobId = 'job-saved';
const persisted = {
  id: jobId, workspace_id: workspaceId, project_id: 'project-1', status: 'needs_review',
  processing_error: null, output_summary: { sheet_count: 23 },
  plan_reading_findings: [{ id: 'finding-1', label: 'Kitchen', page_number: 2, source_excerpt: 'KITCHEN', status: 'needs_review' }],
};

function serviceFor(fetcher: typeof fetch) {
  const db = createClient('https://database.test', 'sb_publishable_not_a_live_key', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetcher },
  });
  return new AiPlanReadingService(db as never,
    { from: () => { throw new Error('Reload must not write'); } },
    { presign: async () => { throw new Error('Reload must not download or resend the PDF'); } },
    { read: async () => { throw new Error('Reload must not run the provider again'); } },
    'user-1', workspaceId);
}

test('a completed reading reloads its persisted findings through an unambiguous tenant-scoped relationship', async () => {
  const requests: URL[] = [];
  const service = serviceFor((async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(url);
    const select = url.searchParams.get('select') ?? '';
    // Production has both a job_id FK and a composite tenant/job FK. PostgREST
    // rejects an unqualified embedding before it can return a saved reading.
    if (select.includes('plan_reading_findings(')) {
      return Response.json({ code: 'PGRST201', message: 'Could not embed because more than one relationship was found' }, { status: 300 });
    }
    const scoped = url.pathname === '/rest/v1/plan_reading_jobs'
      && url.searchParams.get('workspace_id') === `eq.${workspaceId}`
      && url.searchParams.get('id') === `eq.${jobId}`
      && select.includes('plan_reading_findings!plan_reading_findings_job_workspace_project_file_fkey(');
    return Response.json(scoped ? [persisted] : []);
  }) as typeof fetch);

  const actual = await service.get(jobId);
  assert.equal(actual.id, jobId);
  assert.equal(actual.status, 'needs_review');
  assert.equal(actual.output_summary.sheet_count, 23);
  assert.equal(actual.plan_reading_findings[0].label, 'Kitchen');
  assert.equal(requests.length, 1);
});

test('an inaccessible saved reading remains a 404 and never creates a replacement analysis', async () => {
  const service = serviceFor((async () => Response.json([])) as typeof fetch);
  await assert.rejects(service.get('other-tenant-job'), (error: unknown) => error instanceof ProjectApiError && error.status === 404);
});

test('a legacy synthetic reading is still rejected after reload repair', async () => {
  const service = serviceFor((async () => Response.json([{ ...persisted, output_summary: { synthetic: true } }])) as typeof fetch);
  await assert.rejects(service.get(jobId), (error: unknown) => error instanceof ProjectApiError && error.status === 409);
});
