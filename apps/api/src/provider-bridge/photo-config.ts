import { requirePhotoTakeoffProfile,requirePhotoTakeoffConfig,type PhotoTakeoffProfile,type PhotoTakeoffConfig } from '../photos/config.ts';
import { requireBridgeConnectionConfig } from './config.ts';
import { BridgeError } from './protocol.ts';
export interface PhotoBridgeConfig extends ReturnType<typeof requireBridgeConnectionConfig>{
  profile:PhotoTakeoffProfile;profileHash:string;requestTimeoutMs:number;providerConfig?:PhotoTakeoffConfig;
}
export function requirePhotoBridgeConfig(env:Record<string,string|undefined>,side:'worker'|'server'):PhotoBridgeConfig{
  const connection=requireBridgeConnectionConfig(env);
  if(env.PHOTO_TAKEOFF_TRANSPORT!=='bridge')throw new BridgeError('bridge_adapter_unavailable',503);
  const profile=requirePhotoTakeoffProfile(env);
  if(!profile.complete)throw new BridgeError('bridge_adapter_unavailable',503);
  const requestTimeoutMs=Math.max(...Object.values(profile.complete.routes).map(route=>route.timeoutMs));
  if(requestTimeoutMs>180_000)throw new BridgeError('bridge_adapter_unavailable',503);
  return {...connection,profile,profileHash:profile.complete.profileHash,requestTimeoutMs,
    ...(side==='server'?{providerConfig:requirePhotoTakeoffConfig(env)}:{})};
}
