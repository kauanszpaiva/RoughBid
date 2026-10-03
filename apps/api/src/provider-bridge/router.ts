import type { DocumentObjectStorage } from '../documents/service.ts';
import { BridgeError,PHOTO_BRIDGE_PROTOCOL } from './protocol.ts';
import { authenticateBridgeRequest } from './request.ts';
import { requireBridgeConnectionConfig,requireBridgeRuntimeConfig } from './config.ts';
import { requirePhotoBridgeConfig } from './photo-config.ts';
import { handleProviderBridge } from './service.ts';
import { handlePhotoBridge } from './photo-service.ts';
import type { BridgeDatabase } from './persistence.ts';
/** Two explicit internal operation types. Neither accepts a provider URL or payload. */
export async function routeProviderBridge(request:Request,deps:{db:BridgeDatabase;storage:DocumentObjectStorage;env:Record<string,string|undefined>;fetcher?:typeof fetch}):Promise<Response>{
  try{
    const connection=requireBridgeConnectionConfig(deps.env);
    const verified=await authenticateBridgeRequest(request,connection.auth,Math.floor(Date.now()/1000));
    if(verified.command.protocol===PHOTO_BRIDGE_PROTOCOL)return handlePhotoBridge(request,{...deps,config:requirePhotoBridgeConfig(deps.env,'server')},verified);
    return handleProviderBridge(request,{...deps,config:requireBridgeRuntimeConfig(deps.env,'server')},verified);
  }catch(error){return Response.json({error:error instanceof BridgeError?error.code:'bridge_adapter_unavailable'},
    {status:error instanceof BridgeError?error.status:503,headers:{'cache-control':'no-store'}});}
}
