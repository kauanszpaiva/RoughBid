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
  // Observe the committed native disclosure state after the single click.
  // Filter the nearest details ancestor before requiring [open], so an open
  // outer disclosure cannot satisfy this wait for a still-closed inner one.
  await summary.locator('xpath=ancestor::details[1][@open]').waitFor({ state: 'attached', timeout: 5000 });
  assert.equal(await isOpen(), true, `${label} must be open`);
}

export async function openProjectDetails(page) {
  await openFixtureDetails(page, 'Project files, payments & advanced tools');
}

export async function openPlanReadingTools(page) {
  await openProjectDetails(page);
  await openFixtureDetails(page, 'Plan viewer and advanced reading tools');
}

export async function openPaidReturnReadingTools(page, recoveryFailed = false) {
  // Saved-quote recovery can auto-open the parent disclosure. Wait for its
  // committed UI result before checking/clicking, otherwise that auto-open can
  // land between the check and the click and our click would close it again.
  // Failed recovery lives inside the closed parent, so attachment (not initial
  // visibility) is the readiness signal. Opening still uses visible user clicks.
  const recovered = recoveryFailed
    ? page.getByRole('button', { name: 'Payment status could not be loaded. Retry.', exact: true, includeHidden: true })
    : page.getByRole('region', { name: 'Project payment', exact: true, includeHidden: true });
  await recovered.waitFor({ state: 'attached' });
  await openPlanReadingTools(page);
}
