import { SupplierQuoteError } from '../../../../packages/domain/src/supplier-quotes.ts';
import { ProjectApiError, type SupabaseLike } from '../projects/service.ts';
import { ConstructionBudgetService } from './service.ts';

async function boundedBody(request: Request): Promise<unknown> {
  if (!request.body) throw new ProjectApiError(400,'A documented JSON body is required.');
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let length=0;
  try{while(true){const value=await reader.read();if(value.done)break;length+=value.value.length;
    if(length>1_000_000){await reader.cancel();throw new ProjectApiError(413,'Save documented inputs in batches of at most 1 MB.');}chunks.push(value.value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new ProjectApiError(400,'Valid JSON is required.');}
}
export async function handleConstructionBudgetRequest(request:Request,db:SupabaseLike,writer:ConstructorParameters<typeof ConstructionBudgetService>[1],now?:()=>string):Promise<Response>{
  try{
    const {data,error}=await db.auth.getUser();if(error||!data.user)throw new ProjectApiError(401,'Authentication required.');
    const workspaceId=request.headers.get('x-workspace-id');if(!workspaceId)throw new ProjectApiError(400,'Select a workspace.');
    const match=new URL(request.url).pathname.match(/^\/api\/projects\/([^/]+)\/(construction-budget|supplier-quotes)$/);
    if(!match)return Response.json({error:'Not found'},{status:404});
    const service=new ConstructionBudgetService(db,writer,data.user.id,workspaceId,now),projectId=match[1]!,quotes=match[2]==='supplier-quotes';
    let result:unknown;
    if(request.method==='GET')result=quotes?await service.quotes(projectId):await service.get(projectId,new URL(request.url).searchParams.get('snapshot_id')??undefined);
    else if(request.method==='POST')result=quotes?await service.importQuotes(projectId,await boundedBody(request)):await service.calculate(projectId,await boundedBody(request));
    else return Response.json({error:'Method not allowed'},{status:405});
    return Response.json(result,{status:request.method==='POST'?201:200,headers:{'cache-control':'private, no-store'}});
  }catch(error){
    if(error instanceof ProjectApiError)return Response.json({error:error.message},{status:error.status});
    if(error instanceof SupplierQuoteError)return Response.json({error:'Documented quote validation failed.',code:error.code},{status:422});
    if(error instanceof TypeError||error instanceof RangeError)return Response.json({error:'Documented catalog inputs, units or source metadata are invalid.'},{status:422});
    return Response.json({error:'Construction budgeting is unavailable. Saved inputs were not substituted.'},{status:503});
  }
}
