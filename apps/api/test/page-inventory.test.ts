import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { getPageReadingInventory } from '../src/ai-plan/page-inventory.ts';
import { PDF_DIGEST } from '../src/billing/project-preflight.ts';

async function fixture(options: {role?:string;owner?:boolean;historyError?:boolean;pages?:number}={}) {
  const doc=await PDFDocument.create(); for(let i=0;i<(options.pages??3);i++)doc.addPage();
  const bytes=await doc.save(); const calls:any[]=[];
  const jobs=[{id:'saved-2',status:'needs_review',input_summary:{page_strategy:'sheet-v1',file_sha256:PDF_DIGEST(bytes),physical_page_number:2,physical_page_count:3,requested_trades:['Framing'],requested_scope:'Test'},output_summary:{finding_count:4}},{id:'old-scope',status:'needs_review',input_summary:{page_strategy:'sheet-v1',file_sha256:PDF_DIGEST(bytes),physical_page_number:1,physical_page_count:3,requested_trades:['Drywall'],requested_scope:'Other'},output_summary:{}}];
  const db:any={from:(table:string)=>{calls.push({table}); const q:any={};const filters:any[]=[];
    q.select=()=>q;q.order=()=>q;q.limit=()=>q;q.eq=(key:string,value:unknown)=>{filters.push([key,value]);calls.push({table,key,value});return q;};
    const result=()=>({data:table==='profiles'?{is_platform_admin:options.owner!==false}:table==='workspace_members'?{role:options.role??'admin'}:table==='projects'?{id:'p'}:table==='project_files'?{id:'f',processing_status:'ready',storage_path:'w/p/f/source.pdf'}:table==='plan_reading_jobs'?jobs:undefined,error:table==='plan_reading_jobs'&&options.historyError?{}:null});
    q.maybeSingle=async()=>result();q.then=(a:any,b:any)=>Promise.resolve(result()).then(a,b);return q;}};
  const storage={presign:()=>{calls.push({signed:true});return {url:'https://storage.test/source.pdf'};}};
  const run=()=>getPageReadingInventory(db,storage,'u','w','p','f',{trades:['Framing'],scope:'Test'},(async()=>new Response(bytes))as typeof fetch);
  return {run,calls,bytes};
}
test('inventory accounts for every physical page and restores only matching scope without inference',async()=>{
  const h=await fixture();const result=await h.run();
  assert.equal(result.totalPages,3);assert.equal(result.completeTakeoffVerified,false);
  assert.deepEqual(result.pages.map(p=>p.pageNumber),[1,2,3]);
  assert.equal(result.pages[1]!.jobId,'saved-2');assert.equal(result.pages[0]!.jobId,null);
  for(const key of ['workspace_id','project_id','file_id','requested_by','input_summary->>file_sha256'])assert.ok(h.calls.some(c=>c.table==='plan_reading_jobs'&&c.key===key));
});
for(const options of [{role:'viewer'},{owner:false}])test('unauthorized inventory performs no file signing',async()=>{
  const h=await fixture(options);await assert.rejects(h.run(),(e:any)=>e.status===403);assert.ok(!h.calls.some(c=>c.signed));
});
test('history errors never appear as an empty successful inventory',async()=>{const h=await fixture({historyError:true});await assert.rejects(h.run());});
test('over-limit files fail before history lookup rather than skipping physical pages',async()=>{const h=await fixture({pages:201});await assert.rejects(h.run(),(e:any)=>e.status===413);assert.ok(!h.calls.some(c=>c.table==='plan_reading_jobs'));});
