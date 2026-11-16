// Creative alternatives and identity are proposals; adoption belongs to Hive.
import {clone,canonical,digest,validate,validFontFamily} from './scene.mjs';
export async function createProject(brief) {
  if (!brief || typeof brief.id !== 'string' || typeof brief.purpose !== 'string' || !brief.purpose.trim() || typeof brief.audience !== 'string' || !brief.audience.trim() || !Array.isArray(brief.criteria) || !brief.criteria.length || brief.criteria.some(c=>typeof c!=='string'||!c.trim())) throw Error('A project needs purpose, audience and criteria');
  return {schema:'omega-creative-project-1',brief:clone(brief),brief_digest:await digest(brief),directions:[],selection:null};
}
export async function proposeDirection(project, {id,label,rationale,scene,identity=null}) {
  if (await digest(project.brief)!==project.brief_digest) throw Error('Brief changed; reassessment required');
  if (typeof id!=='string'||!id||project.directions.some(d=>d.id===id)||typeof label!=='string'||!label.trim()||typeof rationale!=='string'||!rationale.trim()) throw Error('Invalid direction');
  validate(scene);
  if(canonical(scene.criteria)!==canonical(project.brief.criteria)) throw Error('Direction lost brief criteria');
  if(identity) validateIdentity(identity);
  const d={id,label,rationale,scene:clone(scene),scene_digest:await digest(scene),brief_digest:project.brief_digest,identity:identity?{id:identity.id,revision:identity.revision,digest:await digest(identity)}:null,assessment:'unverified'};
  return {...clone(project),directions:[...clone(project.directions),d]};
}
export async function selectDirection(project, id, reason) {
  const direction=project.directions.find(d=>d.id===id);
  if(!direction||typeof reason!=='string'||!reason.trim())throw Error('Select a retained direction and explain why');
  if(await digest(project.brief)!==project.brief_digest||await digest(direction.scene)!==direction.scene_digest||direction.brief_digest!==project.brief_digest) throw Error('Selection refers to altered work');
  return {...clone(project),selection:{direction_id:id,scene_digest:direction.scene_digest,brief_digest:project.brief_digest,reason,status:'local-selection-not-adoption'}};
}
export function validateIdentity(identity) {
  if(!identity||typeof identity.id!=='string'||!identity.id||!Number.isSafeInteger(identity.revision)||identity.revision<1||!Array.isArray(identity.exemplars)||!identity.exemplars.length||identity.exemplars.some(e=>typeof e!=='string'||!e.trim())||!identity.tokens||!Array.isArray(identity.voice)||identity.voice.some(e=>typeof e!=='string'))throw Error('Identity needs version, tokens, voice and source exemplars');
  for(const [name,color] of Object.entries(identity.tokens))if(!name||!/^#[a-fA-F0-9]{6}$/.test(color))throw Error('Invalid colour token');
  if(identity.fonts!==undefined){if(!identity.fonts||Array.isArray(identity.fonts)||typeof identity.fonts!=='object'||Object.entries(identity.fonts).some(([name,font])=>!name||!validFontFamily(font)))throw Error('Invalid identity font token');}
  return clone(identity);
}
export async function identityImpact(project, changedIdentity) {
  validateIdentity(changedIdentity);
  const latest=await digest(changedIdentity);
  return project.directions.filter(d=>d.identity?.id===changedIdentity.id&&d.identity.digest!==latest).map(d=>({direction_id:d.id,used_identity:clone(d.identity),proposed_identity:{id:changedIdentity.id,revision:changedIdentity.revision,digest:latest},status:'reassessment-needed'}));
}
export function relations(project) {
  // Derived inspectable relations only; this is neither an authority registry nor an evaluator.
  const facts=[['Brief',project.brief.id,project.brief_digest],['Purpose',project.brief_digest,project.brief.purpose],['Audience',project.brief_digest,project.brief.audience]];
  project.brief.criteria.forEach((c,i)=>facts.push(['Criterion',project.brief_digest,i,c]));
  for(const d of project.directions){facts.push(['Alternative',project.brief_digest,d.id,d.scene_digest],['Rationale',d.scene_digest,d.rationale],['Assessment',d.scene_digest,'unverified']);if(d.identity)facts.push(['IdentityDependency',d.scene_digest,d.identity.id,d.identity.revision,d.identity.digest]);}
  if(project.selection)facts.push(['LocalSelection',project.selection.direction_id,project.selection.scene_digest,project.selection.reason]);
  return facts.map(([relation,...values])=>'('+relation+' '+values.map(v=>typeof v==='number'?v:JSON.stringify(v)).join(' ')+')').join('\n')+'\n';
}

export async function verifyProject(project) {
  if(project?.schema!=='omega-creative-project-1'||await digest(project.brief)!==project.brief_digest||!Array.isArray(project.directions))throw Error('Invalid retained project');
  await createProject(project.brief);
  const seen=new Set();
  for(const d of project.directions){validate(d.scene);if(seen.has(d.id)||typeof d.label!=='string'||typeof d.rationale!=='string'||await digest(d.scene)!==d.scene_digest||d.brief_digest!==project.brief_digest||canonical(d.scene.criteria)!==canonical(project.brief.criteria))throw Error('Altered retained direction');seen.add(d.id);if(d.identity_source){validateIdentity(d.identity_source);if(!d.identity||d.identity.digest!==await digest(d.identity_source)||d.identity.id!==d.identity_source.id||d.identity.revision!==d.identity_source.revision)throw Error('Altered retained identity');}}
  for(const d of project.directions){if(d.derivation){
    const derivation=d.derivation,source=project.directions.find(s=>s.id===derivation.source_direction);
    if(derivation.kind!=='explicit-identity-reuse'||!d.identity_source||!source||source.id===d.id||source.scene_digest!==derivation.source_digest)throw Error('Invalid identity derivation source');
    const replay=applyIdentityBindings(source.scene,d.identity_source,derivation.bindings);
    if(canonical(replay)!==canonical(d.scene))throw Error('Identity derivation differs from retained scene');
  }}
  if(project.selection){const chosen=project.directions.find(d=>d.id===project.selection.direction_id);if(!chosen||chosen.scene_digest!==project.selection.scene_digest||project.selection.brief_digest!==project.brief_digest||typeof project.selection.reason!=='string')throw Error('Invalid retained selection');}
  return clone(project);
}

function applyIdentityBindings(source,identity,bindings){
 if(!Array.isArray(bindings)||!bindings.length||bindings.length>200)throw Error('Explicit token bindings required');
 const scene=clone(source);const used=new Set();
 for(const binding of bindings){
  const tokens=binding?.field==='fontFamily'?(identity.fonts??{}):identity.tokens;
  if(!binding||typeof binding.token!=='string'||!Object.hasOwn(tokens,binding.token))throw Error('Unknown identity token');
  const key=JSON.stringify([binding.element??null,binding.field]);if(used.has(key))throw Error('Duplicate identity binding');used.add(key);
  if(binding.element===null&&binding.field==='background')scene.background=identity.tokens[binding.token];
  else{const element=scene.elements.find(e=>e.id===binding.element);const field=element?.kind==='text'?(binding.field==='fontFamily'?'fontFamily':'color'):element?.kind==='rect'?'fill':null;if(!field||binding.field!==field)throw Error('Unsupported identity binding');element[field]=tokens[binding.token];}
 }
 validate(scene);return scene;
}

// Explicit token bindings create a new alternative; original work remains retained.
export async function reuseIdentity(project,{source_direction,expected_digest,identity,bindings,id,label,rationale}){
 await verifyProject(project);validateIdentity(identity);
 const original=project.directions.find(d=>d.id===source_direction);
 if(!original||original.scene_digest!==expected_digest)throw Error('Identity reuse requires the exact retained direction');
 const scene=applyIdentityBindings(original.scene,identity,bindings);
 validate(scene);
 const next=await proposeDirection(project,{id,label,rationale,scene,identity});
 const direction=next.directions.at(-1);direction.identity_source=clone(identity);direction.derivation={kind:'explicit-identity-reuse',source_direction,source_digest:expected_digest,bindings:clone(bindings),voice_assessment:'unverified'};
 return next;
}
