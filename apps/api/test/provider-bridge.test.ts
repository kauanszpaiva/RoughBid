import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGE_HEADER_NAMES, BRIDGE_PATH, BRIDGE_PROTOCOL, BridgeError, type BridgeCommand } from '../src/provider-bridge/protocol.ts';
import { bridgeSha256, signBridgeCommand, verifyBridgeSignature, type BridgeAuthConfig } from '../src/provider-bridge/auth.ts';
import { authenticateBridgeRequest, parseBridgeCommand } from '../src/provider-bridge/request.ts';
import { bridgeCanonical, bridgeObjectHash, requireBridgeRuntimeConfig } from '../src/provider-bridge/config.ts';
import { handleProviderBridge } from '../src/provider-bridge/service.ts';
import { ProviderBridgeClient } from '../src/provider-bridge/client.ts';
import type { BridgeOperation, BridgeDatabase } from '../src/provider-bridge/persistence.ts';
import { createPlanSetManifest } from '../src/takeoff-v2/preflight.ts';
import { fullTakeoffApprovalProfile, approveFullTakeoffSpend } from '../src/takeoff-v2/user-spend-approval.ts';
import { createStageDeepPassProviderFactory } from '../src/takeoff-v2/stage-provider.ts';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { withUsageMeter, meterGeminiCall, meterOpenAiCompatibleCall } from '../src/owner-usage/meter.ts';
import { renderBridgeRegion, verifyBridgeRenderer, bridgePageImages } from '../src/provider-bridge/renderer.ts';
import { isolateStageRegions } from '../src/takeoff-v2/stage-regions.ts';
import { planPageRegions } from '../src/ai-plan/page-tiles.ts';

const now = 1791000000;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const command = (): BridgeCommand => ({ action: 'submit_stage', protocol: BRIDGE_PROTOCOL, run_id: id(1), operation_id: id(2),
  worker: { worker_id: id(3), worker_generation: id(4), lease_id: id(5), fence: '7' }, expected_stage_version: 3,
  expected_approved_contract_sha256: '1'.repeat(64), expected_operation_spec_sha256: '2'.repeat(64) });
const config = (): BridgeAuthConfig => ({ existingSecret: Buffer.from('fixture-only-secret-not-a-real-service-role'),
  trustedEnvironmentContext: 'fixture-supabase-project/production', canonicalize: bridgeCanonical, maxSkewSeconds: 90 });
function request(c = command(), raw?: string, path = BRIDGE_PATH): Request {
  const signed = signBridgeCommand(c, config(), now);
  return new Request(`https://roughbid.test${path}`, { method: 'POST', body: raw ?? signed.canonical_body,
    headers: { 'content-type': 'application/json', [BRIDGE_HEADER_NAMES.timestamp]: signed.headers.timestamp,
      [BRIDGE_HEADER_NAMES.nonce]: signed.headers.nonce, [BRIDGE_HEADER_NAMES.signature]: signed.headers.signature } });
}
const errorCode = (code: string) => (error: unknown) => error instanceof BridgeError && error.code === code && error.message === code;

test('bridge parses the closed command and signs canonical identity independently of JSONB key order', async () => {
  const c = command(), signed = signBridgeCommand(c, config(), now);
  const reordered = Object.fromEntries(Object.entries(c).reverse()) as BridgeCommand;
  const verified = verifyBridgeSignature(reordered, signed.headers, config(), now);
  assert.equal(verified.command_body_sha256, bridgeSha256(signed.canonical_body));
  assert.equal(verified.nonce_sha256.length, 64);
  assert.deepEqual(JSON.parse(JSON.stringify(parseBridgeCommand(JSON.stringify(c)))), c);
  const authenticated = await authenticateBridgeRequest(request(c, JSON.stringify(reordered)), config(), now);
  assert.equal(authenticated.command.operation_id, c.operation_id);
  assert.equal('authorized' in authenticated, false); // HMAC does not grant spending or dispatch.
});

test('bridge command rejects duplicate decoded keys, unsafe numbers, invalid unicode and caller-selected provider inputs', () => {
  const raw = JSON.stringify(command());
  const invalid = [
    raw.replace('"action":', '"action":"get_operation","action":'),
    raw.replace('"action":', '"\\u0061ction":"get_operation","action":'),
    raw.replace('"fence":"7"', '"fence":"7","fence":"8"'),
    raw.replace('"expected_stage_version":3', '"expected_stage_version":9007199254740993'),
    raw.replace('"expected_stage_version":3', '"expected_stage_version":1e999'),
    raw.replace('"expected_stage_version":3', '"expected_stage_version":-0'),
    raw.replace('"fence":"7"', '"fence":"9223372036854775808"'),
    raw.replace('"fence":"7"', '"fence":7'),
    raw.replace('"fence":"7"', '"fence":"07"'),
    raw.replace('"fence":"7"', '"fence":"\\ud800"'),
    raw.replace('"worker":{', '"worker":{"__proto__":{},'),
    raw + ' {}', raw.replace('"worker":{', '"worker":{"nested":{'),
    ...['model', 'provider', 'url', 'prompt', 'paid', 'cost', 'file_path'].map(key => raw.replace('{', `{"${key}":"caller value",`)),
  ];
  for (const body of invalid) assert.throws(() => parseBridgeCommand(body), errorCode('bridge_request_invalid'));
  assert.throws(() => parseBridgeCommand(' '.repeat(16385)), errorCode('bridge_body_too_large'));
});

test('get and reconcile allow only identity fields; operation spec is stable while worker proof and signature change', () => {
  const full = command();
  for (const action of ['get_operation', 'reconcile_operation'] as const) {
    const c = { action, protocol: full.protocol, run_id: full.run_id, operation_id: full.operation_id, worker: full.worker };
    assert.equal(parseBridgeCommand(JSON.stringify(c)).action, action);
    assert.throws(() => parseBridgeCommand(JSON.stringify({ ...c, expected_stage_version: 1 })), errorCode('bridge_request_invalid'));
  }
  const newer = { ...full, worker: { ...full.worker, worker_generation: id(8), lease_id: id(9), fence: '8' } };
  const previous = signBridgeCommand(full, config(), now), next = signBridgeCommand(newer, config(), now);
  assert.notEqual(previous.canonical_body, next.canonical_body);
  assert.equal(newer.action === 'submit_stage' && newer.expected_operation_spec_sha256,
    full.action === 'submit_stage' && full.expected_operation_spec_sha256);
  assert.throws(() => verifyBridgeSignature(newer, previous.headers, config(), now), errorCode('bridge_auth_invalid'));
});

test('MAC, time, context, secret and canonical base64 mutations fail with fixed errors and no credentials', () => {
  const c = command(), cfg = config(), signed = signBridgeCommand(c, cfg, now), secretBefore = Buffer.from(cfg.existingSecret);
  for (const altered of [{ ...signed.headers, signature: 'A'.repeat(43) }, { ...signed.headers, nonce: 'A'.repeat(43) },
    { ...signed.headers, timestamp: '1' }, { ...signed.headers, signature: signed.headers.signature + '=' }]) {
    assert.throws(() => verifyBridgeSignature(c, altered, cfg, now), errorCode('bridge_auth_invalid'));
  }
  assert.throws(() => verifyBridgeSignature(c, signed.headers, cfg, now + 91), errorCode('bridge_auth_expired'));
  assert.throws(() => verifyBridgeSignature(c, signed.headers, cfg, now - 91), errorCode('bridge_auth_expired'));
  assert.throws(() => verifyBridgeSignature(c, signed.headers, { ...cfg, trustedEnvironmentContext: 'other/production' }, now), errorCode('bridge_auth_invalid'));
  assert.throws(() => verifyBridgeSignature(c, signed.headers, { ...cfg, existingSecret: Buffer.from('another-fixture-only-secret') }, now), errorCode('bridge_auth_invalid'));
  assert.throws(() => verifyBridgeSignature(c, signed.headers, { ...cfg, maxSkewSeconds: 301 }, now), errorCode('bridge_auth_unconfigured'));
  assert.deepEqual(Buffer.from(cfg.existingSecret), secretBefore); // Only derived bytes are cleared.
});

test('request enforces fixed method/path/content type and bounds actual bytes without trusting Content-Length', async () => {
  for (const path of [BRIDGE_PATH + '?url=https://example.com', BRIDGE_PATH + '/', '/api/other']) {
    await assert.rejects(authenticateBridgeRequest(request(command(), undefined, path), config(), now), errorCode('bridge_request_invalid'));
  }
  await assert.rejects(authenticateBridgeRequest(new Request(`https://roughbid.test${BRIDGE_PATH}`), config(), now), errorCode('bridge_request_invalid'));
  const wrongType = request(); wrongType.headers.set('content-type', 'text/plain');
  await assert.rejects(authenticateBridgeRequest(wrongType, config(), now), errorCode('bridge_request_invalid'));
  const oversized = request(command(), ' '.repeat(5000)); oversized.headers.set('content-length', '1');
  await assert.rejects(authenticateBridgeRequest(oversized, config(), now, 1024), errorCode('bridge_body_too_large'));
  const invalidUtf8 = new Request(`https://roughbid.test${BRIDGE_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array([0xff]) });
  await assert.rejects(authenticateBridgeRequest(invalidUtf8, config(), now), errorCode('bridge_request_invalid'));
});

test('fresh transport retry retains operation identity, while exact nonce replay only yields proof for the future durable guard', () => {
  const c = command(), cfg = config(), a = signBridgeCommand(c, cfg, now), b = signBridgeCommand(c, cfg, now);
  assert.equal(a.canonical_body, b.canonical_body); assert.notEqual(a.headers.nonce, b.headers.nonce);
  const first = verifyBridgeSignature(c, a.headers, cfg, now), replay = verifyBridgeSignature(c, a.headers, cfg, now);
  assert.deepEqual(replay, first); assert.equal(Object.keys(first).length, 2);
  // No SQL replay guard, CAS, provider or accounting integration is claimed here.
});

test('slow or aborted request bodies stop within the bounded read deadline', async () => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  const req = new Request(`https://roughbid.test${BRIDGE_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: stream, duplex: 'half' } as RequestInit);
  await assert.rejects(authenticateBridgeRequest(req, config(), now, 16384, 20), errorCode('bridge_request_invalid'));
  assert.equal(cancelled, 1);
  const controller = new AbortController(); controller.abort();
  const aborted = new Request(`https://roughbid.test${BRIDGE_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command()), signal: controller.signal });
  await assert.rejects(authenticateBridgeRequest(aborted, config(), now), errorCode('bridge_request_invalid'));
});

test('production RFC8785 canonicalizer preserves Unicode/array order and rejects non-I-JSON values', () => {
  assert.equal(bridgeCanonical({ numbers:[333333333.33333329,1e30,4.50,2e-3,1e-27], literals:[null,true,false] }),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}');
  const keys=['\u20ac','\r','\ufb33','1','\ud83d\ude00','\u0080','\u00f6'];
  assert.deepEqual(Object.keys(JSON.parse(bridgeCanonical(Object.fromEntries(keys.map(k=>[k,k]))))), ['1','\r','\u0080','\u00f6','\u20ac','\ud83d\ude00','\ufb33']);
  assert.notEqual(bridgeObjectHash([1,2]),bridgeObjectHash([2,1]));
  for(const value of [NaN,Infinity,'\ud800',{'\udfff':1}])assert.throws(()=>bridgeCanonical(value));
});

async function executionFixture(options:{unknown?:boolean;denyClaim?:boolean;companyWait?:boolean;changedSource?:boolean;unknownUsage?:boolean;schemaCapability?:unknown;provider?:'gemini'|'kimi'|'deepseek';grid?:2|3}={}){
  const providerName=options.provider??'gemini',model=providerName==='gemini'?'gemini-3.8-flash':providerName==='kimi'?'kimi-k3':'deepseek-flash';
  const serverEnv:Record<string,string|undefined>={TAKEOFF_V2_ENABLED:'true',TAKEOFF_V2_WORKER_ENABLED:'true',
    TAKEOFF_V2_SCHEMA_VERSION:'takeoff-v2-foundation-v1',TAKEOFF_V2_STAGE_PROVIDER_ENABLED:'true',
    TAKEOFF_V2_STAGE_CLASSIFICATION_ENABLED:'true',TAKEOFF_V2_STAGE_CLASSIFICATION_PROVIDER:providerName,
    TAKEOFF_V2_STAGE_CLASSIFICATION_MODEL:model,TAKEOFF_V2_PROVIDER_TIMEOUT_MS:'1000',TAKEOFF_V2_REGION_GRID:String(options.grid??2),
    TAKEOFF_V2_MODEL_ATTESTATIONS_JSON:JSON.stringify({[model]:{accountVerified:true,compatibilityVerified:true,priceVersion:'test-only-2026',maximumCallCostUsd:2.5}}),
    TAKEOFF_V2_CALL_RESERVATION_USD:'2.5',TAKEOFF_V2_RUN_SPEND_LIMITS_JSON:JSON.stringify({[providerName]:{approvedUsd:5,maximumCalls:100,approvalRef:'test-only'}}),
    KIMI_PRIVATE_PLAN_DATA_APPROVED:'true',DEEPSEEK_PRIVATE_PLAN_DATA_APPROVED:'true',KIMI_API_KEY:'synthetic-kimi-key',DEEPSEEK_API_KEY:'synthetic-deepseek-key',
    TAKEOFF_V2_TRANSPORT:'bridge',PROVIDER_BRIDGE_ENABLED:'true',PROVIDER_BRIDGE_URL:`https://roughbid.test${BRIDGE_PATH}`,
    PROVIDER_BRIDGE_AUTH_CONTEXT:'test-project/production',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key-only-for-offline-tests',GEMINI_API_KEY:'synthetic-gemini-key-only-for-offline-tests'};
  const serverConfig=requireBridgeRuntimeConfig(serverEnv,'server'),workerEnv={...serverEnv,GEMINI_API_KEY:undefined,KIMI_API_KEY:undefined,DEEPSEEK_API_KEY:undefined},workerConfig=requireBridgeRuntimeConfig(workerEnv,'worker');
  const pdf=await PDFDocument.create();pdf.addPage([612,792]);const bytes=new Uint8Array(await pdf.save());
  const manifest=await createPlanSetManifest(bytes),profile=fullTakeoffApprovalProfile(workerEnv);
  manifest.spendApproval=approveFullTakeoffSpend({confirmed:true,policyId:profile.policyId,budgetsUsd:{[providerName]:5}},profile,id(7));
  const worker={worker_id:id(3),worker_generation:id(4),lease_id:id(5),fence:'1'};
  let operation:BridgeOperation={id:id(2),run_id:id(1),event_id:id(8),state:'planned',state_version:'1',
    spec:{schema_version:1,protocol:BRIDGE_PROTOCOL,run_id:id(1),workspace_id:id(10),project_id:id(11),user_id:id(7),file_id:id(12),
      file_sha256:manifest.fileSha256,sheet:manifest.sheets[0]!,pass_type:'classification',region_key:null,stage_version:1,authorized_attempt:1,
      approved_contract:manifest.spendApproval,profile:serverConfig.profile,previous_pass_ids:[]},
    operation_spec_sha256:null,dispatch_payload_sha256:null,result_ref:null,result_sha256:null,cost_state:'unreserved',captured_usd_micros:null,not_before:null,error_code:null};
  const calls:string[]=[],nonces=new Map<string,string>();let reserves=0,providerCalls=0,savedResult:any,denyAuthority=false;
  const snapshot=()=>structuredClone(operation),change=(patch:Partial<BridgeOperation>)=>{operation={...operation,...patch,state_version:String(Number(operation.state_version)+1)};};
  const db:BridgeDatabase={from(){assert.fail('The delegated provider execution must not insert a second usage event.');},async rpc(name,args:any={}){
    calls.push(name);
    if(name==='provider_bridge_schema_ready')return {data:options.schemaCapability??{ready:true,reservationCapability:'reviewed-operation-reservations-v1'},error:null};
    if(denyAuthority)return {data:null,error:{message:'synthetic private authority reason'}};
    if(name==='prepare_provider_bridge_full_operation')return {data:{operation:snapshot(),worker},error:null};
    if(name==='authorize_provider_bridge_command'){
      assert.equal(bridgeObjectHash(args.p_command.worker),bridgeObjectHash(worker));const prior=nonces.get(args.p_nonce_sha256);
      if(prior&&prior!==args.p_body_sha256)return {data:null,error:{message:'nonce conflict'}};
      nonces.set(args.p_nonce_sha256,args.p_body_sha256);
      return {data:{replay:!!prior,operation:snapshot(),run:{workspace_id:id(10),project_id:id(11),file_id:id(12),requested_by:id(7),manifest,
        storage_path:`${id(10)}/${id(11)}/${id(12)}.pdf`}},error:null};
    }
    if(name==='reserve_provider_bridge_operation'){
      if(options.companyWait){change({state:'waiting_budget',error_code:'company_budget'});return {data:snapshot(),error:null};}
      if(['planned','waiting_budget'].includes(operation.state)){reserves++;change({state:'reserved',cost_state:'reserved'});}return {data:snapshot(),error:null};
    }
    if(name==='claim_provider_bridge_dispatch'){
      if(options.denyClaim)return {data:null,error:{message:'lease revoked before network'}};
      const won=operation.state==='reserved'&&operation.state_version===String(args.p_expected_state_version);
      if(won){assert.equal(args.p_source_hashes.file_sha256,manifest.fileSha256);assert.match(args.p_dispatch_payload_sha256,/^[a-f0-9]{64}$/);
        change({state:'dispatching',operation_spec_sha256:args.p_operation_spec_sha256,dispatch_payload_sha256:args.p_dispatch_payload_sha256});}
      return {data:{won,operation:snapshot(),...(won?{dispatch_token:id(9)}:{})},error:null};
    }
    if(name==='finalize_provider_bridge_operation'){
      assert.equal(args.p_dispatch_token,id(9));savedResult=args.p_result;
      change({state:args.p_outcome==='result'?'completed':'dispatch_unknown',result_ref:args.p_result?id(2):null,result_sha256:args.p_result_sha256,
        cost_state:args.p_usage.estimated_cost_usd==null?'held_unknown':'captured',captured_usd_micros:args.p_usage.estimated_cost_usd==null?null:'1000',
        error_code:args.p_outcome==='unknown'?'dispatch_outcome_unknown':null});return {data:snapshot(),error:null};
    }
    if(name==='read_provider_bridge_result')return {data:{result:savedResult,result_sha256:operation.result_sha256},error:null};
    assert.fail(`Unexpected RPC ${name}`);
  }};
  const storage={presign:async()=>({url:'https://storage.test/synthetic-private-plan'})};
  const checkpoint={status:'succeeded',checkpoint:{version:'claude-deep-v1',physical_page_number:1,pass_type:'classification',observations:[],blockers:[]}};
  const fetcher=(async(url:unknown,init?:RequestInit)=>{
    if(String(url).startsWith('https://storage.test/')){calls.push('storage');return new Response(options.changedSource?new Uint8Array([0]):bytes);}
    assert.equal(String(url),providerName==='gemini'?'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent'
      :providerName==='kimi'?'https://api.moonshot.ai/v1/chat/completions':'https://api.deepseek.com/chat/completions');
    assert.equal(operation.state,'dispatching');providerCalls++;calls.push('provider');
    const body=JSON.parse(String(init?.body));
    if(providerName==='gemini'){assert.equal(body.generationConfig.maxOutputTokens,64000);assert.equal(body.generationConfig.thinkingConfig.thinkingLevel,'HIGH');}
    else{assert.equal(body[providerName==='kimi'?'max_completion_tokens':'max_tokens'],64000);assert.equal(body.reasoning_effort,'max');
      assert.equal(body.messages[1].content.filter((p:any)=>p.type==='image_url').length,(options.grid??2)**2);assert.doesNotMatch(JSON.stringify(body),/application\/pdf/);}
    if(options.unknown)throw new Error('synthetic network failure with private diagnostics');
    if(providerName!=='gemini')return Response.json({id:'test-only-response',choices:[{finish_reason:'stop',message:{content:JSON.stringify(checkpoint)}}],usage:{prompt_tokens:100,completion_tokens:25}});
    return Response.json({responseId:'test-only-provider-response',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(checkpoint)}]}}],
      ...(options.unknownUsage?{}:{usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:5}})});
  }) as typeof fetch;
  const deps={db,storage,config:serverConfig,env:serverEnv,fetcher};
  const server=(async(url:unknown,init?:RequestInit)=>handleProviderBridge(new Request(String(url),init),deps)) as typeof fetch;
  const submitCommand=():Extract<BridgeCommand,{action:'submit_stage'}>=>({action:'submit_stage',protocol:BRIDGE_PROTOCOL,run_id:id(1),operation_id:id(2),worker,
    expected_stage_version:1,expected_approved_contract_sha256:bridgeObjectHash(operation.spec.approved_contract),expected_operation_spec_sha256:bridgeObjectHash(operation.spec)});
  const send=async(c:BridgeCommand,existing?:Request)=>{const signed=signBridgeCommand(c,serverConfig.auth,Math.floor(Date.now()/1000));
    const req=existing??new Request(serverConfig.endpoint,{method:'POST',body:signed.canonical_body,headers:{'content-type':'application/json',
      [BRIDGE_HEADER_NAMES.timestamp]:signed.headers.timestamp,[BRIDGE_HEADER_NAMES.nonce]:signed.headers.nonce,[BRIDGE_HEADER_NAMES.signature]:signed.headers.signature}});
    return handleProviderBridge(req,deps);};
  const input={fileBytes:bytes,manifest,runId:id(1),workspaceId:id(10),projectId:id(11),fileId:id(12),leaseId:id(5)};
  const metered=<T>(action:()=>Promise<T>)=>withUsageMeter({writer:db,userId:id(7),workspaceId:id(10),projectId:id(11),jobId:id(1),billing:'paid'},action);
  return {serverEnv,workerEnv,serverConfig,workerConfig,worker,db,server,send,submitCommand,input,calls,snapshot,
    metered,stats:()=>({reserves,providerCalls}),revoke:()=>{denyAuthority=true;}};
}

test('planned operation completes through real handler/client/stage adapter with one existing reservation and no local provider key',async()=>{
  const f=await executionFixture(),client=new ProviderBridgeClient(f.db,f.workerConfig,f.worker.worker_id,f.worker.worker_generation,f.server);
  await client.handshake();assert.equal(f.stats().providerCalls,0);assert.equal(f.calls.includes('prepare_provider_bridge_full_operation'),false);
  assert.equal(f.workerConfig.stages.stages.classification!.apiKey,undefined);
  const factory=createStageDeepPassProviderFactory(f.workerEnv,async()=>assert.fail('Worker may not use local provider transport'),{evidenceTransport:client.evidenceTransport});
  const provider=await factory.create(f.input);let attached=0;
  const request={runId:id(1),sheet:f.input.manifest.sheets[0]!,passType:'classification' as const,attempt:1,idempotencyKey:'fixture-page',reasoningEffort:'high' as const};
  const result=await f.metered(()=>provider.runPass(request,async(eventId)=>{assert.equal(eventId,id(8));assert.equal(f.snapshot().state,'completed');attached++;}));
  assert.equal(result.status,'succeeded');assert.equal(attached,1);assert.deepEqual(f.stats(),{reserves:1,providerCalls:1});
  const again=await f.metered(()=>provider.runPass(request));assert.equal(again.status,'succeeded');assert.deepEqual(f.stats(),{reserves:1,providerCalls:1});
});

test('handshake rejects pre-reservation-capability schema without preparing any operation',async()=>{
  for(const schemaCapability of [true,{ready:true},{ready:true,reservationCapability:'old-version'},{ready:false,reservationCapability:'reviewed-operation-reservations-v1'}]){
    const f=await executionFixture({schemaCapability}),client=new ProviderBridgeClient(f.db,f.workerConfig,f.worker.worker_id,f.worker.worker_generation,f.server);
    await assert.rejects(()=>client.handshake());assert.deepEqual(f.stats(),{reserves:0,providerCalls:0});
    assert.deepEqual(f.calls,['provider_bridge_schema_ready']);
  }
});

test('native bridge renderer preserves nonzero CropBox and 0/90/180/270 orientation in actual JPEG pixels',async()=>{
  await verifyBridgeRenderer();const {loadImage,createCanvas}=await import('@napi-rs/canvas');
  for(const rotation of [0,90,180,270]){
    const pdf=await PDFDocument.create(),page=pdf.addPage([240,180]);page.setCropBox(20,30,200,100);page.setRotation(degrees(rotation));
    page.drawRectangle({x:20,y:30,width:200,height:100,color:rgb(0,0,1)});
    const first=planPageRegions({width:200,height:100},2)[0]!;
    page.drawRectangle({x:20+first.x+first.width*.15,y:30+first.y+first.height*.15,
      width:first.width*.1,height:first.height*.1,color:rgb(1,0,0)});
    const region=(await isolateStageRegions(new Uint8Array(await pdf.save()),2))[0]!,image=await renderBridgeRegion(region,1);
    const bitmap=await loadImage(Buffer.from(image.dataUrl.split(',')[1]!,'base64')),canvas=createCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);
    const marker=rotation===0?[.2,.8]:rotation===90?[.2,.2]:rotation===180?[.8,.2]:[.8,.8];
    const pixel=ctx.getImageData(Math.floor(bitmap.width*marker[0]!),Math.floor(bitmap.height*marker[1]!),1,1).data;
    assert.ok(pixel[0]!>220&&pixel[1]!<30&&pixel[2]!<30,`rotation ${rotation} marker pixel ${[...pixel]}`);
    assert.equal(Math.max(image.widthPixels!,image.heightPixels!),1300);assert.equal(image.rotationDegrees,rotation);
    assert.deepEqual(image.region,region.region);assert.deepEqual(image.displayRegion,region.displayRegion);
  }
});

test('image-only bridge routes send every 2x2 or 3x3 verified crop to Kimi/DeepSeek without a local key or native PDF fallback',async()=>{
  for(const [providerName,grid] of [['kimi',2],['deepseek',3]] as const){
    const f=await executionFixture({provider:providerName,grid}),client=new ProviderBridgeClient(f.db,f.workerConfig,f.worker.worker_id,f.worker.worker_generation,f.server);
    await client.handshake();const provider=await createStageDeepPassProviderFactory(f.workerEnv,async()=>assert.fail('no local transport'),{
      evidenceTransport:client.evidenceTransport,loadPageImages:(input,page)=>bridgePageImages(input.fileBytes,input.manifest,page,grid)}).create(f.input);
    const result=await f.metered(()=>provider.runPass({runId:id(1),sheet:f.input.manifest.sheets[0]!,passType:'classification',attempt:1,idempotencyKey:'test',reasoningEffort:'high'}));
    assert.equal(result.status,'succeeded');assert.equal((result.checkpoint.source_coverage as any).regions.length,grid**2);
    assert.deepEqual(f.stats(),{reserves:1,providerCalls:1});assert.equal(f.snapshot().cost_state,'held_unknown');
  }
});

test('reviewed requirements select the seven-argument reservation while legacy calls retain six arguments',async()=>{
  const reservations:Record<string,unknown>[]=[];
  const writer={from:()=>({insert:async()=>({error:null}),update:()=>({eq:async()=>({error:null})})}),
    rpc:async(name:string,args:Record<string,unknown>)=>{if(name==='reserve_provider_spend')reservations.push(args);return {data:{reserved_usd:25},error:null};}};
  const run=<T>(fn:()=>Promise<T>)=>withUsageMeter({writer,userId:id(7),workspaceId:id(10),projectId:id(11),jobId:id(1),billing:'paid'},fn);
  await run(()=>meterGeminiCall('gemini-3.8-flash','generate',async()=>({})));
  await run(()=>meterGeminiCall('gemini-3.8-flash','generate',async()=>({}),{minimumReservationUsd:2.5}));
  await run(()=>meterOpenAiCompatibleCall('openai','gpt-6-astra',async()=>({usage:{prompt_tokens:1,completion_tokens:1}}),{minimumReservationUsd:24.52}));
  assert.equal(Object.keys(reservations[0]!).length,6);assert.equal('p_required_reservation_usd'in reservations[0]!,false);
  assert.equal(Object.keys(reservations[1]!).length,7);assert.equal(reservations[1]!.p_required_reservation_usd,2.5);
  assert.equal(reservations[2]!.p_required_reservation_usd,24.52);
});

test('concurrent fresh submit commands share one CAS winner; GET/reconcile are read only and never return raw evidence or credentials',async()=>{
  const f=await executionFixture(),c=f.submitCommand();const responses=await Promise.all([f.send(c),f.send(c)]);
  assert.ok(responses.every(r=>[200,202].includes(r.status)),JSON.stringify({bodies:await Promise.all(responses.map(r=>r.clone().json())),calls:f.calls}));assert.deepEqual(f.stats(),{reserves:1,providerCalls:1});
  for(const action of ['get_operation','reconcile_operation'] as const){const {protocol,run_id,operation_id,worker}=c;
    const response=await f.send({action,protocol,run_id,operation_id,worker}),body=await response.text();
    assert.equal(response.status,200);assert.doesNotMatch(body,/candidates|synthetic-gemini|checkpoint|provider_response/);
    assert.equal(JSON.parse(body).cost_state,'captured_estimated');}
  assert.deepEqual(f.stats(),{reserves:1,providerCalls:1});
});

test('unknown network outcome is held without replay; unknown cost with a real result remains separately held',async()=>{
  const failed=await executionFixture({unknown:true}),c=failed.submitCommand();
  const body=await (await failed.send(c)).json();assert.equal(body.state,'dispatch_unknown');assert.equal(body.error_code,'provider_result_uncertain');
  await failed.send(c);assert.deepEqual(failed.stats(),{reserves:1,providerCalls:1});assert.equal(failed.snapshot().cost_state,'held_unknown');
  const known=await executionFixture({unknownUsage:true});const result=await (await known.send(known.submitCommand())).json();
  assert.equal(result.state,'completed');assert.equal(result.cost_state,'held_unknown');assert.equal(result.captured_usd_micros,null);
});

test('revoked lease at CAS, changed original, changed profile, and company wait all prevent provider transport',async()=>{
  for(const opts of [{denyClaim:true},{changedSource:true},{companyWait:true}]){
    const f=await executionFixture(opts);const response=await f.send(f.submitCommand());assert.equal(f.stats().providerCalls,0);
    assert.equal(response.status,opts.companyWait?202:opts.changedSource?409:503);
    if(opts.companyWait){assert.equal(f.stats().reserves,0);assert.equal(f.calls.includes('storage'),false);}
  }
  const f=await executionFixture(),c=f.submitCommand();c.expected_operation_spec_sha256='f'.repeat(64);
  assert.equal((await f.send(c)).status,409);assert.equal(f.stats().reserves,0);
  f.revoke();assert.equal((await f.send(f.submitCommand())).status,403);assert.equal(f.stats().providerCalls,0);
});

test('lost submit response recovers only saved result; lost pre-arrival command safely submits the same planned identity',async()=>{
  for(const afterExecution of [false,true]){
    const f=await executionFixture();let lost=false;
    const transport=(async(url:unknown,init?:RequestInit)=>{
      if(JSON.parse(String(init?.body)).action==='submit_stage'&&!lost){lost=true;if(afterExecution)await f.server(url as string,init);throw new Error('transport interrupted');}
      return f.server(url as string,init);
    }) as typeof fetch;
    const client=new ProviderBridgeClient(f.db,f.workerConfig,f.worker.worker_id,f.worker.worker_generation,transport);await client.handshake();
    const provider=await createStageDeepPassProviderFactory(f.workerEnv,async()=>assert.fail('No local fallback'),{evidenceTransport:client.evidenceTransport}).create(f.input);
    assert.equal((await f.metered(()=>provider.runPass({runId:id(1),sheet:f.input.manifest.sheets[0]!,passType:'classification',attempt:1,idempotencyKey:'test',reasoningEffort:'high'}))).status,'succeeded');
    assert.deepEqual(f.stats(),{reserves:1,providerCalls:1});
  }
});
