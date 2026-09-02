import type { Estimate } from '../estimates/service.ts';

export type ProposalBrand = {
  companyName: string;
  accentColor?: string;
  logoUrl?: string;
  contactLine?: string;
};

export type ProposalCustomer = {
  name: string;
  company?: string;
  email?: string;
};

export type ProposalData = {
  estimate: Estimate;
  projectName: string;
  customer: ProposalCustomer;
  brand: ProposalBrand;
  currency?: string;
  notes?: string;
};

export interface PdfRenderer {
  render(html: string): Promise<Uint8Array>;
}

export interface ProposalStorage {
  put(path: string, contents: Uint8Array, contentType: 'application/pdf'): Promise<void>;
  createDownloadUrl(path: string, expiresInSeconds: number): Promise<string>;
}

export type ProposalJob = {
  id: string;
  workspaceId: string;
  estimateId: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  storagePath?: string;
  error?: string;
};

/** A queue-independent worker: call process from a serverless task or queue consumer. */
export class ProposalService {
  readonly jobs = new Map<string, ProposalJob>();
  #sequence = 0;
  private readonly renderer: PdfRenderer;
  private readonly storage: ProposalStorage;

  constructor(renderer: PdfRenderer, storage: ProposalStorage) {
    this.renderer = renderer;
    this.storage = storage;
  }

  enqueue(data: ProposalData): ProposalJob {
    if (data.estimate.status !== 'final') throw new Error('Only finalized estimates can be exported.');
    const job: ProposalJob = {
      id: `proposal-${++this.#sequence}`,
      workspaceId: data.estimate.workspaceId,
      estimateId: data.estimate.id,
      status: 'queued',
    };
    this.jobs.set(job.id, job);
    return { ...job };
  }

  async process(jobId: string, data: ProposalData): Promise<ProposalJob> {
    const job = this.requireJob(jobId, data.estimate.workspaceId);
    if (job.estimateId !== data.estimate.id) throw new Error('Proposal data does not match the queued estimate.');
    job.status = 'processing';
    try {
      const pdf = await this.renderer.render(renderProposalHtml(data));
      if (!pdf.byteLength) throw new Error('PDF renderer returned an empty document.');
      const path = `${job.workspaceId}/proposals/${job.estimateId}/v${data.estimate.version}.pdf`;
      await this.storage.put(path, pdf, 'application/pdf');
      Object.assign(job, { status: 'complete' as const, storagePath: path });
      return { ...job };
    } catch (error) {
      Object.assign(job, { status: 'failed' as const, error: error instanceof Error ? error.message : 'PDF generation failed' });
      throw error;
    }
  }

  async download(jobId: string, workspaceId: string): Promise<{ url: string; expiresInSeconds: number }> {
    const job = this.requireJob(jobId, workspaceId);
    if (job.status !== 'complete' || !job.storagePath) throw new Error('Proposal is not ready.');
    const expiresInSeconds = 300;
    return { url: await this.storage.createDownloadUrl(job.storagePath, expiresInSeconds), expiresInSeconds };
  }

  private requireJob(jobId: string, workspaceId: string): ProposalJob {
    const job = this.jobs.get(jobId);
    if (!job || job.workspaceId !== workspaceId) throw new Error('Proposal job not found.');
    return job;
  }
}

/** Adapter for Playwright/Puppeteer-compatible Page and Browser objects. */
export class BrowserPdfRenderer implements PdfRenderer {
  private readonly browserFactory: () => Promise<BrowserLike>;

  constructor(browserFactory: () => Promise<BrowserLike>) {
    this.browserFactory = browserFactory;
  }

  async render(html: string): Promise<Uint8Array> {
    const browser = await this.browserFactory();
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle' });
      const bytes = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '16mm', right: '16mm', bottom: '16mm', left: '16mm' } });
      return new Uint8Array(bytes);
    } finally {
      await browser.close();
    }
  }
}

type BrowserLike = {
  newPage(): Promise<{ setContent(html: string, options: { waitUntil: 'networkidle' }): Promise<void>; pdf(options: object): Promise<ArrayBufferLike | Uint8Array> }>;
  close(): Promise<void>;
};

export function renderProposalHtml(data: ProposalData): string {
  const { estimate } = data;
  const currency = data.currency ?? 'USD';
  const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
  const color = /^#[0-9a-f]{6}$/i.test(data.brand.accentColor ?? '') ? data.brand.accentColor : '#17324d';
  const rows = [
    ['Materials', estimate.materialCost], ['Labor', estimate.laborCost], ['Equipment', estimate.equipmentCost], ['Other', estimate.otherCost],
    ['Overhead', estimate.overheadAmount], ['Markup', estimate.markupAmount],
  ].map(([label, amount]) => `<tr><td>${escapeHtml(String(label))}</td><td>${money(Number(amount))}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4;margin:0}*{box-sizing:border-box}body{font:14px Arial,sans-serif;color:#24313d;margin:0}.header{border-top:10px solid ${color};display:flex;justify-content:space-between;padding-top:22px}.logo{max-height:54px;max-width:180px}h1{color:${color};font-size:30px;margin:38px 0 8px}.meta{color:#657380}.card{background:#f5f7f9;border-radius:8px;padding:18px;margin:24px 0}table{width:100%;border-collapse:collapse}td{padding:10px;border-bottom:1px solid #dfe5ea}td:last-child{text-align:right}.total{font-size:22px;font-weight:bold;color:${color};display:flex;justify-content:space-between;padding:18px 10px}.footer{margin-top:42px;color:#657380;font-size:12px}
  </style></head><body><header class="header"><div><strong>${escapeHtml(data.brand.companyName)}</strong><div class="meta">${escapeHtml(data.brand.contactLine ?? '')}</div></div>${data.brand.logoUrl ? `<img class="logo" src="${escapeHtml(data.brand.logoUrl)}" alt="">` : ''}</header><h1>Estimate Proposal</h1><div class="meta">${escapeHtml(data.projectName)} · Estimate v${estimate.version}</div><section class="card"><strong>Prepared for</strong><div>${escapeHtml(data.customer.name)}</div><div class="meta">${escapeHtml(data.customer.company ?? '')}${data.customer.email ? ` · ${escapeHtml(data.customer.email)}` : ''}</div></section><table>${rows}</table><div class="total"><span>Proposal total</span><span>${money(estimate.finalPrice)}</span></div>${data.notes ? `<section class="card"><strong>Notes</strong><p>${escapeHtml(data.notes)}</p></section>` : ''}<footer class="footer">Prepared by ${escapeHtml(data.brand.companyName)} · Finalized ${escapeHtml(estimate.finalizedAt?.toISOString().slice(0, 10) ?? '')}</footer></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}
