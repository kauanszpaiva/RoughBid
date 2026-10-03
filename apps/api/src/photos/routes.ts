import { ProjectApiError, type SupabaseLike } from '../projects/service.ts';
import { PhotoEvidenceError } from '../photo-evidence.ts';
import { PhotoTakeoffService, type PhotoRequestDependencies } from './service.ts';

async function body(request:Request):Promise<unknown> {
  const text=await request.text();
  if (Buffer.byteLength(text)>250_000) throw new ProjectApiError(413,'Photo metadata request is too large. Upload image bytes directly to private storage.');
  try {return JSON.parse(text);} catch {throw new ProjectApiError(400,'A JSON metadata body is required.');}
}
export async function handlePhotoRequest(request:Request,db:SupabaseLike,deps:PhotoRequestDependencies):Promise<Response> {
  try {
    const {data,error}=await db.auth.getUser();
    if (error||!data.user) throw new ProjectApiError(401,'Authentication required.');
    const workspaceId=request.headers.get('x-workspace-id');
    if (!workspaceId) throw new ProjectApiError(400,'x-workspace-id header is required.');
    const url=new URL(request.url),parts=url.pathname.replace(/^\/api\/?/,'').split('/').filter(Boolean);
    if (parts[0]!=='projects'||!parts[1]||parts[2]!=='photos') return Response.json({error:'Not found'},{status:404});
    const service=new PhotoTakeoffService(db,deps,data.user.id,workspaceId),projectId=parts[1];
    let result:unknown,status=200;
    if (request.method==='GET'&&parts[3]==='capability'&&parts.length===4) result=await service.capability(projectId);
    else if (parts[3]==='uploads'&&request.method==='POST'&&parts.length===4) {result=await service.beginUpload(projectId,await body(request));status=201;}
    else if (parts[3]==='uploads'&&parts[4]&&parts[5]==='complete'&&request.method==='POST'&&parts.length===6) result=await service.completeUpload(projectId,parts[4]);
    else if (parts[3]==='uploads'&&parts[4]&&parts[5]==='download-url'&&request.method==='POST'&&parts.length===6) result=await service.download(projectId,parts[4]);
    else if (parts[3]==='runs'&&parts.length===4&&request.method==='GET') result=await service.list(projectId);
    else if (parts[3]==='runs'&&parts.length===4&&request.method==='POST') {result=await service.reserve(projectId,await body(request));status=202;}
    else if (parts[3]==='runs'&&parts[4]&&parts.length===5&&request.method==='GET') result=url.searchParams.has('asset_id')
      ? await service.checkpoint(projectId,parts[4],url.searchParams.get('asset_id')??'') : await service.get(projectId,parts[4]);
    else if (parts[3]==='runs'&&parts[4]&&parts.length===6&&request.method==='POST'&&parts[5]==='cancel') result=await service.cancel(projectId,parts[4]);
    else if (parts[3]==='runs'&&parts[4]&&parts.length===6&&request.method==='POST'&&parts[5]==='resume') {result=await service.resume(projectId,parts[4]);status=202;}
    else if (parts[3]==='runs'&&parts[4]&&parts.length===6&&request.method==='POST'&&parts[5]==='review') result=await service.review(projectId,parts[4],await body(request));
    else return Response.json({error:'Not found'},{status:404});
    return Response.json(result,{status,headers:{'cache-control':'private, no-store'}});
  } catch(error) {
    if (error instanceof ProjectApiError) return Response.json({error:error.message},{status:error.status});
    if (error instanceof PhotoEvidenceError) return Response.json({error:'Photo evidence or references are invalid.',code:error.code},{status:422});
    return Response.json({error:'Photo operation failed. Check saved state before continuing.'},{status:500});
  }
}
