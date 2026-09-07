import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePlanReadingResult, sanitizePlanGeometry } from '../src/ai-plan/types.ts';

test('plan geometry only retains bounded coordinates and removes provider pricing', () => {
  assert.deepEqual(sanitizePlanGeometry({bbox:[0.1,0.2,0.3,0.4],area:'Kitchen',pricing:[{cost:999}]}), {bbox:[0.1,0.2,0.3,0.4],coordinate_space:'normalized',area:'Kitchen'});
  for (const bbox of [[0,0,2,1],[-1,0,1,1],[0,0,0,1],[0.9,0.9,0.2,0.2],[0,0,NaN,1]]) assert.deepEqual(sanitizePlanGeometry({bbox}), {});
});

test('a room without measurable area keeps its visual evidence without inventing quantities', () => {
  const result = sanitizePlanReadingResult({summary:{sheet_count:2}, findings:[{label:'Kitchen',finding_type:'room',page_number:2,source_excerpt:'KITCHEN',geometry:{bbox:[0.1,0.1,0.2,0.2]}}]});
  assert.equal(result.findings[0]?.quantity,null);
  assert.deepEqual(result.findings[0]?.geometry.bbox,[0.1,0.1,0.2,0.2]);
});

test('locations without source evidence are not displayed as mapped areas', () => {
  const result = sanitizePlanReadingResult({findings:[{label:'Unknown room',finding_type:'room',geometry:{bbox:[0,0,1,1]}}]});
  assert.deepEqual(result.findings[0]?.geometry,{});
});
