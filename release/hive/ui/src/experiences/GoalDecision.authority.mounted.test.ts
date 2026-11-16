import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const R = vi.hoisted(() => ({ own: null as null | { slots: unknown[]; effects: ({ deps?: unknown[]; cleanup?: unknown } | undefined)[]; dirty: boolean }, i: 0, ei: 0, pending: [] as (() => void)[], ids: 0, present: true }))
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

vi.mock('../store/store', async () => { const a = await vi.importActual<typeof import('../store/store')>('../store/store'); return { ...a, useHive: await bridged(a.useHive) } })
vi.mock('../shell/phase', async () => { const a = await vi.importActual<typeof import('../shell/phase')>('../shell/phase'); return { ...a, usePhase: await bridged(a.usePhase) } })
vi.mock('../lib/resting', async () => { const a = await vi.importActual<typeof import('../lib/resting')>('../lib/resting'); return { ...a, useResting: await bridged(a.useResting) } })
vi.mock('framer-motion', async (orig) => ({ ...(await orig<typeof import('framer-motion')>()), useIsPresent: () => R.present }))
const events = new Map<string, Set<() => void>>()
const win = { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener(t: string, f: () => void) { (events.get(t) ?? events.set(t, new Set()).get(t)!).add(f) }, removeEventListener(t: string, f: () => void) { events.get(t)?.delete(f) }, innerWidth: 1440, innerHeight: 900, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {} }
const doc = { hidden: false, documentElement: { lang: 'en-GB', style: { setProperty() {}, removeProperty() {} }, dataset: {} }, body: {}, activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, setAttribute() {} }) }
const emit = (type: string) => { for (const f of [...events.get(type) ?? []]) f() }
vi.stubGlobal('window', win); vi.stubGlobal('document', doc)
vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} }); vi.stubGlobal('navigator', { userAgent: '', language: 'en-GB' })
const { useHive } = await import('../store/store')
const { testPerson, signInAs, releasePersons } = await import('../lib/identityEpoch.testkit')
const { usePhase } = await import('../shell/phase')
const { useResting } = await import('../lib/resting')
const { useVisibleAuthority, useVisibleState } = await import('../lib/useVisibleAuthority')
const { ApprovalDecision } = await import('./ApprovalDecision')
const { useCosmosGoalAuthority } = await import('./cosmos/Deck')
const { useCosmos } = await import('./cosmos/state')
const { useCosmosApprovalAuthority } = await import('./cosmos')
const { useConstructApprovalAuthority } = await import('./construct')
const { useC } = await import('./construct/state')
const { useFluxApprovalAuthority } = await import('./flux/panels')
const { useFluxGoalAuthority } = await import('./flux/sheets')
const { FluxCtx } = await import('./flux/ctx')
const { GoalDecision } = await import('./GoalDecision')
const { STALE } = await import('../lib/identityEpoch')
const mounted: Mount[] = []
type Mount = { readonly tree: unknown; settle(): void; suspend(): void; resume(): void }
function mount(component: () => unknown): Mount {
 const own = { slots: [] as unknown[], effects: [] as ({ deps?: unknown[]; cleanup?: unknown } | undefined)[], dirty: true }; let tree: unknown
 const render = () => { own.dirty = false; R.own = own; R.i = R.ei = 0; R.pending = []; tree = component(); const jobs = R.pending; R.pending = []; jobs.forEach(f => f()) }
 const settle = () => { for (let n=0; own.dirty && n<30; n++) render(); expect(own.dirty).toBe(false) }
 const suspend = () => { own.effects.forEach(e => typeof e?.cleanup === 'function' && (e.cleanup as () => void)()); own.effects=[] }
 const out = { get tree() { return tree }, settle, suspend, resume() { own.dirty=true; settle() } }; mounted.push(out); settle(); return out
}
const flush = async () => { for(let n=0;n<20;n++) await Promise.resolve() }
type Goal = import('../api/types').Goal
type Dialog = { props: { onClose(): void; actions: { run(): Promise<unknown> }[] } }
let seq=0
async function person() {
 const p=testPerson(`goal-authority-${++seq}`); await signInAs(p)
 const original=Object.values(useHive.getState().goals).find(g=>g.status==='open');expect(original).toBeDefined()
 const seen={...original!,id:'g_retained',status:'open' as const}
 useHive.setState({goals:{...useHive.getState().goals,[seen.id]:seen}})
 const read=vi.fn<(...args: unknown[])=>Promise<Goal>>(async()=>({...seen,status:'done'}));const write=vi.fn<(...args: unknown[])=>Promise<Goal>>(async()=>({...seen,status:'done'}))
 useHive.getState().client!.getGoal=read;useHive.getState().client!.patchGoal=write
 return {seen,read,write}
}
function authority(){return mount(()=>useVisibleAuthority('page',true,'synthetic-goal-surface'))}
function decision(owner:Mount,seen:Goal){return mount(()=>GoalDecision({seen,to:'done',session:useHive.getState().session,onClose(){},current:owner.tree as ()=>boolean}))}
function notice(owner:Mount,seen:Goal){useHive.setState({goalsUnsure:{[seen.id]:true}});const d=decision(owner,seen);(d.tree as Dialog).props.onClose();const action=useHive.getState().toasts.at(-1)!.action!;expect(action.label).toBe('Check again');return action.run}
beforeEach(()=>{R.present=true;win.location.hash='#/tasks';doc.hidden=false;usePhase.setState({phased:false,phase:'pro'});useResting.setState({resting:false})})
afterEach(()=>{mounted.reverse().forEach(m=>m.suspend());mounted.length=0;releasePersons();vi.restoreAllMocks()})
describe('GoalDecision required displayed-surface authority',()=>{
 it('rejects a saved recheck through revoke and reattachment, while a fresh recheck still reads',async()=>{const p=await person(),a=authority(),old=notice(a,p.seen);a.suspend();old();await flush();expect(p.read).not.toHaveBeenCalled();a.resume();old();await flush();expect(p.read).not.toHaveBeenCalled();notice(a,p.seen)();await flush();expect(p.read).toHaveBeenCalledTimes(1)})
 it('publishes no private recheck result after revocation during an in-flight read',async()=>{const p=await person();let resolve!:(g:Goal)=>void;p.read.mockImplementationOnce(()=>new Promise<Goal>(r=>{resolve=r}));const a=authority(),run=notice(a,p.seen);run();await flush();expect(p.read).toHaveBeenCalledTimes(1);const before=useHive.getState().toasts;a.suspend();resolve({...p.seen,status:'done'});await flush();expect(useHive.getState().toasts).toEqual(before);a.resume();run();await flush();expect(p.read).toHaveBeenCalledTimes(1);notice(a,p.seen)();await flush();expect(p.read).toHaveBeenCalledTimes(2)})
 it('rejects a recheck against the next actual identity before React commits',async()=>{const p=await person(),a=authority(),old=notice(a,p.seen),next=await person();old();await flush();expect(p.read).not.toHaveBeenCalled();expect(next.read).not.toHaveBeenCalled();a.settle();notice(a,next.seen)();await flush();expect(next.read).toHaveBeenCalledTimes(1)})
 it('does not revive a recheck when cover and return batch before React commits',async()=>{const p=await person(),a=authority(),old=notice(a,p.seen);win.location.hash='#/programs';emit('hashchange');win.location.hash='#/tasks';emit('hashchange');old();await flush();expect(p.read).not.toHaveBeenCalled();a.settle();old();await flush();expect(p.read).not.toHaveBeenCalled();notice(a,p.seen)();await flush();expect(p.read).toHaveBeenCalledTimes(1)})
 it('rejects a retained actual write after pagehide and accepts a fresh write after pageshow',async()=>{const p=await person(),a=authority(),d=decision(a,p.seen),old=(d.tree as Dialog).props.actions[0].run;emit('pagehide');expect(await old()).toBe(STALE);expect(p.write).not.toHaveBeenCalled();emit('pageshow');a.settle();expect(await old()).toBe(STALE);expect(p.write).not.toHaveBeenCalled();await (decision(a,p.seen).tree as Dialog).props.actions[0].run();expect(p.write).toHaveBeenCalledTimes(1)})
})

describe('one primitive, explicit owner scope',()=>{
 it('a dialog requires its parent at compile time and fails closed without it at runtime',()=>{
  // @ts-expect-error a dialog must name its opening surface authority
  const missing=mount(()=>useVisibleAuthority('dialog',true,'missing-parent'))
  expect((missing.tree as ()=>boolean)()).toBe(false)
 })
 it('a dialog checks its captured actual parent synchronously and never revives after reattachment',()=>{
  const a=authority(),old=mount(()=>useVisibleAuthority('dialog',true,'child',a.tree as ()=>boolean));const saved=old.tree as ()=>boolean
  expect(saved()).toBe(true);a.suspend();expect(saved()).toBe(false);a.resume();expect(saved()).toBe(false)
  const fresh=mount(()=>useVisibleAuthority('dialog',true,'child',a.tree as ()=>boolean));expect((fresh.tree as ()=>boolean)()).toBe(true)
 })
 it.each([['hive-pro', '#/', true],['hive-pro', '#/tasks', false],['page', '#/', false],['page', '#/tasks', true]] as const)('%s at %s has authority=%s', (scope,hash,expected)=>{win.location.hash=hash;const a=mount(()=>useVisibleAuthority(scope,true,'scope-contract'));expect((a.tree as ()=>boolean)()).toBe(expected)})
 it('a hive owner refuses awake even though its dialog is still mounted',async()=>{const p=await person();win.location.hash='#/';usePhase.setState({phased:true,phase:'awake'});const a=mount(()=>useVisibleAuthority('hive-pro',true,'scope-contract'));expect((a.tree as ()=>boolean)()).toBe(false);expect(await (decision(a,p.seen).tree as Dialog).props.actions[0].run()).toBe(STALE);expect(p.write).not.toHaveBeenCalled()})
})
describe('required approval authority and unconditional local dismissal',()=>{
 it.each([false,true])('a pending lost goal answer after Close carries a notice only if its parent remains current (revoked=%s)',async(revoked)=>{
  const p=await person(),a=authority(),g=decision(a,p.seen);let reject!:(e:Error)=>void;p.write.mockImplementationOnce(()=>new Promise<Goal>((_,r)=>{reject=r}));p.read.mockRejectedValue(new TypeError('Failed to fetch'))
  const pending=(g.tree as Dialog).props.actions[0].run();expect(p.write).toHaveBeenCalledTimes(1);(g.tree as Dialog).props.onClose();g.suspend();if(revoked)a.suspend();const before=useHive.getState().toasts
  reject(new TypeError('Failed to fetch'));expect(await pending).toBe(STALE);expect(useHive.getState().goalsUnsure[p.seen.id]).toBe(true)
  if(revoked)expect(useHive.getState().toasts).toEqual(before)
  else{expect(useHive.getState().toasts).toHaveLength(before.length+1);const action=useHive.getState().toasts.at(-1)!.action!;expect(action.label).toBe('Check again');p.read.mockResolvedValue({...p.seen,status:'done'});action.run();await flush();expect(p.read).toHaveBeenCalledTimes(2);expect(useHive.getState().goalsUnsure[p.seen.id]).toBeUndefined()}
 })
 async function approval(){const p=await person();const original=Object.values(useHive.getState().approvals).find(a=>a.status==='pending');expect(original).toBeDefined();const seen={...original!,id:'ap_retained'};useHive.setState({approvals:{...useHive.getState().approvals,[seen.id]:seen}});const post=vi.fn(async()=>({...seen,status:'approved' as const}));useHive.getState().client!.answerApproval=post;useHive.getState().client!.approve=post;return{...p,seenApproval:seen,post}}
 it('an actual approval action refuses across hide and reattachment; a fresh action dispatches once',async()=>{const p=await approval(),a=authority();const open=()=>mount(()=>ApprovalDecision({seen:p.seenApproval,session:useHive.getState().session,current:a.tree as ()=>boolean,onClose(){}}));const d=open(),old=(d.tree as Dialog).props.actions[0].run;a.suspend();expect(await old()).toBe(STALE);a.resume();expect(await old()).toBe(STALE);expect(p.post).not.toHaveBeenCalled();await(open().tree as Dialog).props.actions[0].run();expect(p.post).toHaveBeenCalledTimes(1)})
 it('an actual approval action cannot target the next identity before React commits',async()=>{const p=await approval(),a=authority(),d=mount(()=>ApprovalDecision({seen:p.seenApproval,session:useHive.getState().session,current:a.tree as ()=>boolean,onClose(){}})),old=(d.tree as Dialog).props.actions[0].run;const next=await approval();expect(await old()).toBe(STALE);expect(p.post).not.toHaveBeenCalled();expect(next.post).not.toHaveBeenCalled()})
 it('an exiting approval dialog revokes its saved action before unmount',async()=>{const p=await approval(),a=authority(),d=mount(()=>ApprovalDecision({seen:p.seenApproval,current:a.tree as ()=>boolean,onClose(){}})),old=(d.tree as Dialog).props.actions[0].run;R.present=false;d.resume();expect(await old()).toBe(STALE);expect(p.post).not.toHaveBeenCalled()})
 it('revoked goal and approval Close callbacks still dismiss and publish nothing',async()=>{const p=await approval(),a=authority(),goalClose=vi.fn(),approvalClose=vi.fn();useHive.setState({goalsUnsure:{[p.seen.id]:true}});const g=mount(()=>GoalDecision({seen:p.seen,to:'done',current:a.tree as ()=>boolean,onClose:goalClose})),d=mount(()=>ApprovalDecision({seen:p.seenApproval,current:a.tree as ()=>boolean,onClose:approvalClose}));const before=useHive.getState().toasts;a.suspend();(g.tree as Dialog).props.onClose();(d.tree as Dialog).props.onClose();expect(goalClose).toHaveBeenCalledTimes(1);expect(approvalClose).toHaveBeenCalledTimes(1);expect(useHive.getState().toasts).toEqual(before);expect(p.post).not.toHaveBeenCalled();expect(p.write).not.toHaveBeenCalled()})
 it('a legitimate closed-dialog notice keeps the current surface grant while old dialog actions are revoked',async()=>{const p=await approval(),a=authority(),g=decision(a,p.seen);useHive.setState({goalsUnsure:{[p.seen.id]:true}});(g.tree as Dialog).props.onClose();const notice=useHive.getState().toasts.at(-1)!.action!,old=(g.tree as Dialog).props.actions[0].run;g.suspend();expect(await old()).toBe(STALE);notice.run();await flush();expect(p.read).toHaveBeenCalledTimes(1);expect(p.write).not.toHaveBeenCalled()})
})
describe.each(['cosmos','flux'] as const)('%s goal-owner state and exit presence',kind=>{
 function owner(){win.location.hash='#/';if(kind==='cosmos'){useCosmos.setState({deck:'goals'});return{a:mount(useCosmosGoalAuthority),leave:()=>useCosmos.setState({deck:'index'}),back:()=>useCosmos.setState({deck:'goals'})}}const initial={page:'goals' as const};const state=mount(()=>useVisibleState<import('./flux/ctx').SheetState|null>(initial));const [,set,source]=state.tree as ReturnType<typeof useVisibleState<import('./flux/ctx').SheetState|null>>;(FluxCtx as unknown as {_currentValue:unknown})._currentValue={sheetOwner:source};return{a:mount(useFluxGoalAuthority),leave:()=>set({page:'index'}),back:()=>set(initial)}}
 it('revokes synchronously on local navigation, including a leave/return before React commits',async()=>{const p=await person(),o=owner(),old=(decision(o.a,p.seen).tree as Dialog).props.actions[0].run;o.leave();expect(await old()).toBe(STALE);o.back();expect(await old()).toBe(STALE);expect(p.write).not.toHaveBeenCalled();o.a.settle();await(decision(o.a,p.seen).tree as Dialog).props.actions[0].run();expect(p.write).toHaveBeenCalledTimes(1)})
 if(kind==='cosmos')it('also revokes when only its task filter context changes',async()=>{const p=await person(),o=owner(),old=(decision(o.a,p.seen).tree as Dialog).props.actions[0].run;const before=useCosmos.getState().deckSwarm;useCosmos.setState({deckSwarm:'synthetic-other-swarm'});expect(await old()).toBe(STALE);useCosmos.setState({deckSwarm:before});expect(await old()).toBe(STALE);expect(p.write).not.toHaveBeenCalled()})
 it('revokes while animated exit retains the owner; fresh presence gets a new grant',async()=>{const p=await person(),o=owner(),old=(decision(o.a,p.seen).tree as Dialog).props.actions[0].run;R.present=false;o.a.resume();expect(await old()).toBe(STALE);R.present=true;o.a.resume();expect(await old()).toBe(STALE);expect(p.write).not.toHaveBeenCalled();await(decision(o.a,p.seen).tree as Dialog).props.actions[0].run();expect(p.write).toHaveBeenCalledTimes(1)})
})

describe.each(['cosmos','construct','flux'] as const)('%s actual approval owner adapter',kind=>{
 it('revokes before React commits a close and reopen, and a fresh request still answers',async()=>{
  const p=await person();win.location.hash='#/';const original=Object.values(useHive.getState().approvals).find(a=>a.status==='pending');expect(original).toBeDefined();const seen={...original!,id:'ap_owner_retained'};useHive.setState({approvals:{...useHive.getState().approvals,[seen.id]:seen}});const post=vi.fn(async()=>({...seen,status:'approved' as const}));useHive.getState().client!.approve=post
  let owner:Mount,leave:()=>void,back:()=>void
  if(kind==='cosmos'){useCosmos.setState({answering:seen});owner=mount(useCosmosApprovalAuthority);leave=()=>useCosmos.setState({answering:null});back=()=>useCosmos.setState({answering:seen})}
  else if(kind==='construct'){useC.setState({answering:seen});owner=mount(useConstructApprovalAuthority);leave=()=>useC.setState({answering:null});back=()=>useC.setState({answering:seen})}
  else{const initial={id:seen.id};const state=mount(()=>useVisibleState<{id:string}|null>(initial));const [,set,source]=state.tree as ReturnType<typeof useVisibleState<{id:string}|null>>;(FluxCtx as unknown as {_currentValue:unknown})._currentValue={decisionOwner:source};owner=mount(()=>useFluxApprovalAuthority(seen.id));leave=()=>set(null);back=()=>set(initial)}
  const open=()=>mount(()=>ApprovalDecision({seen,current:owner.tree as ()=>boolean,onClose(){}}));const old=(open().tree as Dialog).props.actions[0].run;leave();expect(await old()).toBe(STALE);back();expect(await old()).toBe(STALE);expect(post).not.toHaveBeenCalled();owner.settle();await(open().tree as Dialog).props.actions[0].run();expect(post).toHaveBeenCalledTimes(1);expect(p.write).not.toHaveBeenCalled()
 })
})
