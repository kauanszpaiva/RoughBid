import test from 'node:test';
import assert from 'node:assert/strict';
import type { Project, QuantityItem } from '../app/src/types/index.ts';
import { createUnpricedEstimateItem, editEstimateLine, updateTakeoffQuantity, validateEstimateInput } from '../app/src/utils/manualEstimate.ts';
import { calculateProjectFinancials } from '../app/src/utils/calculations.ts';

function projectWithTakeoff(): Project {
  const quantities: QuantityItem[] = [
    { id: 'drywall', itemNumber: 1, name: 'Drywall', quantity: 10, unit: 'SF' },
    { id: 'drywall-other', itemNumber: 2, name: 'Drywall', quantity: 5, unit: 'SF' },
  ];
  return {
    id: 'manual-project', name: 'Manual estimate', clientName: 'Client', address: '', projectType: 'Residential',
    status: 'Planning', updatedAt: 'now', overheadPercentage: 10, markupPercentage: 20, revisions: [], quantities,
    estimateItems: quantities.map(createUnpricedEstimateItem),
  };
}

test('manual takeoff starts without invented prices and actual costs flow into review totals', () => {
  let project = projectWithTakeoff();
  const item = project.estimateItems[0]!;
  assert.equal(item.directCost, 0);
  assert.equal(calculateProjectFinancials(project.estimateItems, 10, 20).finalPrice, 0);
  project = editEstimateLine(project, item.id, {
    name: 'Paint-ready drywall', quantity: 10, unit: 'SF', materialCost: 100, laborCost: 50, equipmentCost: 10,
  });
  assert.equal(project.quantities[0]?.name, 'Paint-ready drywall');
  assert.equal(calculateProjectFinancials(project.estimateItems, 10, 20).finalPrice, 211.2);

  project = updateTakeoffQuantity(project, 'drywall', { name: 'Paint-ready drywall', quantity: 15, unit: 'SF' });
  assert.equal(project.estimateItems[0]?.quantity, 15);
  assert.equal(project.estimateItems[0]?.materialCost, 150);
  assert.equal(project.estimateItems[0]?.laborCost, 75);
  assert.equal(project.estimateItems[0]?.equipmentCost, 15);
  assert.equal(project.estimateItems[0]?.directCost, 240);
  assert.equal(calculateProjectFinancials(project.estimateItems, 10, 20).finalPrice, 316.8);
  assert.equal(project.estimateItems[1]?.quantity, 5);
  assert.equal(project.estimateItems[1]?.name, 'Drywall');
});

test('changing a measurement unit clears incompatible pricing for review', () => {
  let project = projectWithTakeoff();
  const item = project.estimateItems[0]!;
  project = editEstimateLine(project, item.id, { ...item, materialCost: 100, laborCost: 50 });
  project = updateTakeoffQuantity(project, 'drywall', { name: 'Drywall', quantity: 10, unit: 'EA' });
  assert.equal(project.estimateItems[0]?.unit, 'EA');
  assert.equal(project.estimateItems[0]?.directCost, 0);
  assert.equal(project.estimateItems[0]?.materialCost, 0);
  assert.equal(project.estimateItems[0]?.laborCost, 0);
});

test('estimate edits preserve entered line totals and synchronize only their linked quantity', () => {
  const original = projectWithTakeoff();
  const item = original.estimateItems[0]!;
  const updated = editEstimateLine(original, item.id, {
    ...item, name: 'Board', quantity: 12.5, unit: 'EA', materialCost: 123.456, laborCost: 22.224, equipmentCost: 0,
  });
  assert.equal(updated.quantities[0]?.quantity, 12.5);
  assert.equal(updated.quantities[0]?.unit, 'EA');
  assert.equal(updated.estimateItems[0]?.materialCost, 123.46);
  assert.equal(updated.estimateItems[0]?.directCost, 145.68);
  assert.deepEqual(updated.quantities[1], original.quantities[1]);
  assert.equal(original.quantities[0]?.quantity, 10);
});

test('invalid numbers, empty descriptions and negative costs never reach persisted estimates', () => {
  const project = projectWithTakeoff();
  const item = project.estimateItems[0]!;
  for (const quantity of [-1, 0, Infinity, NaN, 1e100]) {
    assert.throws(() => editEstimateLine(project, item.id, { ...item, quantity }));
  }
  for (const materialCost of [-1, Infinity, NaN, 1e100]) {
    assert.throws(() => editEstimateLine(project, item.id, { ...item, materialCost }));
  }
  assert.throws(() => updateTakeoffQuantity(project, 'drywall', { name: ' ', quantity: 1, unit: 'SF' }));
  assert.equal(validateEstimateInput('Drywall', 0.25, [0, 0, 0]), '');
});

test('cost-only lines remain independent from similar takeoff descriptions', () => {
  const project = projectWithTakeoff();
  const line = { ...project.estimateItems[0]!, id: 'independent' };
  delete line.quantityId;
  project.estimateItems.push(line);
  const updated = updateTakeoffQuantity(project, 'drywall', { name: 'Drywall', quantity: 20, unit: 'SF' });
  assert.equal(updated.estimateItems[2]?.quantity, 10);
  const edited = editEstimateLine(project, 'independent', { ...line, quantity: 99 });
  assert.equal(edited.quantities[0]?.quantity, 10);
});
