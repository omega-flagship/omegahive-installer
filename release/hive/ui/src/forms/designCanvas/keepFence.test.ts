import { beforeEach, describe, expect, it, vi } from 'vitest'
import { omegaDesign } from '../../api/sim/omegadesign'
import type { WorkGraph } from '../../api/types'
import { current, isDirty, openDoc, readSource, type Doc } from './model'

// Review B2 (b49856c r2 verdict): every delayed answer in the canvas is fenced, synchronously, by the identity it began
// under: the store session and the client's sign-in (authContext, read at the moment of adoption) plus every sign-in
// change the client reported meanwhile (onAuthChange, so A→B→A on the same handle is still a change). Finalisation is
// owned by the operation. The actual useCanvas hook under the same React stand-in as keepRace.test.ts, here with a store
// that has getState (the app's path). INVENTED sim designs only.

const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  refs: [] as { current: unknown }[],
  ri: 0,
  doc: null as unknown,
  state: { client: null as unknown, session: 's1' },
  navigate: [] as unknown[],
  confirm: null as null | ((ok: boolean) => void),
  downloads: 0,
}))
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useState: (initial: unknown) => {
    const i = h.index++
    if (!(i in h.slots)) h.slots[i] = i === 1 ? h.doc : typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [h.slots[i], (v: unknown) => { h.slots[i] = typeof v === 'function' ? (v as (p: unknown) => unknown)(h.slots[i]) : v }]
  },
  useRef: (initial: unknown) => {
    const i = h.ri++
    return h.refs[i] ?? (h.refs[i] = { current: i === 0 ? h.doc : initial })
  },
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => unknown) => { fn() },
}))
vi.mock('../../store/store', () => ({ useHive: Object.assign((fn: (s: unknown) => unknown) => fn(h.state), { getState: () => h.state }) }))
vi.mock('../../lib/router', async (importOriginal) => ({ ...(await importOriginal<object>()), navigate: (r: unknown) => h.navigate.push(r) }))
vi.mock('../../ui/confirm', () => ({ askConfirm: () => new Promise<boolean>((r) => (h.confirm = r)) }))
vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout, clearTimeout, location: { search: '' } })
vi.stubGlobal('document', { createElement: () => ({ click: () => h.downloads++, remove: () => undefined }), body: { appendChild: () => undefined } })
vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined })

import { useCanvas, type CanvasProps } from './useCanvas'

/** The hook, called the way the stand-in renders it. */
const canvasOf = useCanvas

const REF = (artifact: string, revision = 1, c = 'a') => ({ artifact_id: artifact, revision, digest: 'sha256:' + c.repeat(64) })
const SAVED = (rev = 2) => ({ status: 'done' as const, data: { output: REF('ar_simstarter', rev, 'b') } })
const deferred = <T,>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const docNow = () => h.refs[0].current as Doc
const notice = () => h.slots[5] as { text: string } | null
const receipts = () => h.slots[6] as unknown[]
const busy = () => h.slots[7]

/** One client whose sign-in handle can change, reporting each change the way the live client does. */
function signInClient(first: object) {
  let handle = first
  const listeners = new Set<() => void>()
  return {
    client: { authContext: () => handle, onAuthChange: (l: () => void) => (listeners.add(l), () => listeners.delete(l)) },
    signIn(next: object, report = true) {
      handle = next
      if (report) listeners.forEach((l) => l())
    },
  }
}

let props: CanvasProps
const render = () => {
  h.index = 0
  h.ri = 0
  return canvasOf(props)
}
beforeEach(() => {
  const graph = omegaDesign().view({} as never, `studio-source:${JSON.stringify(REF('ar_simstarter'))}`, 'unfold') as unknown as WorkGraph
  const got = readSource({ ...graph, links: [], groups: [], notes: [] })
  if (got.kind !== 'studio') throw new Error('fixture')
  h.doc = openDoc(got.source, got.reference)
  h.slots = []
  h.refs = []
  h.navigate = []
  h.downloads = 0
  h.confirm = null
  h.state = { client: null, session: 's1' }
  props = { source: got.reference, scope: 's_lyra', onDirty: () => undefined, act: async () => ({ status: 'done' }) } as unknown as CanvasProps
})

describe('a Keep is fenced by the sign-in it began under, at the moment its answer arrives', () => {
  it('A→B→A on the same client and the same handle: the Keep started under the first A adopts nothing', async () => {
    const A = {}
    const s = signInClient(A)
    h.state.client = s.client
    const a = deferred<unknown>()
    props.act = (() => a.promise) as never
    const keeping = render().keep()
    const held = docNow()
    s.signIn({})
    s.signIn(A)   // back to the very same handle: only the reported changes show it happened
    a.resolve(SAVED())
    await keeping
    expect(docNow()).toBe(held)
    expect(docNow().reference).toEqual(REF('ar_simstarter'))
    expect(h.navigate).toHaveLength(0)
    expect(notice()).toBeNull()
    expect(receipts()).toEqual([])
  })
  it('A→B→A with fresh handles and no render or effect in between: no adoption', async () => {
    const s = signInClient({})
    h.state.client = s.client
    const a = deferred<unknown>()
    props.act = (() => a.promise) as never
    const keeping = render().keep()
    const held = docNow()
    s.signIn({}, false)
    s.signIn({}, false)   // unreported changes: the handle read at adoption differs from the captured one
    a.resolve(SAVED())
    await keeping
    expect(docNow()).toBe(held)
  })
  it('the store session changed (a re-init) with no render: no adoption', async () => {
    const s = signInClient({})
    h.state.client = s.client
    const a = deferred<unknown>()
    props.act = (() => a.promise) as never
    const keeping = render().keep()
    const held = docNow()
    h.state = { ...h.state, session: 's2' }
    a.resolve(SAVED())
    await keeping
    expect(docNow()).toBe(held)
  })
  it('after a sign-in change a replacement Keep may start; the old answer neither adopts nor finishes the new one', async () => {
    const s = signInClient({})
    h.state.client = s.client
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    props.act = send as never
    const k1 = render().keep()
    s.signIn({})
    const k2 = render().keep()
    expect(send).toHaveBeenCalledTimes(2)
    first.resolve(SAVED(2))
    await k1
    expect(busy()).toBe('saving')   // still the replacement's
    expect(docNow().reference).toEqual(REF('ar_simstarter'))
    second.resolve(SAVED(3))
    await k2
    expect(busy()).toBeNull()
    expect(docNow().reference).toEqual(REF('ar_simstarter', 3, 'b'))
    expect(isDirty(docNow())).toBe(false)
  })
  it('the design closed (no source) during the Keep: nothing adopted, and the lock is released for the next one', async () => {
    const a = deferred<unknown>()
    const send = vi.fn(() => a.promise)
    props.act = send as never
    const keeping = render().keep()
    props.source = undefined
    render()
    a.resolve(SAVED())
    await keeping
    expect(h.navigate).toHaveLength(0)
    expect(busy()).toBeNull()
  })
})

describe('every other delayed callback is fenced the same way', () => {
  it('an edit begun before a sign-in change (a picture still being read) does not land and publishes nothing', async () => {
    const s = signInClient({})
    h.state.client = s.client
    const c = render()
    const token = c.generation()
    const before = docNow()
    s.signIn({})
    expect(await render().commit([{ op: 'set', element: 'kicker', patch: { text: 'LATE' } }], { generation: token })).toBe(false)
    expect(docNow()).toBe(before)
    expect(notice()).toBeNull()
  })
  it('an edit whose native revision is computed across a sign-in change does not land', async () => {
    const s = signInClient({})
    h.state.client = s.client
    const c = render()
    const editing = c.commit([{ op: 'set', element: 'kicker', patch: { text: 'MID' } }])
    s.signIn({})
    expect(await editing).toBe(false)
    expect(current(docNow()).scene.elements.find((e) => e.id === 'kicker')?.text).toBe('AN EVENING FOR NEIGHBOURS')
    expect(notice()).toBeNull()
  })
  it('a picture confirmed after a sign-in change is not saved and records nothing', async () => {
    const s = signInClient({})
    h.state.client = s.client
    const saving = render().download()
    s.signIn({})
    h.confirm!(true)
    await saving
    expect(h.downloads).toBe(0)
    expect(receipts()).toEqual([])
  })
  it('a picture confirmed under the same sign-in is saved, and its receipt says it is an unverified mirror', async () => {
    h.state.client = signInClient({}).client
    const saving = render().download()
    h.confirm!(true)
    await saving
    expect(h.downloads).toBe(1)
    expect(JSON.stringify(receipts())).toMatch(/unverified mirror/)
  })
  it('a design read that answers after a sign-in change is dropped', async () => {
    const s = signInClient({})
    h.state.client = s.client
    const v = deferred<unknown>()
    props.view = (() => v.promise) as never
    const c = render()
    const before = docNow()
    const loading = c.retry()
    s.signIn({})
    v.resolve(omegaDesign().view({} as never, `studio-source:${JSON.stringify(REF('ar_simposter', 4))}`, 'unfold'))
    await loading
    expect(docNow()).toBe(before)
  })
})
