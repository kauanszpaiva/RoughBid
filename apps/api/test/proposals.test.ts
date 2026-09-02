import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPdfRenderer, ProposalService, renderProposalHtml } from '../src/proposals/service.ts';
import type { Estimate } from '../src/estimates/service.ts';

const estimate: Estimate = {
  id: 'est-1', workspaceId: 'ws-1', projectId: 'project-1', createdBy: 'user-1', version: 2, status: 'final',
  materialCost: 1000, laborCost: 500, equipmentCost: 100, otherCost: 50, overheadPercent: 10, markupPercent: 20,
  directCost: 1650, overheadAmount: 165, costWithOverhead: 1815, markupAmount: 363, finalPrice: 2178, grossMarginPercent: 16.67,
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'), finalizedAt: new Date('2026-01-02'),
};
const data = { estimate, projectName: '<School>', customer: { name: 'A & B' }, brand: { companyName: 'RoughBid', accentColor: '#123456' } };

test('proposal HTML is branded, escaped, and contains estimate totals', () => {
  const html = renderProposalHtml(data);
  assert.match(html, /#123456/);
  assert.match(html, /&lt;School&gt;/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /\$2,178\.00/);
});

test('proposal jobs only export final estimates into private workspace paths', async () => {
  const writes: string[] = [];
  const service = new ProposalService({ render: async () => new Uint8Array([37, 80, 68, 70]) }, {
    put: async (path) => { writes.push(path); }, createDownloadUrl: async (path) => `signed://${path}`,
  });
  assert.throws(() => service.enqueue({ ...data, estimate: { ...estimate, status: 'draft' } }), /finalized/i);
  const job = service.enqueue(data);
  const completed = await service.process(job.id, data);
  assert.equal(completed.status, 'complete');
  assert.deepEqual(writes, ['ws-1/proposals/est-1/v2.pdf']);
  assert.match((await service.download(job.id, 'ws-1')).url, /^signed:/);
  await assert.rejects(service.download(job.id, 'other-workspace'), /not found/i);
});

test('browser renderer closes the browser after rendering', async () => {
  let closed = false;
  const renderer = new BrowserPdfRenderer(async () => ({
    newPage: async () => ({ setContent: async () => {}, pdf: async () => new Uint8Array([1]) }),
    close: async () => { closed = true; },
  }));
  assert.deepEqual(await renderer.render('<html></html>'), new Uint8Array([1]));
  assert.equal(closed, true);
});
