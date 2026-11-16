// records (from gen_timeline) -> timeline.json. Formatting only: every value is decided in MeTTa.
import {readFileSync, writeFileSync} from 'node:fs'; import {createHash} from 'node:crypto';
const [recFile, out, ...srcs] = process.argv.slice(2);
const tok = s => s.match(/"(?:[^"\\]|\\.)*"|[()]|[^\s()]+/g);
function parse(ts){ const t=ts.shift(); if(t==='('){const l=[];while(ts[0]!==')')l.push(parse(ts));ts.shift();return l}
  if(t[0]==='"')return JSON.parse(t); const n=Number(t); return Number.isNaN(n)?t:n }
const recs = readFileSync(recFile,'utf8').trim().split('\n').map(l=>parse(tok(l)));
const sha = f => 'sha256:'+createHash('sha256').update(readFileSync(f)).digest('hex');
const tl = {schema:'omegacreate.timeline/1', source:Object.fromEntries(srcs.map(f=>[f.split('/').pop(), sha(f)])),
  segments:[], transitions:[], events:[], checks:{}};
for (const r of recs) switch (r[0]) {
  case 'timeline-film': Object.assign(tl,{film:r[1],fps:r[2],seconds:r[3],seed:r[4]}); break;
  case 'seg': tl.segments.push({beat:r[1],from:r[2],to:r[3],env:r[4],action:r[5],intent:r[6],next:r[7],
     lt:{kind:'linear',a:r[8],rate:r[9]}, presence:{kind:'approach',from:r[10],target:r[11],k:4.0,mode:r[12]}}); break;
  case 'trans': tl.transitions.push({a:r[1],b:r[2],from:r[3],to:r[4],envA:r[5],envB:r[6],morph:r[7],ease:r[8]}); break;
  case 'event-at': tl.events.push({id:r[1],t:r[2],kind:r[3],beat:r[4]}); break;
  case 'endcard': if (typeof r[1]==='string') tl.endcard={text:r[1],from:r[2]}; break;
  case 'check': tl.checks[r[1]]=r[2]; break; }
tl.segments.sort((x,y)=>x.from-y.from); tl.transitions.sort((x,y)=>x.from-y.from); tl.events.sort((x,y)=>x.t-y.t);
writeFileSync(out, JSON.stringify(tl,null,1)+'\n');
if (Object.values(tl.checks).some(v=>v!=='ok')) { console.error('CHECK FAIL', tl.checks); process.exit(3); }
