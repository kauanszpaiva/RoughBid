import test from 'node:test';
import assert from 'node:assert/strict';
import { openFixtureDetails, openPlanReadingTools, openProjectDetails } from '../../../scripts/browser-fixture-navigation.mjs';

const projectLabel = 'Project files, payments & advanced tools';
const readingLabel = 'Plan viewer and advanced reading tools';

// Exercise the real navigation helper with disclosure semantics. Browser CI
// remains responsible for actual visibility, click actionability and rendering.
function fixture(projectOpen = false, readingOpen = false) {
  const states = new Map([[projectLabel, { open: projectOpen }], [readingLabel, { open: readingOpen }]]);
  const clicks: string[] = [];
  const page = {
    getByText(label: string, options: { exact: boolean }) {
      assert.deepEqual(options, { exact: true });
      const details = states.get(label);
      assert.ok(details, 'Only a known disclosure may be opened');
      return {
        async waitFor(options: { state: string }) {
          assert.deepEqual(options, { state: 'visible' });
          if (label === readingLabel) assert.equal(states.get(projectLabel)!.open, true, 'Open the parent before waiting for its child');
        },
        async evaluate(read: (element: { closest: (selector: string) => typeof details }) => unknown) {
          return read({ closest: selector => { assert.equal(selector, 'details'); return details; } });
        },
        async click() { clicks.push(label); details.open = !details.open; },
      };
    },
  };
  return { page, states, clicks };
}

test('browser navigation opens the outer disclosure before hidden reading tools', async () => {
  const h = fixture();
  await openPlanReadingTools(h.page);
  assert.deepEqual(h.clicks, [projectLabel, readingLabel]);
  assert.equal(h.states.get(readingLabel)!.open, true);
});

test('browser navigation preserves a parent already opened by saved-payment recovery', async () => {
  const h = fixture(true);
  await openPlanReadingTools(h.page);
  assert.deepEqual(h.clicks, [readingLabel]);
});

test('browser disclosure navigation is idempotent for consent and history recovery', async () => {
  const h = fixture(true, true);
  await openPlanReadingTools(h.page);
  await openProjectDetails(h.page);
  assert.deepEqual(h.clicks, []);
});

test('browser navigation does not hide visibility failures with forced clicks', async () => {
  let clicked = false;
  await assert.rejects(openFixtureDetails({ getByText: () => ({
    waitFor: async () => { throw new Error('Disclosure is not visible'); },
    click: async () => { clicked = true; },
  }) }, projectLabel), /Disclosure is not visible/);
  assert.equal(clicked, false);
});

test('browser navigation rejects a label outside a details element', async () => {
  await assert.rejects(openFixtureDetails({ getByText: () => ({
    waitFor: async () => {},
    evaluate: async (read: (element: { closest: () => null }) => unknown) => read({ closest: () => null }),
  }) }, projectLabel), /no details ancestor/);
});
