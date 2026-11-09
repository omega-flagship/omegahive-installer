import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const R = vi.hoisted(() => ({ own: null as null | { slots: unknown[]; effects: ({ deps?: unknown[]; cleanup?: unknown } | undefined)[]; dirty: boolean }, i: 0, ei: 0, pending: [] as (() => void)[], ids: 0 }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const changed = (a?: unknown[], b?: unknown[]) => !a || !b || a.length !== b.length || a.some((d, k) => !Object.is(d, b[k]))
  const slot = (init: () => unknown) => {
    const own = R.own!, n = R.i++
    if (!(n in own.slots)) own.slots[n] = init()
    return n
  }
  const memo = (f: () => unknown, deps?: unknown[]) => {
    const own = R.own!, n = slot(() => ({ deps: undefined, value: undefined, fresh: true }))
    const s = own.slots[n] as { deps?: unknown[]; value: unknown; fresh: boolean }
    if (s.fresh || changed(deps, s.deps)) own.slots[n] = { deps, value: f(), fresh: false }
    return (own.slots[n] as { value: unknown }).value
  }
  const effect = (fn: () => unknown, deps?: unknown[]) => {
    const own = R.own!, n = R.ei++, prev = own.effects[n]
    if (!prev || changed(deps, prev.deps)) R.pending.push(() => {
      if (typeof prev?.cleanup === 'function') (prev.cleanup as () => void)()
      own.effects[n] = { deps, cleanup: fn() }
    })
  }
  const m = { ...actual,
    useState: (init: unknown) => {
      const own = R.own!, n = slot(() => typeof init === 'function' ? (init as () => unknown)() : init)
      return [own.slots[n], (v: unknown) => {
        const next = typeof v === 'function' ? (v as (p: unknown) => unknown)(own.slots[n]) : v
        if (!Object.is(next, own.slots[n])) { own.slots[n] = next; own.dirty = true }
      }]
    },
    useRef: (v: unknown) => R.own!.slots[slot(() => ({ current: v }))],
    useCallback: (f: unknown, deps?: unknown[]) => memo(() => f, deps), useMemo: memo,
    useId: () => R.own!.slots[slot(() => `:enter${++R.ids}:`)],
    useSyncExternalStore: (subscribe: (changed: () => void) => () => void, get: () => unknown) => {
      const own = R.own!, n = slot(() => ({ get, value: get() }))
      const snapshot = own.slots[n] as { get: () => unknown; value: unknown }
      snapshot.get = get; snapshot.value = get()
      effect(() => {
        const changed = () => {
          const next = snapshot.get()
          if (!Object.is(snapshot.value, next)) { snapshot.value = next; own.dirty = true }
        }
        const off = subscribe(changed)
        changed()
        return off
      }, [subscribe])
      return snapshot.value
    }, useDebugValue: () => undefined,
    useContext: (c: { _currentValue?: unknown }) => c._currentValue, useEffect: effect, useLayoutEffect: effect,
  }
  return { ...m, default: m }
})
// External Zustand's React binding is outside the stand-in's module graph: bridge only its hook (the dualP2 pattern)
async function bridged<S>(store: { getState: () => S; subscribe: (l: () => void) => () => void }) {
  const { useSyncExternalStore } = await import('react')
  return Object.assign((sel?: (s: S) => unknown) => {
    const read = () => (sel ? sel(store.getState()) : store.getState())
    return useSyncExternalStore(store.subscribe, read, read)
  }, store)
}

vi.mock('../../store/store', async () => { const a = await vi.importActual<typeof import('../../store/store')>('../../store/store'); return { ...a, useHive: await bridged(a.useHive) } })
vi.mock('../../shell/phase', async () => { const a = await vi.importActual<typeof import('../../shell/phase')>('../../shell/phase'); return { ...a, usePhase: await bridged(a.usePhase) } })
vi.mock('../../lib/resting', async () => { const a = await vi.importActual<typeof import('../../lib/resting')>('../../lib/resting'); return { ...a, useResting: await bridged(a.useResting) } })
vi.mock('framer-motion', async (orig) => ({ ...(await orig<typeof import('framer-motion')>()), useIsPresent: () => true }))
const events = new Map<string, Set<() => void>>()
const win = { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener(t: string, f: () => void) { (events.get(t) ?? events.set(t, new Set()).get(t)!).add(f) }, removeEventListener(t: string, f: () => void) { events.get(t)?.delete(f) }, innerWidth: 1440, innerHeight: 900, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {} }
const doc = { hidden: false, documentElement: { lang: 'en-GB', style: { setProperty() {}, removeProperty() {} }, dataset: {} }, body: {}, activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, setAttribute() {} }) }
const emit = (type: string) => { for (const f of [...events.get(type) ?? []]) f() }
vi.stubGlobal('window', win); vi.stubGlobal('document', doc)
vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} }); vi.stubGlobal('navigator', { userAgent: '', language: 'en-GB' })
const { useHive } = await import('../../store/store')
const { testPerson, signInAs, releasePersons } = await import('../../lib/identityEpoch.testkit')
const { usePhase } = await import('../../shell/phase')
const { useResting } = await import('../../lib/resting')
const { CanvasActionBoundary } = await import('./actionAuthority')
const { SelectionActions } = await import('./index')
const { Act } = await import('./BoardOutline')
const { ChatCard } = await import('./chat')
type El = { type: unknown; props: Record<string, unknown> }
const isEl = (x: unknown): x is El => !!x && typeof x === 'object' && 'type' in x && 'props' in x
function find(x: unknown, f: (e: El) => boolean): El[] { return Array.isArray(x) ? x.flatMap(n => find(n, f)) : !isEl(x) ? [] : [...(f(x) ? [x] : []), ...find(x.props.children, f)] }
const words = (x: unknown): string => typeof x === 'string' ? x : Array.isArray(x) ? x.map(words).join('') : isEl(x) ? words(x.props.children) : ''
type Mount = { readonly tree: unknown; settle(): void; suspend(): void; resume(): void }
const mounted: Mount[] = []
function mount(component: () => unknown): Mount {
 const own = { slots: [] as unknown[], effects: [] as ({ deps?: unknown[]; cleanup?: unknown } | undefined)[], dirty: true }; let tree: unknown
 const render = () => { own.dirty = false; R.own = own; R.i = R.ei = 0; R.pending = []; tree = component(); const jobs = R.pending; R.pending = []; jobs.forEach(f => f()) }
 const settle = () => { for (let n=0; own.dirty && n<30; n++) render(); expect(own.dirty).toBe(false) }
 const suspend = () => { own.effects.forEach(e => typeof e?.cleanup === 'function' && (e.cleanup as () => void)()); own.effects=[] }
 const out = { get tree() { return tree }, settle, suspend, resume() { own.dirty=true; settle() } }; mounted.push(out); settle(); return out
}
const flush = async () => { for(let n=0;n<20;n++) await Promise.resolve() }
let seq=0
async function person() {
 const p=testPerson(`canvas-action-${++seq}`); await signInAs(p)
 const first=Object.values(useHive.getState().agents)[0], target={...first,id:'a_retained',status:'asleep' as const}
 useHive.setState({agents:{...useHive.getState().agents,[target.id]:target}})
 const post=vi.fn(async(id:string,action:string)=>({...target,id,status:action==='wake'?'awake':'asleep'}))
 useHive.getState().client!.agentAction=post as never
 const message=vi.fn(async(agent_id:string,body:{text:string})=>({id:'msg_synthetic',agent_id,role:'user',text:body.text,created_at:new Date().toISOString()}))
 useHive.getState().client!.sendMessage=message as never
 return {agentAction:post,sendMessage:message}
}
function boundary() { return mount(() => CanvasActionBoundary({children:null})) }
function wake(b: Mount) {
 const provider=b.tree as El; (provider.type as {_currentValue:unknown})._currentValue=provider.props.value
 const row=mount(()=>SelectionActions({item:{kind:'mind',id:'a_retained',key:'mind:a_retained'} as never,openChat(){},startDraft(){},flyToItem(){},openInspect(){},askGoal(){}}))
 const leaf=find(row.tree,e=>typeof e.props.run==='function'&&words(e)==='Wake')[0]; expect(leaf).toBeDefined()
 const button=mount(()=>{const bar=(leaf.type as (p:unknown)=>El)(leaf.props);return(bar.type as (p:unknown)=>unknown)(bar.props)})
 const el=find(button.tree,e=>e.type==='button')[0];expect(el).toBeDefined()
 const click=el.props.onClick as (e:unknown)=>void
 return async()=>{click({stopPropagation(){}});await flush()}
}
function provide(b: Mount) { const p=b.tree as El; (p.type as {_currentValue:unknown})._currentValue=p.props.value }
function outline(b: Mount) { provide(b);const m=mount(()=>Act({label:'Wake synthetic mind',children:'Wake',run:()=>useHive.getState().agentAction('a_retained','wake')}));const button=find(m.tree,e=>e.type==='button')[0];return async()=>{(button.props.onClick as ()=>unknown)();await flush()} }
function sendChat(b: Mount) {
 provide(b);const m=mount(()=>ChatCard({r:{x:0,y:0,w:400,h:500},agent:useHive.getState().agents.a_retained,phase:undefined,now:Date.now(),reduced:true,onCloseX(){},onDismiss(){}}))
 const field=find(m.tree,e=>e.type==='textarea')[0];(field.props.onChange as (e:unknown)=>void)({target:{value:'Invented retained chat words'}});m.settle()
 const send=find(m.tree,e=>e.type==='button'&&e.props['aria-label']==='Send')[0];expect(send).toBeDefined();const fn=send.props.onClick as ()=>unknown;return async()=>{fn();await flush()}
}
beforeEach(async()=>{win.location.hash='#/';doc.hidden=false;usePhase.setState({phased:false,phase:'pro'});useResting.setState({resting:false});await person()})
afterEach(()=>{mounted.reverse().forEach(m=>m.suspend());mounted.length=0;releasePersons();vi.restoreAllMocks()})
describe.each([['selection Wake',wake,'agentAction'],['outline Wake',outline,'agentAction'],['chat Send',sendChat,'sendMessage']] as const)('%s callback owns its rendered identity and visible attachment',(_name,action,method)=>{
 const post=()=>useHive.getState().client![method]
 it('is revoked during Activity cleanup and stays revoked after reattachment',async()=>{const calls=post();const b=boundary(),old=action(b);b.suspend();await old();expect(calls).not.toHaveBeenCalled();b.resume();await old();expect(calls).not.toHaveBeenCalled();await action(b)();expect(calls).toHaveBeenCalledTimes(1)})
 it('refuses while a page covers the Board and after returning to a fresh attachment',async()=>{const calls=post();const b=boundary(),old=action(b);win.location.hash='#/programs';emit('hashchange');await old();expect(calls).not.toHaveBeenCalled();b.settle();win.location.hash='#/';emit('hashchange');b.settle();await old();expect(calls).not.toHaveBeenCalled();await action(b)();expect(calls).toHaveBeenCalledTimes(1)})
 it('revokes a cover and return batched before React commits',async()=>{const calls=post();const b=boundary(),old=action(b);win.location.hash='#/programs';emit('hashchange');win.location.hash='#/';emit('hashchange');await old();expect(calls).not.toHaveBeenCalled();b.settle();await old();expect(calls).not.toHaveBeenCalled();await action(b)();expect(calls).toHaveBeenCalledTimes(1)})
 it('revokes legacy rest and return batched before React commits',async()=>{const calls=post();const b=boundary(),old=action(b);useResting.setState({resting:true});useResting.setState({resting:false});await old();expect(calls).not.toHaveBeenCalled();b.settle();await old();expect(calls).not.toHaveBeenCalled();await action(b)();expect(calls).toHaveBeenCalledTimes(1)})
 it('revokes native home and Pro batched before React commits',async()=>{const calls=post();const b=boundary(),old=action(b);usePhase.setState({phased:true,phase:'awake'});usePhase.setState({phase:'pro'});await old();expect(calls).not.toHaveBeenCalled();b.settle();await old();expect(calls).not.toHaveBeenCalled();await action(b)();expect(calls).toHaveBeenCalledTimes(1)})
 it('cannot dispatch through the next identity before its React commit',async()=>{const a=post();const b=boundary(),old=action(b),next=await person(),calls=next[method];await old();expect(a).not.toHaveBeenCalled();expect(calls).not.toHaveBeenCalled();b.settle();await action(b)();expect(calls).toHaveBeenCalledTimes(1)})
 it('revokes synchronously on pagehide and never revives on pageshow',async()=>{const calls=post();const b=boundary(),old=action(b);emit('pagehide');await old();expect(calls).not.toHaveBeenCalled();emit('pageshow');b.settle();await old();expect(calls).not.toHaveBeenCalled();await action(b)();expect(calls).toHaveBeenCalledTimes(1)})
})
