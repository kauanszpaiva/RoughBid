import test from 'node:test';
import assert from 'node:assert/strict';
import { priceFindings } from '../src/ai-plan/pricing.ts';

test('prices a material finding as both a material line and its companion install-labor line', () => {
  const result = priceFindings([
    { finding_type: 'material', label: 'Exterior Composite Decking Boards', quantity: 450, unit: 'SF' },
  ]);

  assert.equal(result.pricedFindings, 1);
  assert.equal(result.unpricedFindings, 0);
  const components = result.byFindingIndex.get(0);
  assert.equal(components?.length, 2);
  assert.deepEqual(components?.map((c) => c.category).sort(), ['labor', 'material']);
  assert.equal(result.totals.categoryTotals.material, 3262.5); // 450 SF * 7.25
  assert.equal(result.totals.categoryTotals.labor, 2025); // 450 SF * 4.50 install labor
});

test('prices an hourly labor finding at its trade rate, with no material cost', () => {
  const result = priceFindings([
    { finding_type: 'labor', label: 'Deck framing labor', quantity: 8, unit: 'HR' },
  ]);

  assert.equal(result.pricedFindings, 1);
  assert.equal(result.totals.categoryTotals.material, 0);
  assert.equal(result.totals.categoryTotals.labor, 760); // 8 HR * NE framing carpenter $95.00/hr
  assert.equal(result.byFindingIndex.get(0)?.[0]?.category, 'labor');
});

test('a lump sum or an unlabelled count is left unpriced instead of multiplied by a per-unit rate', () => {
  // 1 LS * the $16.50/SF framing rate used to produce a $7.42 lump sum for deck
  // framing, and 2 EA of generic fasteners produced $90 of invented money.
  const result = priceFindings([
    { finding_type: 'labor', label: 'Deck framing labor', quantity: 1, unit: 'LS' },
    { finding_type: 'material', label: 'Miscellaneous fastener package', quantity: 2, unit: 'EA' },
  ]);

  assert.equal(result.pricedFindings, 0);
  assert.equal(result.unpricedFindings, 2);
  assert.equal(result.totals.directCost, 0);
});

test('falls back to a dimensional unit rate when no label keyword matches', () => {
  const result = priceFindings([
    { finding_type: 'material', label: 'Miscellaneous site material', quantity: 100, unit: 'LF' },
  ]);
  assert.equal(result.totals.categoryTotals.material, 600); // 100 LF * 6.00 default
  assert.equal(result.totals.categoryTotals.labor, 500); // 100 LF * 5.00 default
});

test('a finish word never borrows an equipment rate from another trade', () => {
  // Observed on a real reading of a real sheet: a wood "panel" door matched the
  // 200 A service-panel keyword and was priced at $4,030 per interior door.
  const result = priceFindings([
    { finding_type: 'material', label: 'Door D2 Wood Panel Interior Door', quantity: 6, unit: 'EA' },
  ]);

  const components = result.byFindingIndex.get(0)!;
  assert.equal(components.find(component => component.category === 'material')?.unitRate, 320); // a door rate
  assert.equal(result.totals.directCost, 3000); // 6 EA * (320 + 180)
});

test('hardware is a set, not an opening', () => {
  const result = priceFindings([
    { finding_type: 'material', label: 'Interior Door Hardware Sets', quantity: 12, unit: 'EA' },
  ]);

  assert.equal(result.byFindingIndex.get(0)?.find(component => component.category === 'material')?.unitRate, 25);
  assert.equal(result.totals.directCost, 540); // 12 * (25 + 20)
});

test('a per-EA equipment rate never lands on a linear quantity', () => {
  const result = priceFindings([
    { finding_type: 'material', label: 'Plumbing supply pipe', quantity: 40, unit: 'LF' },
    { finding_type: 'material', label: '200A service panel', quantity: 1, unit: 'EA' },
  ]);

  // The pipe is dimensional, so it uses the LF rate rather than the $1,850 per
  // fitment rate its "plumbing" keyword would have matched before.
  assert.equal(result.byFindingIndex.get(0)?.find(component => component.category === 'material')?.unitRate, 6.00);
  // The service panel keeps its own per-EA rate.
  assert.equal(result.byFindingIndex.get(1)?.find(component => component.category === 'material')?.unitRate, 4030);
});

test('leaves findings without a usable quantity, unit, or rate unpriced and out of totals', () => {
  const result = priceFindings([
    { finding_type: 'question', label: 'Unclear scale on sheet A2', quantity: null, unit: null },
    { finding_type: 'material', label: 'Structural steel beam', quantity: null, unit: null },
    { finding_type: 'material', label: 'Composite decking', quantity: -5, unit: 'SF' },
    { finding_type: 'measurement', label: 'Deck width', quantity: 20, unit: 'LF' },
  ]);

  assert.equal(result.pricedFindings, 0);
  assert.equal(result.unpricedFindings, 2); // the two material findings; question/measurement are never priced
  assert.equal(result.byFindingIndex.size, 0);
  assert.equal(result.totals.directCost, 0);
});

test('demolition labor has no material cost even though it matches a keyword rate', () => {
  const result = priceFindings([
    { finding_type: 'labor', label: 'Demolition of existing deck', quantity: 8, unit: 'HR' },
  ]);
  assert.equal(result.totals.categoryTotals.material, 0);
  assert.equal(result.totals.categoryTotals.labor, 464); // 8 HR * NE skilled-laborer rate ($58.00/hr)
});

test('prices New England-benchmarked trades: concrete footing, drywall, and a cold-climate heat pump', () => {
  const result = priceFindings([
    { finding_type: 'material', label: 'Continuous Concrete Spread Footings', quantity: 14, unit: 'CY' },
    { finding_type: 'material', label: '5/8" Type X Gypsum Drywall', quantity: 2850, unit: 'SF' },
    { finding_type: 'material', label: 'Cold-Climate Inverter Heat Pump System', quantity: 1, unit: 'EA' },
  ]);

  assert.equal(result.pricedFindings, 3);
  // NE footing: $265.00/CY installed, split 45% material / 55% labor.
  const footing = result.byFindingIndex.get(0)!;
  assert.equal(footing.find((c) => c.category === 'material')?.unitRate, 119.25);
  assert.equal(footing.find((c) => c.category === 'labor')?.unitRate, 145.75);
  // NE drywall: $4.10/SF installed, split 40% material / 60% labor (hang/tape/finish is labor-heavy).
  const drywall = result.byFindingIndex.get(1)!;
  assert.equal(drywall.find((c) => c.category === 'material')?.unitRate, 1.64);
  assert.equal(drywall.find((c) => c.category === 'labor')?.unitRate, 2.46);
  // NE heat pump: $18,500/EA installed, split 65% material / 35% labor (equipment-dominated).
  const heatPump = result.byFindingIndex.get(2)!;
  assert.equal(heatPump.find((c) => c.category === 'material')?.unitRate, 12025);
  assert.equal(heatPump.find((c) => c.category === 'labor')?.unitRate, 6475);
});
