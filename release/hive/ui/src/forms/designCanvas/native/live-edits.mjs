// Local receiver for incremental maker proposals. Host authenticates transport.
// No model calls, grants, effects, or inferred adoption.
import {apply,canonical,clone,digest} from './scene.mjs';
export function liveEdits({streamId,sceneId}){
 if(typeof streamId!=='string'||!streamId||streamId.length>128||typeof sceneId!=='string'||!sceneId)throw Error('Exact stream and scene required');
 let next=1,paused=false,closed=false,inFlight=false,controlEpoch=0,retainedBytes=0;const seen=new Map();
 return {
  pause(){paused=true;controlEpoch++;},resume(){if(closed)throw Error('Stream closed');paused=false;},close(){closed=true;controlEpoch++;},
  state(){return {streamId,sceneId,next,paused,closed};},
  async receive(current,event,{commit}={}){
   if(closed)throw Error('Stream closed');
   if(!event||Object.keys(event).some(k=>!['stream_id','scene_id','sequence','changes'].includes(k))||event.stream_id!==streamId||event.scene_id!==sceneId||current.scene.id!==sceneId||!Number.isInteger(event.sequence)||event.sequence<1)throw Error('Wrong stream binding');
   if(!Array.isArray(event.changes)||!event.changes.length||event.changes.length>20||canonical(event).length>128*1024)throw Error('Bounded incremental changes required');
   const encoded=canonical(event);
   if(seen.has(event.sequence)){if(seen.get(event.sequence).encoded!==encoded)throw Error('Sequence payload differs');return {status:'duplicate',current,receipt:clone(seen.get(event.sequence).receipt)};}
   if(paused)throw Error('Stream paused');
   if(event.sequence!==next||next>1000)throw Error('Sequence gap or stream limit');
   const eventBytes=new TextEncoder().encode(encoded).length;
   if(retainedBytes+eventBytes>2*1024*1024)throw Error('Stream receipt byte limit');
   const epoch=controlEpoch;
   const changes=[];
   const targets=new Set();
   for(const c of event.changes){
    if(!c||targets.has(c.element))throw Error('One change per element per event required');targets.add(c.element);
    if(c.op==='add'){
     if(Object.keys(c).some(k=>!['op','element','before','value'].includes(k))||c.before!==null||!c.value||c.value.id!==c.element)throw Error('Absent element precondition required');
     if(current.scene.elements.some(e=>e.id===c.element))throw Error('User element conflicts with maker addition');
     changes.push({op:'add',element:c.element,value:clone(c.value)});continue;
    }
    if(c.op!=='set'||!c.before||!c.patch||Object.keys(c).some(k=>!['op','element','before','patch'].includes(k))||canonical(Object.keys(c.before).sort())!==canonical(Object.keys(c.patch).sort()))throw Error('Exact field preconditions required');
    const element=current.scene.elements.find(e=>e.id===c.element);if(!element)throw Error('Element removed');
    for(const field of Object.keys(c.patch))if(canonical(element[field])!==canonical(c.before[field]))throw Error('User edit conflicts with maker proposal: '+c.element+'/'+field);
    changes.push({op:'set',element:c.element,patch:clone(c.patch)});
   }
   if(inFlight)throw Error('Another event is applying');
   inFlight=true;
   try{
    const updated=await apply(current,current.digest,changes);
    const eventDigest=await digest(JSON.parse(encoded));
    const reference=r=>({scene_id:r.scene.id,revision:r.revision,digest:r.digest});
    const receipt={schema:'omega-local-maker-edit-1',stream_id:streamId,sequence:event.sequence,event_digest:eventDigest,before:reference(current),after:reference(updated),issuer_authentication:'unverified',adopted:false};
    if(paused||closed||epoch!==controlEpoch)throw Error('Stream paused or closed during apply');
    if(commit!==undefined){
     if(typeof commit!=='function')throw Error('Synchronous canvas commit required');
     if(commit(updated,current)!==true)throw Error('Canvas changed before commit');
    }
    seen.set(next,{encoded,receipt});retainedBytes+=eventBytes;next++;return {status:'applied',current:updated,receipt:clone(receipt)};
   }finally{inFlight=false;}
  }
 };
}
