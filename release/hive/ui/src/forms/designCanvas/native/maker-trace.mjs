// Retained local execution trace. Byte integrity does not authenticate a maker.
import {canonical,digest} from './scene.mjs';
export const STUDIO_MAKER_TRACE_LIMIT=1000;
export const STUDIO_MAKER_TRACE_BYTES=3*1024*1024;
export async function verifyMakerTrace(trace,history){
 if(trace===undefined)return [];
 if(!Array.isArray(trace)||trace.length>STUDIO_MAKER_TRACE_LIMIT||new TextEncoder().encode(canonical(trace)).length>STUDIO_MAKER_TRACE_BYTES)throw Error('Bounded maker trace required');
 const seen=new Set();
 for(const entry of trace){
  if(!entry||Object.keys(entry).sort().join(',')!=='event,receipt')throw Error('Invalid maker trace entry');
  const {event,receipt:r}=entry;
  if(!r||r.schema!=='omega-local-maker-edit-1'||r.issuer_authentication!=='unverified'||r.adopted!==false||event?.stream_id!==r.stream_id||event?.sequence!==r.sequence||event?.scene_id!==r.before?.scene_id||await digest(event)!==r.event_digest)throw Error('Unbound maker trace');
  const key=canonical([r.stream_id,r.sequence]);if(seen.has(key))throw Error('Duplicate maker trace sequence');seen.add(key);
  const locate=ref=>history.findIndex(h=>h.scene.id===ref?.scene_id&&h.revision===ref?.revision&&h.digest===ref?.digest);
  const before=locate(r.before),after=locate(r.after);
  if(before<0||after!==before+1)throw Error('Maker trace revision not retained');
  if(!Array.isArray(event.changes)||!event.changes.length||event.changes.length>20)throw Error('Invalid traced event');
  const targets=new Set(),changes=[];
  for(const c of event.changes){
   if(!c||targets.has(c.element))throw Error('Ambiguous traced event');targets.add(c.element);
   const element=history[before].scene.elements.find(e=>e.id===c.element);
   if(c.op==='add'){
    if(c.before!==null||element||c.value?.id!==c.element)throw Error('Invalid traced addition');
    changes.push({op:'add',element:c.element,value:c.value});
   }else if(c.op==='set'){
    if(!element||!c.before||!c.patch||canonical(Object.keys(c.before).sort())!==canonical(Object.keys(c.patch).sort()))throw Error('Invalid traced preconditions');
    for(const field of Object.keys(c.patch))if(canonical(element[field])!==canonical(c.before[field]))throw Error('Traced precondition differs');
    changes.push({op:'set',element:c.element,patch:c.patch});
   }else throw Error('Unsupported traced operation');
  }
  if(canonical(changes)!==canonical(history[after].changes))throw Error('Trace differs from applied edits');
 }
 return structuredClone(trace);
}
export function retainedMakerTrace(trace,history){return trace.filter(e=>history.some(h=>h.scene.id===e.receipt.after.scene_id&&h.revision===e.receipt.after.revision&&h.digest===e.receipt.after.digest));}
