import { randomUUID } from 'node:crypto';
import { ProjectApiError } from '../projects/service.ts';

export type AiFailureStage = 'prepare_file' | 'generate' | 'parse' | 'validate' | 'count_tokens';
export type AiFailureCode = 'provider_credentials' | 'provider_permissions' | 'provider_quota' | 'provider_model_unavailable'
  | 'provider_request_rejected' | 'provider_timeout' | 'provider_unavailable' | 'provider_invalid_output'
  | 'provider_empty_output' | 'provider_file_preparation' | 'provider_unknown' | 'provider_output_truncated';
const reasons = new Set(['API_KEY_INVALID','API_KEY_EXPIRED','API_KEY_SERVICE_BLOCKED','API_KEY_HTTP_REFERRER_BLOCKED','API_KEY_IP_ADDRESS_BLOCKED',
  'SERVICE_DISABLED','BILLING_DISABLED','RATE_LIMIT_EXCEEDED','QUOTA_EXCEEDED','RESOURCE_EXHAUSTED','PERMISSION_DENIED','UNAUTHENTICATED',
  'NOT_FOUND','INVALID_ARGUMENT','FAILED_PRECONDITION','INTERNAL','UNAVAILABLE','DEADLINE_EXCEEDED']);
const messages: Record<AiFailureCode,string> = {
  provider_credentials:'AI analysis is unavailable because its service credentials need attention. Contact support.',
  provider_permissions:'AI analysis is unavailable because service access needs attention. Contact support.',
  provider_quota:'The AI service has reached its available quota. Contact support before retrying.',
  provider_model_unavailable:'The configured AI model is unavailable. Contact support.',
  provider_request_rejected:'The AI service could not accept this reading request. Contact support.',
  provider_timeout:'The AI service timed out. Check the reading status before retrying.',
  provider_unavailable:'The AI service is temporarily unavailable. Check the reading status before retrying.',
  provider_invalid_output:'The AI response could not be validated. Check the reading status before retrying.',
  provider_empty_output:'The AI returned no usable findings. Review the plan manually or contact support.',
  provider_file_preparation:'The uploaded PDF could not be prepared for visual reading. Contact support.',
  provider_unknown:'AI could not read this plan. Contact support.',
  provider_output_truncated:'The AI response reached its output limit. Reduce the selected trade scope or contact support before retrying.',
};

export class AiProviderError extends ProjectApiError {
  readonly diagnostic: { reference:string;provider:string;model:string;stage:AiFailureStage;code:AiFailureCode;provider_status:number|null;reason:string|null;duration_ms:number };
  constructor(code:AiFailureCode, context:{provider:string;model:string;stage:AiFailureStage;durationMs:number}, providerStatus:number|null=null, reason:string|null=null) {
    const reference=randomUUID();
    const status=code==='provider_timeout'?504:['provider_credentials','provider_permissions','provider_quota','provider_model_unavailable','provider_unavailable'].includes(code)?503:502;
    super(status,`${messages[code]} No quantities were generated. Reference: ${reference}`);
    this.name='AiProviderError';
    this.diagnostic={reference,provider:['gemini','claude','openrouter'].includes(context.provider)?context.provider:'other',
      model:/^gemini-[a-z0-9][a-z0-9.-]{0,80}$/i.test(context.model)?context.model:'configured-model',stage:context.stage,code,
      provider_status:providerStatus,reason,duration_ms:Math.max(0,Math.round(context.durationMs))};
  }
}

/** Only numeric status and explicitly allowed machine reasons survive. Never retain raw error, stack, URL, response, request, key or document. */
export function classifyProviderFailure(error:unknown, context:{provider:string;model:string;stage:AiFailureStage;durationMs:number}, fallback:AiFailureCode='provider_unknown'):AiProviderError {
  if(error instanceof AiProviderError)return error;
  const input=error&&typeof error==='object'?error as Record<string,any>:{};
  let body:Record<string,any>={};
  if(typeof input.message==='string' && input.message.length<=64_000) {
    try { const parsed=JSON.parse(input.message);if(parsed&&typeof parsed==='object')body=parsed.error??parsed; } catch { /* Raw text is never exposed. */ }
  }
  const details=Array.isArray(body.details)?body.details:Array.isArray(input.error?.details)?input.error.details:[];
  const candidates=[...details.map((detail:any)=>detail?.reason),body.status,input.error?.status];
  const reportedLeaked = [body.message,input.message].some(value=>typeof value==='string'&&value.includes('Your API key was reported as leaked.'));
  const reason=reportedLeaked?'API_KEY_REPORTED_LEAKED':candidates.find(value=>typeof value==='string'&&reasons.has(value))??null;
  const rawStatus=input.status??input.statusCode??body.code;
  const status=typeof rawStatus==='number'&&Number.isInteger(rawStatus)&&rawStatus>=400&&rawStatus<=599?rawStatus:null;
  const timedOut=['TimeoutError','AbortError'].includes(input.name)||['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(input.code);
  let code:AiFailureCode=fallback;
  if(reason?.startsWith('API_KEY_')||status===401||reason==='UNAUTHENTICATED')code='provider_credentials';
  else if(status===402||status===403||['PERMISSION_DENIED','SERVICE_DISABLED','BILLING_DISABLED'].includes(reason??''))code='provider_permissions';
  else if(status===429||['RESOURCE_EXHAUSTED','RATE_LIMIT_EXCEEDED','QUOTA_EXCEEDED'].includes(reason??''))code='provider_quota';
  else if(status===404||reason==='NOT_FOUND')code='provider_model_unavailable';
  else if(timedOut||status===408||status===504||reason==='DEADLINE_EXCEEDED')code='provider_timeout';
  else if(status!==null&&status>=500)code='provider_unavailable';
  else if(status===400||status===422)code='provider_request_rejected';
  return new AiProviderError(code,context,status,reason);
}

export function logProviderFailure(error:AiProviderError):void {
  console.error('ai_provider_failure',error.diagnostic);
}

export async function runProviderOperation<T>(provider:string,model:string,stage:AiFailureStage,operation:()=>Promise<T>):Promise<T> {
  const started=Date.now();
  try{return await operation();}
  catch(error){
    const failure=classifyProviderFailure(error,{provider,model,stage,durationMs:Date.now()-started},stage==='parse'?'provider_invalid_output':'provider_unknown');
    logProviderFailure(failure);throw failure;
  }
}
