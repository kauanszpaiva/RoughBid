import type { DeepPassResult } from './types.ts';

export const MAX_PRIOR_CONTEXT_CHARS=24_000;
const record=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Shared server/worker projection. Coverage limits and blockers are evidence too. */
export function buildPriorEvidenceContext(entries:readonly Pick<DeepPassResult,'status'|'checkpoint'>[]):string {
  const context=entries.map(({status,checkpoint:c})=>({physical_page_number:c.physical_page_number,pass_type:c.pass_type,status,
    observations:c.observations,blockers:c.blockers,
    ...Object.fromEntries(['source_coverage','capacity','deterministic_scale','human_review_required','coverageStatus','humanReviewRequired','truncated']
      .filter(key=>c[key]!==undefined).map(key=>[key,c[key]])),
    ...(Array.isArray(c.measurements)?{reviewed_measurement_count:c.measurements.length}:{}),
    ...(record(c.automatic_geometry)?{automatic_geometry:{coverage:c.automatic_geometry.coverage,status:c.automatic_geometry.status,
      blockers:c.automatic_geometry.blockers,limitations:c.automatic_geometry.limitations,truncated:c.automatic_geometry.truncated,
      candidate_count:Array.isArray(c.automatic_geometry.candidates)?c.automatic_geometry.candidates.length:undefined}}:{})}));
  const text=JSON.stringify(context);
  if(text.length<=MAX_PRIOR_CONTEXT_CHARS)return text;
  return JSON.stringify({coverage:'context_capacity_reached',context_complete:false,checkpoint_count:context.length,
    source_pages:[...new Set(context.map(c=>c.physical_page_number).filter(Number.isSafeInteger))].slice(0,200),
    blocker:'Previous checkpoints, regional coverage and unresolved blockers exceed this request. They were not reviewed here; directed review remains required.'});
}
export function priorEvidenceNeedsReview(context:string,page:number):boolean {
  let rows:unknown;try{rows=JSON.parse(context);}catch{return true;}
  if(!Array.isArray(rows))return true;
  const samePage=rows.filter(row=>record(row)&&row.physical_page_number===page);
  const required=['classification','legends_schedules','geometry','discipline','reconciliation','conflict_detection','completeness','arithmetic_qa','pricing_assemblies'];
  if(required.some(pass=>!samePage.some(row=>row.pass_type===pass)))return true;
  return rows.some(row=>!record(row)||row.status!=='succeeded'||!Array.isArray(row.blockers)||row.blockers.length>0
    ||row.human_review_required===true||row.humanReviewRequired===true||row.truncated===true||row.coverageStatus==='partial'
    ||row.capacity?.reached_observation_limit===true||row.source_coverage?.completeness_verified===false
    ||row.source_coverage?.truncated===true||['not_observed','selected_region','selected_regions'].includes(row.source_coverage?.visual_coverage));
}
