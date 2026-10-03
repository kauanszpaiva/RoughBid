import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {requirePhotoTakeoffConfig,requirePhotoTakeoffProfile,PHOTO_TAKEOFF_VERSION} from '../src/photos/config.ts';
import {inspectPhoto,loadVerifiedPhoto,photoStoragePath} from '../src/photos/assets.ts';
import {HttpPhotoReader,parsePhotoReading} from '../src/photos/provider.ts';
import {PhotoTakeoffProcessor} from '../src/photos/worker.ts';
import {handlePhotoRequest} from '../src/photos/routes.ts';
import {withUsageMeter} from '../src/owner-usage/meter.ts';
import {USER,WORKSPACE,PROJECT,REQUEST_KEY,PNG,photoDatabase} from './helpers/photo-db.mjs';

function environment(provider='openai',model='gpt-6-astra'){
  return {PHOTO_TAKEOFF_ENABLED:'true',PHOTO_TAKEOFF_SCHEMA_VERSION:PHOTO_TAKEOFF_VERSION,PRIVATE_PHOTO_DATA_APPROVED:'true',
    PHOTO_TAKEOFF_PROVIDER:provider,PHOTO_TAKEOFF_MODEL:model,OPENAI_API_KEY:'unit-local-token',ANTHROPIC_API_KEY:'unit-local-token',GEMINI_API_KEY:'unit-local-token',
    PHOTO_TAKEOFF_APPROVED_RUN_BUDGET_USD:'10',PHOTO_TAKEOFF_RUN_BUDGET_APPROVAL_REF:'test-manual-approval-v1',
    PHOTO_TAKEOFF_MODEL_ATTESTATIONS_JSON:JSON.stringify({[model]:{accountVerified:true,imageCompatibilityVerified:true,priceVersion:'test-tariff-v1',maximumCallCostUsd:1}})};
}
function evidence(assetId:string){
  return {quality:{usable:true,limitations:['Hidden wall construction is not visible.'],additionalViewsNeeded:true},blockers:[],observations:[{
    id:`${assetId}:wall`,label:'Visible wall paint scope',regions:[{sourceAssetId:assetId,surfaceKey:'wall-1',bbox:[0.1,0.1,0.7,0.7]}],
    proposedQuantity:null,proposedUnit:null,referenceId:null,method:'visual_estimate',confidence:0.8,uncertainty:['Physical area requires a supplied measurement.'],
  }]};
}
// Locally generated 2 x 3 solid-color Pillow fixtures; no customer image or network.
const WEBP_LOSSY=Buffer.from('UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoCAAMAAUAmJaACdLoB+AAEgwAA/vIiX/xu3GG/Bd/5BcsLriMAAA==','base64');
const WEBP_LOSSLESS=Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAAAfQrX70sf+BiOh/AAA=','base64');
const JPEG=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDjqKKK+gPBP//Z','base64');
const JPEG_PROGRESSIVE=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVAQEBAAAAAAAAAAAAAAAAAAAEBf/aAAwDAQACEAMQAAABjCgD/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABDz/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=','base64');
function webpChunk(kind:string,payload:Uint8Array):Buffer {
  const header=Buffer.alloc(8);header.write(kind,0,'ascii');header.writeUInt32LE(payload.length,4);
  return Buffer.concat([header,payload,...(payload.length%2?[Buffer.alloc(1)]:[])]);
}
function webpContainer(...chunks:Uint8Array[]):Buffer {
  const header=Buffer.alloc(12);header.write('RIFF',0,'ascii');header.write('WEBP',8,'ascii');
  const result=Buffer.concat([header,...chunks]);result.writeUInt32LE(result.length-8,4);return result;
}
function extendedWebpPayload(width=2,height=3):Buffer {
  const payload=Buffer.alloc(10);payload.writeUIntLE(width-1,4,3);payload.writeUIntLE(height-1,7,3);return payload;
}
test('WebP validation accepts framed lossy/lossless images and rejects header-only, malformed chunks and inconsistent frames',()=>{
  for(const valid of [WEBP_LOSSY,WEBP_LOSSLESS,webpContainer(webpChunk('VP8X',extendedWebpPayload()),WEBP_LOSSY.subarray(12))]){
    const inspected=inspectPhoto(valid,'image/webp');assert.equal(inspected.width,2);assert.equal(inspected.height,3);
  }
  const losslessHeader=WEBP_LOSSLESS.subarray(20,25),vp8Header=WEBP_LOSSY.subarray(20,30);
  const unsupportedVersion=Buffer.from(WEBP_LOSSLESS);unsupportedVersion[24]!|=0x20;
  const interframe=Buffer.from(WEBP_LOSSY);interframe[20]!|=1;
  const oversizedPartition=Buffer.from(WEBP_LOSSY);oversizedPartition[21]=255;oversizedPartition[22]=255;
  const chunkOverflow=Buffer.from(WEBP_LOSSY);chunkOverflow.writeUInt32LE(65535,16);
  const wrongSize=Buffer.from(WEBP_LOSSY);wrongSize.writeUInt32LE(wrongSize.length-10,4);
  const invalidPad=Buffer.from(WEBP_LOSSLESS);invalidPad[invalidPad.length-1]=1;
  const animated=extendedWebpPayload();animated[0]=2;
  const invalidImages=[
    webpContainer(webpChunk('VP8X',Buffer.alloc(10))), // Exact original 30-byte exploit, with no frame.
    webpContainer(webpChunk('VP8X',Buffer.alloc(9)),WEBP_LOSSY.subarray(12)),
    webpContainer(webpChunk('VP8 ',vp8Header)),webpContainer(webpChunk('VP8L',losslessHeader)),
    webpContainer(webpChunk('VP8X',extendedWebpPayload(9,3)),WEBP_LOSSY.subarray(12)),
    webpContainer(WEBP_LOSSY.subarray(12),WEBP_LOSSY.subarray(12)),
    webpContainer(WEBP_LOSSY.subarray(12),Buffer.alloc(6)),
    webpContainer(webpChunk('VP8X',animated),WEBP_LOSSY.subarray(12)),
    unsupportedVersion,interframe,oversizedPartition,chunkOverflow,wrongSize,invalidPad,
    WEBP_LOSSLESS.subarray(0,WEBP_LOSSLESS.length-1),
  ];
  for(const invalid of invalidImages)assert.throws(()=>inspectPhoto(invalid,'image/webp'),/supported|Animated/);
});
test('JPEG needs bounded frame/scan data and EOI; PNG needs complete nonempty IDAT and IEND',()=>{
  for(const valid of [JPEG,JPEG_PROGRESSIVE]){
    const inspected=inspectPhoto(valid,'image/jpeg');assert.equal(inspected.width,2);assert.equal(inspected.height,3);
  }
  const headerOnly=Buffer.from([255,216,255,192,0,11,8,0,3,0,2,1,1,17,0,255,217]);
  const scanMarker=JPEG.indexOf(Buffer.from([255,218]));assert.ok(scanMarker>0);
  const scanEnd=scanMarker+2+JPEG.readUInt16BE(scanMarker+2);
  for(const invalid of [headerOnly,headerOnly.subarray(0,-2),JPEG.subarray(0,-2),
    Buffer.concat([JPEG.subarray(0,scanMarker),Buffer.from([255,217])]),
    Buffer.concat([JPEG.subarray(0,scanEnd),Buffer.from([255,217])])]){
    assert.throws(()=>inspectPhoto(invalid,'image/jpeg'),/supported/);
  }
  const iend=PNG.subarray(-12),ihdr=PNG.subarray(0,33),emptyIdat=Buffer.concat([Buffer.alloc(4),Buffer.from('IDAT'),Buffer.alloc(4)]);
  const overflow=Buffer.from(PNG);overflow.writeUInt32BE(0x7fffffff,33);
  for(const invalid of [ihdr,Buffer.concat([ihdr,iend]),Buffer.concat([ihdr,emptyIdat,iend]),PNG.subarray(0,-12),overflow]){
    assert.throws(()=>inspectPhoto(invalid,'image/png'),/supported/);
  }
});
test('authenticated upload completion rejects a header-only WebP before saving a ready source or creating a job',async()=>{
  const fixture=await photoDatabase();try{
    const bytes=webpContainer(webpChunk('VP8X',Buffer.alloc(10))),config=requirePhotoTakeoffConfig(environment());
    let downloads=0,enqueues=0;
    const storage={async presign(method:any,key:string){return {url:'https://private.invalid/'+key,method,headers:{},expiresAt:'2099-01-01'};}};
    const fetcher=(async()=>{downloads++;return new Response(bytes,{headers:{'content-type':'image/webp','content-length':String(bytes.length)}});}) as typeof fetch;
    const deps={writer:fixture.client,storage,config,fetcher,queue:{async add(){enqueues++;}}};
    const request=(path:string,body?:unknown)=>handlePhotoRequest(new Request(`https://roughbid.test/api/projects/${PROJECT}/photos/${path}`,{
      method:'POST',headers:{'x-workspace-id':WORKSPACE,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),fixture.client,deps);
    const reserved=await request('uploads',{name:'header-only.webp',contentType:'image/webp',byteSize:bytes.length});assert.equal(reserved.status,201);
    const asset=(await reserved.json()).asset,completed=await request(`uploads/${asset.id}/complete`);
    assert.equal(completed.status,415);assert.equal(downloads,1);assert.equal(enqueues,0);
    const row=(await fixture.sql.query('select status,sha256,width_pixels,height_pixels from photo_assets where id=$1',[asset.id])).rows[0];
    assert.deepEqual(row,{status:'uploading',sha256:null,width_pixels:null,height_pixels:null});
    assert.equal((await fixture.sql.query('select count(*)::int count from photo_takeoff_runs')).rows[0].count,0);
    assert.equal((await fixture.sql.query('select count(*)::int count from api_usage_events')).rows[0].count,0);
  }finally{await fixture.close();}
});
test('photo config is closed by default, public profile has no key and credit never approves run budget',()=>{
  assert.throws(()=>requirePhotoTakeoffConfig({}),/reviewed enablement/);
  const env=environment(),profile=requirePhotoTakeoffProfile({...env,OPENAI_API_KEY:undefined});
  assert.equal(Object.hasOwn(profile,'apiKey'),false);assert.equal(profile.model,'gpt-6-astra');
  assert.equal(requirePhotoTakeoffConfig(env).reasoningEffort,'max');
  assert.throws(()=>requirePhotoTakeoffConfig({...env,OPENAI_API_KEY:undefined}),/credential/);
  assert.throws(()=>requirePhotoTakeoffConfig({...env,PHOTO_TAKEOFF_APPROVED_RUN_BUDGET_USD:undefined}),/separately approved/);
  assert.throws(()=>requirePhotoTakeoffConfig({...env,PHOTO_TAKEOFF_MODEL:'cheaper-model'}),/unsupported/);
  assert.throws(()=>requirePhotoTakeoffConfig({...env,PRIVATE_PHOTO_DATA_APPROVED:'false'}),/authorization/);
  assert.throws(()=>requirePhotoTakeoffConfig({...env,PHOTO_TAKEOFF_MODEL_ATTESTATIONS_JSON:'{}'}),/account/);
});
test('private photo validation binds exact tenant path, MIME, byte bound, source hash and dimensions',async()=>{
  const inspected=inspectPhoto(PNG,'image/png');assert.equal(inspected.width,1);assert.equal(inspected.height,1);
  assert.throws(()=>inspectPhoto(PNG,'image/jpeg'),/supported/);
  assert.throws(()=>inspectPhoto(PNG.subarray(0,33),'image/png'),/supported/);
  const id=crypto.randomUUID(),row={id,workspace_id:WORKSPACE,project_id:PROJECT,uploaded_by:USER,original_name:'wall.png',
    storage_path:photoStoragePath(WORKSPACE,PROJECT,id,'image/png'),mime_type:'image/png' as const,byte_size:PNG.length,status:'ready' as const,
    sha256:inspected.sha256,width_pixels:1,height_pixels:1};
  let signs=0;const storage={async presign(method:any,key:string){signs++;return {url:'https://storage.invalid/'+key,method,headers:{},expiresAt:'2099-01-01'};}};
  const fetcher=(async()=>new Response(PNG,{headers:{'content-type':'image/png','content-length':String(PNG.length)}})) as typeof fetch;
  assert.equal((await loadVerifiedPhoto(row,storage,fetcher)).length,PNG.length);
  await assert.rejects(loadVerifiedPhoto({...row,sha256:'a'.repeat(64)},storage,fetcher),/changed/);
  const before=signs;await assert.rejects(loadVerifiedPhoto({...row,storage_path:'another-tenant/source.png'},storage,fetcher),/authorized/);assert.equal(signs,before);
  await assert.rejects(loadVerifiedPhoto({...row,byte_size:PNG.length-1},storage,fetcher),/differs/);
});
test('unreferenced physical quantities and counterfeit sources are rejected instead of approved',()=>{
  const id=crypto.randomUUID(),asset={id,workspaceId:WORKSPACE,projectId:PROJECT,sha256:createHash('sha256').update(PNG).digest('hex'),
    revision:'revision-1',mimeType:'image/png' as const,byteSize:PNG.length,widthPixels:1,heightPixels:1,storageVerified:true as const};
  const invalid=evidence(id);invalid.observations[0]!.proposedQuantity=55 as any;
  assert.throws(()=>parsePhotoReading(invalid,asset,[]),/invalid/);
  const wrong=evidence(id);wrong.observations[0]!.regions[0]!.sourceAssetId=crypto.randomUUID();
  assert.throws(()=>parsePhotoReading(wrong,asset,[]),/invalid_photo_observation/);
});

for(const [provider,model] of [['openai','gpt-6-astra'],['claude','claude-opus-5-5'],['gemini','gemini-3.1-pro-preview']]){
  test(`${provider} photo adapter requires a real reservation before its single mocked HTTP dispatch`,async()=>{
    const config=requirePhotoTakeoffConfig(environment(provider,model)),id=crypto.randomUUID();
    const asset={id,workspaceId:WORKSPACE,projectId:PROJECT,sha256:createHash('sha256').update(PNG).digest('hex'),revision:'revision-1',
      mimeType:'image/png' as const,byteSize:PNG.length,widthPixels:1,heightPixels:1,storageVerified:true as const};
    let calls=0,reservations=0,allowed=false;
    const transport=(async(url,options)=>{
      calls++;const body=JSON.parse(String(options?.body));
      if(provider==='gemini')assert.ok(String(url).includes(`/models/${model}:generateContent`));else assert.equal(body.model,model);
      assert.ok(!String(options?.body).includes('storage.invalid'));
      assert.equal(options?.redirect,'error');assert.ok(options?.signal);
      const payload=JSON.stringify(evidence(id));
      const raw=provider==='openai'?{id:'request-1',status:'completed',usage:{input_tokens:11,output_tokens:22},output:[{type:'message',content:[{type:'output_text',text:payload}]}]}
        :provider==='claude'?{id:'request-1',stop_reason:'end_turn',usage:{input_tokens:11,output_tokens:22},content:[{type:'text',text:payload}]}
        :{responseId:'request-1',usageMetadata:{promptTokenCount:11,candidatesTokenCount:22},candidates:[{finishReason:'STOP',content:{parts:[{text:payload}]}}]};
      return Response.json(raw);
    }) as typeof fetch;
    const reader=new HttpPhotoReader(config,transport),input={asset,bytes:PNG,references:[],signal:new AbortController().signal};
    await assert.rejects(reader.read(input),/accounting/);assert.equal(calls,0);
    const writer={from(){return {insert:async()=>({error:null}),update(){return {eq:async()=>({error:null})};}};},
      async rpc(name:string){if(name==='reserve_provider_spend'){reservations++;return allowed?{data:{reserved_usd:2.5},error:null}:{data:null,error:{message:'Company AI spend limit reached'}};}return {data:null,error:null};}};
    const scope={writer,userId:USER,workspaceId:WORKSPACE,projectId:PROJECT,jobId:crypto.randomUUID(),billing:'paid' as const};
    await assert.rejects(withUsageMeter(scope,()=>reader.read(input)),/spend limit/);assert.equal(calls,0);
    allowed=true;const result=await withUsageMeter(scope,()=>reader.read(input));assert.equal(calls,1);assert.equal(reservations,2);
    assert.equal(result.independentReview,'pending');assert.equal(result.observations[0]!.proposedQuantity,null);
  });
}

test('mocked authenticated photo flow uploads, durably reads, recovers saved evidence and records a manual measurement',async()=>{
  const fixture=await photoDatabase();try{
    const config=requirePhotoTakeoffConfig(environment()),objects=new Map<string,Uint8Array>(),jobs:any[]=[],signed:string[]=[];
    let paidDispatches=0;
    const storage={async presign(method:any,key:string){signed.push(key);return {url:'https://private.invalid/'+encodeURIComponent(key),method,headers:{'content-type':'image/png'},expiresAt:'2099-01-01'};}};
    const storageFetch=(async(url,options)=>{
      const parsed=new URL(String(url));assert.equal(parsed.hostname,'private.invalid');const key=decodeURIComponent(parsed.pathname.slice(1));
      if(options?.method==='PUT'){objects.set(key,new Uint8Array(options.body as Uint8Array));return new Response(null,{status:200});}
      const bytes=objects.get(key);return bytes?new Response(bytes,{headers:{'content-type':'image/png','content-length':String(bytes.length)}}):new Response(null,{status:404});
    }) as typeof fetch;
    const queue={async add(_name:any,data:any,options:any){assert.equal(options.attempts,1);jobs.push(data);}};
    const deps={writer:fixture.client,storage,config,queue,fetcher:storageFetch};
    const request=(path:string,method='GET',body?:unknown,workspace=WORKSPACE)=>handlePhotoRequest(new Request(`https://roughbid.test/api/projects/${PROJECT}/photos/${path}`,{
      method,headers:{'x-workspace-id':workspace,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),
    }),fixture.client,deps);
    const processor=new PhotoTakeoffProcessor(fixture.client,storage,new HttpPhotoReader(config,(async(_url,options)=>{
      paidDispatches++;const body=JSON.parse(String(options?.body));const input=body.input[0].content[1].text;assert.ok(input.includes('Inspect'));
      const assetId=body.instructions.match(/sourceAssetId=([a-f0-9-]+)/)[1];
      return Response.json({id:'mock-transport-request',status:'completed',usage:{input_tokens:30,output_tokens:40},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(evidence(assetId))}]}]});
    }) as typeof fetch),config,'test-photo-worker',storageFetch);
    await processor.touch();
    const began=await request('uploads','POST',{name:'wall.png',contentType:'image/png',byteSize:PNG.length});assert.equal(began.status,201);
    const upload=await began.json();await storageFetch(upload.upload.url,{method:'PUT',body:PNG});
    const completed=await request(`uploads/${upload.asset.id}/complete`,'POST');assert.equal(completed.status,200);
    const ready=await completed.json();assert.equal(ready.asset.storageVerified,true);assert.equal(ready.asset.widthPixels,1);
    const launched=await request('runs','POST',{assetIds:[upload.asset.id],requestKey:REQUEST_KEY});assert.equal(launched.status,202);
    const saved=await launched.json();assert.equal(saved.enqueued,true);assert.equal(jobs.length,1);assert.equal(paidDispatches,0);
    const repeated=await request('runs','POST',{assetIds:[upload.asset.id],requestKey:REQUEST_KEY});assert.equal((await repeated.json()).run.id,saved.run.id);
    await processor.process({data:jobs[0]});assert.equal(paidDispatches,1);
    await processor.process({data:jobs[1]});assert.equal(paidDispatches,1);
    const recovered=await request(`runs/${saved.run.id}`);assert.equal(recovered.status,200);
    const result=await recovered.json();assert.equal(result.run.status,'needs_review');assert.deepEqual(result.run.progress.completed,1);
    assert.equal(result.run.result.estimate,null);assert.equal(result.run.result.pricingStatus,'missing_price');assert.equal(result.run.result.independentReview,'pending');
    assert.equal(result.run.result.approvedMeasurements.length,0);assert.equal(Object.hasOwn(result.run,'lease_id'),false);assert.equal(Object.hasOwn(result.steps[0],'result'),false);
    const history=await request('runs');const summaries=await history.json();assert.equal(summaries.runs[0].request_key,REQUEST_KEY);assert.equal(Object.hasOwn(summaries.runs[0],'result'),false);
    const checkpointResponse=await request(`runs/${saved.run.id}?asset_id=${upload.asset.id}`);
    const checkpoint=await checkpointResponse.json();assert.equal(checkpoint.status,'completed');
    assert.equal(checkpoint.checkpoint.observations[0].regions[0].sourceAssetId,upload.asset.id);
    assert.equal((await request(`runs/${saved.run.id}?asset_id=${crypto.randomUUID()}`)).status,404);
    const observation=result.run.result.observations[0],region=observation.regions[0];
    assert.equal(result.run.review_revision,0);
    const reviewBody={expectedReviewRevision:result.run.review_revision,reviewRequestKey:crypto.randomUUID(),references:[{id:'measure-1',region,objectIdentityKey:'wall-1',reviewerId:'spoofed',verified:true,
      kind:'instrument_reading',value:120,unit:'SF',coplanarVerified:false,perspectiveVerified:false}],decisions:[{observationId:observation.id,disposition:'approved',
      reviewerId:'spoofed',quantity:120,unit:'SF',method:'instrument_measurement',calculationMethod:'Supplied tape measurement of this wall area.',referenceId:'measure-1',
      objectIdentityKey:'wall-1',identityAssetIds:[upload.asset.id],crossViewIdentityReviewed:false,uncertaintyResolved:true}]};
    assert.equal((await request(`runs/${saved.run.id}/review`,'POST',{...reviewBody,expectedReviewRevision:undefined})).status,400);
    const review=await request(`runs/${saved.run.id}/review`,'POST',reviewBody);
    assert.equal(review.status,200);const reviewed=await review.json();assert.equal(reviewed.review.approvedMeasurements[0].quantity,120);
    assert.equal(reviewed.reviewRevision,1);assert.equal(reviewed.reused,false);
    assert.deepEqual(reviewed.review.approvedMeasurements[0].reviewerIds,[USER]);assert.equal(reviewed.review.releaseStatus,'blocked');assert.equal(reviewed.review.estimate,null);
    const competing=(quantity:number)=>({...reviewBody,expectedReviewRevision:1,reviewRequestKey:crypto.randomUUID(),
      references:[{...reviewBody.references[0]!,value:quantity}],decisions:[{...reviewBody.decisions[0]!,quantity}]});
    const concurrent=await Promise.all([request(`runs/${saved.run.id}/review`,'POST',competing(126)),request(`runs/${saved.run.id}/review`,'POST',competing(127))]);
    assert.deepEqual(concurrent.map(response=>response.status).sort(),[200,409]);
    const winner=await concurrent.find(response=>response.status===200)!.json();assert.equal(winner.reviewRevision,2);
    // A lost acknowledgement of revision one must return its immutable receipt,
    // even after another reviewed measurement is now the current result.
    const retry=await request(`runs/${saved.run.id}/review`,'POST',{...reviewBody,expectedReviewRevision:2});
    assert.equal(retry.status,200);assert.deepEqual(await retry.json(),{...reviewed,reused:true});
    assert.equal((await request(`runs/${saved.run.id}/review`,'POST',{...reviewBody,decisions:[{...reviewBody.decisions[0]!,quantity:119}]})).status,409);
    const afterReviews=await (await request(`runs/${saved.run.id}`)).json();assert.equal(afterReviews.run.review_revision,2);
    assert.equal(afterReviews.run.result.approvedMeasurements[0].quantity,winner.review.approvedMeasurements[0].quantity);
    assert.equal((await fixture.sql.query('select count(*)::int count from photo_takeoff_reviews')).rows[0].count,2);
    const before=signed.length;assert.equal((await request(`uploads/${upload.asset.id}/download-url`,'POST',undefined,crypto.randomUUID())).status,403);assert.equal(signed.length,before);
    fixture.setAuthenticatedUser(null);assert.equal((await request('runs')).status,401);fixture.setAuthenticatedUser(USER);
    const spend=(await fixture.sql.query('select photo_run_id,job_id,takeoff_run_id,status,reserved_usd,telemetry_known from provider_spend_reservations')).rows;
    assert.equal(spend.length,1);assert.equal(spend[0].photo_run_id,saved.run.id);assert.equal(spend[0].job_id,null);assert.equal(spend[0].takeoff_run_id,null);
    assert.equal(spend[0].status,'captured');assert.equal(spend[0].telemetry_known,false);assert.equal(Number(spend[0].reserved_usd),2.5);
    const cancelStart=await request('runs','POST',{assetIds:[upload.asset.id],requestKey:crypto.randomUUID()});const cancelledRun=(await cancelStart.json()).run.id;
    assert.equal((await request(`runs/${cancelledRun}/cancel`,'POST')).status,200);await processor.process({data:jobs.at(-1)});assert.equal(paidDispatches,1);
    const cancelled=await request(`runs/${cancelledRun}`);assert.equal((await cancelled.json()).run.status,'cancelled');
    // Rollback keeps private results and cancellation available while disabling new processing.
    const noConfig={writer:fixture.client,storage};
    const disabled=await handlePhotoRequest(new Request(`https://roughbid.test/api/projects/${PROJECT}/photos/runs/${saved.run.id}`,{headers:{'x-workspace-id':WORKSPACE}}),fixture.client,noConfig);
    assert.equal(disabled.status,200);assert.equal(paidDispatches,1);
  }finally{await fixture.close();}
});

for(const [scope,errorCode] of [['run','run_provider_spend_limit'],['company','company_spend_limit'],['missing_budget','run_provider_spend_limit']]){
  test(`${scope} photo spend denial is saved before dispatch with a pending checkpoint and no automatic retry`,async()=>{
    const fixture=await photoDatabase();try{
      const config=requirePhotoTakeoffConfig({...environment(),PHOTO_TAKEOFF_APPROVED_RUN_BUDGET_USD:scope==='run'?'2':'10'});
      const id=crypto.randomUUID(),metadata=inspectPhoto(PNG,'image/png'),path=photoStoragePath(WORKSPACE,PROJECT,id,'image/png');
      await fixture.sql.query("insert into photo_assets(id,workspace_id,project_id,uploaded_by,storage_path,original_name,mime_type,byte_size) values($1,$2,$3,$4,$5,'fixture.png','image/png',$6)",
        [id,WORKSPACE,PROJECT,USER,path,PNG.length]);
      await fixture.sql.query("update photo_assets set status='ready',sha256=$1,width_pixels=1,height_pixels=1,completed_at=now() where id=$2",[metadata.sha256,id]);
      let dispatches=0;const reader=new HttpPhotoReader(config,(async()=>{dispatches++;throw Error('Unexpected mocked provider dispatch.');}) as typeof fetch);
      const storage={async presign(method:any,key:string){return {url:'https://private.invalid/'+key,method,headers:{},expiresAt:'2099-01-01'};}};
      const fetcher=(async()=>new Response(PNG,{headers:{'content-type':'image/png','content-length':String(PNG.length)}})) as typeof fetch;
      const processor=new PhotoTakeoffProcessor(fixture.client,storage,reader,config,'budget-test',fetcher);await processor.touch();
      const jobs:any[]=[],queue={async add(_name:any,data:any){jobs.push(data);}};
      const deps={writer:fixture.client,storage,config,queue,fetcher};
      const request=(path:string,method='GET',body?:unknown)=>handlePhotoRequest(new Request(`https://roughbid.test/api/projects/${PROJECT}/photos/${path}`,{
        method,headers:{'x-workspace-id':WORKSPACE,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),fixture.client,deps);
      const reserved=await request('runs','POST',{assetIds:[id],requestKey:crypto.randomUUID()});assert.equal(reserved.status,202);
      const runId=(await reserved.json()).run.id;
      if(scope==='company')await fixture.sql.exec('update provider_spend_policy set spend_cap_usd=1');
      if(scope==='missing_budget')await fixture.sql.query('delete from photo_provider_run_budgets where run_id=$1',[runId]);
      await assert.rejects(processor.process({data:jobs[0]}),{message:errorCode});
      const saved=await (await request(`runs/${runId}`)).json();
      assert.equal(saved.run.status,'blocked');assert.equal(saved.run.error_code,errorCode);assert.equal(saved.steps[0].status,'pending');
      assert.equal(saved.run.progress.completed,0);assert.equal(dispatches,0);
      assert.equal((await fixture.sql.query('select count(*)::int count from provider_spend_reservations')).rows[0].count,0);
      const usage=(await fixture.sql.query('select operation from api_usage_events')).rows;assert.equal(usage.length,1);
      assert.equal(usage[0].operation,`rb1:${runId}:generate:blocked_spend_limit`);
      const repeated=await processor.process({data:jobs[0]});assert.equal((repeated as any).skip,true);assert.equal(dispatches,0);
      assert.equal((await fixture.sql.query('select count(*)::int count from api_usage_events')).rows[0].count,1);
    }finally{await fixture.close();}
  });
}
