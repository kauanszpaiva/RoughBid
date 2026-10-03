import {GEOMETRY_VERSION} from './config.ts';
export const GEOMETRY_QUEUE='roughbid-geometry-provider';
export interface GeometryJob{runId:string;version:typeof GEOMETRY_VERSION}
export interface GeometryQueue{add(name:'read-geometry',data:GeometryJob,options:{jobId:string;attempts:1;delay:number;removeOnComplete:number;removeOnFail:number|boolean}):Promise<unknown>;isWorkerAvailable():Promise<boolean>;close?():Promise<void>;on?(event:string,listener:()=>void):unknown;}
export async function createGeometryQueue(redisUrl:string,loader:()=>Promise<any>=()=>import('bullmq')):Promise<GeometryQueue>{
  if(!redisUrl)throw new Error('geometry_redis_required');const {Queue}=await loader();
  const queue=new Queue(GEOMETRY_QUEUE,{connection:{url:redisUrl,maxRetriesPerRequest:1,enableOfflineQueue:false,connectTimeout:5000,retryStrategy:()=>null}});queue.on?.('error',()=>{});
  queue.isWorkerAvailable=async()=>{try{return (await queue.getWorkers()).length>0;}catch{return false;}};return queue;
}
export async function enqueueGeometryRun(queue:GeometryQueue,runId:string,delayMs=0):Promise<void>{
  await queue.add('read-geometry',{runId,version:GEOMETRY_VERSION},{jobId:`${runId}-${crypto.randomUUID()}`,attempts:1,delay:Math.max(0,delayMs),removeOnComplete:1000,removeOnFail:1000});
}
