import {verifyMakerTrace} from './maker-trace.mjs';
// Validate retained local source. This does not authenticate an author or grant adoption.
import {apply,canonical,clone,digest,validate} from './scene.mjs';
import {verifyProject} from './project.mjs';
import {verifyBriefChange} from './brief-change.mjs';
export const STUDIO_SOURCE_HISTORY_LIMIT=10000;
export const STUDIO_SOURCE_FEEDBACK_LIMIT=10000;
function mergeConflicts(mine,theirs){
 const fields=c=>c.op==='set'?Object.keys(c.patch):['*'];const conflicts=[];
 for(const left of mine)for(const right of theirs){
  if((left.op==='layer'&&['layer','add','remove'].includes(right.op))||(right.op==='layer'&&['layer','add','remove'].includes(left.op))){conflicts.push({element:left.element,field:'layer-order'});continue;}
  if(left.element===right.element)for(const field of fields(left).filter(f=>f==='*'||fields(right).includes('*')||fields(right).includes(f)))conflicts.push({element:left.element,field});
 }
 return conflicts;
}
export async function verifySource(source,depth=0){
 if(depth>8)throw Error('Source merge nesting exceeds 8 levels');
 if(source?.schema!=='omega-studio-source-1'||!Array.isArray(source.history)||!source.history.length||source.history.length>STUDIO_SOURCE_HISTORY_LIMIT)throw Error('Invalid source history');
 await verifyProject(source.project);
 if(source.brief_change!==undefined){
  const change=source.brief_change;
  const prior=await verifySource(change.source,depth+1);
  await verifyBriefChange(change.transition);
  if(await digest(prior)!==change.source_digest||canonical(prior.project)!==canonical(change.transition.before)||canonical(source.project.brief)!==canonical(change.transition.after.brief))throw Error('Steering source custody differs');
  const expected={...clone(prior.current.scene),criteria:clone(source.project.brief.criteria)};
  const selected=source.project.directions.find(d=>d.id===source.project.selection?.direction_id);
  if(canonical(source.history[0].scene)!==canonical(expected)&&(!selected||canonical(source.history[0].scene)!==canonical(selected.scene)))throw Error('Steering changed prior artwork without a retained selection');
 }
 for(let i=0;i<source.history.length;i++){
  const r=source.history[i];validate(r.scene);
  if(!Number.isSafeInteger(r.revision)||r.revision<1||await digest(r.scene)!==r.digest||canonical(r.scene.criteria)!==canonical(source.project.brief.criteria))throw Error('Invalid source revision');
  if(i===0){if(r.revision!==1||r.parent!==null||canonical(r.changes)!=='[]')throw Error('Invalid history root');}
  else{const prior=source.history[i-1];const replay=await apply(prior,prior.digest,r.changes);if(canonical(replay)!==canonical(r))throw Error('Broken source lineage');}
 }
 if(!source.history.some(r=>canonical(r)===canonical(source.current)))throw Error('Current revision missing from history');
 await verifyMakerTrace(source.maker_trace,source.history);
 if(!Array.isArray(source.feedback)||source.feedback.length>STUDIO_SOURCE_FEEDBACK_LIMIT)throw Error('Invalid feedback');
 for(const f of source.feedback){const t=f?.subject;if(!t||typeof t.scene_id!=='string'||!Number.isSafeInteger(t.revision)||t.revision<1||!/^sha256:[a-f0-9]{64}$/.test(t.digest)||typeof t.element_id!=='string'||typeof f.note!=='string'||!f.note.trim()||f.note.length>4000)throw Error('Invalid feedback target');}
 if(source.merge_sources!==undefined){
  if(!Array.isArray(source.merge_sources)||source.merge_sources.length>100)throw Error('Invalid merge records');
  for(const record of source.merge_sources){
   if(record.schema!=='omega-source-merge-1'||record.assessment!=='unverified'||record.adopted!==false)throw Error('Invalid merge assessment');
   const incoming=await verifySource(record.incoming_source,depth+1);
   const retained=await verifySource({schema:'omega-studio-source-1',current:record.result_history?.at(-1),history:record.result_history,project:incoming.project,feedback:[]},depth+1);
   if(await digest(incoming)!==record.incoming_digest||!retained.history.some(r=>canonical(r)===canonical(record.common_baseline))||canonical(incoming.current)!==canonical(incoming.history.at(-1)))throw Error('Altered incoming merge source');
   const origin=incoming.history.findIndex(r=>canonical(r)===canonical(record.common_baseline));
   const result=retained.history.find(r=>r.digest===record.result_reference?.digest&&r.revision===record.result_reference?.revision&&r.scene.id===record.result_reference?.scene_id);
   const localOrigin=retained.history.findIndex(r=>canonical(r)===canonical(record.common_baseline));const resultIndex=retained.history.indexOf(result);
   if(origin<0||!result||mergeConflicts(retained.history.slice(localOrigin+1,resultIndex).flatMap(r=>r.changes),incoming.history.slice(origin+1).flatMap(r=>r.changes)).length||canonical(result.parent)!==canonical(record.local_reference)||canonical(result.changes)!==canonical(incoming.history.slice(origin+1).flatMap(r=>r.changes)))throw Error('Merge result differs from recorded incoming edits');
  }
 }
 return clone(source);
}
export function feedbackScope(comment,source,depth=0){
 if(depth>8)return 'source-not-retained';
 const t=comment.subject;
 const matches=r=>r.scene.id===t.scene_id&&r.revision===t.revision&&r.digest===t.digest;
 if(matches(source.current))return source.current.scene.elements.some(e=>e.id===t.element_id)?'current-revision':'missing-element';
 const retained=source.history.find(matches);
 if(retained)return retained.scene.elements.some(e=>e.id===t.element_id)?'earlier-or-other-revision':'missing-element';
 const direction=source.project.directions.find(d=>d.scene.id===t.scene_id&&t.revision===1&&d.scene_digest===t.digest);
 if(direction)return direction.scene.elements.some(e=>e.id===t.element_id)?'retained-direction':'missing-element';
 function searchMerges(branch,depth=0){
  if(depth>8)return null;
  for(const record of branch.merge_sources??[]){
   const retained=[...record.incoming_source.history,...record.result_history].find(matches);
   if(retained)return retained.scene.elements.some(e=>e.id===t.element_id)?'retained-merge-source':'missing-element';
   const nested=searchMerges(record.incoming_source,depth+1);if(nested)return nested;
  }
  return null;
 }
 const mergedScope=searchMerges(source);if(mergedScope)return mergedScope;
 const prior=source.brief_change?.source;
 if(prior){const scope=feedbackScope(comment,prior,depth+1);if(scope==='missing-element')return scope;if(scope!=='source-not-retained')return 'prior-brief-source';}
 return 'source-not-retained';
}

export function retainedFeedback(source,depth=0){
 if(depth>8)return [];
 const notes=clone(source.feedback??[]);
 for(const prior of [source.brief_change?.source,...(source.merge_sources??[]).map(r=>r.incoming_source)].filter(Boolean)){
  for(const note of retainedFeedback(prior,depth+1))if(!notes.some(n=>canonical(n)===canonical(note)))notes.push(note);
 }
 return notes;
}

// Merge only exact common history with disjoint element fields; no aesthetic verdict.
export async function mergeSources(localInput,incomingInput){
 const local=await verifySource(localInput),incoming=await verifySource(incomingInput);
 if(canonical(local.project)!==canonical(incoming.project))throw Error('Merge requires the same retained project and selection');
 if(canonical(local.current)!==canonical(local.history.at(-1))||canonical(incoming.current)!==canonical(incoming.history.at(-1)))throw Error('Merge requires latest active revisions; resolve undo/redo first');
 let shared=0;while(shared<Math.min(local.history.length,incoming.history.length)&&canonical(local.history[shared])===canonical(incoming.history[shared]))shared++;
 if(!shared)throw Error('Merge has no exact common baseline');
 const mine=local.history.slice(shared).flatMap(r=>r.changes),theirs=incoming.history.slice(shared).flatMap(r=>r.changes);
 if(!theirs.length)throw Error('Incoming source has no new edits');
 if(theirs.length>200)throw Error('Incoming merge exceeds 200 changes');
 const conflicts=mergeConflicts(mine,theirs);
 if(conflicts.length)return {status:'conflict',conflicts,local_reference:{scene_id:local.current.scene.id,revision:local.current.revision,digest:local.current.digest},incoming_reference:{scene_id:incoming.current.scene.id,revision:incoming.current.revision,digest:incoming.current.digest}};
 const merged=await apply(local.current,local.current.digest,theirs);
 const feedback=[...local.feedback];for(const note of incoming.feedback)if(!feedback.some(n=>canonical(n)===canonical(note)))feedback.push(note);
 const source={...local,current:merged,history:[...local.history,merged],feedback,merge_sources:[...(local.merge_sources??[]),{schema:'omega-source-merge-1',common_baseline:clone(local.history[shared-1]),result_history:clone([...local.history,merged]),local_reference:clone(merged.parent),result_reference:{scene_id:merged.scene.id,revision:merged.revision,digest:merged.digest},incoming_digest:await digest(incoming),incoming_source:incoming,assessment:'unverified',adopted:false}]};
 if(new TextEncoder().encode(JSON.stringify(source)).length>20*1024*1024)throw Error('Merged source exceeds 20 MB import bound');
 await verifySource(source);return {status:'merged',source};
}
