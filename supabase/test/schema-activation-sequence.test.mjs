import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Synthetic dependency-equivalent bootstrap, not a production clone. Source
// fixture DDL is reused without running its tests or evaluating template code.
const fixture = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const migration = name => readFileSync(new URL(`../migrations/${name}`, import.meta.url));
const canonicalSql = bytes => bytes.toString('utf8').replace(/\r\n?/g, '\n');
export const activationSequence = [
  ['20261002110000_durable_owner_workspace_dependency.sql', 'fd171d5e045a532a21a07ed1a85bed449f54d0bddab97c1f9de32de95e14ff2c'],
  ['0023_durable_ai_plan_jobs.sql', '57a7ece9fce944a6e16ae1db9f7d805025e83f893d4023700d2dd28822ebc77e'],
  ['0024_durable_ai_worker_capabilities.sql', '21fbd3e0e78d95ed7fc31b855ee1c9ddebc02e1658f36a6b936d50a05ac1858c'],
  ['0025_durable_ai_lease_alignment.sql', '9d83feffeb0b47397baf5963aa62e02d98d3bb5c6415c4d089ae7558528a8209'],
  ['20260910225937_takeoff_v2_foundation.sql', '3c278263e09e8cee8d02132fde169080c44e15a6f074ed2800047260e6201b8d'],
  ['20260910233003_takeoff_v2_fk_indexes.sql', '7dbabcd9cd9315730d1897494f0f771c35d3f27cfa8bc07c0870d31c2f4d92f2'],
  ['20260919142500_low_cost_ai_provider_spend.sql', '18495264e64b2313618702e50d2205adea166b7abf57fe3a2bacba963fff5763'],
  ['20260924134500_openai_claude_provider_spend.sql', '81243d9417d1aec0146839a777f9dc842032bbbf882b10f8782703e578219491'],
  ['20260925200000_exhaustive_plan_scan.sql', '0b5f56844c45094ccbfd8f20edda8e60b0141f498815214adb4f5e2589d1629d'],
  ['20261002120000_full_takeoff_v2_durable.sql', 'f5914237deb156b0e78ae910342069e49148a9568c9903bf9dc1497e47e7cf4a'],
  ['20261002130000_photo_takeoff.sql', 'e243d940024afe5fa24da72314f60d6d37a15f9be3e179586272180aca1eec3d'],
  ['20261002140000_takeoff_measurement_review.sql', '9f5187aa0d3462810bf5df271dd5974c14e7a3872b8657559a0847bb6e3c2f8d'],
  ['20261002150000_full_takeoff_regions.sql', 'dbf3104c877d9dcfabc48e993dbdd53edc63798d22421348d7c9da9fffec8fac'],
  ['20261002160000_full_takeoff_run_budgets.sql', 'c01d69a7d0e6c70edbe8a519ce43000c7604500d80a319daa20864b90ddee01b'],
  ['20261002170000_construction_budget.sql', '1b0de9c1eb11047b78a016db5d62a083ff8f39b5491de6dd24cff102b9b6384a'],
  ['20261002180000_geometry_provider_jobs.sql', 'b9f82bca51e893812dd8b55578424746e20873ceb768a17a9c214cb76ebdd213'],
  ['20261002190000_geometry_construction_budget.sql', '1b7cae47ea66da2e0c18ab941ea1d4fd3d4963291fcd528de36669692c6fffd2'],
];

async function equivalentBaseline() {
  const db = new PGlite();
  const exhaustive = fixture('exhaustive-plan-scan.test.mjs');
  const commercial = fixture('ai-provider-spend-openai.test.mjs');
  let base = exhaustive.match(/await db\.exec\(`([\s\S]*?)`\);/)[1].split('    insert into auth.users')[0];
  // The real audited base does not contain this dependency; the FIRST reviewed
  // migration must create it. Do not hide that absence with an existing fixture.
  base = base.replace(/create table private\.free_owner_workspaces\(workspace_id uuid primary key\);/, '');
  const commercialDdl = commercial.match(/await db\.exec\(`([\s\S]*?)`\);/)[1];
  base += `
    alter table projects add unique(id,workspace_id);
    alter table project_files add unique(id,workspace_id,project_id);
    alter table project_files add column page_count integer;
    alter table plan_reading_jobs add unique(id,workspace_id);
    ${commercialDdl.match(/    create table api_usage_events[^\n]+/)[0]}
    ${commercialDdl.slice(commercialDdl.indexOf('    create table marketplace_entitlements'), commercialDdl.indexOf('    insert into auth.users'))}
    create function auth.uid() returns uuid language sql stable as 'select null::uuid';
    create function private.has_workspace_role(uuid,text[]) returns boolean language sql stable as 'select true';
    create function private.has_product_access() returns boolean language sql stable as 'select true';
  `;
  await db.exec(base);
  // ONLY the disposable local DB receives historical 0039 to represent the
  // already-installed remote 20260910190303 commercial baseline.
  await db.exec(migration('0039_commercial_spend_and_marketplace.sql').toString('utf8'));
  return db;
}

test('exact 17-file activation sequence applies on a synthetic commercial-equivalent baseline', async t => {
  const db = await equivalentBaseline();
  try {
    for (const [file, expectedHash] of activationSequence) {
      const bytes = migration(file);
      assert.equal(createHash('sha256').update(canonicalSql(bytes), 'utf8').digest('hex'), expectedHash, `bundle drift: ${file}`);
      await db.exec(bytes.toString('utf8'));
      t.diagnostic(`PASS ${file}`);
    }
    for (const table of ['takeoff_runs', 'takeoff_passes', 'photo_assets', 'takeoff_measurement_reviews', 'takeoff_region_checkpoints', 'full_takeoff_provider_budgets', 'construction_supplier_quotes', 'construction_budget_snapshots', 'geometry_provider_jobs', 'geometry_provider_candidates']) {
      const result = await db.query('select relrowsecurity from pg_class where oid=to_regclass($1)', [`public.${table}`]);
      assert.equal(result.rows[0]?.relrowsecurity, true, `RLS: ${table}`);
    }
    const writers = (await db.query(`select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('reserve_full_takeoff_v2','reserve_photo_takeoff','reserve_geometry_provider_job','save_construction_budget_snapshot','save_construction_supplier_quotes')`)).rows;
    assert.equal(writers.length, 5);
    for (const writer of writers) {
      const grants = (await db.query(`select has_function_privilege('anon',$1::oid,'execute') as anon,has_function_privilege('authenticated',$1::oid,'execute') as authenticated,has_function_privilege('service_role',$1::oid,'execute') as service`, [writer.oid])).rows[0];
      assert.deepEqual(grants, { anon: false, authenticated: false, service: true }, writer.proname);
    }
    const parent = (await db.query(`select data_type from information_schema.columns where table_schema='public' and table_name='construction_budget_snapshots' and column_name='geometry_run_id'`)).rows;
    assert.equal(parent[0]?.data_type, 'uuid');
    assert.equal((await db.query('select count(*)::int as count from private.free_owner_workspaces')).rows[0].count, 0);
    assert.equal((await db.query("select relrowsecurity from pg_class where oid=to_regclass('private.free_owner_workspaces')")).rows[0].relrowsecurity, true);
    // Parse/run the actual nonmutating gate on this deliberately different local
    // baseline. It must reject already-applied new objects, not bless partial work.
    await db.exec('create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text,name text)');
    const gate = readFileSync(new URL('../preflight/roughbid-activation-readonly.sql', import.meta.url), 'utf8');
    const rows = (await db.query(gate)).rows;
    assert.equal(rows.find(r => r.check_name==='00.summary')?.status, 'BLOCKER');
    assert.equal(rows.find(r => r.check_name==='absence.relation.public.takeoff_runs')?.status, 'BLOCKER');
    assert.equal(rows.find(r => r.check_name==='dependency.owner_free_allowlist_planned_closed')?.status, 'BLOCKER');
  } finally { await db.close(); }
});

test('bundle checksum guard refuses an altered migration before execution', () => {
  const [file, expectedHash] = activationSequence[0];
  const altered = Buffer.concat([migration(file), Buffer.from('\n-- hypothetical drift\n')]);
  assert.throws(() => assert.equal(createHash('sha256').update(canonicalSql(altered), 'utf8').digest('hex'), expectedHash), /AssertionError/);
});
