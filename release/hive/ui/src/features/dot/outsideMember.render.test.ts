import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { fakeBrowser } from '../../lib/closeHome.testkit'

/**
 * A tester added an outside agent and its mind panel offered Start, which the hive always refuses for a member that runs
 * outside it ("Could not start: this member runs outside the hive; it connects with its token instead"). The panel's
 * header is rendered on the minimal hook runtime lib/closeHome.render.test.ts uses (no DOM library here), and its status
 * controls read. INVENTED members.
 */
// ---- a minimal hook runtime: one component render at a time; state survives re-renders until `unmount()` ----
const rt = { slots: new Map<string, unknown[]>(), cur: [] as unknown[], i: 0, dirty: false, pending: [] as (() => void)[] }
vi.mock('react', async (orig) => {
  const real = await orig<typeof import('react')>()
  const slot = <T,>(init: () => T): { v: T } => {
    const k = rt.i++
    if (!(k in rt.cur)) rt.cur[k] = { v: init() }
    return rt.cur[k] as { v: T }
  }
  return {
    ...real,
    useState: <T,>(init: T | (() => T)) => {
      const s = slot(() => (typeof init === 'function' ? (init as () => T)() : init))
      return [s.v, (v: T | ((p: T) => T)) => { const next=typeof v === 'function' ? (v as (p: T) => T)(s.v) : v; if(!Object.is(next,s.v)){s.v=next;rt.dirty=true} }]
    },
    useRef: <T,>(init: T) => slot(() => ({ current: init })).v,
    useMemo: <T,>(f: () => T) => f(),
    useCallback: <T,>(f: T) => f,
    useEffect: () => undefined,
    useLayoutEffect: (fn:()=>void|(()=>void),deps?:unknown[]) => {
      const state=slot(()=>({effect:true,deps:undefined as unknown[]|undefined,cleanup:undefined as void|(()=>void),fresh:true})).v
      if(state.fresh||!deps||!state.deps||deps.length!==state.deps.length||deps.some((v,i)=>!Object.is(v,state.deps![i])))rt.pending.push(()=>{state.cleanup?.();state.deps=deps;state.fresh=false;state.cleanup=fn()})
    },
    useContext: (context: { _currentValue?: unknown }) => context._currentValue,
    useId: () => 'id',
    useSyncExternalStore: <T,>(_s: unknown, get: () => T) => get(),
  }
})
// zustand is loaded outside vitest's module graph (it would reach the real React dispatcher): its hooks read the store
vi.mock('zustand', async (orig) => {
  const real = await orig<typeof import('zustand')>()
  type Init = (...a: never[]) => unknown
  const make = (init: Init) => {
    const api = real.createStore(init as never) as { getState: () => unknown }
    const hook = (sel: (s: unknown) => unknown = (s) => s) => sel(api.getState())
    return Object.assign(hook, api)
  }
  return { ...real, create: (init?: Init) => (init ? make(init) : make) }
})
vi.mock('../../lib/hooks', async (orig) => ({
  ...(await orig<typeof import('../../lib/hooks')>()),
  useEscape: () => undefined,
  useIsDesktop: () => true,
  useReducedMotion: () => true,
}))
vi.mock('framer-motion', async (orig) => ({ ...(await orig<typeof import('framer-motion')>()), useDragControls: () => ({ start: () => undefined }) }))
vi.mock('../../ui/overlays', async (orig) => ({ ...(await orig<typeof import('../../ui/overlays')>()), useOverlay: () => undefined }))

type El = { type?: unknown; props?: Record<string, unknown> }
function all(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => all(n, out))
  else if (node && typeof node === 'object' && 'props' in node) {
    const e = node as El
    out.push(e)
    for (const v of Object.values(e.props ?? {})) if (v && typeof v === 'object') all(v, out)
  }
  return out
}
/** Render one component (its own hooks only; child components stay elements until `expand`). */
function render<P>(key: string, C: (p: P) => unknown, props: P): ReactElement {
  if (!rt.slots.has(key)) rt.slots.set(key, [])
  let tree:ReactElement
  for(let n=0;n<20;n++){
    rt.cur=rt.slots.get(key)!;rt.i=0;rt.dirty=false;rt.pending=[]
    tree=C(props) as ReactElement
    rt.pending.forEach(effect=>effect())
    if(!rt.dirty)return tree
  }
  throw new Error('controlled layout effects did not settle')
}
const unmount = (key: string) => {for(const entry of rt.slots.get(key)??[]){const state=(entry as {v?:{effect?:boolean;cleanup?:()=>void}}).v;if(state?.effect)state.cleanup?.()}rt.slots.delete(key)}
const find = (el: unknown, pick: (e: El) => boolean): El => {
  const hit = all(el).find(pick)
  if (!hit) throw new Error('not rendered')
  return hit
}

async function controls(agent: Record<string, unknown>) {
  vi.resetModules()
  fakeBrowser(`#/dot/${agent.id}`)
  vi.stubGlobal('document', { hidden: false, documentElement: { lang: 'en-GB', style: { setProperty() {}, removeProperty() {} }, dataset: {} }, body: {}, activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, setAttribute() {} }) })
  rt.slots.clear()
  const { useHive } = await import('../../store/store')
  useHive.setState({ agents: { [agent.id as string]: agent } as never, ready: true } as never)
  const { default: DotPanel } = await import('./DotPanel')
  const sheet = render('dot', DotPanel as never, { id: agent.id }) as El
  const header = sheet.props!.header as El
  const headerEl = render('dot-header', header.type as (p: unknown) => unknown, header.props)
  const el = find(headerEl, (e) => typeof e.type === 'function' && (e.type as { name?: string }).name === 'Controls')
  const tree = render('controls', el.type as (p: unknown) => unknown, el.props)
  return all(tree).map((e) => e.props?.['aria-label']).filter((l): l is string => typeof l === 'string')
}
beforeEach(() => vi.unstubAllGlobals())
afterEach(() => {for(const key of [...rt.slots.keys()])unmount(key);vi.unstubAllGlobals()})

describe("a mind panel's status controls", { timeout: 30_000 }, () => {
  const member = { id: 'a_ot', name: 'Omega Test', hue: 200, model: 'mock/echo', status: 'created', kind: 'module', swarm_id: null, created_at: '2026-11-12T00:00:00Z' }

  it('offer an outside member how it connects, never Start', async () => {
    const labels = await controls(member)
    expect(labels).not.toContain('Start Omega Test')
    expect(labels).toContain('How Omega Test connects')
  })

  it('still offer Start to a mind this hive runs', async () => {
    const labels = await controls({ ...member, id: 'a_ju', name: 'Juniper', kind: 'omega' })
    expect(labels).toContain('Start Juniper')
    expect(labels).not.toContain('How Juniper connects')
  })
})
