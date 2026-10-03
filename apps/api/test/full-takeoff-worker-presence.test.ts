import test from 'node:test';
import assert from 'node:assert/strict';
import { createFullTakeoffConsumerPresence, fullTakeoffConsumerPresent, FULL_TAKEOFF_PRESENCE_KEY,
  FULL_TAKEOFF_PRESENCE_TTL_MS, READ_FULL_TAKEOFF_PRESENCE, RENEW_FULL_TAKEOFF_PRESENCE,
  type PresenceRedis, type PresenceConsumer } from '../src/takeoff-v2/worker-presence.ts';
import { createFullTakeoffV2Queue, DurableFullTakeoffV2Service } from '../src/takeoff-v2/durable.ts';

function fixture() {
  const members = new Set<string>();
  const calls: Array<{script:string;key:string;args:Array<string|number>}> = [];
  const client: PresenceRedis = { status:'ready', async eval(script,_count,key,...args) {
    calls.push({script,key:String(key),args});
    if(script===RENEW_FULL_TAKEOFF_PRESENCE){members.add(String(args[0]));return 1;}
    return members.size;
  }, async zrem(key,member){assert.equal(key,FULL_TAKEOFF_PRESENCE_KEY);return members.delete(member)?1:0;} };
  const primary={status:'ready'},blocking={status:'ready'};
  let running=true,paused=false;
  const worker:PresenceConsumer={isRunning:()=>running,isPaused:()=>paused,client:Promise.resolve(primary),blockingConnection:{client:Promise.resolve(blocking)}};
  return {members,calls,client,primary,blocking,worker,setRunning:(value:boolean)=>{running=value;},setPaused:(value:boolean)=>{paused=value;}};
}
test('only the running Full consumer with both actual connections ready publishes its versioned lease',async()=>{
  const f=fixture(),presence=createFullTakeoffConsumerPresence(f.worker,'worker-a',Promise.resolve(f.client));
  assert.equal(await presence.refresh(),true);
  assert.deepEqual(f.calls[0],{script:RENEW_FULL_TAKEOFF_PRESENCE,key:FULL_TAKEOFF_PRESENCE_KEY,args:['worker-a',45000]});
  for(const state of ['paused','stopped','primary','blocking','closing','closed']){
    f.setPaused(state==='paused');f.setRunning(state!=='stopped');f.primary.status=state==='primary'?'reconnecting':'ready';
    f.blocking.status=state==='blocking'?'reconnecting':'ready';f.worker.closing=state==='closing';f.worker.closed=state==='closed';
    assert.equal(await presence.refresh(),false,state);assert.equal(f.members.has('worker-a'),false,state);
  }
  await presence.close();
});
test('worker cleanup preserves another worker and shutdown orders a delayed publication before removal',async()=>{
  const f=fixture(),a=createFullTakeoffConsumerPresence(f.worker,'worker-a',Promise.resolve(f.client)),b=createFullTakeoffConsumerPresence(f.worker,'worker-b',Promise.resolve(f.client));
  await a.refresh();await b.refresh();await a.close();assert.deepEqual([...f.members],['worker-b']);
  let release!:()=>void;const blocker=new Promise<void>(resolve=>{release=resolve;});
  const original=f.client.eval.bind(f.client);f.client.eval=async(...args)=>{await blocker;return original(...args);};
  const pending=b.refresh();await new Promise(resolve=>setImmediate(resolve));const stopping=b.close();
  release();await Promise.all([pending,stopping]);assert.equal(f.members.size,0);assert.equal(await b.refresh(),false);
});
test('Redis faults close presence and a later healthy refresh recovers without a job',async()=>{
  const f=fixture(),presence=createFullTakeoffConsumerPresence(f.worker,'worker-a',Promise.resolve(f.client));
  const original=f.client.eval.bind(f.client);f.client.eval=async()=>{throw new Error('network');};
  assert.equal(await presence.refresh(),false);assert.equal(await fullTakeoffConsumerPresent(Promise.resolve(f.client)),false);
  f.client.eval=original;assert.equal(await presence.refresh(),true);assert.equal(await fullTakeoffConsumerPresent(Promise.resolve(f.client)),true);
  await presence.close();assert.equal(await fullTakeoffConsumerPresent(Promise.resolve(f.client)),false);
});
test('API requires numeric live lease evidence and does not fall back to CLIENT LIST',async()=>{
  for(const answer of [0,-1,'1',null,NaN,Infinity,{}]){
    const client={status:'ready',eval:async()=>answer} as PresenceRedis;
    assert.equal(await fullTakeoffConsumerPresent(Promise.resolve(client)),false);
  }
  let listCalls=0;
  class Queue{client=Promise.resolve({status:'ready',eval:async()=>1});async getWorkers(){listCalls++;return[];}async add(){}async close(){}}
  const queue=await createFullTakeoffV2Queue('redis://unused',async()=>({Queue}) as never);
  assert.equal(await queue.isWorkerAvailable(),true);assert.equal(listCalls,0);await queue.close?.();
});
test('a lease cannot bypass the SQL capability gate or trigger a download/reservation',async()=>{
  let leaseChecks=0;
  const service=new DurableFullTakeoffV2Service({} as never,{rpc:async()=>({data:false,error:null})} as never,
    {presign:async()=>{throw new Error('No download allowed');}} as never,
    {isWorkerAvailable:async()=>{leaseChecks++;return true;},add:async()=>{throw new Error('No enqueue allowed');}},'user','workspace');
  await assert.rejects(()=>service.reserve('project',{mode:'full_v2',file_id:'file'}),/live Full Takeoff/);
  assert.equal(leaseChecks,0);
});
test('Lua uses Redis time, server expiry and bounded score interval in the queue/version namespace',()=>{
  assert.equal(FULL_TAKEOFF_PRESENCE_KEY,'roughbid:consumer-presence:takeoff-full-v2:takeoff-v2.2-durable');
  assert.equal(FULL_TAKEOFF_PRESENCE_TTL_MS,45000);
  assert.match(RENEW_FULL_TAKEOFF_PRESENCE,/redis\.call\('TIME'\)/);assert.match(RENEW_FULL_TAKEOFF_PRESENCE,/PEXPIRE/);
  assert.match(READ_FULL_TAKEOFF_PRESENCE,/kind\.ok ~= 'zset'/);assert.match(READ_FULL_TAKEOFF_PRESENCE,/ttl <= 0 or ttl > tonumber/);
  assert.match(READ_FULL_TAKEOFF_PRESENCE,/ZCOUNT.*'\(' \.\. now, now \+ tonumber/);
});
