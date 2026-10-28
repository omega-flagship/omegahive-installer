/* eslint-disable @typescript-eslint/no-explicit-any -- OmegaReview's b393fa8 probe, kept verbatim below this line (body sha256 81925cf9be8729a2e9d3a85385428b79a50813082c1bd4f44dc8334acb6cdd69) */
import {expect,it,vi} from 'vitest'
import {omegaDesign} from '../../api/sim/omegadesign'
import {readSource,openDoc,current} from './model'
const h=vi.hoisted(()=>({slots:[] as any[],index:0,refs:[] as any[],ri:0,doc:null as any}))
vi.mock('react',async(importOriginal)=>({...await importOriginal<any>(),
 useState:(initial:any)=>{const i=h.index++;if(!(i in h.slots))h.slots[i]=i===1?h.doc:typeof initial==='function'?initial():initial;return [h.slots[i],(value:any)=>{h.slots[i]=typeof value==='function'?value(h.slots[i]):value}]},
 useRef:(initial:any)=>{const i=h.ri++;return h.refs[i]??(h.refs[i]={current:i===0?h.doc:initial})},
 useCallback:(fn:any)=>fn,useEffect:()=>{},
}))
vi.mock('../../store/store',()=>({useHive:(fn:any)=>fn({client:null})}))
import {useCanvas} from './useCanvas'
it('a delayed Keep answer must preserve an edit made while saving',async()=>{
 const p=omegaDesign();const graph=p.view({} as never,`studio-source:${JSON.stringify({artifact_id:'ar_simstarter',revision:1,digest:'sha256:'+'a'.repeat(64)})}`,'unfold') as any
 const got=readSource({...graph,links:[],groups:[],notes:[]});if(got.kind!=='studio')throw Error('fixture')
 h.doc=openDoc(got.source,got.reference);h.slots=[];h.refs=[];h.index=0;h.ri=0
 let finish:any;const answer=new Promise<any>(r=>{finish=r})
 const canvas=useCanvas({source:got.reference,act:()=>answer} as any)
 const keeping=canvas.keep()
 const el=current(h.doc).scene.elements.find(e=>e.kind==='text')!
 expect(await canvas.commit([{op:'set',element:el.id,patch:{text:'NEWER UNSAVED WORK'}}])).toBe(true)
 expect(current(h.refs[0].current).scene.elements.find(e=>e.id===el.id)?.text).toBe('NEWER UNSAVED WORK')
 finish({status:'done',data:{output:{artifact_id:'ar_saved',revision:2,digest:'sha256:'+'b'.repeat(64)}}});await keeping
 expect(current(h.refs[0].current).scene.elements.find(e=>e.id===el.id)?.text).toBe('NEWER UNSAVED WORK')
})
