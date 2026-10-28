import { beforeEach, describe, expect, it, vi } from 'vitest'
import { omegaDesign } from '../../api/sim/omegadesign'
import type { WorkGraph } from '../../api/types'
import { canUndo, current, isDirty, openDoc, readSource, type Doc } from './model'

// Review B1 (b393fa8, release 0fef6666): a Keep adopts only what it actually saved, under the session and the design it
// ran under. The actual useCanvas hook under a minimal React stand-in (the review probe's pattern, here with effects run
// in order after each render so the identity fence is exercised), the real model, and INVENTED sim designs.

const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  refs: [] as { current: unknown }[],
  ri: 0,
  doc: null as unknown,
  client: { id: 'client-a' } as object | null,
  session: 's1',
  navigate: [] as unknown[],
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
vi.mock('../../store/store', () => ({ useHive: (fn: (s: unknown) => unknown) => fn({ client: h.client, session: h.session }) }))
vi.mock('../../lib/router', async (importOriginal) => ({ ...(await importOriginal<object>()), navigate: (r: unknown) => h.navigate.push(r) }))
vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout, clearTimeout, location: { search: '' } })

import { useCanvas, type CanvasProps } from './useCanvas'

/** The hook, called the way the stand-in renders it (outside React; the stand-in owns the slots). */
const canvasOf = useCanvas

const REF = (artifact: string, revision = 1, c = 'a') => ({ artifact_id: artifact, revision, digest: 'sha256:' + c.repeat(64) })
function design(artifact = 'ar_simstarter') {
  const graph = omegaDesign().view({} as never, `studio-source:${JSON.stringify(REF(artifact))}`, 'unfold') as unknown as WorkGraph
  const got = readSource({ ...graph, links: [], groups: [], notes: [] })
  if (got.kind !== 'studio') throw new Error('fixture')
  return got
}
const docNow = () => h.refs[0].current as Doc
const textOf = (d: Doc, id: string) => current(d).scene.elements.find((e) => e.id === id)?.text
const deferred = <T,>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const SAVED = { status: 'done' as const, data: { output: REF('ar_simstarter', 2, 'b') } }

let props: CanvasProps
let dirtyReports: boolean[]
const render = () => {
  h.index = 0
  h.ri = 0
  return canvasOf(props)
}
beforeEach(() => {
  const got = design()
  h.doc = openDoc(got.source, got.reference)
  h.slots = []
  h.refs = []
  h.navigate = []
  h.client = { id: 'client-a' }
  h.session = 's1'
  dirtyReports = []
  props = { source: got.reference, scope: 's_lyra', onDirty: (d: boolean) => dirtyReports.push(d), act: async () => ({ status: 'done' }) } as unknown as CanvasProps
})

describe('a Keep adopts exactly what it saved', () => {
  it('nothing changed while keeping: the kept revision becomes the base, the canvas is clean and moves to it', async () => {
    const a = deferred<unknown>()
    props.act = vi.fn(() => a.promise) as never
    const keeping = render().keep()
    a.resolve(SAVED)
    await keeping
    const d = docNow()
    expect(d.reference).toEqual(REF('ar_simstarter', 2, 'b'))
    expect(isDirty(d)).toBe(false)
    expect(dirtyReports.at(-1)).toBe(false)
    expect(h.navigate).toHaveLength(1)
  })
  it('an edit made while keeping survives the answer, stays not-kept, and the kept revision becomes its base', async () => {
    const a = deferred<unknown>()
    props.act = (() => a.promise) as never
    const c = render()
    const keeping = c.keep()
    expect(await c.commit([{ op: 'set', element: 'kicker', patch: { text: 'NEWER UNSAVED WORK' } }])).toBe(true)
    a.resolve(SAVED)
    await keeping
    const d = docNow()
    expect(textOf(d, 'kicker')).toBe('NEWER UNSAVED WORK')
    expect(isDirty(d)).toBe(true)
    expect(d.reference).toEqual(REF('ar_simstarter', 2, 'b'))   // the next Keep builds on the kept revision
    expect(current(d).revision).toBe(d.history[d.floor].revision + 1)
    expect(h.navigate).toHaveLength(0)   // no move: the host would otherwise ask to discard the newer work
    render()
    expect(dirtyReports.at(-1)).toBe(true)
    // undo goes back to the kept revision, never behind it
    render().undo()
    expect(isDirty(docNow())).toBe(false)
    expect(canUndo(docNow())).toBe(false)
    expect(textOf(docNow(), 'kicker')).toBe('AN EVENING FOR NEIGHBOURS')
    // the next Keep sends the newer work against the kept revision
    render().redo()
    const send = vi.fn(async () => ({ status: 'done', data: { output: REF('ar_simstarter', 3, 'c') } }))
    props.act = send as never
    await render().keep()
    const [, , wire] = send.mock.calls[0] as unknown as [string, string[], { source: unknown; editable_source_json: string }]
    const params = { source: wire.source, editable_source: JSON.parse(wire.editable_source_json) as { history: { digest: string }[] } }
    expect(params.source).toEqual(REF('ar_simstarter', 2, 'b'))
    expect(params.editable_source.history.map((r) => r.digest)).toContain(d.history[d.floor].digest)
    expect(isDirty(docNow())).toBe(false)
  })
  it('while a Keep is in flight, undo cannot reach behind the revision being kept (so its answer always finds it)', async () => {
    const a = deferred<unknown>()
    props.act = (() => a.promise) as never
    const c = render()
    expect(await c.commit([{ op: 'set', element: 'kicker', patch: { text: 'ONE' } }])).toBe(true)
    const keeping = render().keep()
    render().undo()
    expect(textOf(docNow(), 'kicker')).toBe('ONE')
    a.resolve(SAVED)
    await keeping
    expect(isDirty(docNow())).toBe(false)
    expect(textOf(docNow(), 'kicker')).toBe('ONE')
  })
})

describe('a Keep that does not land keeps the work and says so', () => {
  it('two Keeps: the second waits for the first (one send), and says so plainly', async () => {
    const a = deferred<unknown>()
    const send = vi.fn(() => a.promise)
    props.act = send as never
    const first = render().keep()
    await render().keep()
    expect(send).toHaveBeenCalledTimes(1)
    expect((h.slots[5] as { text: string } | null)?.text).toBe('A version is already being kept. Wait for it to finish, then keep again.')
    a.resolve(SAVED)
    await first
    expect(isDirty(docNow())).toBe(false)
  })
  it('refused: the work and any newer edit stay, not marked kept, in one plain sentence', async () => {
    const a = deferred<unknown>()
    props.act = (() => a.promise) as never
    const c = render()
    await c.commit([{ op: 'set', element: 'kicker', patch: { text: 'MINE' } }])
    const keeping = render().keep()
    await render().commit([{ op: 'set', element: 'kicker', patch: { text: 'MINE, LATER' } }])
    a.resolve({ status: 'refused', message: 'named person required' })
    await keeping
    expect(textOf(docNow(), 'kicker')).toBe('MINE, LATER')
    expect(isDirty(docNow())).toBe(true)
    expect(docNow().reference).toEqual(design().reference)
    expect(docNow().hold ?? null).toBeNull()
    expect((h.slots[5] as { text: string }).text).toBe('Keeping a version needs a signed-in person. Sign in, then keep it again.')
    render()
    expect(dirtyReports.at(-1)).toBe(true)
  })
  it('unknown: the work stays, nothing is marked kept, and the person is told to check before keeping again', async () => {
    props.act = (async () => ({ status: 'error', message: 'timeout', unknown: true })) as never
    await render().commit([{ op: 'set', element: 'kicker', patch: { text: 'MINE' } }])
    await render().keep()
    expect(textOf(docNow(), 'kicker')).toBe('MINE')
    expect(isDirty(docNow())).toBe(true)
    expect((h.slots[5] as { text: string }).text).toMatch(/did not say whether this version was kept/)
    expect(h.navigate).toHaveLength(0)
  })
})

describe('a late Keep answer is fenced to the design and the session it ran under', () => {
  it('another design opened during the Keep: its answer never touches the new design', async () => {
    const a = deferred<unknown>()
    props.act = (() => a.promise) as never
    props.view = (async () => omegaDesign().view({} as never, `studio-source:${JSON.stringify(REF('ar_simposter', 4))}`, 'unfold')) as never
    const keeping = render().keep()
    props.source = REF('ar_simposter', 4)
    await render().retry()   // the canvas reads the other design (as a source change does)
    await new Promise((r) => setTimeout(r, 0))
    const opened = docNow()
    expect(opened.reference.artifact_id).toBe('ar_simposter')
    a.resolve(SAVED)
    await keeping
    expect(docNow()).toBe(opened)
    expect(h.navigate).toHaveLength(0)
  })
  it('the session changed during the Keep: the old answer writes nothing at all', async () => {
    const a = deferred<unknown>()
    props.act = (() => a.promise) as never
    await render().commit([{ op: 'set', element: 'kicker', patch: { text: 'MINE' } }])
    const keeping = render().keep()
    const before = docNow()
    h.session = 's2'   // a sign-in change re-inits the store session
    render()
    const notice = h.slots[5]
    a.resolve(SAVED)
    await keeping
    expect(docNow().reference).toEqual(before.reference)
    expect(textOf(docNow(), 'kicker')).toBe('MINE')
    expect(h.slots[5]).toBe(notice)
    expect(h.navigate).toHaveLength(0)
    render()
    expect(dirtyReports.at(-1)).toBe(true)
  })
  it('a delayed edit (a picture still being read) is fenced to the design it started on', async () => {
    const c = render()
    const gen = c.generation()
    props.source = REF('ar_simposter', 4)
    props.view = (async () => omegaDesign().view({} as never, `studio-source:${JSON.stringify(REF('ar_simposter', 4))}`, 'unfold')) as never
    await render().retry()
    await new Promise((r) => setTimeout(r, 0))
    const opened = docNow()
    expect(await render().commit([{ op: 'set', element: 'kicker', patch: { text: 'LATE' } }], { generation: gen })).toBe(false)
    expect(docNow()).toBe(opened)
  })
})

 it('Review: synchronous auth generation change fences a delayed Keep without waiting for render/effects', async () => {
    let auth = {}
    h.client = {authContext: () => auth}
    const a = deferred<unknown>()
    props.act = (() => a.promise) as never
    const keeping = render().keep()
    const held = docNow()
    auth = {} // same client, another sign-in; no React effect has run yet
    a.resolve(SAVED)
    await keeping
    expect(docNow()).toBe(held)
    expect(h.navigate).toHaveLength(0)
  })
