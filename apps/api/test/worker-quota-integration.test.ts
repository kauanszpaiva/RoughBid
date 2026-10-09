import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Worker } from 'bullmq';
import { createQuotaCircuit } from '../src/queue/quota-circuit.ts';

// Real BullMQ + ioredis over loopback TCP. No production connection or provider.
async function quotaServer(options: { delayQueueInitialization?: boolean; stallAllInfo?: boolean } = {}) {
  const heldInfo: Array<() => void> = [];
  let connections = 0;
  const sockets=new Set<net.Socket>();const commands:string[]=[];
  const server=net.createServer(socket=>{
    const connectionIndex = connections++; let infoCount = 0;
    sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length){
        let offset=0; const line=()=>{const end=buffer.indexOf('\r\n',offset);if(end<0)return null;const value=buffer.toString('utf8',offset,end);offset=end+2;return value;};
        const header=line();if(!header||header[0]!=='*')return;
        const args:string[]=[];let complete=true;
        for(let n=0;n<Number(header.slice(1));n++){const length=line();if(!length){complete=false;break;}const size=Number(length.slice(1));if(buffer.length<offset+size+2){complete=false;break;}args.push(buffer.toString('utf8',offset,offset+size));offset+=size+2;}
        if(!complete)return;buffer=buffer.subarray(offset);const command=args[0].toLowerCase();commands.push(command);
        if(command==='info'){
          infoCount++;
          const reply = () => { if (!socket.destroyed) { const info='redis_version:7.2.0\r\nmaxmemory_policy:noeviction\r\n';socket.write('$'+Buffer.byteLength(info)+'\r\n'+info+'\r\n'); } };
          if(options.stallAllInfo || (options.delayQueueInitialization && connectionIndex === 0 && infoCount === 2)) heldInfo.push(reply);
          else reply();
        }
        else if(command==='evalsha'||command==='eval')socket.write('-max requests limit exceeded. Limit: 500000, Usage: 500004\r\n');
        else if(command==='hmget')socket.write('*2\r\n$-1\r\n$-1\r\n');
        else if(command==='quit'){socket.end('+OK\r\n');}
        else socket.write('+OK\r\n');
      }
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {releaseInfo(){for(const reply of heldInfo.splice(0))reply();},get heldInfoCount(){return heldInfo.length;},port:(server.address() as net.AddressInfo).port,commands,async close(){for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));}};
}
test('real BullMQ quota failure stops three consumers by local pause alone, before teardown', {timeout:5000}, async()=>{
  const redis=await quotaServer();let dispatches=0,trips=0;
  const circuit=createQuotaCircuit(()=>trips++);const workers:Worker[]=[];
  try{
    for(const [name,concurrency] of [['pdf',2],['full',1],['photo',1]] as const){
      const w=new Worker(name,async()=>{dispatches++;},{connection:{host:'127.0.0.1',port:redis.port,maxRetriesPerRequest:null},concurrency,skipStalledCheck:true,stalledInterval:100,autorun:false});
      circuit.registerWorker(w);workers.push(w);void w.run().catch(e=>circuit.observe(e));
    }
    const deadline=Date.now()+2000;while(!circuit.tripped&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
    assert.equal(circuit.tripped,true);assert.equal(trips,1);
    await Promise.all(workers.map(w=>w.waitUntilReady()));
    await new Promise(r=>setTimeout(r,100));
    const count=redis.commands.filter(x=>x==='evalsha'||x==='eval').length;
    assert.ok(count>0&&count<=9,`bounded script commands: ${count}`);
    await new Promise(r=>setTimeout(r,100));
    assert.equal(redis.commands.filter(x=>x==='evalsha'||x==='eval').length,count);
    assert.equal(dispatches,0);assert.ok(workers.every(w=>w.isPaused()&&!w.closed));
  } finally {await Promise.all(workers.map(w=>w.close(true)));await redis.close();}
});

for (const delayQueueInitialization of [false,true]) for (const signal of ['SIGTERM', 'SIGINT'] as const) test(`actual worker parks after quota with delayed Queue INFO=${delayQueueInitialization}, then exits on ${signal}`, {timeout:20000}, async()=>{
  const {spawn}=await import('node:child_process');
  const redis=await quotaServer({delayQueueInitialization});
  const child=spawn(process.execPath,['--experimental-strip-types','scripts/worker.ts'],{cwd:new URL('../../../',import.meta.url),env:{
    PATH:process.env.PATH, REDIS_URL:`redis://127.0.0.1:${redis.port}`,SUPABASE_URL:'http://127.0.0.1:1',SUPABASE_SERVICE_ROLE_KEY:'local-test-not-a-secret',
    OBJECT_STORAGE_ENDPOINT:'http://localhost:1',OBJECT_STORAGE_BUCKET:'fixture',OBJECT_STORAGE_ACCESS_KEY_ID:'fixture',OBJECT_STORAGE_SECRET_ACCESS_KEY:'fixture',
    AI_PLAN_DURABLE_ENABLED:'false',TAKEOFF_V2_WORKER_ENABLED:'false',PHOTO_TAKEOFF_WORKER_ENABLED:'false',
  },stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  const exited=new Promise<{code:number|null,signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  try{
    const deadline=Date.now()+10000;
    while(!output.includes('manual recovery')&&child.exitCode===null&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    assert.match(output,/readiness degraded/);assert.equal(child.exitCode,null);
    if(delayQueueInitialization)assert.equal(redis.heldInfoCount,1);
    redis.releaseInfo();
    await new Promise(r=>setTimeout(r,150));assert.equal(child.exitCode,null,output);const commands=redis.commands.length;
    await new Promise(r=>setTimeout(r,150));assert.equal(redis.commands.length,commands);
    assert.equal(output.match(/Redis monthly quota exhausted/g)?.length,1);
    child.kill(signal);assert.deepEqual(await Promise.race([exited,new Promise(r=>setTimeout(()=>r('signal ignored'),3000).unref())]),{code:0,signal:null},output);
  } finally {if(child.exitCode===null)child.kill('SIGKILL');await exited;await redis.close();}
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) test(`SIGINT/SIGTERM remains effective during stalled non-quota startup: ${signal}`, {timeout:20000}, async()=>{
  const {spawn}=await import('node:child_process');
  const {createServer}=await import('node:http');
  let startupRequests=0;
  const database=createServer(()=>{startupRequests++; /* Hold schema RPC in startup. */});
  await new Promise<void>(r=>database.listen(0,'127.0.0.1',r));
  const databasePort=(database.address() as net.AddressInfo).port;
  const redis=await quotaServer({stallAllInfo:true});
  const child=spawn(process.execPath,['--experimental-strip-types','scripts/worker.ts'],{cwd:new URL('../../../',import.meta.url),env:{
    PATH:process.env.PATH, REDIS_URL:`redis://127.0.0.1:${redis.port}`,SUPABASE_URL:`http://127.0.0.1:${databasePort}`,SUPABASE_SERVICE_ROLE_KEY:'local-test-not-a-secret',
    OBJECT_STORAGE_ENDPOINT:'http://localhost:1',OBJECT_STORAGE_BUCKET:'fixture',OBJECT_STORAGE_ACCESS_KEY_ID:'fixture',OBJECT_STORAGE_SECRET_ACCESS_KEY:'fixture',
    AI_PLAN_DURABLE_ENABLED:'false',TAKEOFF_V2_ENABLED:'true',TAKEOFF_V2_WORKER_ENABLED:'true',PHOTO_TAKEOFF_WORKER_ENABLED:'false',
    TAKEOFF_V2_STAGE_PROVIDER_ENABLED:'true',TAKEOFF_V2_SCHEMA_VERSION:'takeoff-v2-foundation-v1',
    TAKEOFF_V2_STAGE_CLASSIFICATION_ENABLED:'true',TAKEOFF_V2_STAGE_CLASSIFICATION_PROVIDER:'openai',
    TAKEOFF_V2_STAGE_CLASSIFICATION_MODEL:'gpt-6-astra',OPENAI_API_KEY:'unit-openai-credential',
    TAKEOFF_V2_MODEL_ATTESTATIONS_JSON:JSON.stringify({'gpt-6-astra':{accountVerified:true,compatibilityVerified:true,priceVersion:'unit-offline',maximumCallCostUsd:25}}),
  },stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  const exited=new Promise<{code:number|null,signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  try{
    const deadline=Date.now()+10000;
    while((startupRequests===0||redis.heldInfoCount===0)&&child.exitCode===null&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    assert.ok(startupRequests>0,output);assert.ok(redis.heldInfoCount>0,output);assert.equal(child.exitCode,null);assert.doesNotMatch(output,/manual recovery/);
    child.kill(signal);assert.deepEqual(await Promise.race([exited,new Promise(r=>setTimeout(()=>r('signal ignored'),3000).unref())]),{code:0,signal:null},output);
  } finally {if(child.exitCode===null)child.kill('SIGKILL');await exited;await redis.close();database.closeAllConnections();await new Promise<void>(r=>database.close(()=>r()));}
});
