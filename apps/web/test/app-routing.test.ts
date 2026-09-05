import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const buildScript = readFileSync(new URL('../../../scripts/build.mjs', import.meta.url), 'utf8');
const vercelConfig = readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8');

test('build keeps landing at root and protected app under app path', () => {
  assert.match(buildScript, /dist\/app\/index\.html/);
  assert.match(buildScript, /apps\/web\/index\.html/);
  assert.match(buildScript, /dist\/index\.html/);
});

test('vercel routes client proposals to app without exposing app at root', () => {
  assert.doesNotMatch(vercelConfig, /"source": "\/app"[\s\S]*"destination": "\/"/);
  assert.match(vercelConfig, /"source": "\/proposal\/:token"/);
  assert.match(vercelConfig, /"destination": "\/app"/);
});
