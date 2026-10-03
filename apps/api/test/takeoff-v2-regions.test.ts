import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument,degrees } from 'pdf-lib';
import { withUsageMeter } from '../src/owner-usage/meter.ts';
import { createPlanSetManifest } from '../src/takeoff-v2/preflight.ts';
import { createStageDeepPassProviderFactory } from '../src/takeoff-v2/stage-provider.ts';
import { isolateStageRegions, stageRegionIdentity, type RegionCheckpointStore } from '../src/takeoff-v2/stage-regions.ts';
import { runDeepTakeoff } from '../src/takeoff-v2/orchestrator.ts';
import { FullTakeoffBudgetWait } from '../src/takeoff-v2/budget-wait.ts';
import type { DeepPassRequest, DeepPassResult } from '../src/takeoff-v2/types.ts';

const env = { TAKEOFF_V2_ENABLED: 'true', TAKEOFF_V2_WORKER_ENABLED: 'true', TAKEOFF_V2_STAGE_PROVIDER_ENABLED: 'true',
  TAKEOFF_V2_SCHEMA_VERSION: 'takeoff-v2-foundation-v1', TAKEOFF_V2_REGIONAL_REVIEW_ENABLED: 'true', TAKEOFF_V2_REGION_GRID: '2',
  TAKEOFF_V2_STAGE_DISCIPLINE_ENABLED: 'true', TAKEOFF_V2_STAGE_DISCIPLINE_PROVIDER: 'openai',
  TAKEOFF_V2_STAGE_DISCIPLINE_MODEL: 'gpt-6-astra', OPENAI_API_KEY: 'offline-mock-credential',
  TAKEOFF_V2_MODEL_ATTESTATIONS_JSON: JSON.stringify({ 'gpt-6-astra': {
    accountVerified: true, compatibilityVerified: true, priceVersion: 'offline-reviewed-fixture', maximumCallCostUsd: 1 } }) };
async function fixture(rotation:0|90|180|270=0) {
  const pdf = await PDFDocument.create(); pdf.addPage([200, 100]);
  pdf.getPage(0).setRotation(degrees(rotation));
  const fileBytes = new Uint8Array(await pdf.save()), manifest = await createPlanSetManifest(fileBytes);
  const input = { fileBytes, manifest, runId: 'run-1', workspaceId: 'workspace-1', projectId: 'project-1', fileId: 'file-1', leaseId: 'lease-1' };
  const request: DeepPassRequest = { runId: 'run-1', sheet: manifest.sheets[0]!, passType: 'discipline', attempt: 1,
    idempotencyKey: 'a'.repeat(64), reasoningEffort: 'high' };
  return { input, request };
}
function meter() {
  const calls: string[] = [];
  const writer = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({ error: null }) }) }),
    async rpc(fn: string) { calls.push(fn); return { data: { reserved_usd: 1 }, error: null }; } };
  return { calls, run: <T>(f: () => Promise<T>) => withUsageMeter({ writer, userId: 'user-1', workspaceId: 'workspace-1',
    projectId: 'project-1', jobId: 'run-1', billing: 'paid' }, f) };
}
function store() {
  const saved = new Map<string, DeepPassResult | null>();
  const implementation: RegionCheckpointStore = {
    async begin(_input, _request, _region, identity) {
      if (saved.has(identity)) {
        const result = saved.get(identity);
        if (!result) throw new Error('Uncertain fixture dispatch');
        return { disposition: 'saved', result };
      }
      saved.set(identity, null); return { disposition: 'run' };
    },
    async save(_input, _request, _region, identity, result) { saved.set(identity, result); },
  };
  return { saved, implementation };
}
function reply() { return Response.json({ status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, output: [{ type: 'message',
  content: [{ type: 'output_text', text: JSON.stringify({ status: 'succeeded', checkpoint: {
    version: 'claude-deep-v1', physical_page_number: 1, pass_type: 'discipline', observations: [
      { kind: 'scope', description: 'Visible partition candidate; quantity needs calibrated geometry.', source_excerpt: null, confidence: 0.7 }], blockers: [] } }) }] }] }); }

test('regional PDF review saves every individual crop and reserves each call, with no completeness claim', async () => {
  const { input, request } = await fixture(), accounting = meter(), checkpoints = store();
  const cropSizes: number[] = [], instructions: string[] = [];
  const provider = await createStageDeepPassProviderFactory(env, (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const doc = await PDFDocument.load(Buffer.from(body.input[0].content[0].file_data.split(',')[1], 'base64'));
    cropSizes.push(doc.getPage(0).getCropBox().width); instructions.push(body.input[0].content[1].text);
    return reply();
  }) as typeof fetch, { regionCheckpoints: checkpoints.implementation }).create(input);
  const result = await accounting.run(() => provider.runPass(request));
  assert.equal(checkpoints.saved.size, 4); assert.equal(cropSizes.length, 4);
  assert.ok(cropSizes.every(width => width < 200)); assert.ok(instructions.every(text => text.includes('ONLY region')));
  assert.equal(accounting.calls.filter(fn => fn === 'reserve_provider_spend').length, 4);
  assert.equal(accounting.calls.filter(fn => fn === 'capture_provider_spend').length, 4);
  assert.equal(result.status, 'succeeded');
  assert.equal((result.checkpoint.source_coverage as any).completeness_verified, false);
  assert.equal((result.checkpoint.source_coverage as any).overlap_deduplication, 'human_review_required');
  assert.equal((result.checkpoint.observations as any[]).length, 4);
  assert.equal(new Set((result.checkpoint.observations as any[]).map(value => value.region_key)).size, 4);
});

test('missing regional persistence blocks before exposure and never falls back to a whole sheet', async () => {
  const { input, request } = await fixture(); const accounting = meter();
  const provider = await createStageDeepPassProviderFactory(env, (async () => { assert.fail('Paid dispatch must not happen'); }) as typeof fetch).create(input);
  const result = await accounting.run(() => provider.runPass(request));
  assert.equal(result.status, 'blocked'); assert.equal(accounting.calls.length, 0);
});

test('a crash after saved regions preserves them and refuses a repeat of the uncertain region', async () => {
  const { input, request } = await fixture(); const checkpoints = store(), accounting = meter(); let dispatches = 0;
  const fetcher = (async () => { dispatches++; if (dispatches === 3) throw new Error('Fixture transport lost after dispatch'); return reply(); }) as typeof fetch;
  const factory = createStageDeepPassProviderFactory(env, fetcher, { regionCheckpoints: checkpoints.implementation });
  const first = await factory.create(input);
  await assert.rejects(accounting.run(() => first.runPass(request)));
  assert.equal([...checkpoints.saved.values()].filter(Boolean).length, 2);
  const resumed = await factory.create(input);
  await assert.rejects(accounting.run(() => resumed.runPass(request)), /Uncertain fixture/);
  assert.equal(dispatches, 3);
});

test('regional identity binds file page, crop, model and pass without treating overlap as another object', async () => {
  const { input, request } = await fixture(); const regions = await isolateStageRegions(input.fileBytes, 2);
  const identity = await stageRegionIdentity(request, regions[0]!, 'openai', 'gpt-6-astra');
  assert.match(identity, /^[a-f0-9]{64}$/);
  assert.notEqual(identity, await stageRegionIdentity(request, regions[1]!, 'openai', 'gpt-6-astra'));
  assert.notEqual(identity, await stageRegionIdentity({ ...request, passType: 'completeness' }, regions[0]!, 'openai', 'gpt-6-astra'));
  assert.notEqual(identity, await stageRegionIdentity(request, regions[0]!, 'claude', 'claude-opus-5-5'));
});

test('inventory covers later sheets before any sheet-specific geometry or reconciliation', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage(); pdf.addPage();
  const manifest = await createPlanSetManifest(new Uint8Array(await pdf.save())); const order: string[] = [];
  await runDeepTakeoff('offline-set', manifest, { async runPass(request) {
    order.push(`${request.passType}:${request.sheet.physicalPageNumber}`); return { status: 'succeeded', checkpoint: {} };
  } }, { async begin() { return 'run'; }, async succeed() {}, async fail() {} });
  assert.deepEqual(order.slice(0, 6), ['classification:1','classification:2','classification:3','legends_schedules:1','legends_schedules:2','legends_schedules:3']);
  assert.equal(order[6], 'geometry:1');
});

test('cancellation aborts the active transport and keeps the uncertain regional claim without retry',async()=>{
  const {input,request}=await fixture(),checkpoints=store(),accounting=meter(),controller=new AbortController();let dispatched=0;
  const fetcher=(async(_url,init)=>{
    dispatched++;const signal=init?.signal;assert.ok(signal);
    return new Promise<Response>((_resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(new Error('Offline transport aborted')),{once:true});
      queueMicrotask(()=>controller.abort());
    });
  }) as typeof fetch;
  const provider=await createStageDeepPassProviderFactory(env,fetcher,{regionCheckpoints:checkpoints.implementation}).create({...input,signal:controller.signal});
  await assert.rejects(accounting.run(()=>provider.runPass(request)));
  assert.equal(dispatched,1);assert.equal(checkpoints.saved.size,1);assert.equal([...checkpoints.saved.values()][0],null);
  await assert.rejects(accounting.run(()=>provider.runPass(request)));assert.equal(dispatched,1);
  const preCancelled=new AbortController();preCancelled.abort();
  await assert.rejects(createStageDeepPassProviderFactory(env,fetcher).create({...input,signal:preCancelled.signal}));assert.equal(dispatched,1);
});

test('financial admission precedes regional claims; a refusal leaves no uncertain region and saved crops resume once',async()=>{
  const {input,request}=await fixture(),checkpoints=store();const sequence:string[]=[];let reservations=0,dispatches=0,denied=true;
  checkpoints.implementation.inspect=async(_input,_request,_region,identity)=>{
    if(checkpoints.saved.has(identity)){
      const result=checkpoints.saved.get(identity);if(!result)throw new Error('Uncertain fixture dispatch');
      return {disposition:'saved',result};
    }
    return {disposition:'run'};
  };
  const begin=checkpoints.implementation.begin;
  checkpoints.implementation.begin=async(...args)=>{assert.ok(args[4]);sequence.push('region');return begin(...args);};
  const writer={from:()=>({insert:async()=>({error:null}),update:()=>({eq:async()=>({error:null})})}),
    rpc:async(fn:string)=>{if(fn==='reserve_provider_spend'){reservations++;sequence.push('reserve');
      if(denied&&reservations===3)return{data:null,error:{message:'Company AI spend limit reached'}};}
      return{data:{reserved_usd:1},error:null};}};
  const scope=<T>(run:()=>Promise<T>)=>withUsageMeter({writer,userId:'user-1',workspaceId:'workspace-1',projectId:'project-1',jobId:'run-1',billing:'paid'},run);
  const factory=createStageDeepPassProviderFactory(env,(async()=>{sequence.push('send');dispatches++;return reply();}) as typeof fetch,{regionCheckpoints:checkpoints.implementation});
  const claim=async(eventId?:string)=>{assert.match(eventId!,/^[a-f0-9-]{36}$/);sequence.push('parent');};
  const first=await factory.create(input);
  await assert.rejects(scope(()=>first.runPass(request,claim)),FullTakeoffBudgetWait);
  assert.equal(dispatches,2);assert.equal(checkpoints.saved.size,2);assert.ok([...checkpoints.saved.values()].every(Boolean));
  assert.deepEqual(sequence,['reserve','parent','region','send','reserve','parent','region','send','reserve']);
  denied=false;const resumed=await factory.create(input);const result=await scope(()=>resumed.runPass(request,claim));
  assert.equal(dispatches,4);assert.equal(reservations,5);assert.equal(checkpoints.saved.size,4);
  assert.equal((result.checkpoint.source_coverage as any).completed_regions,4);
});

test('revoked checkpoint lease after admission sends no provider request',async()=>{
  const {input,request}=await fixture(),checkpoints=store(),accounting=meter();let sends=0;
  checkpoints.implementation.inspect=async()=>({disposition:'run'});
  const provider=await createStageDeepPassProviderFactory(env,(async()=>{sends++;return reply();}) as typeof fetch,{regionCheckpoints:checkpoints.implementation}).create(input);
  await assert.rejects(accounting.run(()=>provider.runPass(request,async()=>{throw new Error('Lease revoked');})),/Lease revoked/);
  assert.equal(sends,0);assert.equal(checkpoints.saved.size,0);assert.equal(accounting.calls.filter(x=>x==='reserve_provider_spend').length,1);
});

test('rotated regional stages send all four original-orientation PDF crops with explicit source/display frames',async()=>{
  for(const rotation of [90,180,270] as const){
    const {input,request}=await fixture(rotation),accounting=meter(),checkpoints=store();let calls=0;
    const provider=await createStageDeepPassProviderFactory(env,(async(_url,init)=>{
      calls++;const body=JSON.parse(String(init?.body)),content=body.input[0].content;
      const crop=await PDFDocument.load(Buffer.from(content[0].file_data.split(',')[1],'base64'));
      assert.equal(crop.getPageCount(),1);assert.equal(crop.getPage(0).getRotation().angle,rotation);
      assert.match(content[1].text,/UNROTATED PDF points/);assert.match(content[1].text,new RegExp(`rotation of ${rotation} degrees`));
      assert.match(content[1].text,/displayed_cropbox_top_left_points/);return reply();
    }) as typeof fetch,{regionCheckpoints:checkpoints.implementation}).create(input);
    const result=await accounting.run(()=>provider.runPass(request));
    assert.equal(calls,4);assert.equal(checkpoints.saved.size,4);assert.equal(result.status,'succeeded');
    assert.equal((result.checkpoint.source_coverage as any).rotation_degrees,rotation);
    assert.equal((result.checkpoint.source_coverage as any).completed_regions,4);
  }
});
