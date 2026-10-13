import test from 'node:test';
import assert from 'node:assert/strict';
import { openFixtureDetails, openPaidReturnReadingTools, openPlanReadingTools, openProjectDetails } from '../../../scripts/browser-fixture-navigation.mjs';

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

for (const recoveryFailed of [false, true]) {
  test(`paid return waits for committed ${recoveryFailed ? 'failure' : 'payment'} UI before disclosure navigation`, async () => {
    const h = fixture();
    let commit!: () => void;
    const pendingRecovery = new Promise<void>(resolve => { commit = resolve; });
    let recoveryObserved = false;
    const page = { ...h.page, getByRole(role: string, options: { name: string; exact: boolean; includeHidden: boolean }) {
      assert.equal(role, recoveryFailed ? 'button' : 'region');
      assert.deepEqual(options, { name: recoveryFailed ? 'Payment status could not be loaded. Retry.' : 'Project payment', exact: true, includeHidden: true });
      return { async waitFor(options: { state: string }) {
        assert.deepEqual(options, { state: 'attached' });
        await pendingRecovery;
        recoveryObserved = true;
      } };
    }, getByText(label: string, options: { exact: boolean }) {
      assert.equal(recoveryObserved, true, 'Do not even inspect disclosure state while quote recovery can still change it');
      return h.page.getByText(label, options);
    } };
    const navigating = openPaidReturnReadingTools(page, recoveryFailed);
    await Promise.resolve();
    assert.deepEqual(h.clicks, []);
    // Successful recovery opens the parent in the same React commit as the
    // payment region. A recovery error leaves that parent closed.
    h.states.get(projectLabel)!.open = !recoveryFailed;
    commit();
    await navigating;
    assert.deepEqual(h.clicks, recoveryFailed ? [projectLabel, readingLabel] : [readingLabel]);
    assert.equal(h.states.get(projectLabel)!.open, true);
    assert.equal(h.states.get(readingLabel)!.open, true);
  });
}

test('paid return cannot bypass a missing recovery result by clicking the disclosure', async () => {
  const h = fixture();
  const page = { ...h.page, getByRole: () => ({ waitFor: async () => { throw new Error('Recovery result never appeared'); } }) };
  await assert.rejects(openPaidReturnReadingTools(page), /Recovery result never appeared/);
  assert.deepEqual(h.clicks, []);
});
