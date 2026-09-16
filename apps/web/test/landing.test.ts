import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('landing page explains RoughBid as an independent SaaS product', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /Construction estimates without the spreadsheet chaos/i);
  assert.match(html, /Plans → Quantities → Estimate → Export/i);
  assert.match(html, /role="tablist" aria-label="RoughBid workflow steps"/i);
  assert.match(html, /Try PDF Reader/i);
  assert.match(html, /See Sample Export/i);
  assert.match(html, /data-demo="4"/i);
  assert.match(html, /ArrowRight/);
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

test('landing conversion surfaces include accessible navigation, modal, footer, and sticky CTA', async () => {
  const [html, styles, script] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../landing.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /href="#workflow">Workflow/);
  assert.match(html, /href="#features">Features/);
  assert.match(html, /href="#pricing">Pricing/);
  assert.match(html, /class="sticky-cta"/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /id="company-size"/);
  assert.match(html, /Product[\s\S]*Legal[\s\S]*Contact/);
  assert.match(html, /Documentation[\s\S]*All systems operational/);
  assert.match(styles, /backdrop-filter: blur/);
  assert.match(styles, /\.site-header-wrap\s*{[\s\S]*position: sticky/);
  assert.match(script, /validEmail/);
  assert.match(script, /success-toast/);
});
