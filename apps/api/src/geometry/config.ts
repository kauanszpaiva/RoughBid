import {createHash} from 'node:crypto';
import {requireKamaiProviderConfig,type KamaiProviderConfig} from '../takeoff-v2/kamai-provider.ts';
import {requireApsProviderConfig,type ApsProviderConfig} from '../takeoff-v2/aps-provider.ts';

export const GEOMETRY_VERSION='geometry-provider-v1' as const;
export interface GeometryProfile {version:typeof GEOMETRY_VERSION;profileHash:string;kamai?:KamaiProviderConfig;aps?:ApsProviderConfig;
  apsSourceBindings?:readonly {projectId:string;objectId:string;sourceVersion:string;fileSha256:string;proofRef:string;reviewed:true}[];
  approvedRunBudgetUsd:number;maximumCallCostUsd:number;maximumCalls:number;approvalRef:string;pollIntervalMs:number;}
/** Credentials alone never enable data transmission or spending. No budget is inferred from a balance. */
export function loadGeometryProfile(env:Record<string,string|undefined>):GeometryProfile|undefined {
  if(env.GEOMETRY_PROVIDER_ENABLED!=='true')return undefined;
  if(env.GEOMETRY_PROVIDER_SPEND_APPROVED!=='true')throw new Error('geometry_spending_authorization_required');
  const number=(key:string,min:number,max:number)=>{const value=Number(env[key]);if(!env[key]?.trim()||!Number.isFinite(value)||value<min||value>max)throw new Error(`geometry_configuration_required:${key}`);return value;};
  const approvedRunBudgetUsd=number('GEOMETRY_PROVIDER_RUN_BUDGET_USD',0.000001,100000);
  const maximumCallCostUsd=number('GEOMETRY_PROVIDER_MAXIMUM_CALL_COST_USD',0.000001,100000);
  const maximumCalls=number('GEOMETRY_PROVIDER_MAXIMUM_CALLS',1,100000);
  if(!Number.isSafeInteger(maximumCalls)||maximumCallCostUsd>approvedRunBudgetUsd)throw new Error('geometry_budget_invalid');
  const approvalRef=env.GEOMETRY_PROVIDER_APPROVAL_REF?.trim()??'';if(approvalRef.length<3||approvalRef.length>200)throw new Error('geometry_approval_reference_required');
  const kamai=env.TAKEOFF_V2_KAMAI_ENABLED==='true'?requireKamaiProviderConfig(env):undefined;
  const aps=env.TAKEOFF_V2_APS_ENABLED==='true'?requireApsProviderConfig(env):undefined;
  let apsSourceBindings:GeometryProfile['apsSourceBindings']=[];
  if(aps){try{const raw=env.GEOMETRY_APS_SOURCE_BINDINGS_JSON;if(!raw||raw.length>200000)throw new Error();const parsed=JSON.parse(raw);
    if(!Array.isArray(parsed)||!parsed.length||parsed.length>200||parsed.some(v=>!v||v.reviewed!==true||typeof v.projectId!=='string'||typeof v.objectId!=='string'
      ||typeof v.sourceVersion!=='string'||!v.sourceVersion.trim()||typeof v.proofRef!=='string'||v.proofRef.length<3||v.proofRef.length>200||!/^[a-f0-9]{64}$/.test(v.fileSha256??'')))throw new Error();apsSourceBindings=parsed;
  }catch{throw new Error('geometry_aps_documented_source_bindings_required');}}
  if(!kamai&&!aps)throw new Error('geometry_provider_not_authorized');
  const publicConfig={version:GEOMETRY_VERSION,kamaiEnabled:Boolean(kamai),apsEnabled:Boolean(aps),kamaiStatus:kamai?.jobSuccessStatus??null,
    sourceBindingsDigest:createHash('sha256').update(JSON.stringify(apsSourceBindings)).digest('hex'),approvedRunBudgetUsd,maximumCallCostUsd,maximumCalls,approvalRef,pollIntervalMs:30_000};
  return {...publicConfig,profileHash:createHash('sha256').update(JSON.stringify(publicConfig)).digest('hex'),...(kamai?{kamai}:{}),...(aps?{aps}:{}),apsSourceBindings};
}
