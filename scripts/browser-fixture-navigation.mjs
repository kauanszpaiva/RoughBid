import assert from 'node:assert/strict';

// Use the same visible disclosure controls as a user. Never force clicks or
// change DOM attributes: hidden ancestors must be opened in order.
export async function openFixtureDetails(page, label) {
  const summary = page.getByText(label, { exact: true });
  await summary.waitFor({ state: 'visible' });
  const isOpen = () => summary.evaluate(element => {
    const details = element.closest('details');
    if (!details) throw new Error('Fixture disclosure has no details ancestor');
    return details.open;
  });
  if (!await isOpen()) await summary.click();
  assert.equal(await isOpen(), true, `${label} must be open`);
}

export async function openProjectDetails(page) {
  await openFixtureDetails(page, 'Project files, payments & advanced tools');
}

export async function openPlanReadingTools(page) {
  await openProjectDetails(page);
  await openFixtureDetails(page, 'Plan viewer and advanced reading tools');
}
