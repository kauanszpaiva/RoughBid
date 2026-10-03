import test from 'node:test';
import assert from 'node:assert/strict';
import {handlePhotoRequest} from '../src/photos/routes.ts';
import {USER,WORKSPACE,PROJECT,PHOTO,photoDatabase} from './helpers/photo-db.mjs';

test('authenticated planar review persists deterministic quantities, source proofs and CAS/idempotent receipts with providers disabled',async()=>{
  const fixture=await photoDatabase();try{
    const runId=crypto.randomUUID(),hash='b'.repeat(64),asset={id:PHOTO,workspaceId:WORKSPACE,projectId:PROJECT,sha256:hash,revision:hash,
      mimeType:'image/png',byteSize:1000,widthPixels:400,heightPixels:300,storageVerified:true};
    await fixture.sql.query("insert into photo_assets(id,workspace_id,project_id,uploaded_by,storage_path,original_name,mime_type,byte_size) values($1,$2,$3,$4,$5,'synthetic-rectangle.png','image/png',1000)",
      [PHOTO,WORKSPACE,PROJECT,USER,`${WORKSPACE}/${PROJECT}/photos/${PHOTO}/source.png`]);
    await fixture.sql.query("update photo_assets set status='ready',sha256=$1,width_pixels=400,height_pixels=300,completed_at=now() where id=$2",[hash,PHOTO]);
    const region={sourceAssetId:PHOTO,surfaceKey:'reviewed-wall',bbox:[.1,.1,.8,.8]};
    const evidence={observations:[{id:'wall-observation',label:'Visible wall finish',regions:[region],proposedQuantity:null,proposedUnit:null,referenceId:null,
      method:'visual_estimate',confidence:.8,uncertainty:['Known reviewed dimensions required.']}],approvedMeasurements:[],blockers:['human_measurement_review_required'],
      releaseStatus:'blocked',pricingStatus:'missing_price',estimate:null,humanReviewRequired:true,independentReview:'pending',
      stageStatus:{observation:'completed',reconciliation:'pending',risk_review:'pending'},photoQuality:[{sourceAssetId:PHOTO,usable:true,limitations:[],additionalViewsNeeded:false}]};
    await fixture.sql.query("insert into photo_takeoff_runs(id,workspace_id,project_id,requested_by,request_key,profile_hash,provider,model,manifest,asset_ids,status,result) values($1,$2,$3,$4,$5,$6,'openai','gpt-6-astra',$7,$8,'needs_review',$9)",
      [runId,WORKSPACE,PROJECT,USER,crypto.randomUUID(),'a'.repeat(64),JSON.stringify({assets:[asset],references:[]}),`{${PHOTO}}`,JSON.stringify(evidence)]);
    const deps={writer:fixture.client,storage:{async presign(){throw Error('Review must not read images or dispatch providers.');}}};
    const request=(method:string,body?:unknown)=>handlePhotoRequest(new Request(`https://roughbid.test/api/projects/${PROJECT}/photos/runs/${runId}${method==='POST'?'/review':''}`,{
      method,headers:{'x-workspace-id':WORKSPACE,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),fixture.client,deps);
    const metadata={sourceAssetId:PHOTO,sourceRevision:hash,sourceSha256:hash,surfaceKey:'reviewed-wall'};
    const corners=[[.1,.1],[.9,.1],[.9,.9],[.1,.9]],key=crypto.randomUUID();
    const body={expectedReviewRevision:0,reviewRequestKey:key,references:[{id:'reference-wall',region,objectIdentityKey:'physical-wall',reviewerId:'spoofed',
      kind:'planar_calibration',value:10,unit:'LF',verified:true,coplanarVerified:true,perspectiveVerified:true,
      planarCalibration:{version:'photo-planar-v1',...metadata,referencePoints:corners,referenceWidth:10,referenceHeight:12,referenceUnit:'LF',
        rectangleVerified:true,lensDistortionReviewed:true,privateExtra:'discard-this-fixture-field',imageToPlaneMeters:[999999]}}],
      decisions:[{observationId:'wall-observation',disposition:'approved',reviewerId:'spoofed',quantity:null,unit:'SF',method:'calibrated_planar_geometry',
        calculationMethod:'Human reviewed target surface.',referenceId:'reference-wall',objectIdentityKey:'physical-wall',identityAssetIds:[PHOTO],
        crossViewIdentityReviewed:false,uncertaintyResolved:true,planarMeasurement:{version:'photo-planar-v1',...metadata,kind:'polygon',points:corners,measure:'area',
          samePlaneReviewed:true,geometryReviewed:true,privateExtra:'discard-this-fixture-field'}}]};
    const savedResponse=await request('POST',body);assert.equal(savedResponse.status,200);const saved=await savedResponse.json();
    assert.equal(saved.reviewRevision,1);assert.equal(saved.reused,false);assert.equal(saved.review.approvedMeasurements[0].quantity,120);
    assert.equal(saved.review.planarProofs[0].reviewerId,USER);assert.equal(saved.review.planarProofs[0].sourceSha256,hash);
    assert.equal(saved.review.planarProofs[0].scope,'reviewed_planar_region');assert.equal(saved.review.releaseStatus,'blocked');
    assert.equal(saved.review.independentReview,'pending');assert.equal(saved.review.estimate,null);assert.equal(saved.review.pricingStatus,'missing_price');
    assert.ok(!JSON.stringify(saved).includes('discard-this-fixture-field'));assert.equal(saved.review.decisions[0].quantity,null);
    const halfBody={...body,decisions:[{...body.decisions[0],planarMeasurement:{...body.decisions[0]!.planarMeasurement,points:[[.1,.1],[.5,.1],[.5,.9],[.1,.9]]}}]};
    assert.equal((await request('POST',halfBody)).status,409); // A request key cannot be reused with altered geometry.
    assert.equal((await request('POST',{...halfBody,reviewRequestKey:crypto.randomUUID()})).status,409); // Stale expected revision.
    const halfResponse=await request('POST',{...halfBody,expectedReviewRevision:1,reviewRequestKey:crypto.randomUUID()});assert.equal(halfResponse.status,200);
    const half=await halfResponse.json();assert.equal(half.reviewRevision,2);assert.equal(half.review.approvedMeasurements[0].quantity,60);
    const repeated=await request('POST',{...body,expectedReviewRevision:2});assert.equal(repeated.status,200);assert.deepEqual(await repeated.json(),{...saved,reused:true});
    const restored=await (await request('GET')).json();assert.equal(restored.run.review_revision,2);assert.equal(restored.run.result.approvedMeasurements[0].quantity,60);
    const unclearPlane=await request('POST',{...body,expectedReviewRevision:2,reviewRequestKey:crypto.randomUUID(),
      decisions:[{...body.decisions[0],planarMeasurement:{...body.decisions[0]!.planarMeasurement,samePlaneReviewed:false}}]});
    assert.equal(unclearPlane.status,200);const pending=await unclearPlane.json();assert.equal(pending.reviewRevision,3);assert.equal(pending.review.approvedMeasurements.length,0);
    assert.ok(pending.review.blockers.includes('wall-observation:photo_planar_geometry_review_required'));
    assert.equal((await fixture.sql.query('select count(*)::int count from photo_takeoff_reviews')).rows[0].count,3);
    assert.equal((await fixture.sql.query('select count(*)::int count from api_usage_events')).rows[0].count,0);
    assert.equal((await fixture.sql.query('select count(*)::int count from provider_spend_reservations')).rows[0].count,0);
  }finally{await fixture.close();}
});
