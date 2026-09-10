import test from 'node:test';
import assert from 'node:assert/strict';
import { appendAcceptedAiQuantity, groupAiFindingsByArea } from '../app/src/utils/aiFindingReview.ts';
import { projectReadiness } from '../app/src/utils/projectReadiness.ts';
import { persistentProject } from '../app/src/utils/storage.ts';
import { editEstimateLine } from '../app/src/utils/manualEstimate.ts';
import type { PlanReadingFinding } from '../app/src/services/api.ts';
import type { Project } from '../app/src/types/index.ts';

const finding: PlanReadingFinding = {
  id: 'finding-1', finding_type: 'material', label: 'Drywall', page_number: 2,
  quantity: 500, unit: 'SF', value_text: null, confidence: 0.95,
  source_excerpt: '500 SF gypsum board', status: 'needs_review',
  geometry: { area: 'Living Room', pricing: [{ category: 'material', cost: 999999, quantity: 500, unit: 'SF', unitRate: 1999.998 }] },
};
const project: Project = {
  id: 'project-1', name: 'Regression fixture', clientName: 'Fixture', address: '',
  projectType: 'New Construction', status: 'Planning', updatedAt: '',
  overheadPercentage: 12, markupPercentage: 20, quantities: [], estimateItems: [],
  revisions: [{ id: 'rev-1', revisionNumber: '01', fileName: 'fixture.pdf', fileSize: 'fixture',
    pages: 2, uploadDate: '', uploadedBy: '', isCurrent: true, remoteFileId: 'file-1', processingStatus: 'ready' }],
};

test('source finding report groups evidence but never turns geometry money into verified costs', () => {
  const groups = groupAiFindingsByArea([
    finding,
    { ...finding, id: 'finding-note', quantity: null, unit: null, finding_type: 'scope_note' },
    { ...finding, id: 'rejected', status: 'rejected' },
    { ...finding, id: 'unknown-area', geometry: {} },
  ]);
  assert.deepEqual(groups.map(group => [group.areaName, group.findings.length, group.unpricedCount]), [
    ['Living Room', 2, 1], ['Unknown Area', 1, 1],
  ]);
  assert.deepEqual([...groups[0].pages], [2]);
  assert.equal('materialCost' in groups[0], false);
  assert.equal('laborCost' in groups[0], false);
});

test('accepted AI quantities require entered prices and duplicate review cannot double an estimate', () => {
  const item = { name: finding.label, quantity: finding.quantity!, unit: 'SF' as const,
    findingId: finding.id, pageNumber: 2, area: 'Living Room', sourceExcerpt: finding.source_excerpt! };
  let ids = 0;
  const accepted = appendAcceptedAiQuantity(project, item, () => String(++ids));
  const line = accepted.estimateItems[0];
  assert.deepEqual([line.materialCost, line.laborCost, line.equipmentCost, line.directCost], [0, 0, 0, 0]);
  assert.equal(line.pricingStatus, 'missing_price');
  assert.equal(line.pricingSource, undefined);
  assert.equal(line.findingId, finding.id);
  assert.equal(line.sourceExcerpt, finding.source_excerpt);
  assert.equal(projectReadiness(accepted).canExport, false);
  assert.equal(appendAcceptedAiQuantity(accepted, item, () => String(++ids)), accepted);
  assert.equal(ids, 2);
  assert.equal(project.quantities.length, 0);
});

test('historical AI prices remain auditable but cannot authorize export until costs are explicitly saved', () => {
  const accepted = appendAcceptedAiQuantity(project, { name: finding.label, quantity: 500, unit: 'SF', findingId: finding.id });
  const raw = { ...accepted, estimateItems: accepted.estimateItems.map(item => ({ ...item,
    materialCost: 900, laborCost: 100, directCost: 1000, pricingStatus: 'configured' as const,
    pricingSource: 'AI Finding Geometry Pricing',
  })) };
  assert.equal(projectReadiness(raw).canExport, false);
  const restored = persistentProject(raw);
  assert.equal(restored.estimateItems[0].pricingStatus, 'missing_price');
  assert.equal(restored.estimateItems[0].materialCost, 900);
  assert.equal(restored.estimateItems[0].pricingSource, 'AI Finding Geometry Pricing');
  const verified = editEstimateLine(restored, restored.estimateItems[0].id, {
    name: finding.label, quantity: 500, unit: 'SF', materialCost: 200, laborCost: 100, equipmentCost: 0,
  });
  assert.equal(verified.estimateItems[0].pricingStatus, 'configured');
  assert.equal(verified.estimateItems[0].pricingSource, 'Estimator entered costs');
  assert.equal(projectReadiness(verified).canExport, true);
  assert.deepEqual(persistentProject(verified).estimateItems, verified.estimateItems);
});
