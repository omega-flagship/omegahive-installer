import { beforeEach, describe, expect, it, vi } from 'vitest'
import { omegaDesign } from '../../api/sim/omegadesign'
import type { WorkGraph } from '../../api/types'
import { addImage, current, isDirty, openDoc, readSource, type Doc } from './model'

// Review r3 R1 / Design r6 (adopted): the actual useCanvas hook, mounted and unmounted under a minimal React stand-in
// that runs each effect once at mount and its cleanup at unmount (StrictMode replay = cleanup then setup again).
// Pending Keep, load, delayed edit and picture work, and retained controls, after unmount. INVENTED sim designs.

const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  refs: [] as { current: unknown }[],
  ri: 0,
  effects: [] as { fn: () => unknown; cleanup?: unknown; ran: boolean }[],
  ei: 0,
  doc: null as unknown,
  listeners: new Set<() => void>(),
  navigate: [] as unknown[],
  confirm: null as null | ((ok: boolean) => void),
  created: 0,
  /** when set, the canvas's native commit (nextRevision) waits for it: a commit pending across unmount */
  gate: null as null | Promise<void>,
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
  useEffect: (fn: () => unknown) => {
    const i = h.ei++
    if (!h.effects[i]) h.effects[i] = { fn, ran: false }
    else h.effects[i].fn = fn
  },
}))
const client = { onAuthChange: (l: () => void) => (h.listeners.add(l), () => h.listeners.delete(l)) }
vi.mock('../../store/store', () => ({ useHive: (fn: (s: unknown) => unknown) => fn({ client, session: 's1' }) }))
vi.mock('../../lib/router', async (importOriginal) => ({ ...(await importOriginal<object>()), navigate: (r: unknown) => h.navigate.push(r) }))
vi.mock('../../ui/confirm', () => ({ askConfirm: () => new Promise<boolean>((r) => (h.confirm = r)) }))
vi.mock('./model', async (importOriginal) => {
  const m = await importOriginal<typeof import('./model')>()
  return { ...m, nextRevision: async (...a: Parameters<typeof m.nextRevision>) => { const r = await m.nextRevision(...a); if (h.gate) await h.gate; return r } }
})
vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout, clearTimeout, location: { search: '' } })
vi.stubGlobal('document', { createElement: () => (h.created++, { click: () => undefined, remove: () => undefined }), body: { appendChild: () => undefined } })
vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined })

import { useCanvas, type CanvasProps } from './useCanvas'

const canvasOf = useCanvas
const REF = (artifact: string, revision = 1, c = 'a') => ({ artifact_id: artifact, revision, digest: 'sha256:' + c.repeat(64) })
function design() {
  const graph = omegaDesign().view({} as never, `studio-source:${JSON.stringify(REF('ar_simstarter'))}`, 'unfold') as unknown as WorkGraph
  const got = readSource({ ...graph, links: [], groups: [], notes: [] })
  if (got.kind !== 'studio') throw new Error('fixture')
  return got
}
const deferred = <T,>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const tick = () => new Promise((r) => setTimeout(r, 0))
let props: CanvasProps
let dirty: boolean[]
const render = () => {
  h.index = 0
  h.ri = 0
  h.ei = 0
  return canvasOf(props)
}
/** mount: render, then run every effect not yet run (setups) */
const mount = () => {
  const c = render()
  for (const e of h.effects) if (!e.ran) { e.ran = true; e.cleanup = e.fn() }
  return c
}
const unmount = () => {
  for (const e of [...h.effects].reverse()) if (e.ran) { e.ran = false; if (typeof e.cleanup === 'function') (e.cleanup as () => void)() }
}
const docNow = () => h.refs[0].current as Doc | null
const snapshot = () => JSON.stringify(h.slots.map((s) => (typeof s === 'function' ? 'fn' : s)))

beforeEach(() => {
  const got = design()
  h.doc = openDoc(got.source, got.reference)
  Object.assign(h, { slots: [], refs: [], effects: [], navigate: [], confirm: null, created: 0 })
  h.listeners.clear()
  dirty = []
  props = { source: got.reference, scope: 's_lyra', onDirty: (d: boolean) => dirty.push(d), act: async () => ({ status: 'done' }) } as unknown as CanvasProps
})

describe('after unmount nothing local is written, and owned listeners are released', () => {
  it('a pending Keep: its later answer neither adopts, navigates, reports clean nor publishes a notice or receipt', async () => {
    const a = deferred<unknown>()
    const send = vi.fn(() => a.promise)
    props.act = send as never
    const c = mount()
    await c.commit([{ op: 'set', element: 'kicker', patch: { text: 'MINE' } }])
    const keeping = render().keep()
    expect(send).toHaveBeenCalledTimes(1)   // already posted: the host has it (Design's custody), whatever the canvas does next
    expect(h.listeners.size).toBeGreaterThan(0)
    unmount()
    expect(h.listeners.size).toBe(0)
    const before = snapshot()
    const reportsBefore = dirty.length
    a.resolve({ status: 'done', data: { output: REF('ar_simstarter', 2, 'b') } })
    await keeping
    expect(snapshot()).toBe(before)
    expect(docNow()).toBeNull()
    expect(h.navigate).toHaveLength(0)
    expect(dirty.slice(reportsBefore)).not.toContain(false)
  })
  it('a pending load: its answer is dropped and its listener released at unmount', async () => {
    h.doc = null
    const v = deferred<unknown>()
    props.view = (() => v.promise) as never
    mount()   // the source effect starts the read
    expect(h.listeners.size).toBe(1)
    unmount()
    expect(h.listeners.size).toBe(0)
    const before = snapshot()
    v.resolve(omegaDesign().view({} as never, `studio-source:${JSON.stringify(REF('ar_simstarter'))}`, 'unfold'))
    await tick()
    expect(snapshot()).toBe(before)
    expect(docNow()).toBeNull()
  })
  it('delayed local work (a picture still being read) begun before unmount commits nothing', async () => {
    const c = mount()
    const fence = c.generation()
    unmount()
    const scene = current(h.doc as Doc).scene
    expect(await c.commit([addImage(scene, { x: 0, y: 0 }, 'data:image/png;base64,iVBORw0KGgo=', 'photo.png')], { generation: fence })).toBe(false)
    expect(docNow()).toBeNull()
  })
  it('a picture whose confirm is answered after unmount is not saved and records nothing', async () => {
    const c = mount()
    const saving = c.download()
    await tick()
    unmount()
    const before = snapshot()
    h.confirm!(true)
    await saving
    expect(h.created).toBe(0)
    expect(snapshot()).toBe(before)
  })
  it('retained controls refuse after unmount: commit, keep, undo, select, notices', async () => {
    const send = vi.fn(async () => ({ status: 'done' }))
    props.act = send as never
    const c = mount()
    unmount()
    const before = snapshot()
    expect(await c.commit([{ op: 'set', element: 'kicker', patch: { text: 'LATE' } }])).toBe(false)
    await c.keep()
    c.undo()
    c.select('kicker')
    c.setNotice({ text: 'late', tone: 'ok' })
    c.setMode('deliver')
    expect(send).not.toHaveBeenCalled()
    expect(snapshot()).toBe(before)
  })
  it('StrictMode replay: work begun before the replay is withdrawn; the same mount keeps working after it', async () => {
    const c = mount()
    const fence = c.generation()
    unmount()
    mount()   // the replayed setup
    await tick()   // the replay publishes fresh controls (stand-in r4 B1: retired ones stay retired)
    const scene = current(h.doc as Doc).scene
    expect(await render().commit([addImage(scene, { x: 0, y: 0 }, 'data:image/png;base64,iVBORw0KGgo=', 'photo.png')], { generation: fence })).toBe(false)
    // the replay cleared the doc ref, so the canvas reads the design again (the source effect); edits work after that
    props.view = (async () => omegaDesign().view({} as never, `studio-source:${JSON.stringify(REF('ar_simstarter'))}`, 'unfold')) as never
    await render().retry()
    expect(await c.commit([{ op: 'set', element: 'kicker', patch: { text: 'RETIRED CONTROL' } }])).toBe(false)   // pre-replay control
    expect(await render().commit([{ op: 'set', element: 'kicker', patch: { text: 'AFTER REPLAY' } }])).toBe(true)   // fresh control
    expect(isDirty(docNow()!)).toBe(true)
  })
  it('r3: the empty canvas keeps its recent designs when a StrictMode re-render gives a new view and the source effect reruns', async () => {
    h.doc = null
    props = { ...props, source: undefined, view: (async () => ({})) as never }
    const list = deferred<unknown[]>()
    const recent = [{ artifact_id: 'ar_simposter', kind: 'studio-source', title: 'Invented poster', revision: 1, digest: 'sha256:' + 'd'.repeat(64), created_at: 'c', revised_at: 'r' }]
    Object.assign(client, { swarmArtifacts: () => list.promise })
    try {
      mount()
      unmount()
      mount()   // the replayed setup: the list is read again
      await tick()
      // the replay's re-render hands the canvas a new `view`, so the source effect (and only it) runs again
      props = { ...props, view: (async () => ({})) as never }
      render()
      const source = h.effects.find((e) => String(e.fn).includes('sameCreation'))!
      if (typeof source.cleanup === 'function') (source.cleanup as () => void)()
      source.cleanup = source.fn()
      list.resolve(recent)
      await tick()
      expect(render().recent).toEqual(recent)
    } finally {
      delete (client as { swarmArtifacts?: unknown }).swarmArtifacts
    }
  })
  it('stand-in r4 B1 probe: a control retired by unmount stays retired after a StrictMode replay (an old select)', async () => {
    const c = mount()
    unmount()
    c.select('kicker')
    expect(h.slots[2]).toBeNull()   // refused after cleanup
    mount()   // the replayed setup
    await tick()
    c.select('kicker')
    expect(h.slots[2]).toBeNull()   // the old select must not work again
    c.setMode('deliver')
    c.setNotice({ text: 'late', tone: 'ok' })
    expect(h.slots[3]).toBe('make')
    expect(h.slots[5]).toBeNull()
    render().select('kicker')   // a control from a render after the replay works
    expect(h.slots[2]).toBe('kicker')
  })
  it('stand-in r4 R1: a native commit pending when the canvas unmounts publishes nothing when it resolves', async () => {
    const c = mount()
    let open!: () => void
    h.gate = new Promise<void>((r) => (open = r))
    const pending = c.commit([{ op: 'set', element: 'kicker', patch: { text: 'PENDING AT UNMOUNT' } }], { select: 'kicker', say: 'Changed.' })
    await tick()
    expect(h.slots[7]).toBe('committing')
    unmount()
    const before = snapshot()
    open()
    expect(await pending).toBe(false)
    h.gate = null
    expect(snapshot()).toBe(before)   // no document, selection, notice or busy publication
    expect(docNow()).toBeNull()
  })
})

describe('Keep wire: Design’s source-save helper, refused locally when too large', () => {
  it('a version over the 2 MB confirmation envelope is not sent, holds nothing, and says what to do in plain words', async () => {
    const send = vi.fn(async () => ({ status: 'done' }))
    props.act = send as never
    const c = mount()
    const scene = current(h.doc as Doc).scene
    // an embedded picture of about 2.3 MB (native-valid base64): the source is valid, the confirmation envelope is not
    expect(await c.commit([addImage(scene, { x: 0, y: 0 }, `data:image/png;base64,${'A'.repeat(2_400_000)}`, 'big.png')])).toBe(true)
    await render().keep()
    expect(send).not.toHaveBeenCalled()
    expect(docNow()!.hold ?? null).toBeNull()
    expect((h.slots[5] as { text: string }).text).toBe('This version is larger than the hive’s 2 MB confirmation limit, so it was not sent. Remove or shrink a picture, then keep it again.')
    expect(isDirty(docNow()!)).toBe(true)
  })
})
