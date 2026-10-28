const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const hostOrigin = document.documentElement.dataset.flowHostOrigin || location.origin;
const hostChannel = document.documentElement.dataset.flowChannel || null;
const hosted = !!hostChannel || new URL(import.meta.url).pathname.includes('/flow-studio/');
const bridgePending = new Map();
let hostContext=null,hostRevision=null,hostRun=null,hostList=[];
function hostCall(operation,params={}){
  if(!hosted)return Promise.reject(new Error('Open Flow in a connected Hive to use stored revisions.'));
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();const timeout=setTimeout(()=>{bridgePending.delete(id);reject(new Error('Hive connection timed out'));},15000);
    bridgePending.set(id,{resolve,reject,timeout});
    parent.postMessage({type:'omegaflow-request',id,operation,params,channel:hostChannel},hostOrigin);
  });
}
window.addEventListener('message',ev=>{
  if(!hosted||ev.source!==parent||ev.origin!==hostOrigin||ev.data?.channel!==hostChannel)return;
  if(ev.data?.type==='omegaflow-context'){hostContext=ev.data.context;renderHost();return;}
  if(ev.data?.type!=='omegaflow-response')return;
  const pending=bridgePending.get(ev.data.id);if(!pending)return;
  clearTimeout(pending.timeout);bridgePending.delete(ev.data.id);
  if(ev.data.error)pending.reject(new Error(ev.data.error));else pending.resolve(ev.data.result);
});
let body, layout = {}, selected = null, validation = null, busy = false, connectFrom = null;
let history = [], future = [], view = {x: 0, y: 0, width: 1200, height: 740};
const copy = (v) => JSON.parse(JSON.stringify(v));
const snapshot = () => ({body: copy(body), layout: copy(layout), selected});
const note = (message) => { $('notice').textContent = message; };
function label(e) { return typeof e.props.label === 'string' ? e.props.label : e.id; }
function el(tag, attrs = {}, text = '') {
  const n = document.createElementNS(NS, tag);
  for (const [k,v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text) n.textContent = text;
  return n;
}
function dom(tag, text, parent) {
  const n = document.createElement(tag); if (text !== undefined) n.textContent = text;
  if (parent) parent.append(n); return n;
}
async function check(candidate) {
  if(hosted)return hostCall('validate',candidate);
  const r = await fetch('/api/validate', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(candidate)});
  const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Validation failed'); return data;
}
async function commit(candidate, message = 'Revision updated', selection = selected) {
  if (busy) {note('Checking previous edit…'); return false;}
  busy = true;
  try {
    const result = await check(candidate);
    if (body) {history.push(snapshot()); if(history.length > 80) history.shift(); future = [];}
    body = result.revision.body; layout = result.revision.layout; validation = result; selected = selection;
    render(); note(message); return true;
  } catch(e) {note(e.message); return false;}
  finally {busy = false;}
}
function position(e) {
  if (layout[e.id]) return layout[e.id];
  const index = body.elements.filter(x => x.kind !== 'transition').findIndex(x => x.id === e.id);
  return {x: 130 + (index % 4) * 265, y: 170 + Math.floor(index / 4) * 170};
}
function initialLayout(f) {
  const points = {
    visitor: [120,170], signup: [410,170], review: [700,170], welcome: [990,170],
    garden: [340,560], role: [640,560], person: [930,430],
    volunteers: [370,380], attests: [690,390], submitted: [190,690], accepted: [510,690]
  };
  const out = {};
  f.elements.filter(e => e.kind !== 'transition').forEach((e,i) => {
    const p = points[e.id] || [130 + i % 4 * 265, 170 + Math.floor(i/4)*170]; out[e.id] = {x:p[0], y:p[1]};
  }); return out;
}
function runState(e){return hostRun&&validation&&hostRun.digest==='sha256:'+validation.revision.digest?hostRun.steps.find(s=>s.transition_id===e.id)?.status:null;}
function renderCanvas() {
  $('canvas').setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
  $('edges').replaceChildren(); $('objects').replaceChildren();
  const map = new Map(body.elements.map(e => [e.id, e]));
  for (const e of body.elements) {
    if (e.kind === 'transition') {
      const a = position(map.get(e.from)), b = position(map.get(e.to));
      const dx = b.x-a.x, dy=b.y-a.y, size=Math.hypot(dx,dy)||1;
      const start={x:a.x+dx/size*88,y:a.y+dy/size*35}, end={x:b.x-dx/size*88,y:b.y-dy/size*35};
      const path = el('path', {d:`M${start.x},${start.y} L${end.x},${end.y}`,class:`edge ${selected===e.id?'selected':''}`,'marker-end':'url(#arrow)', 'data-id':e.id});
      const hit = el('path', {d:path.getAttribute('d'),fill:'none',stroke:'transparent','stroke-width':20, 'data-id':e.id});
      path.addEventListener('click',()=>select(e.id)); hit.addEventListener('click',()=>select(e.id));
      const text=el('text',{x:(a.x+b.x)/2,y:(a.y+b.y)/2-14,'text-anchor':'middle',class:'edge-label','data-id':e.id},e.approver?'approval →':label(e)+(runState(e)?' · '+runState(e):''));
      text.addEventListener('click',()=>select(e.id)); $('edges').append(path,hit,text);
    }
    if (e.kind === 'relation') {
      const a=position(e);
      e.roles.forEach(role=>{
        const b=position(map.get(role.member));
        $('edges').append(el('path',{d:`M${a.x},${a.y} L${b.x},${b.y}`,class:'edge spoke'}));
        $('edges').append(el('text',{x:(a.x+b.x)/2,y:(a.y+b.y)/2-8,'text-anchor':'middle',class:'role-label'},role.name));
      });
    }
  }
  for (const e of body.elements.filter(e=>e.kind!=='transition')) {
    const p=position(e), w=e.kind==='relation'?150:192, h=e.kind==='relation'?62:88;
    const g=el('g',{transform:`translate(${p.x},${p.y})`,class:`object ${e.kind} ${selected===e.id?'selected':''}`,tabindex:0,role:'button','aria-label':`${e.kind}: ${label(e)}`,'data-id':e.id});
    g.append(el('rect',{x:-w/2,y:-h/2,width:w,height:h,rx:e.kind==='relation'?24:9}));
    g.append(el('text',{x:0,y:-h/2+20,'text-anchor':'middle',class:'kind-text'},e.kind.toUpperCase()));
    g.append(el('text',{x:0,y:e.kind==='relation'?10:1,'text-anchor':'middle',class:'label'},label(e).length>(e.kind==='relation'?18:23)?label(e).slice(0,e.kind==='relation'?16:21)+'…':label(e)));
    if(e.kind!=='relation') g.append(el('text',{x:0,y:24,'text-anchor':'middle',class:'subtitle'},`${e.meta.revision_state} · ${e.meta.origin}`));
    g.addEventListener('pointerdown',ev=>startDrag(ev,e));
    g.addEventListener('keydown',ev=>objectKey(ev,e));
    g.addEventListener('click',()=>select(e.id)); $('objects').append(g);
  }
}
function select(id) {
  if (connectFrom !== null) {
    const e=body.elements.find(x=>x.id===id);
    if(!['node','subflow'].includes(e.kind)){note('Choose an object or subflow as the destination.');return;}
    if(id===connectFrom){note('Choose a different destination.');return;}
    addTransition(connectFrom,id); connectFrom=null; $('connect').setAttribute('aria-pressed','false'); return;
  }
  selected=id; renderCanvas(); renderInspector(); renderList();
}
let drag=null;
function canvasPoint(ev) {
  return new DOMPoint(ev.clientX,ev.clientY).matrixTransform($('canvas').getScreenCTM().inverse());
}
function startDrag(ev,e) {
  if(busy||connectFrom!==null||ev.button!==0) return;
  ev.preventDefault(); selected=e.id; const p=canvasPoint(ev); const current=position(e);
  drag={id:e.id,x:p.x,y:p.y,start:copy(current),before:snapshot(),moved:false};
  $('canvas').setPointerCapture(ev.pointerId); renderInspector(); renderList();
}
$('canvas').addEventListener('pointermove',ev=>{
  if(!drag)return; const p=canvasPoint(ev);
  const dx=p.x-drag.x,dy=p.y-drag.y; if(Math.abs(dx)+Math.abs(dy)>2) drag.moved=true;
  layout[drag.id]={x:Math.round(drag.start.x+dx),y:Math.round(drag.start.y+dy)};renderCanvas();
});
function finishDrag(){
  if(!drag)return;
  if(drag.moved){history.push(drag.before);future=[];note('Layout updated · semantic fingerprint unchanged');}
  drag=null; renderButtons();
}
$('canvas').addEventListener('pointerup',finishDrag); $('canvas').addEventListener('pointercancel',finishDrag);
function objectKey(ev,e){
  if(['Enter',' '].includes(ev.key)){ev.preventDefault();select(e.id);return;}
  const shifts={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
  if(!shifts[ev.key]||busy)return;ev.preventDefault();history.push(snapshot());future=[];selected=e.id;
  const p=position(e),delta=shifts[ev.key],step=ev.shiftKey?40:10;layout[e.id]={x:p.x+delta[0]*step,y:p.y+delta[1]*step};renderCanvas();renderButtons();[...$('objects').children].find(n=>n.dataset.id===e.id)?.focus();note('Object moved · layout only');
}
$('canvas').addEventListener('wheel',ev=>{
  ev.preventDefault();const p=canvasPoint(ev),scale=ev.deltaY>0?1.12:.89;
  const w=Math.max(400,Math.min(3000,view.width*scale)),ratio=w/view.width;
  view={x:p.x-(p.x-view.x)*ratio,y:p.y-(p.y-view.y)*ratio,width:w,height:view.height*ratio};renderCanvas();
},{passive:false});
function renderButtons(){$('undo').disabled=!history.length;$('redo').disabled=!future.length;}
function renderList(){
  $('element-list').replaceChildren();$('list-count').textContent=`(${body.elements.length})`;
  body.elements.forEach(e=>{
    const b=dom('button',label(e),$('element-list'));b.className=e.id===selected?'selected':'';b.dataset.id=e.id;
    dom('span',e.kind,b).className='kind';b.addEventListener('click',()=>select(e.id));
  });
}
function field(parent,name,value,options){
  const label=dom('label',name,parent);label.className='field';
  const input=dom(options?'select':'input',undefined,label);input.setAttribute('aria-label',name);
  if(options) options.forEach(v=>{const o=dom('option',v,input);o.value=v;});input.value=value;return input;
}
function renderInspector(){
  const host=$('inspector');host.replaceChildren();const e=body.elements.find(x=>x.id===selected);
  $('selection-title').textContent=e?label(e):'Select an object';
  if(!e){dom('p','Choose an object, relation or transition on the canvas to edit its meaning.',host).className='muted small';return;}
  const badges=dom('div',undefined,host);dom('span',e.kind,badges).className='badge';dom('span',e.meta.revision_state,badges).className='badge';
  const id=field(host,'Stable identity',e.id);id.readOnly=true;
  const name=field(host,'Display name',label(e));
  const origin=field(host,'Epistemic origin',e.meta.origin,['asserted','host-record','inferred']);
  const adoption=field(host,'Revision state',e.meta.revision_state,['draft','proposed','adopted','superseded']);
  dom('p',`Runtime: ${runState(e)||e.meta.runtime_state}. Adoption here is descriptive; the host owns activation.`,host).className='muted small';
  const editors = {};
  const item = (key, title, value, options) => {editors[key] = field(host,title,value,options);};
  if(['node','relation','event'].includes(e.kind))item('type','Semantic type',e.type);
  if(e.kind==='node'){
    item('ref','Identity reference',e.ref||'');
    item('control','Control step',e.props.control_step===true?'yes':'no',['yes','no']);
  }
  if(e.kind==='transition'){
    const targets=body.elements.filter(x=>['node','subflow'].includes(x.kind)).map(x=>x.id);
    const events=body.elements.filter(x=>x.kind==='event').map(x=>x.id);
    const people=body.elements.filter(x=>x.kind==='node').map(x=>x.id);
    item('from','From',e.from,targets);item('to','To',e.to,targets);item('trigger','Trigger event',e.trigger,events);
    item('actionKind','Action kind',e.action.kind,['goal','request','program_action','message']);
    item('target','Action target',e.action.target);
    item('approval','Requires approval',e.props.requires_approval===true?'yes':'no',['yes','no']);
    item('approver','Approver',e.approver||'', ['',...people]);
    dom('p','Guards and action parameters can be edited in the typed JSON below.',host).className='muted small';
  }
  if(e.kind==='subflow'){item('flowId','Referenced flow',e.flow_id);item('pin','Revision digest',e.revision_digest);}
  if(e.kind==='constraint')item('predicate','Constraint predicate',e.predicate,['all-present','distinct-members']);
  const save=dom('button','Save properties',host);
  save.addEventListener('click',()=>{
    const next=copy(body),edited=next.elements.find(x=>x.id===e.id);
    edited.props.label=name.value;edited.meta.origin=origin.value;edited.meta.revision_state=adoption.value;
    if(editors.type)edited.type=editors.type.value;
    if(editors.ref){edited.ref=editors.ref.value||null;edited.props.control_step=editors.control.value==='yes';}
    if(editors.from){
      edited.from=editors.from.value;edited.to=editors.to.value;edited.trigger=editors.trigger.value;
      edited.action.kind=editors.actionKind.value;edited.action.target=editors.target.value;
      edited.approver=editors.approver.value||null;edited.props.requires_approval=editors.approval.value==='yes';
    }
    if(editors.flowId){edited.flow_id=editors.flowId.value;edited.revision_digest=editors.pin.value;}
    if(editors.predicate)edited.predicate=editors.predicate.value;
    commit({body:next,layout:copy(layout)},'Properties saved');
  });
  const labelBox=dom('label','Typed element JSON',host);labelBox.className='field';
  const json=dom('textarea',undefined,labelBox);json.id='element-json';json.spellcheck=false;json.value=JSON.stringify(e,null,2);json.setAttribute('aria-label','Typed element JSON');
  const actions=dom('div',undefined,host);actions.className='inspector-actions';
  const apply=dom('button','Apply JSON',actions);apply.id='apply-json';apply.addEventListener('click',()=>{
    try{const value=JSON.parse(json.value);if(value.id!==e.id)throw new Error('Stable identity cannot be renamed here.');
      const next=copy(body);next.elements[next.elements.findIndex(x=>x.id===e.id)]=value;commit({body:next,layout:copy(layout)},'Typed element updated');
    }catch(err){note(err.message);}
  });
  const remove=dom('button','Remove',actions);remove.className='danger';remove.addEventListener('click',()=>removeElement(e));
  if(e.kind==='relation'){
    dom('p','Add a role to connect another object or relation.',host).className='muted small';
    const role=field(host,'Role name','participant');
    const members=body.elements.filter(x=>['node','relation','subflow'].includes(x.kind)).map(x=>x.id);
    const member=field(host,'Member',members[0],members);const add=dom('button','Add role',host);add.id='add-role';
    add.addEventListener('click',()=>{const next=copy(body);next.elements.find(x=>x.id===e.id).roles.push({name:role.value,member:member.value});commit({body:next,layout:copy(layout)},'Relation role added');});
  }
}
function removeElement(e){
  if(e.id===body.entry){note('Choose a different entry in an imported revision before removing this object.');return;}
  const next=copy(body);next.elements=next.elements.filter(x=>x.id!==e.id);const nextLayout=copy(layout);delete nextLayout[e.id];
  commit({body:next,layout:nextLayout},'Element removed',null); // dangling refs refused by authoritative model
}
function render(){
  renderHost();
  $('flow-title').textContent=body.id==='synthetic:garden-signup'?'Garden volunteer sign-up':body.id;
  $('element-count').textContent=`${body.elements.length} elements · schema 1`;
  $('digest').textContent=validation.revision.digest;
  $('checks').replaceChildren();
  if(!validation.check.findings.length)dom('p','✓ Structural checks passed',$('checks')).className='success';
  validation.check.findings.forEach(f=>{const b=dom('button',`${f.code} · ${f.element}`,$('checks'));b.className='check-item';b.addEventListener('click',()=>select(f.element));});
  renderCanvas();renderInspector();renderList();renderButtons();
}
function base(id,kind,fields){return {id,kind,props:{},meta:{origin:'asserted',confidence:null,evidence:[],revision_state:'draft',runtime_state:'idle'},...fields};}
function unique(prefix){let i=1;while(body.elements.some(e=>e.id===`${prefix}-${i}`))i++;return `${prefix}-${i}`;}
async function add(kind){
  if(busy)return;
  const next=copy(body),id=unique(kind),nodes=next.elements.filter(e=>['node','subflow'].includes(e.kind));let fields={};
  if(kind==='node')fields={type:'object',ref:null};
  if(kind==='event')fields={type:'synthetic.event'};
  if(kind==='relation'){
    const source=next.elements.find(e=>e.id===selected&&['node','relation','subflow'].includes(e.kind))||nodes[0];
    fields={type:'related-to',roles:[{name:'subject',member:source.id}]};
  }
  if(kind==='constraint')fields={predicate:'all-present',members:[nodes[0].id]};
  if(kind==='subflow')fields={flow_id:'draft:subflow',revision_digest:'0'.repeat(64)};
  const e=base(id,kind,fields);e.props.label=`New ${kind}`;next.elements.push(e);
  const newLayout=copy(layout);newLayout[id]={x:view.x+view.width/2,y:view.y+view.height/2};
  await commit({body:next,layout:newLayout},kind==='subflow'?'Placeholder subflow added · replace its revision digest before host admission':`${kind} added`,id);
}
for(const kind of ['node','relation','event','constraint','subflow'])$(`add-${kind}`).addEventListener('click',()=>add(kind));
$('connect').addEventListener('click',()=>{
  if(connectFrom!==null){connectFrom=null;$('connect').setAttribute('aria-pressed','false');note('Transition mode cancelled');return;}
  const e=body.elements.find(x=>x.id===selected);
  if(!e||!['node','subflow'].includes(e.kind)){note('Select a source object first, then choose Transition.');return;}
  connectFrom=e.id;$('connect').setAttribute('aria-pressed','true');note('Choose the destination object');
});
function addTransition(from,to){
  const next=copy(body),id=unique('transition');let event=next.elements.find(e=>e.kind==='event');
  if(!event){event=base(unique('event'),'event',{type:'synthetic.event'});next.elements.push(event);}
  next.elements.push(base(id,'transition',{from,to,trigger:event.id,guards:[],approver:null,action:{kind:'goal',target:'draft:choose-target',params:{}}}));
  commit({body:next,layout:copy(layout)},'Transition added · inspect its trigger and action target',id);
}
async function restore(source,destination){
  if(busy||!source.length)return;busy=true;
  try{const state=source[source.length-1],result=await check({body:state.body,layout:state.layout});
    destination.push(snapshot());source.pop();body=result.revision.body;layout=result.revision.layout;validation=result;selected=state.selected;
    render();note('History restored');
  }catch(e){note(e.message);}finally{busy=false;}
}
$('undo').addEventListener('click',()=>restore(history,future));$('redo').addEventListener('click',()=>restore(future,history));
function fit(){
  const ps=body.elements.filter(e=>e.kind!=='transition').map(position);
  const left=Math.min(...ps.map(p=>p.x))-140,top=Math.min(...ps.map(p=>p.y))-90;
  const right=Math.max(...ps.map(p=>p.x))+140,bottom=Math.max(...ps.map(p=>p.y))+110;
  view={x:left,y:top,width:Math.max(600,right-left),height:Math.max(400,bottom-top)};renderCanvas();
}
$('fit').addEventListener('click',fit);
$('new-flow').addEventListener('click',async()=>{
  const start=base('start','node',{type:'step',ref:null});start.props.control_step=true;start.props.label='Start';
  const next={schema:'omegaflow/1',id:'draft:'+Date.now(),entry:'start',elements:[start]};
  if(await commit({body:next,layout:{start:{x:350,y:300}}},'New flow draft · previous edits available in Undo',null))fit();
});
$('export').addEventListener('click',async()=>{
  if(busy)return;
  try{
    const result=await check({body,layout});
    const blob=new Blob([JSON.stringify(result.revision,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob);
    const a=dom('a');a.href=url;a.download='omegaflow-revision.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);note('Revision exported with layout and semantic fingerprint');
  }catch(e){note(e.message);}
});
$('import').addEventListener('change',async(ev)=>{
  const file=ev.target.files[0];if(!file)return;
  try{
    if(file.size>300000)throw new Error('Import exceeds size limit');const value=JSON.parse(await file.text());
    if(!value.body||!value.layout)throw new Error('Import requires a revision body and layout');
    const result=await check({body:value.body,layout:value.layout});
    if(value.digest&&value.digest!==result.revision.digest)throw new Error('Imported semantic fingerprint does not match body');
    if(await commit({body:value.body,layout:value.layout},'Revision imported',null))fit();
  }catch(e){note(e.message);}ev.target.value='';
});
$('show-atoms').addEventListener('click',()=>{$('atoms').textContent=validation.atoms.join('\n');$('atoms-dialog').showModal();});
$('close-atoms').addEventListener('click',()=>$('atoms-dialog').close());
try{
  if(hosted)parent.postMessage({type:'omegaflow-ready',channel:hostChannel},hostOrigin);
  const value=hosted?await hostCall('example'):await fetch('/api/example').then(r=>{if(!r.ok)throw new Error('Example unavailable');return r.json();});value.layout=initialLayout(value.body);
  await commit(value,'Local draft ready · execution is not active',null);fit();
}catch(e){note(e.message);}


function renderHost(){
  let panel=$('host-panel');
  if(!hosted||!hostContext)return;
  if(!panel){panel=dom('details',undefined,document.querySelector('aside'));panel.id='host-panel';panel.open=true;}
  const oldSwarm=panel.querySelector('select')?.value;panel.replaceChildren();dom('summary','Hive revisions & runs',panel);
  const swarms=hostContext.swarms||[];
  const selector=field(panel,'Flow swarm',oldSwarm||swarms[0]?.id||'',swarms.map(s=>s.id));selector.id='flow-swarm';
  for(const option of selector.options)option.textContent=swarms.find(s=>s.id===option.value)?.name||option.value;
  const signed=hostContext.me?.kind==='sso'&&hostContext.me?.principal?.startsWith('user:u_');
  dom('p',signed?'Stored revisions require explicit adoption before a run.':'Sign in as a named person to save or run a flow.',panel).className='muted small';
  const actions=dom('div',undefined,panel);actions.className='host-actions';
  function button(text,id,work,enabled=signed){const b=dom('button',text,actions);b.id=id;b.disabled=!enabled;b.addEventListener('click',async()=>{if(busy)return;b.disabled=true;try{await work();}catch(e){note(e.message);}finally{renderHost();}});return b;}
  button('Goal template','host-template',async()=>{
    const value=await hostCall('example');const f=value.body,es=new Map(f.elements.map(e=>[e.id,e]));
    f.elements.forEach(e=>e.meta.revision_state='adopted');
    es.get('submitted').type='run.start';es.get('accepted').type='goal.done';es.get('accepted').props.source_transition='t0';
    const event=copy(es.get('accepted'));event.id='review-done';event.props.source_transition='t1';f.elements.push(event);
    es.get('t1').trigger='accepted';es.get('t2').trigger='review-done';es.get('t2').props.requires_approval=false;
    for(const tid of ['t0','t1','t2'])es.get(tid).action={kind:'goal',target:selector.value,params:{title:'Garden '+tid,review:tid==='t1'?'person':'none'}};
    hostRevision=null;hostRun=null;await commit({body:f,layout:initialLayout(f)},'Goal template prepared · not adopted or running',null);fit();
  });
  button('Save revision','host-save',async()=>{
    const same=hostRevision?.body.id===body.id&&hostRevision.swarm_id===selector.value;
    hostRevision=await hostCall('publish',{swarm_id:selector.value,title:body.id,body,layout,...(same?{artifact_id:hostRevision.artifact_id,parent:hostRevision.revision}:{})});
    hostRun=null;note('Revision '+hostRevision.revision+' saved in Hive');
  });
  const current=hostRevision&&validation&&hostRevision.digest===validation.revision.digest;
  if(hostRevision)dom('p',`Stored r${hostRevision.revision} · ${current?'matches draft':'draft has edits'}`,panel).className='small muted';
  button('Save layout','host-layout',async()=>{
    hostRevision=await hostCall('layout',{artifact_id:hostRevision.artifact_id,n:hostRevision.revision,layout,expected_version:hostRevision.layout_version});note('Layout saved · same semantic revision');
  },signed&&current);
  button('Adopt revision','host-adopt',async()=>{
    hostRevision=await hostCall('adopt',{artifact_id:hostRevision.artifact_id,n:hostRevision.revision,digest:hostRevision.digest});note('Exact revision adopted by the signed-in owner');
  },signed&&current&&!hostRevision?.adoption);
  button('Start goal run','host-start',async()=>{
    const key=crypto.randomUUID();hostRun=await hostCall('start',{artifact_id:hostRevision.artifact_id,n:hostRevision.revision,digest:hostRevision.digest,client_key:key});note('Run created · '+hostRun.status);
  },signed&&current&&!!hostRevision?.adoption&&!hostRun);
  button('Load stored flow','host-load',async()=>{
    hostList=await hostCall('list',{swarm_id:selector.value});
    if(!hostList.length)note('No stored flows in this swarm');
  });
  if(hostList.length){
    const chooser=dom('div',undefined,panel);chooser.id='stored-flow-list';
    for(const item of hostList){const b=dom('button',`${item.title} · r${item.revision}`,chooser);b.addEventListener('click',async()=>{
      try{const loaded=await hostCall('read',{artifact_id:item.artifact_id,n:item.revision});
        if(await commit({body:loaded.body,layout:loaded.layout},'Stored revision loaded',null)){hostRevision=loaded;hostRun=null;hostList=[];renderHost();fit();}
      }catch(e){note(e.message);}
    });}
  }
  if(hostRun){
    const output=dom('div',undefined,panel);output.id='host-run-status';
    dom('p',`Run: ${hostRun.status}`,output).className='small';
    for(const step of hostRun.steps)dom('p',`${step.transition_id} · ${step.status} · ${step.goal_id}`,output).className='small muted';
    button('Refresh run','host-refresh',async()=>{hostRun=await hostCall('run',{run_id:hostRun.id});renderCanvas();renderInspector();note('Run state refreshed');});
    button('Cancel run','host-cancel',async()=>{hostRun=await hostCall('cancel',{run_id:hostRun.id});note('Run cancelled');},signed&&hostRun.status==='running');
  }
}

// Catalogue selection creates a reversible local draft, never a stored revision or run.
$('templates').addEventListener('click',async()=>{
  try{
    const value=hosted?await hostCall('templates'):await fetch('/api/templates').then(r=>{if(!r.ok)throw new Error('Templates unavailable');return r.json();});
    if(!Array.isArray(value.templates)||value.templates.length>20)throw new Error('Invalid template catalogue');
    const list=$('template-list');list.replaceChildren();
    for(const template of value.templates){
      const card=dom('article',undefined,list);card.className='template-card';
      dom('p',template.category,card).className='eyebrow';dom('h3',template.title,card);dom('p',template.description,card);
      const use=dom('button','Use template',card);use.dataset.templateKey=template.key;
      use.addEventListener('click',async()=>{
        try{
          const r=template.revision;const candidate={body:copy(r.body),layout:copy(r.layout)};
          const checked=await check(candidate);if(checked.revision.digest!==r.digest||r.execution_authority!=='none')throw new Error('Invalid template fingerprint or authority');
          if(await commit(candidate,`Template loaded: ${template.title} · local draft`,null)){hostRevision=null;hostRun=null;hostList=[];renderHost();fit();$('templates-dialog').close();}
        }catch(e){note(e.message);}
      });
    }
    $('templates-dialog').showModal();
  }catch(e){note(e.message);}
});
$('close-templates').addEventListener('click',()=>$('templates-dialog').close());
