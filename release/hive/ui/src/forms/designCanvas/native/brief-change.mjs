// Exact retained creative work survives steering; prior judgments do not transfer.
import {createProject,verifyProject} from './project.mjs';
import {clone,digest,canonical} from './scene.mjs';
export async function changeBrief(project,brief,reason){
 await verifyProject(project);
 if(typeof reason!=='string'||!reason.trim()||reason.length>4000)throw Error('Explain the brief change');
 if(brief?.id!==project.brief.id)throw Error('Brief change must remain in the same project');
 const next=await createProject(brief);
 if(next.brief_digest===project.brief_digest)throw Error('Brief is unchanged');
 const before=project.brief.criteria,after=brief.criteria;
 if(new Set(before).size!==before.length||new Set(after).size!==after.length)throw Error('Unique criteria required');
 const delta={purpose_changed:brief.purpose!==project.brief.purpose,audience_changed:brief.audience!==project.brief.audience,
  retained_criteria:before.filter(c=>after.includes(c)),removed_criteria:before.filter(c=>!after.includes(c)),added_criteria:after.filter(c=>!before.includes(c))};
 return {schema:'omega-project-brief-change-1',before:clone(project),before_digest:await digest(project),after:next,
  reason,delta,retained_work:project.directions.map(d=>({direction_id:d.id,scene_digest:d.scene_digest,brief_digest:d.brief_digest,status:'reassessment-required'})),
  previous_selection:clone(project.selection),adopted:false};
}
export async function verifyBriefChange(record){
 if(record?.schema!=='omega-project-brief-change-1'||record.adopted!==false||await digest(record.before)!==record.before_digest)throw Error('Brief change custody differs');
 const replay=await changeBrief(record.before,record.after?.brief,record.reason);
 if(canonical(record)!==canonical(replay))throw Error('Brief change differs from retained transition');
 return clone(record);
}
