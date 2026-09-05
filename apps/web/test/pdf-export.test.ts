import test from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Project } from '../app/src/types/index.ts';
import { buildClientProposalPDF, buildInternalEstimatePDF } from '../app/src/utils/pdfExport.ts';

function projectWithLines(count: number, longMetadata = false): Project {
  return {
    id: 'pdf-project', name: longMetadata ? 'Residential renovation project '.repeat(6) + 'PROJECT_END' : 'Residential renovation',
    clientName: longMetadata ? 'Client and contracting company '.repeat(5) + 'CLIENT_END' : 'Client',
    address: longMetadata ? '123 Long Avenue, Building 4, Suite 250, '.repeat(12) + 'ADDRESS_END' : '123 Main Street',
    projectType: 'Renovation', status: 'In Progress', updatedAt: 'now',
    overheadPercentage: 10, markupPercentage: 20, quantities: [],
    revisions: [{
      id: 'rev-1', revisionNumber: '01', fileName: longMetadata ? 'Architectural drawings and structural details '.repeat(5) + 'PLAN_END.pdf' : 'Plans.pdf',
      fileSize: '1 MB', pages: 1, uploadDate: '2026-09-05', uploadedBy: 'Estimator', isCurrent: true,
    }],
    estimateItems: Array.from({ length: count }, (_, index) => ({
      id: 'line-' + index, name: 'Ordinary estimate item ' + (index + 1), quantity: 1, unit: 'EA',
      materialCost: 70, laborCost: 25, equipmentCost: 5, directCost: 100,
    })),
  };
}

async function inspectPdf(doc: ReturnType<typeof buildClientProposalPDF>) {
  const bytes = new Uint8Array(doc.output('arraybuffer'));
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  const loading = getDocument({ data: bytes, useSystemFonts: true });
  const pdf = await loading.promise;
  const text: string[] = [];
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const x = item.transform[4]!;
        const baselineY = viewport.height - item.transform[5]!;
        assert.ok(baselineY >= item.height - 1 && baselineY <= viewport.height - 20,
          `Page ${number} vertical overflow at ${baselineY}: ${item.str}`);
        assert.ok(x >= 20 && x + item.width <= viewport.width - 20,
          `Page ${number} horizontal overflow at ${x}: ${item.str}`);
        text.push(item.str);
      }
    }
    return { pages: pdf.numPages, text: text.join(' ') };
  } finally { await loading.destroy(); }
}

for (const count of [12, 30]) {
  test(`client proposal with ${count} lines keeps totals, unchanged terms and both signatures on the page`, async () => {
    const result = await inspectPdf(buildClientProposalPDF(projectWithLines(count)));
    assert.ok(result.pages >= 2);
    assert.match(result.text, /Total Proposed Investment:/);
    assert.match(result.text, /Terms of Proposal & Acceptance/);
    assert.match(result.text, /Proposal is valid for 30 calendar days/);
    assert.match(result.text, /Authorized Contractor Signature/);
    assert.match(result.text, /Client Acceptance Signature & Date/);
    assert.match(result.text, new RegExp('Ordinary estimate item ' + count));
  });

  test(`internal estimate with ${count} lines keeps its financial summary within the page`, async () => {
    const result = await inspectPdf(buildInternalEstimatePDF(projectWithLines(count)));
    assert.match(result.text, /Financial Engine Recap/);
    assert.match(result.text, /Final Estimate Price:/);
    assert.match(result.text, /Estimated Gross Margin:/);
    assert.match(result.text, new RegExp('Ordinary estimate item ' + count));
  });
}

test('long project, client, address and plan metadata wrap without clipping either PDF', async () => {
  for (const build of [buildClientProposalPDF, buildInternalEstimatePDF]) {
    const result = await inspectPdf(build(projectWithLines(30, true)));
    for (const marker of ['PROJECT_END', 'CLIENT_END', 'ADDRESS_END', 'PLAN_END.pdf']) {
      assert.ok(result.text.includes(marker), marker);
    }
  }
});
