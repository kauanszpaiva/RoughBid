import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createQuotaCircuit, isUpstashQuotaError } from '../src/queue/quota-circuit.ts';
const quota = Object.assign(new Error('max requests limit exceeded. Limit: 500000, Usage: 500004'), {name:'ReplyError'});
class Consumer extends EventEmitter {
  pauses=0; closes=0;
  async pause(noWait?:boolean){assert.equal(noWait,true);this.pauses++;}
  async close(force?:boolean){assert.equal(force,true);this.closes++;}
}
test('recognizes only the Redis monthly quota ReplyError',()=>{
  assert.equal(isUpstashQuotaError(quota),true);
  assert.equal(isUpstashQuotaError(Object.assign(new Error('ERR '+quota.message),{name:'ReplyError'})),true);
  for(const e of [new Error(quota.message),new Error('429 rate limit'),{name:'ReplyError',message:'READONLY'}, {name:'ReplyError',message:'max requests limit exceeded'}]) assert.equal(isUpstashQuotaError(e),false);
});
test('trips once synchronously and stops all present and later consumers',async()=>{
  let logs=0;const c=createQuotaCircuit(()=>logs++);const a=new Consumer(),b=new Consumer();
  c.registerWorker(a);c.registerWorker(b);
  for(let i=0;i<20;i++)a.emit('error',quota);
  assert.equal(c.tripped,true);assert.equal(logs,1);
  const late=new Consumer();c.registerWorker(late);
  await new Promise(r=>setImmediate(r));
  for(const w of [a,b,late]){assert.equal(w.pauses,1);assert.equal(w.closes,0);}
  assert.throws(()=>c.assertOpen(),/manual recovery/);
});
test('unrelated errors do not open circuit or stop consumers',()=>{
  const c=createQuotaCircuit(()=>{}),w=new Consumer();c.registerWorker(w);w.emit('error',new Error('ECONNRESET'));
  assert.equal(c.tripped,false);assert.equal(w.pauses,0);c.assertOpen();
});
test('clears heartbeat timers and disables late registration without recovery probes',async()=>{
  const c=createQuotaCircuit(()=>{});let ticks=0,stops=0;
  c.interval(()=>ticks++,5);c.onTrip(()=>stops++);c.observe(quota);c.interval(()=>ticks++,5);c.onTrip(()=>stops++);
  await new Promise(r=>setTimeout(r,30));assert.equal(ticks,0);assert.equal(stops,2);
});
test('a failing pause cannot reopen the latch or create an unhandled rejection',async()=>{
  const c=createQuotaCircuit(()=>{});const w=new Consumer();w.pause=async()=>{throw new Error('pause failed');};
  c.registerWorker(w);c.observe(quota);await new Promise(r=>setImmediate(r));assert.equal(c.tripped,true);
});

test('suspended presence neither publishes readiness nor retries revocation',async()=>{
  const {createFullTakeoffConsumerPresence}=await import('../src/takeoff-v2/worker-presence.ts');
  let commands=0;const c=createQuotaCircuit(()=>{});
  const redis={status:'ready',eval:async()=>{commands++;throw quota;},zrem:async()=>{commands++;return 1;}};
  const worker={isRunning:()=>true,isPaused:()=>false,client:Promise.resolve(redis),blockingConnection:{client:Promise.resolve(redis)}};
  const presence=createFullTakeoffConsumerPresence(worker,'test-worker',Promise.resolve(redis),c.observe);
  c.onTrip(()=>presence.suspend());
  assert.equal(await presence.refresh(),false);assert.equal(c.tripped,true);assert.equal(commands,1);
  assert.equal(await presence.refresh(),false);await presence.close();assert.equal(commands,1);
});
test('a delayed renewal returns unavailable after suspension, without a second Redis write',async()=>{
  const {createFullTakeoffConsumerPresence}=await import('../src/takeoff-v2/worker-presence.ts');
  let release!:(n:number)=>void,commands=0;
  const redis={status:'ready',eval:async()=>{commands++;return new Promise<number>(r=>release=r);},zrem:async()=>{commands++;return 1;}};
  const worker={isRunning:()=>true,isPaused:()=>false,client:Promise.resolve(redis),blockingConnection:{client:Promise.resolve(redis)}};
  const presence=createFullTakeoffConsumerPresence(worker,'test-worker',Promise.resolve(redis));
  const pending=presence.refresh();await new Promise(r=>setImmediate(r));presence.suspend();release(1);
  assert.equal(await pending,false);await presence.close();assert.equal(commands,1);
});

test('suspension fences a revocation waiting for its Redis client',async()=>{
  const {createFullTakeoffConsumerPresence}=await import('../src/takeoff-v2/worker-presence.ts');
  let resolve!:(v:any)=>void,commands=0;
  const redis={status:'ready',eval:async()=>1,zrem:async()=>{commands++;return 1;}};
  const lease=new Promise<any>(r=>resolve=r);
  const worker={isRunning:()=>false,isPaused:()=>true,client:Promise.resolve(redis),blockingConnection:{client:Promise.resolve(redis)}};
  const presence=createFullTakeoffConsumerPresence(worker,'test-worker',lease);
  const pending=presence.refresh();presence.suspend();resolve(redis);
  assert.equal(await pending,false);assert.equal(commands,0);
});
test('quota rejection during lease revocation also trips the shared circuit',async()=>{
  const {createFullTakeoffConsumerPresence}=await import('../src/takeoff-v2/worker-presence.ts');
  const c=createQuotaCircuit(()=>{});
  const redis={status:'ready',eval:async()=>1,zrem:async()=>{throw quota;}};
  const worker={isRunning:()=>false,isPaused:()=>true,client:Promise.resolve(redis),blockingConnection:{client:Promise.resolve(redis)}};
  const presence=createFullTakeoffConsumerPresence(worker,'test-worker',Promise.resolve(redis),c.observe);
  c.onTrip(()=>presence.suspend());assert.equal(await presence.refresh(),false);assert.equal(c.tripped,true);
});
