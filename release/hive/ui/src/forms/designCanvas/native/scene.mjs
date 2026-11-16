// Shared editable document model for the Studio canvas. No host effect authority.
export const clone = value => structuredClone(value);
export function resizeElement(scene,elementId,width,height) {
  validate(scene);
  const element=scene.elements.find(e=>e.id===elementId);
  if(!element)throw Error('Selected element missing');
  if(!Number.isFinite(width)||!Number.isFinite(height))throw Error('Invalid resize dimensions');
  return {op:'set',element:elementId,patch:{width:Math.max(1,Math.min(scene.width-element.x,width)),height:Math.max(1,Math.min(scene.height-element.y,height))}};
}
export function alignElement(scene,elementId,alignment) {
  validate(scene);
  const element=scene.elements.find(e=>e.id===elementId);
  if(!element)throw Error('Selected element missing');
  const positions={left:{x:0},center:{x:(scene.width-element.width)/2},right:{x:scene.width-element.width},top:{y:0},middle:{y:(scene.height-element.height)/2},bottom:{y:scene.height-element.height}};
  if(!Object.hasOwn(positions,alignment))throw Error('Unknown alignment');
  return {op:'set',element:elementId,patch:positions[alignment]};
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return 'sha256:' + [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2,'0')).join('');
}
const number = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
export const validFontFamily = value => typeof value==='string' && /^[A-Za-z][A-Za-z0-9 -]{0,79}$/.test(value);
const color = c => typeof c === 'string' && /^#[a-fA-F0-9]{6}$/.test(c);
const id = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(s);
export function validate(scene) {
  if (!scene || scene.schema !== 'omega-scene-1' || !id(scene.id) || typeof scene.title !== 'string' || scene.title.length > 200) throw Error('Invalid scene');
  if (!number(scene.width,100,4000) || !number(scene.height,100,4000) || !color(scene.background)) throw Error('Invalid canvas');
  if (!Array.isArray(scene.criteria) || scene.criteria.length > 100 || scene.criteria.some(c => typeof c !== 'string' || c.length > 2000)) throw Error('Invalid criteria');
  if (!Array.isArray(scene.elements) || scene.elements.length > 200) throw Error('Invalid elements');
  const ids = new Set();
  for (const e of scene.elements) {
    if (!id(e.id) || ids.has(e.id) || !['text','rect','image'].includes(e.kind)) throw Error('Invalid element identity');
    ids.add(e.id);
    if (!number(e.x,0,scene.width) || !number(e.y,0,scene.height) || !number(e.width,1,scene.width) || !number(e.height,1,scene.height) || e.x+e.width>scene.width || e.y+e.height>scene.height) throw Error('Element outside canvas');
    if (e.kind === 'text' && (typeof e.text !== 'string' || e.text.length > 10000 || !number(e.fontSize,8,300) || !color(e.color) || !['normal','bold'].includes(e.weight))) throw Error('Invalid text');
    if(e.kind==='text' && e.fontFamily!==undefined && !validFontFamily(e.fontFamily))throw Error('Invalid font family');
    if (e.kind === 'rect' && !color(e.fill)) throw Error('Invalid fill');
    if (e.kind === 'rect' && e.radius !== undefined && !number(e.radius,0,Math.min(e.width,e.height)/2)) throw Error('Invalid rectangle radius');
    if (e.kind === 'image' && (typeof e.src !== 'string' || e.src.length > 14*1024*1024 || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(e.src) || typeof e.alt !== 'string')) throw Error('Image must be an embedded PNG or JPEG');
  }
  return clone(scene);
}
export async function initial(scene) {
  scene = validate(scene);
  return {scene, revision:1, digest:await digest(scene), parent:null, changes:[]};
}
export async function apply(current, expected, changes) {
  if (expected !== current.digest || await digest(current.scene) !== current.digest) throw Error('Stale or altered revision');
  if (!Array.isArray(changes) || !changes.length || changes.length > 200) throw Error('Invalid change batch');
  const scene = clone(current.scene);
  for (const change of changes) {
    const i = scene.elements.findIndex(e => e.id === change.element);
    if (change.op === 'add') {
      if (i >= 0 || change.value?.id !== change.element) throw Error('Duplicate element');
      scene.elements.push(clone(change.value));
    } else if (change.op === 'remove') {
      if (i < 0) throw Error('Missing element');
      scene.elements.splice(i,1);
    } else if (change.op === 'layer') {
      if(i<0||!['back','front'].includes(change.position))throw Error('Invalid layer change');
      const [element]=scene.elements.splice(i,1);
      if(change.position==='back')scene.elements.unshift(element);else scene.elements.push(element);
    } else if (change.op === 'set') {
      if (i < 0 || !change.patch || Object.keys(change.patch).some(k => !['x','y','width','height','text','fontSize','fontFamily','color','weight','fill','src','alt'].includes(k))) throw Error('Invalid element change');
      const sourceChanged = Object.hasOwn(change.patch,'src') && change.patch.src !== scene.elements[i].src;
      scene.elements[i] = {...scene.elements[i], ...clone(change.patch)};
      if(sourceChanged)delete scene.elements[i].provenance;
    } else throw Error('Unknown operation');
  }
  validate(scene);
  return {scene,revision:current.revision+1,digest:await digest(scene),parent:{scene_id:current.scene.id,revision:current.revision,digest:current.digest},changes:clone(changes)};
}
export function feedback(current, element, note) {
  if (!current.scene.elements.some(e => e.id === element) || typeof note !== 'string' || !note.trim() || note.length > 4000) throw Error('Invalid feedback target');
  return {subject:{scene_id:current.scene.id,revision:current.revision,digest:current.digest,element_id:element},note,status:'open',author:'local-user'};
}
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export function svg(scene) {
  validate(scene);
  const elements = scene.elements.map(e => {
    if(e.kind==='text' && e.fontFamily!==undefined && !validFontFamily(e.fontFamily))throw Error('Invalid font family');
    if (e.kind === 'rect') return `<rect data-element="${e.id}" x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" fill="${e.fill}"${e.radius!==undefined?` rx="${e.radius}" ry="${e.radius}"`:''}/>`;
    if (e.kind === 'image') return `<image data-element="${e.id}" x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" href="${e.src}" preserveAspectRatio="xMidYMid meet"><title>${escape(e.alt)}</title></image>`;
    const wrapped=wrapText(e);
    const lines = wrapped.lines.map((line,i)=>`<tspan x="${e.x}" dy="${i ? e.fontSize*1.2 : 0}">${escape(line)}</tspan>`).join('');
    return `<text data-element="${e.id}" data-overflow="${wrapped.overflow}" x="${e.x}" y="${e.y+e.fontSize}" fill="${e.color}" font-family="${escape(e.fontFamily??'Arial')}" font-size="${e.fontSize}" font-weight="${e.weight}">${lines}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}" role="img"><title>${escape(scene.title)}</title><rect width="${scene.width}" height="${scene.height}" fill="${scene.background}"/>${elements}</svg>`;
}

// Conservative portable wrapping; explicit breaks remain paragraph boundaries.
// This is not font-engine measurement. Overflow still requires visual review.
export function wrapText(element){
 const width=text=>[...text].reduce((sum,c)=>sum+element.fontSize*(c===' '?0.33:0.65),0);
 const lines=[];
 for(const paragraph of element.text.split('\n')){
  let line='';
  for(const word of paragraph.split(/\s+/)){
   const candidate=line?line+' '+word:word;
   if(width(candidate)<=element.width){line=candidate;continue;}
   if(line){lines.push(line);line='';}
   for(const character of [...word]){if(line&&width(line+character)>element.width){lines.push(line);line='';}line+=character;}
  }
  lines.push(line);
 }
 return {lines,overflow:element.fontSize+(lines.length-1)*element.fontSize*1.2>element.height};
}
