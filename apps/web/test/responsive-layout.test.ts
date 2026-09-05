import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
const header = readFileSync(new URL('../app/src/components/Header.tsx', import.meta.url), 'utf8');
const blueprint = readFileSync(new URL('../app/src/components/BlueprintViewer.tsx', import.meta.url), 'utf8');
const materials = readFileSync(new URL('../app/src/pages/MaterialsPage.tsx', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../app/src/pages/DashboardPage.tsx', import.meta.url), 'utf8');
const projects = readFileSync(new URL('../app/src/pages/ProjectsPage.tsx', import.meta.url), 'utf8');
const plans = readFileSync(new URL('../app/src/pages/PlansPage.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../app/src/services/api.ts', import.meta.url), 'utf8');

test('app shell uses mobile viewport height and tablet-friendly collapsed sidebar default', () => {
  assert.match(app, /h-dvh/);
  assert.match(app, /window\.innerWidth < 1180/);
});

test('header and project stepper avoid mobile text crowding', () => {
  assert.match(header, /hidden sm:inline/);
  assert.match(header, /overflow-x-auto/);
  assert.doesNotMatch(header, /mx-auto justify-center/);
});

test('plan viewer fits smaller screens and uses a mobile bottom sheet for callouts', () => {
  assert.match(blueprint, /window\.innerWidth < 640\) return 50/);
  assert.match(blueprint, /h-\[68dvh\]/);
  assert.match(blueprint, /bottom-20 sm:left-auto/);
});

test('plan viewer renders the uploaded PDF under the markup layer', () => {
  assert.match(blueprint, /<canvas/);
  assert.match(blueprint, /pdfjs\.getDocument/);
  assert.match(blueprint, /Rendering uploaded PDF/);
  assert.match(blueprint, /Blue marks and notes sit on top of the PDF you uploaded/);
  assert.doesNotMatch(blueprint, /PLAN SHEET A-1|EXISTING HOUSE|STAIRS \(4 RISERS\)/);
  assert.match(plans, /URL\.createObjectURL\(file\)/);
  assert.match(plans, /createDocumentPreviewObjectUrl/);
  assert.match(api, /URL\.createObjectURL/);
  assert.match(api, /application\/pdf/);
});

test('dashboard and projects stack dense metrics on phones', () => {
  assert.match(dashboard, /grid-cols-1 sm:grid-cols-2 lg:grid-cols-4/);
  assert.match(projects, /grid-cols-1 sm:grid-cols-2 lg:grid-cols-4/);
});

test('materials uses mobile cards instead of forcing a wide table', () => {
  assert.match(materials, /md:hidden space-y-3/);
  assert.match(materials, /hidden md:block/);
  assert.match(materials, /min-w-\[780px\]/);
});

