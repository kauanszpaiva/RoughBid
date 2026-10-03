import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('landing page presents RoughBid as a construction estimating workspace', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

  assert.match(html, /From plan set[sS]*to proposal/i);
  assert.match(html, /construction estimating software/i);
  assert.match(html, /Plans[sS]*Quantities[sS]*Estimate[sS]*Review[sS]*Proposal/i);
  assert.match(html, /ESTIMATING WORKSPACE/i);
  assert.match(html, /PROJECT SEQUENCE/i);
  assert.match(html, /REVIEW CONTROLS/i);
  assert.match(html, /CLIENT DELIVERY/i);
  assert.match(html, /Every finding is reviewable before it affects the estimate/i);
  assert.match(html, /Internal costs stay separate from proposal output/i);
  assert.match(html, /Nothing is added to the estimate automatically/i);
  assert.match(html, /controlled customer access/i);
  assert.match(html, /href="\/refunds\.html"/i);
  assert.match(html, /href="\/app\/"/i);
  assert.match(html, /rel="icon" href="\/brand\/roughbid-mark\.png" type="image\/png"/i);
  assert.match(html, /class="brand-logo" src="\/brand\/roughbid-logo\.png"/i);
  assert.doesNotMatch(html, /brand-mark/i);
  assert.match(html, /KSP Ventures/i);
  assert.match(html, /name="viewport"/i);
  assert.doesNotMatch(html, /AI-powered estimating available now/i);
  assert.doesNotMatch(html, /1,200\+/i);
  assert.doesNotMatch(html, /average estimate export time/i);
});

test('landing conversion surfaces include accessible navigation, modal, footer, and product interaction', async () => {
  const [html, styles, script, heroScript] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../landing.js', import.meta.url), 'utf8'),
    readFile(new URL('../hero.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /href="#workspace">Workspace/);
  assert.match(html, /href="#workflow">Workflow/);
  assert.match(html, /href="#review">Review controls/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /id="company-size"/);
  assert.match(html, /Product[\s\S]*Legal[\s\S]*Contact/);
  assert.match(html, /System status/);
  assert.match(html, /id="overhead"/);
  assert.match(html, /id="markup"/);
  assert.match(html, /class="plan-sheet"/);
  assert.match(styles, /backdrop-filter:blur/);
  assert.match(styles, /\.site-header-wrap\{[^}]*position:sticky/);
  assert.match(script, /validEmail/);
  assert.match(script, /success-toast/);
  assert.match(heroScript, /updateEstimate/);
  assert.match(heroScript, /renderBlueprint/);
});
