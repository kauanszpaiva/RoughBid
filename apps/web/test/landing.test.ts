import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('landing page explains RoughBid as an independent SaaS product', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /Construction estimates without the spreadsheet chaos/i);
  assert.match(html, /Plans → Quantities → Estimate → Export/i);
  assert.match(html, /Independent SaaS platform/i);
  assert.match(html, /standalone construction estimating SaaS/i);
  assert.match(html, /controlled customer access/i);
  assert.match(html, /Marketplace add-ons/i);
  assert.match(html, /href="\/refunds\.html"/i);
  assert.match(html, /href="\/app\/"/i);
  assert.match(html, /rel="icon" href="\/brand\/roughbid-mark\.png" type="image\/png"/i);
  assert.match(html, /class="brand-logo" src="\/brand\/roughbid-logo\.png"/i);
  assert.doesNotMatch(html, /brand-mark/i);
  assert.match(html, /KSP Ventures/i);
  assert.match(html, /name="viewport"/i);
  assert.doesNotMatch(html, /AI-powered estimating available now/i);
});
