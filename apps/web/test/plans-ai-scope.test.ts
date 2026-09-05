import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const plansPage = readFileSync(new URL('../app/src/pages/PlansPage.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../app/src/services/api.ts', import.meta.url), 'utf8');

test('plans page exposes AI scope controls for whole plan or selected areas', () => {
  assert.match(plansPage, /AI Reading Scope/);
  assert.match(plansPage, /All areas/);
  assert.match(plansPage, /Pick area/);
  assert.match(plansPage, /Area, room, sheet, or zone/);
  assert.match(plansPage, /Trades to inspect/);
  assert.match(plansPage, /PDF plan sets up to 60 pages and 12 MB/);
  assert.match(plansPage, /page coverage and source evidence/);
});

test('plans page sends structured scope to the backend AI reading endpoint', () => {
  assert.match(api, /scopeMode\?: "all_trades" \| "selected_scope"/);
  assert.match(api, /requestedAreas\?: string\[\]/);
  assert.match(api, /trades\?: AiPlanReadingTrade\[\]/);
  assert.match(api, /processAiPlanReading/);
  assert.match(plansPage, /scopeMode: aiScopeMode/);
  assert.match(plansPage, /requestedAreas/);
  assert.match(plansPage, /trades: selectedTrades/);
  assert.match(plansPage, /processAiPlanReading\(workspaceId, job\.id\)/);
});
