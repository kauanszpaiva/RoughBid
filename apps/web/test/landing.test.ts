import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('landing page explains the product and 60-day class access in plain language', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /Construction estimates without the spreadsheet chaos/i);
  assert.match(html, /Plans → Quantities → Estimate → Export/i);
  assert.match(html, /60 days included/i);
  assert.match(html, /KSP Ventures/i);
  assert.match(html, /name="viewport"/i);
  assert.doesNotMatch(html, /AI-powered estimating available now/i);
});
