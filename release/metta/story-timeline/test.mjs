import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; import {stateAt} from './stateAt.mjs';
const load = f => JSON.parse(readFileSync(f,'utf8'));
const q = v => typeof v==='number' ? Number(v.toFixed(9)) : Array.isArray(v) ? v.map(q) : v && typeof v==='object' ? Object.fromEntries(Object.entries(v).map(([k,x])=>[k,q(x)])) : v;
const fh = (tl,i) => createHash('sha256').update(JSON.stringify(q(stateAt(tl, i/tl.fps)))).digest('hex').slice(0,16);
const frames = tl => Math.round(tl.seconds*tl.fps);
let fail = 0; const ok = (name, c, info='') => { console.log(`${c?'PASS':'FAIL'} ${name} ${info}`); if(!c) fail++; };
const tl = load('timeline.json'); const N = frames(tl);
// 1. purity: in-order vs jumped (seeded shuffle) gives identical frame hashes
const seq = Array.from({length:N}, (_,i)=>fh(tl,i));
let s = 1907; const rnd = () => (s = (s*1103515245+12345) % 2147483648) / 2147483648;
const order = Array.from({length:N},(_,i)=>i).sort(()=>rnd()-.5);
const jumped = []; for (const i of order) jumped[i] = fh(tl,i);
ok('1 purity: in-order == jumped', seq.every((h,i)=>h===jumped[i]), `(${N} frames)`);
// 3. split without warm-up: two cold chunks, concatenated == one run
const a = Array.from({length:N>>1},(_,i)=>fh(tl,i)), b = Array.from({length:N-(N>>1)},(_,i)=>fh(tl,(N>>1)+i));
ok('3 split: chunk A + chunk B == full', [...a,...b].join()===seq.join());
// 4. intent edit: only the edited beat and its transitions change
for (const [name, file] of [['local clock','timeline_edit.json'],['cumulative clock','timeline_edit_cum.json']]) {
  const base = name==='local clock' ? tl : load('timeline_cum.json'); const ed = load(file);
  const b3 = ed.segments.find(x=>x.beat==='b3'); const trs = ed.transitions.filter(x=>x.a==='b3'||x.b==='b3');
  const lo = Math.min(b3.from, ...trs.map(x=>x.from)), hi = Math.max(b3.to, ...trs.map(x=>x.to));
  const changed = []; for (let i=0;i<N;i++) if (fh(base,i)!==fh(ed,i)) changed.push(i);
  const outside = changed.filter(i => i/tl.fps < lo || i/tl.fps >= hi);
  const info = `changed=${changed.length} outside=${outside.length}${outside.length?` first-outside-t=${(outside[0]/tl.fps).toFixed(3)}`:''}`;
  if (name==='local clock') ok(`4 intent edit (${name}): changes confined to [${lo}, ${hi})`, outside.length===0 && changed.length>0, info);
  else ok(`CONTROL (expected to leak): cumulative clock, edit leaks outside [${lo}, ${hi})`, outside.length>0, info);
}
// 6. provenance: every frame knows its beat, intent and next
ok('6 provenance: beat/intent/next on every frame', seq.length===N && Array.from({length:N},(_,i)=>stateAt(tl,i/tl.fps)).every(x=>x.beat&&x.intent&&x.next));
process.exit(fail?1:0);
