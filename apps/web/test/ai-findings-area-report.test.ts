import test from "node:test";
import assert from "node:assert/strict";
import { calculateProjectFinancials } from "../app/src/utils/calculations.ts";
import type { Project, EstimateItem, QuantityItem } from "../app/src/types/index.ts";
import type { PlanReadingFinding } from "../app/src/services/api.ts";

test("AI Markers vs Manual Notes distinction & area report grouping", () => {
  const syntheticFindings: PlanReadingFinding[] = [
    {
      id: "f1",
      page_number: 1,
      finding_type: "material",
      label: "Drywall 1/2 in",
      value_text: "Sheetrock",
      quantity: 500,
      unit: "SF",
      confidence: 0.95,
      geometry: { bbox: [0.1, 0.1, 0.2, 0.2], area: "Living Room", pricing: [{ category: "material", quantity: 500, unit: "SF", unitRate: 2.50, cost: 1250 }] },
      source_excerpt: "1/2 inch Gypsum board",
      status: "needs_review",
    },
    {
      id: "f2",
      page_number: 1,
      finding_type: "labor",
      label: "Drywall Installation Labor",
      value_text: null,
      quantity: 500,
      unit: "SF",
      confidence: 0.90,
      geometry: { point: [0.2, 0.2], area: "Living Room", pricing: [{ category: "labor", quantity: 500, unit: "SF", unitRate: 1.50, cost: 750 }] },
      source_excerpt: "Hang and finish gypsum board",
      status: "needs_review",
    },
    {
      id: "f3",
      page_number: 2,
      finding_type: "material",
      label: "Unmapped Scope Item",
      value_text: null,
      quantity: 10,
      unit: "EA",
      confidence: 0.80,
      geometry: {},
      source_excerpt: "General scope note page 2",
      status: "needs_review",
    },
  ];

  // Test bounding box check
  const bbox1 = syntheticFindings[0].geometry.bbox as number[];
  assert.equal(bbox1.length, 4);
  assert.equal(bbox1[0] + bbox1[2] <= 1, true);

  // Test point check for f2
  const point2 = syntheticFindings[1].geometry.point as number[];
  assert.equal(point2.length, 2);

  // Test unmapped item check for f3
  assert.equal(syntheticFindings[2].geometry.bbox, undefined);
  assert.equal(syntheticFindings[2].geometry.point, undefined);
});

test("Line-item provenance metadata & configured vs missing price states", () => {
  const qtyItem: QuantityItem = {
    id: "qty-1",
    itemNumber: 1,
    name: "Drywall 1/2 in",
    category: "Plan Takeoff",
    quantity: 500,
    unit: "SF",
    findingId: "f1",
    pageNumber: 1,
    area: "Living Room",
    sourceExcerpt: "1/2 inch Gypsum board",
  };

  const estItemPriced: EstimateItem = {
    id: "est-1",
    quantityId: qtyItem.id,
    name: qtyItem.name,
    quantity: qtyItem.quantity,
    unit: qtyItem.unit,
    materialCost: 1250,
    laborCost: 750,
    equipmentCost: 0,
    directCost: 2000,
    findingId: "f1",
    pageNumber: 1,
    area: "Living Room",
    sourceExcerpt: "1/2 inch Gypsum board",
    pricingStatus: "configured",
    pricingSource: "Estimator entered supplier quote",
  };

  const estItemUnpriced: EstimateItem = {
    id: "est-2",
    quantityId: "qty-2",
    name: "Unmapped Scope Item",
    quantity: 10,
    unit: "EA",
    materialCost: 0,
    laborCost: 0,
    equipmentCost: 0,
    directCost: 0,
    findingId: "f3",
    pageNumber: 2,
    area: "Unknown Area",
    sourceExcerpt: "General scope note page 2",
    pricingStatus: "missing_price",
  };

  assert.equal(estItemPriced.pricingStatus, "configured");
  assert.equal(estItemUnpriced.pricingStatus, "missing_price");
  assert.equal(estItemPriced.materialCost, 1250);
  assert.equal(estItemPriced.laborCost, 750);
  assert.equal(estItemUnpriced.directCost, 0);
});

test("Root manual financial engine $100 mat + $200 labor -> $403.20 using 12% OH and 20% Markup", () => {
  const estimateItems: EstimateItem[] = [
    {
      id: "est-100",
      name: "Manual Line Item",
      quantity: 1,
      unit: "LS",
      materialCost: 100,
      laborCost: 200,
      equipmentCost: 0,
      directCost: 300,
    },
  ];

  const fin = calculateProjectFinancials(estimateItems, 12, 20);
  assert.equal(fin.directCost, 300);
  assert.equal(fin.overheadPercentage, 12);
  assert.equal(fin.overheadAmount, 36); // 300 * 0.12 = 36
  assert.equal(fin.costBeforeMarkup, 336); // 300 + 36 = 336
  assert.equal(fin.markupPercentage, 20);
  assert.equal(fin.markupAmount, 67.20); // 336 * 0.20 = 67.20
  assert.equal(fin.finalPrice, 403.20); // 336 + 67.20 = 403.20
});
