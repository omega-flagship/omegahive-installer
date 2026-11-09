import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { fakeBrowser } from './closeHome.testkit'

/**
 * close-home r3, rendered: the REAL components (ui/Page, ui/Sheet, the mind panel, Create a mind, Canvas's
 * conversation card) are called on a minimal hook runtime (this repo's tests run in node with no DOM library; the same
 * approach as ui/decisionDialog.r6.test.ts) and driven through the elements they render: the X's onClick, the Esc the
 * component registers, the phone sheet's drag end, the composer's onChange. Each check asserts the route, whether
 * home:requested was sent, and the kept draft. Invented data only.
 */

// ---- a minimal hook runtime: one component render at a time; state survives re-renders until `unmount()` ----
const rt = { slots: new Map<string, unknown[]>(), cur: [] as unknown[], i: 0, dirty: false, pending: [] as (() => void)[] }
let escape: (() => void) | null = null
let desktop = true
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
vi.mock('./hooks', async (orig) => ({
  ...(await orig<typeof import('./hooks')>()),
  useEscape: (fn: () => void) => void (escape = fn),
  useIsDesktop: () => desktop,
  useReducedMotion: () => true,
}))
vi.mock('framer-motion', async (orig) => ({ ...(await orig<typeof import('framer-motion')>()), useDragControls: () => ({ start: () => undefined }) }))
vi.mock('../ui/overlays', async (orig) => ({ ...(await orig<typeof import('../ui/overlays')>()), useOverlay: () => undefined }))

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
const byLabel = (label: string) => (e: El) => e.props?.['aria-label'] === label || e.props?.label === label

let r: typeof import('./router')
let b: ReturnType<typeof fakeBrowser>
let heard: number
async function boot(first: string) {
  vi.resetModules()
  b = fakeBrowser(first)
  vi.stubGlobal('document', { hidden: false, documentElement: { lang: 'en-GB', style: { setProperty() {}, removeProperty() {} }, dataset: {} }, body: {}, activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, setAttribute() {} }) })
  r = await import('./router')
  heard = 0
  r.onHomeRequested(() => heard++)
  escape = null
  rt.slots.clear()
}
beforeEach(() => vi.unstubAllGlobals())
afterEach(() => {for(const key of [...rt.slots.keys()])unmount(key);vi.unstubAllGlobals()})

describe('the shared page, rendered', { timeout: 30_000 }, () => {
  it('its X goes home and sends home:requested; its Esc steps back and sends nothing', async () => {
    await boot('#/')
    const { Page } = await import('../ui/Page')
    r.navigate({ name: 'tasks' })
    r.navigate({ name: 'settings' })
    render('page', Page, { title: 'Settings', label: 'Settings', onClose: () => r.navigate({ name: 'hive' }), children: null })
    escape!() // Esc
    expect([b.location.hash, heard]).toEqual(['#/tasks', 0])
    r.navigate({ name: 'settings' })
    const el = render('page', Page, { title: 'Settings', label: 'Settings', onClose: () => r.navigate({ name: 'hive' }), children: null })
    ;(find(el, byLabel('Close')).props!.onClick as () => void)() // the X
    expect([b.location.hash, heard]).toEqual(['#/', 1])
  })
})

describe('Sheet dismissal (Esc and the phone drag) calls only the dismissal it was given', { timeout: 30_000 }, () => {
  it('Esc and a long drag call onClose; the sheet itself never sends home:requested', async () => {
    await boot('#/dot/a1')
    const { Sheet } = await import('../ui/Sheet')
    let closed = 0
    desktop = false
    const el = render('sheet', Sheet, { label: 'Mind', onClose: () => closed++, children: null })
    escape!()
    const dragged = find(el, (e) => typeof e.props?.onDragEnd === 'function')
    ;(dragged.props!.onDragEnd as (e: unknown, i: unknown) => void)({}, { offset: { y: 400 }, velocity: { y: 0 } })
    expect([closed, heard]).toEqual([2, 0])
    desktop = true
  })
})

describe('the mind panel and Create a mind, rendered', { timeout: 30_000 }, () => {
  const agent = { id: 'a1', name: 'Juniper', hue: 200, model: 'synthetic/model', status: 'awake', kind: 'omega', swarm_id: null, created_at: '2026-10-08T00:00:00Z' }

  it('mind panel: Esc and the drag (the Sheet’s onClose) leave without home:requested; the X sends it', async () => {
    await boot('#/')
    const { useHive } = await import('../store/store')
    useHive.setState({ agents: { a1: agent } as never, ready: true } as never)
    const { default: DotPanel } = await import('../features/dot/DotPanel')
    r.navigate({ name: 'tasks' })
    r.navigate({ name: 'dot', id: 'a1' })
    const el = render('dot', DotPanel as never, { id: 'a1' })
    const sheet = el as El
    ;(sheet.props!.onClose as () => void)() // Esc / drag
    expect([b.location.hash, heard]).toEqual(['#/', 0])
    r.navigate({ name: 'dot', id: 'a1' })
    const header = sheet.props!.header as El
    const headerEl = render('dot-header', header.type as (p: unknown) => unknown, header.props)
    ;(find(headerEl, byLabel('Close panel')).props!.onClick as () => void)() // the X
    expect([b.location.hash, heard]).toEqual(['#/', 1])
  })

  it('Create a mind: the Sheet’s onClose (Esc / drag) sends nothing; the X (Cancel) sends home:requested', async () => {
    await boot('#/')
    const { default: CreateFlow } = await import('../features/create/CreateFlow')
    r.navigate({ name: 'new' })
    const el = render('create', CreateFlow as never, {}) as El
    const sheet = find(el, (e) => e.props?.label === 'Create a mind')
    ;(sheet.props!.onClose as () => void)()
    expect([b.location.hash, heard]).toEqual(['#/', 0])
    r.navigate({ name: 'new' })
    ;(find(sheet.props!.header, byLabel('Cancel')).props!.onClick as () => void)()
    expect([b.location.hash, heard]).toEqual(['#/', 1])
  })
})

describe('Canvas conversation, rendered', { timeout: 30_000 }, () => {
  const agent = { id: 'a1', name: 'Juniper', hue: 200, model: 'synthetic/model', status: 'awake', kind: 'omega', swarm_id: null, created_at: '2026-10-08T00:00:00Z' }
  const rect = { x: 0, y: 0, w: 100, h: 100 }
  async function conversation(props: Parameters<typeof import('../experiences/canvas/chat').ChatCard>[0]) {
    const {CanvasActionBoundary}=await import('../experiences/canvas/actionAuthority')
    const owner=render('canvas-owner',CanvasActionBoundary,{children:null})
    ;(owner.type as unknown as {_currentValue:unknown})._currentValue=(owner.props as {value:unknown}).value
    const {ChatCard}=await import('../experiences/canvas/chat')
    return render('chat',ChatCard,props)
  }


  it('Esc closes just the conversation; the X goes home with home:requested', async () => {
    await boot('#/')
    let dismissed = 0
    const props = { r: rect, agent: agent as never, phase: undefined, now: 0, reduced: true, onCloseX: r.closeToHome, onDismiss: () => dismissed++ }
    const el = await conversation(props)
    const root = find(el, (e) => e.props?.role === 'dialog')
    ;(root.props!.onKeyDown as (e: unknown) => void)({ key: 'Escape', preventDefault: () => undefined, stopPropagation: () => undefined })
    expect([dismissed, heard, b.location.hash]).toEqual([1, 0, '#/'])
    r.navigate({ name: 'tasks' })
    ;(find(el, byLabel('Close the conversation')).props!.onClick as () => void)()
    expect([dismissed, heard, b.location.hash]).toEqual([1, 1, '#/'])
  })

  it('a typed draft survives: type, Open full page, the page’s X (home:requested closes the card), reopen: intact', async () => {
    await boot('#/')
    const { Page } = await import('../ui/Page')
    const props = { r: rect, agent: agent as never, phase: undefined, now: 0, reduced: true, onCloseX: r.closeToHome, onDismiss: () => undefined }
    let el = await conversation(props)
    const box = () => find(el, (e) => e.type === 'textarea')
    ;(box().props!.onChange as (e: unknown) => void)({ target: { value: 'half a thought' } })
    el = await conversation(props)
    expect(box().props!.value).toBe('half a thought')
    ;(find(el, byLabel('Open the full page for this mind')).props!.onClick as () => void)()
    expect(b.location.hash).toBe('#/dot/a1')
    unmount('chat') // home:requested: Canvas clears openId, MindSlot swaps the card for the mind's tile
    const page = render('page', Page, { title: 'Juniper', label: 'Mind', children: null })
    ;(find(page, byLabel('Close')).props!.onClick as () => void)()
    expect([b.location.hash, heard]).toEqual(['#/', 1])
    el = await conversation(props) // reopened
    expect(box().props!.value).toBe('half a thought')
  })
})

describe('every experience’s conversation keeps its draft across the reset', { timeout: 30_000 }, () => {
  it.each([
    ['canvas', '../experiences/canvas/chat.tsx', /useDraft\(`canvas:mind:\$\{agent\.id\}`\)/],
    ['flux', '../experiences/flux/panels.tsx', /useDraft\(`flux:mind:\$\{id\}`\)/],
    ['cosmos', '../experiences/cosmos/Panels.tsx', /useDraft\(`cosmos:mind:\$\{id\}`\)/],
    ['construct', '../experiences/construct/Panes.tsx', /useDraft\(`construct:mind:\$\{id\}`\)/],
    ['still', '../experiences/still/Reading.tsx', /useDraft\(`still:mind:\$\{id\}`\)/],
    ['professional', '../experiences/professional/Conversation.tsx', /useDraft\(`professional:mind:\$\{id\}`\)/],
  ])('%s: the composer keeps its words in the draft store', async (_x, file, re) => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
    expect(fs.readFileSync(new URL(file, import.meta.url), 'utf8')).toMatch(re)
  })
})
