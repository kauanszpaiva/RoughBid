import {ProjectApiError,type SupabaseLike} from '../projects/service.ts';
import {GeometryTakeoffService,type GeometryDependencies} from './service.ts';
async function body(request:Request){const raw=await request.text();if(Buffer.byteLength(raw)>100000)throw new ProjectApiError(413,'Geometry metadata is too large.');try{return JSON.parse(raw);}catch{throw new ProjectApiError(400,'JSON metadata is required.');}}
export async function handleGeometryRequest(request:Request,db:SupabaseLike,deps:GeometryDependencies):Promise<Response>{try{
  const auth=await db.auth.getUser();if(auth.error||!auth.data.user)throw new ProjectApiError(401,'Authentication required.');
  const workspace=request.headers.get('x-workspace-id');if(!workspace)throw new ProjectApiError(400,'x-workspace-id is required.');
  const url=new URL(request.url),parts=url.pathname.replace(/^\/api\/?/,'').split('/').filter(Boolean);
  if(parts[0]!=='projects'||!parts[1]||parts[2]!=='geometry')return Response.json({error:'Not found'},{status:404});
  const service=new GeometryTakeoffService(db,deps,auth.data.user.id,workspace),projectId=parts[1];let result:unknown,status=200;
  if(parts[3]==='capability'&&parts.length===4&&request.method==='GET')result=await service.capability(projectId);
  else if(parts[3]==='runs'&&parts.length===4&&request.method==='POST'){result=await service.reserve(projectId,await body(request));status=202;}
  else if(parts[3]==='runs'&&parts.length===4&&request.method==='GET')result=await service.list(projectId,{...(url.searchParams.has('file_id')?{fileId:url.searchParams.get('file_id')!}:{}),
    ...(url.searchParams.has('physical_page_number')?{physicalPageNumber:Number(url.searchParams.get('physical_page_number'))}:{})});
  else if(parts[3]==='runs'&&parts[4]&&parts.length===5&&request.method==='GET')result=await service.get(projectId,parts[4]);
  else if(parts[3]==='runs'&&parts[4]&&parts.length===6&&request.method==='POST'&&['cancel','resume'].includes(parts[5]!))result=await service.control(projectId,parts[4],parts[5] as 'cancel'|'resume');
  else if(parts[3]==='runs'&&parts[4]&&request.method==='POST'&&(parts.length===6&&parts[5]==='review'||parts.length===8&&parts[5]==='candidates'&&parts[7]==='review')){
    const input=await body(request);result=await service.review(projectId,parts[4],parts[6]?{...(input&&typeof input==='object'?input:{}),candidateId:parts[6]}:input);
  }else return Response.json({error:'Not found'},{status:404});
  return Response.json(result,{status,headers:{'cache-control':'private, no-store'}});
}catch(error){return error instanceof ProjectApiError?Response.json({error:error.message},{status:error.status}):Response.json({error:'Geometry processing failed. Check saved state before continuing.'},{status:500});}}
