import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, ids, version, manifest, claim, rpc, scalar } from './provider-bridge-runtime.test.mjs';

async function setup() {
  const db = await fixture();
  await db.exec(readFileSync(new URL('../migrations/20261003060000_reviewed_operation_reservations.sql', import.meta.url), 'utf8'));
  await db.exec('update provider_spend_policy set spend_cap_usd=25; update profiles set is_platform_admin=true');
  const { run } = await rpc(db, 'reserve_full_takeoff_v2', [ids.user, ids.workspace, ids.project, ids.file, manifest, version]);
  const lease = await claim(db, run);
  const configure = (approvedUsd = 5, maximumCalls = 100) => db.query('select configure_full_takeoff_run_budget($1,$2,$3,$4,$5,$6,$7)',
    [run.id, lease.lease_id, 'gemini', ['gemini-3.8-flash'], approvedUsd, maximumCalls, 'legacy-explicit-approval']);
  await configure();
  let next = 0;
  const spend = async (reviewedCost) => {
    const id = `90000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
    await db.query('insert into api_usage_events(id,workspace_id,project_id,user_id,provider,model,operation) values($1,$2,$3,$4,$5,$6,$7)',
      [id, ids.workspace, ids.project, ids.user, 'gemini', 'gemini-3.8-flash', `rb1:${run.id}:generate:pending`]);
    const args = [id, run.id, ids.workspace, ids.user, 'gemini', 'gemini-3.8-flash'];
    if (reviewedCost !== undefined) args.push(reviewedCost);
    await rpc(db, 'reserve_provider_spend', args);
    return id;
  };
  return { db, run, lease, configure, spend };
}

test('legacy 5 USD allowance survives migration600, unknown aging and same-run resume without replenishment', async () => {
  const f = await setup();
  try {
    await assert.rejects(f.configure(25, 100), /cannot be silently replaced/);
    await assert.rejects(f.configure(5, 101), /cannot be silently replaced/);
    await assert.rejects(f.spend(24.52), /Legacy operation cannot increase/);
    const first = await f.spend(), second = await f.spend(.5);
    assert.equal(Number(await scalar(f.db, 'select reserved_usd from provider_spend_reservations where event_id=$1', [second])), 2.5);
    await rpc(f.db, 'capture_provider_spend', [first, null]);
    await f.db.exec("update provider_spend_reservations set created_at=now()-interval '3 days'");
    await assert.rejects(f.spend(), /provider run spend limit reached/);
    await rpc(f.db, 'cancel_full_takeoff_v2', [f.run.id, ids.user, ids.workspace]);
    await assert.rejects(rpc(f.db, 'restart_full_takeoff_v2', [f.run.id, ids.user, ids.workspace]), /requires reconciliation/);
    // Synthetic completed-response evidence permits resume, but absent cost
    // telemetry still conserves both original reservations.
    await rpc(f.db, 'capture_provider_spend', [second, null]);
    await f.db.query("update api_usage_events set operation=$1 where id in ($2,$3)",
      [`rb1:${f.run.id}:generate:tokens_only`, first, second]);
    await rpc(f.db, 'restart_full_takeoff_v2', [f.run.id, ids.user, ids.workspace]);
    const nextLease = await claim(f.db, f.run);
    await f.db.query('select configure_full_takeoff_run_budget($1,$2,$3,$4,$5,$6,$7)',
      [f.run.id, nextLease.lease_id, 'gemini', ['gemini-3.8-flash'], 5, 100, 'legacy-explicit-approval']);
    await assert.rejects(f.spend(), /provider run spend limit reached/);
    assert.equal(await scalar(f.db, 'select count(*)::int from provider_spend_reservations'), 2);
    assert.equal(Number(await scalar(f.db, 'select sum(amount) from private.company_spend_exposure()')), 5);
    assert.equal(Number(await scalar(f.db, 'select approved_usd from full_takeoff_provider_budgets')), 5);
    assert.equal(await scalar(f.db, 'select maximum_calls from full_takeoff_provider_budgets'), 100);
  } finally { await f.db.close(); }
});

test('legacy 100-call limit survives migration600 even with known low costs and cannot use reviewed overload to exceed it', async () => {
  const f = await setup();
  try {
    for (let n = 0; n < 100; n++) await rpc(f.db, 'capture_provider_spend', [await f.spend(), .001]);
    assert.equal(await scalar(f.db, 'select count(*)::int from provider_spend_reservations'), 100);
    assert.equal(Number(await scalar(f.db, 'select sum(estimated_cost_usd) from provider_spend_reservations')), .1);
    await assert.rejects(f.spend(), /provider run spend limit reached/);
    await assert.rejects(f.spend(.5), /provider run spend limit reached/);
    assert.equal(await scalar(f.db, 'select count(*)::int from provider_spend_reservations'), 100);
    assert.equal(Number(await scalar(f.db, 'select spend_cap_usd from provider_spend_policy')), 25);
    assert.equal(Number(await scalar(f.db, 'select call_reservation_usd from provider_spend_policy')), 2.5);
  } finally { await f.db.close(); }
});
