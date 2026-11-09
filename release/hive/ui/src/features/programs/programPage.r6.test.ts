import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useEffect } from 'react'
import type { CreationReference } from '../../lib/router'
import { MiniDocument, press, type MiniNode } from '../../ui/miniDom.testkit'
import { DISCARD_LABEL } from './viewLink'

/**
 * followups-r6 item 6 (Kimi r5 #4, stand-in r5 #1): ProgramPage MOUNTED (react-dom on ui/miniDom.testkit, so its
 * effects run), with its app frame, menus and host faked. The unsaved-edits question:
 * - one route event with a new source AND the graph view asks ONE question, worded for both;
 * - declined, the frame on screen (the canvas) is unchanged: same instance, same creation, graph view not opened, and
 *   the route goes back to it;
 * - an identity change or an unmount while it is open settles it safely: answered no, and nothing acts afterwards
 *   (no navigation back to the app, no view switch).
 * INVENTED data only.
 */

// ---- the page's surroundings, faked: what the frame was given, and every navigation asked for

const frames: { mount: number; source: CreationReference | undefined; onDirty: (d: boolean) => void; alive: boolean }[] = []
const navigations: unknown[] = []

vi.mock('./AppFrame', () => ({
  AppFrame: (p: { source?: CreationReference; onDirty: (d: boolean) => void }) => {
    useEffect(() => {
      const f = { mount: frames.length + 1, source: p.source, onDirty: p.onDirty, alive: true }
      frames.push(f)
      return () => { f.alive = false }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- one record per mounted frame
    }, [])
    return createElement('div', { 'data-frame': JSON.stringify(p.source ?? null) })
  },
}))
vi.mock('./ProgramHost', () => ({ default: () => createElement('div', { 'data-host': '' }) }))
// r7.1: the native form, recorded like the frame (its unmount is the canvas document and history being lost)
const forms: { mount: number; onDirty?: (d: boolean) => void; alive: boolean }[] = []
vi.mock('./ProgramForm', () => ({
  ProgramForm: (p: { onDirty?: (d: boolean) => void }) => {
    useEffect(() => {
      const f = { mount: forms.length + 1, onDirty: p.onDirty, alive: true }
      forms.push(f)
      return () => { f.alive = false }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- one record per mounted form
    }, [])
    return createElement('div', { 'data-form': '' })
  },
}))
// r7.1: the View menu's items, so a test can choose Graph or Studio as a person does
const menu = vi.hoisted(() => ({ sections: [] as { title?: string; items: { label: string; run: () => void }[] }[] }))
// r7.1: a seam in the REAL askConfirmBound: `afterYes` runs right after a bound question has resolved "yes" and
// before the page's own continuation runs, so a test can change the identity in exactly that gap
const code = vi.hoisted(() => ({ pending: null as null | (() => void), requested: 0 }))
vi.mock('../flow/FlowPage', () => ({ FlowStudio: () => createElement('div', { 'data-flow-studio-fixture': '' }, 'Flow studio fixture'), default: () => null }))
vi.mock('../createPlan/PlanCanvas', () => ({ default: () => createElement('div', { 'data-plan-canvas-fixture': '' }, 'Make fixture') }))
vi.mock('../code/CreateCodeBench', () => ({ default: (props: { departure: { current: ((leave: () => void) => void) | null }; onBack: () => void }) => {
  useEffect(() => {
    const guard = (leave: () => void) => { code.pending = leave; code.requested++ }
    props.departure.current = guard
    return () => { if (props.departure.current === guard) props.departure.current = null }
  }, [props.departure])
  return createElement('div', { 'data-code-bench-fixture': '' }, 'Code bench fixture')
} }))
const seam = vi.hoisted(() => ({ afterYes: null as null | (() => void) }))
vi.mock('../../lib/identityEpoch', async (orig) => {
  const real = await orig<typeof import('../../lib/identityEpoch')>()
  return {
    ...real,
    askConfirmBound: (...a: Parameters<typeof real.askConfirmBound>) => real.askConfirmBound(...a).then((ok) => {
      if (ok && seam.afterYes) { const f = seam.afterYes; seam.afterYes = null; f() }
      return ok
    }),
  }
})
vi.mock('./AppActivity', () => ({ AppAccess: () => null }))
// Draw live R3: the press's Ask turn (held open by a test) and the picker (counted), with every other test unchanged
const draw = vi.hoisted(() => ({ record: null as null | ((...a: unknown[]) => Promise<unknown>), begin: null as null | ((...a: unknown[]) => Promise<void>), words: null as null | string }))
vi.mock('../studioLive/store', async (orig) => {
  const real = await orig<typeof import('../studioLive/store')>()
  return {
    ...real,
    recordDrawTurn: (...a: Parameters<typeof real.recordDrawTurn>) => (draw.record ? draw.record(...a) : real.recordDrawTurn(...a)) as ReturnType<typeof real.recordDrawTurn>,
    beginLiveStudio: (...a: Parameters<typeof real.beginLiveStudio>) => (draw.begin ? draw.begin(...a) : real.beginLiveStudio(...a)),
  }
})
vi.mock('../ask/useAskField', async (orig) => {
  const real = await orig<typeof import('../ask/useAskField')>()
  return { ...real, askFieldWords: () => draw.words ?? real.askFieldWords() }
})
vi.mock('../../experiences/OmegaMenu', () => ({ OmegaMenu: (p: { sections: typeof menu.sections }) => { menu.sections = p.sections; return null } }))
vi.mock('../../ui/useModalContainment', () => ({ useModalContainment: () => undefined }))
vi.mock('../../ui/primitives', () => ({
  Button: (p: { children?: unknown; onClick?: () => void }) => createElement('button', { onClick: p.onClick }, p.children as string),
  EmptyState: (p: { title?: string }) => createElement('div', { 'data-empty': p.title ?? '' }),
}))
vi.mock('../../lib/router', async (orig) => ({
  ...(await orig<typeof import('../../lib/router')>()),
  navigate: (r: unknown) => void navigations.push(r),
  closePage: () => undefined,
}))

// ---- a DOM for react-dom, installed for this file only

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
let doc: MiniDocument
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument()
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  const win = {
    document: doc,
    location: { hash: '', search: '', pathname: '/' },
    history: { state: null, replaceState: () => undefined, pushState: () => undefined },
    addEventListener: (t: string, f: (e: unknown) => void) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(f) },
    removeEventListener: (t: string, f: (e: unknown) => void) => void listeners.get(t)?.delete(f),
    dispatchEvent: () => true,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    HTMLIFrameElement: class {},
    innerWidth: 1440,
    innerHeight: 900,
  }
  doc.defaultView = win
  g.window = win
  g.document = doc
  g.HTMLIFrameElement = win.HTMLIFrameElement
  g.IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v
})

// ---- the page

const APP = 'invented-canvas'
const SWARM = 's_invented'
const A: CreationReference = { artifact_id: 'art_invented_a', revision: 1, digest: `sha256:${'a'.repeat(64)}` }
const B: CreationReference = { artifact_id: 'art_invented_b', revision: 2, digest: `sha256:${'b'.repeat(64)}` }

async function hive(client: object, app = APP) {
  const { useHive } = await import('../../store/store')
  useHive.setState({
    client: client as never,
    programs: [{ id: app, name: 'Invented canvas', description: '', enabled: true, ui: { entry: 'index.html' } }] as never,
    programDetails: { [app]: { describe: null } } as never,
    swarms: { [SWARM]: { id: SWARM, name: 'Invented swarm', description: '', hue: 120, member_ids: [], created_at: '2026-10-01T00:00:00Z' } } as never,
    agents: {},
  })
  return useHive
}

async function mount(props: { source?: CreationReference; view?: 'graph' | 'studio'; id?: string }) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { default: ProgramPage } = await import('./ProgramPage')
  const container = doc.body.appendChild(doc.createElement('div'))
  const root = createRoot(container as unknown as HTMLElement)
  const render = async (p: { source?: CreationReference; view?: 'graph' | 'studio'; id?: string }) => {
    await act(async () => root.render(createElement(ProgramPage, { id: APP, swarm: SWARM, ...p })))
  }
  await render(props)
  let gone = false
  const unmount = async () => {
    if (gone) return
    gone = true
    await act(async () => root.unmount())
  }
  mounted.push(unmount)
  return {
    act,
    render,
    container,
    unmount,
    dialogs: () => container.findAll((n) => n.getAttribute('role') === 'alertdialog'),
    button: (label: string) => container.findAll((n) => n.tagName === 'BUTTON' && n.textContent === label)[0] as MiniNode | undefined,
  }
}

const mounted: (() => Promise<void>)[] = []
// whether the app frame sits under a hidden part: MeTTa places it (program-stage) and the part that holds it is hidden
// under another view (hidden-when), so the hidden mark is on a wrapper above the frame, not always its parent
const hiddenAbove = (n: MiniNode): boolean => {
  for (let at = n.parentNode; at; at = at.parentNode) if (at.hasAttribute('hidden')) return true
  return false
}
// r7.1: the page's module graph is imported once here, with room for a loaded machine, so no test pays the cold import
// in its own 5 s (under load the first test took 7.9 s and every later one then failed behind it)
beforeAll(async () => {
  await import('./ProgramPage')
  await import('react-dom/client')
}, 60_000)
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) }

beforeEach(async () => {
  frames.length = 0
  forms.length = 0
  seam.afterYes = null
  navigations.length = 0
  await hive({})
})
afterEach(async () => {
  // a failed case never leaves its page (and its ConfirmHost) mounted for the next one
  for (const u of mounted.splice(0)) await u()
  const { useStudioLive } = await import('../studioLive/store')
  useStudioLive.setState({ ledger: null })
  vi.restoreAllMocks()
})

describe('item 6: the unsaved-edits question, on the mounted page', () => {
  it('a new creation and the graph view in one route event: ONE dialog, worded for both', async () => {
    const p = await mount({ source: A })
    expect(frames).toHaveLength(1)
    await p.act(async () => frames[0].onDirty(true))
    await p.render({ source: B, view: 'graph' })
    await p.act(flush)
    const shown = p.dialogs()
    expect(shown).toHaveLength(1)
    const text = shown[0].textContent
    expect(text).toMatch(/unsaved edits/)
    expect(text).toMatch(/opening another creation/i)
    expect(text).toMatch(/switching the view/i)
    // and nothing has been answered behind it: a second question would have cancelled the first, which then acts
    expect(navigations).toEqual([])
    expect(frames).toHaveLength(1)
    await p.unmount()
  })

  it('declined: the canvas is unchanged (same frame, same creation, no graph view) and the route goes back to it', async () => {
    const p = await mount({ source: A })
    await p.act(async () => frames[0].onDirty(true))
    await p.render({ source: B, view: 'graph' })
    await p.act(flush)
    await p.act(async () => press(p.button('Cancel')!))
    await p.act(flush)
    expect(p.dialogs()).toHaveLength(0)
    // the router puts the route back to the creation on screen (no ?view, no new source)
    expect(navigations.length).toBeGreaterThanOrEqual(1)
    for (const n of navigations) expect(n).toEqual({ name: 'program', id: APP, swarm: SWARM, source: A })
    await p.render({ source: A })
    await p.act(flush)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ alive: true, source: A })
    const frame = p.container.findAll((n) => n.hasAttribute('data-frame'))
    expect(frame).toHaveLength(1)
    expect(hiddenAbove(frame[0])).toBe(false)   // the graph view did not take its place
    expect(p.dialogs()).toHaveLength(0)                             // and nothing asks again
    await p.unmount()
  })

  it('accepted: the new creation opens and the graph view shows (the control case)', async () => {
    const p = await mount({ source: A })
    await p.act(async () => frames[0].onDirty(true))
    await p.render({ source: B, view: 'graph' })
    await p.act(flush)
    await p.act(async () => press(p.button('Discard and continue')!))
    await p.act(flush)
    expect(navigations).toEqual([])
    expect(frames.at(-1)).toMatchObject({ alive: true, source: B })
    const frame = p.container.findAll((n) => n.hasAttribute('data-frame'))
    expect(hiddenAbove(frame[0])).toBe(true)   // under the graph view
    await p.unmount()
  })

  it('unmounted while the question is open: it is answered no, and nothing acts afterwards', async () => {
    const p = await mount({ source: A })
    await p.act(async () => frames[0].onDirty(true))
    await p.render({ source: B, view: 'graph' })
    await p.act(flush)
    expect(p.dialogs()).toHaveLength(1)
    const { confirmShowing } = await import('../../ui/confirm')
    await p.unmount()
    await p.act(flush)
    expect(confirmShowing()).toBeNull()
    // no navigation back to the app it left, from either guard
    expect(navigations).toEqual([])
  })

  it('an identity change while the question is open: the page goes, the question is answered no, nothing acts for the old person', async () => {
    const p = await mount({ source: A })
    await p.act(async () => frames[0].onDirty(true))
    await p.render({ source: B, view: 'graph' })
    await p.act(flush)
    expect(p.dialogs()).toHaveLength(1)
    const { useHive } = await import('../../store/store')
    // another person: a new client; their app list is not read yet
    await p.act(async () => useHive.setState({ client: {} as never, programs: null as never, programDetails: {} }))
    await p.act(flush)
    const { confirmShowing } = await import('../../ui/confirm')
    expect(confirmShowing()).toBeNull()
    expect(p.dialogs()).toHaveLength(0)
    expect(frames.every((f) => !f.alive)).toBe(true)
    expect(navigations).toEqual([])
    await p.unmount()
  })
})

/**
 * followups-r7 item 1 (stand-in r6 P2 vs Kimi r6 #1): a SAME-CLIENT re-init (the store's `init` with the client it
 * already holds: `inits` + 1, the app list kept) is an identity change for the identity epoch (lib/identityEpoch:
 * the key is client, session AND inits), but it does not unmount the page. While the unsaved-edits question is open,
 * such a re-init must leave nothing for the earlier identity to act on: the question is answered no at once, and a
 * late answer (pressed after the re-init) neither opens the new creation, nor switches the view, nor navigates back.
 */
describe('followups-r7 item 1: a same-client re-init while the question is open', () => {
  // the smallest client the real store's init accepts: no events, and signed out (so init stops before reading)
  const sameClient = () => ({ onConnection: () => () => undefined, subscribe: () => () => undefined, needsAuth: () => true })

  async function openQuestionThenReinit() {
    const c = sameClient()
    const useHive = await hive(c)
    const p = await mount({ source: A })
    await p.act(async () => frames[0].onDirty(true))
    await p.render({ source: B, view: 'graph' })
    await p.act(flush)
    expect(p.dialogs()).toHaveLength(1)
    const { currentEpoch } = await import('../../lib/identityEpoch')
    const before = { epoch: currentEpoch(), inits: useHive.getState().inits }
    // the REAL store init with the SAME client: the page stays mounted (its app is still listed)
    await p.act(async () => { await useHive.getState().init(c as never) })
    await p.act(flush)
    expect(useHive.getState().client).toBe(c)
    expect(useHive.getState().inits).toBe(before.inits + 1)
    expect(currentEpoch()).toBeGreaterThan(before.epoch)          // the identity epoch moved
    expect(frames[0].alive).toBe(true)                            // and the page (with its frame) did not unmount
    return p
  }

  async function lateAnswer(p: Awaited<ReturnType<typeof mount>>, label: string) {
    // if a question is still on screen after the re-init, the person answers it now (late)
    const b = p.button(label)
    if (b) await p.act(async () => press(b))
    await p.act(flush)
  }

  function nothingActed(p: Awaited<ReturnType<typeof mount>>) {
    // r7.1: exactly ONE navigation: the fresh reconciliation putting the route back to what is on screen (A, no graph).
    // A stale restore would be a second one.
    expect(navigations).toEqual([{ name: 'program', id: APP, swarm: SWARM, source: A }])
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ alive: true, source: A })    // the new creation was not opened
    const frame = p.container.findAll((n) => n.hasAttribute('data-frame'))
    expect(frame).toHaveLength(1)
    expect(hiddenAbove(frame[0])).toBe(false) // the graph view did not open
  }

  it('the open question is answered no at once: nothing left on screen to answer for the earlier identity', async () => {
    const p = await openQuestionThenReinit()
    const { confirmShowing } = await import('../../ui/confirm')
    expect(confirmShowing()).toBeNull()
    expect(p.dialogs()).toHaveLength(0)
    nothingActed(p)
    await p.unmount()
  })

  it('a late "Discard and continue" after the re-init applies nothing (no new creation, no graph view)', async () => {
    const p = await openQuestionThenReinit()
    await lateAnswer(p, DISCARD_LABEL)
    nothingActed(p)
    await p.unmount()
  })

  it('a late "Cancel" after the re-init restores nothing (no navigation back)', async () => {
    const p = await openQuestionThenReinit()
    await lateAnswer(p, 'Cancel')
    nothingActed(p)
    await p.unmount()
  })

  it('a "Discard and continue" whose identity changes on its way in (every microtask step): all of it acts, or none', async () => {
    // The person's yes and the re-init race: the re-init lands k microtasks after the press, for k = 0..12, so it falls
    // before the bound question settles, between that and the guards, and after them. Each guard checks the epoch
    // immediately before it writes, so the page never ends half-switched (graph view over the old creation, or the
    // new creation with the route sent back), and never acts for the earlier identity after the change.
    const outcomes: string[] = []
    for (let k = 0; k <= 12; k++) {
      frames.length = 0
      navigations.length = 0
      const c = sameClient()
      const useHive = await hive(c)
      const p = await mount({ source: A })
      await p.act(async () => frames[0].onDirty(true))
      await p.render({ source: B, view: 'graph' })
      await p.act(flush)
      const yes = p.button(DISCARD_LABEL)!
      await p.act(async () => {
        press(yes)
        let chain: Promise<unknown> = Promise.resolve()
        for (let i = 0; i < k; i++) chain = chain.then(() => undefined)
        await chain.then(() => useHive.getState().init(c as never))
        await flush()
      })
      await p.act(flush)
      const frame = p.container.findAll((n) => n.hasAttribute('data-frame'))
      const graph = frame.length > 0 && hiddenAbove(frame[0])
      const opened = frames.at(-1)?.source === B
      expect({ k, graph, opened: opened }).toEqual({ k, graph: opened, opened })   // both or neither
      // r7.1: the route ends as what is on screen: acted, it already says B + graph (no navigation); stopped, the one
      // reconciliation puts it back to A
      expect(navigations, `k=${k}`).toEqual(opened ? [] : [{ name: 'program', id: APP, swarm: SWARM, source: A }])
      outcomes.push(opened ? 'acted' : 'none')
      await p.unmount()
    }
    // the race really was run on both sides: an early re-init stops it, a late one comes after it acted
    expect(outcomes[0]).toBe('none')
    expect(outcomes.at(-1)).toBe('acted')
  })

  it('control: without a re-init the same question still works (accepted: new creation and graph view)', async () => {
    await hive(sameClient())
    const p = await mount({ source: A })
    await p.act(async () => frames[0].onDirty(true))
    await p.render({ source: B, view: 'graph' })
    await p.act(flush)
    await p.act(async () => press(p.button(DISCARD_LABEL)!))
    await p.act(flush)
    expect(frames.at(-1)).toMatchObject({ alive: true, source: B })
    await p.unmount()
  })
})

/**
 * followups-r7.1 (stand-in r7 FIX-FIRST). After a SAME-CLIENT re-init (the real store init, the page kept):
 * - the route is put back to what is on screen by a fresh reconciliation under the current epoch (P2: it was stranded on
 *   ?source=B&view=graph while A stayed on screen), and never by the old question's continuation;
 * - the View menu's switch (BLOCKER, data loss): a late "Discard and switch" never switches the view, so the native
 *   form (and its canvas document and history) is never unmounted for the earlier identity.
 * `seam.afterYes` lands the re-init exactly between the bound question resolving "yes" and the page continuing.
 */
describe('followups-r7.1: the route after a re-init, and the View menu switch', () => {
  const sameClient = () => ({ onConnection: () => () => undefined, subscribe: () => () => undefined, needsAuth: () => true })
  const ROUTE_A = { name: 'program', id: APP, swarm: SWARM, source: A }
  const reinit = async (useHive: Awaited<ReturnType<typeof hive>>, c: object) => { await useHive.getState().init(c as never) }
  const graphShown = (p: Awaited<ReturnType<typeof mount>>) => {
    const frame = p.container.findAll((n) => n.hasAttribute('data-frame'))
    return frame.length > 0 && hiddenAbove(frame[0])
  }

  it('route: after the re-init the URL matches what is on screen, through one fresh reconciliation', async () => {
    const c = sameClient()
    const useHive = await hive(c)
    const p = await mount({ source: A })
    await p.act(async () => frames[0].onDirty(true))
    await p.render({ source: B, view: 'graph' })
    await p.act(flush)
    expect(p.dialogs()).toHaveLength(1)
    await p.act(async () => reinit(useHive, c))
    await p.act(flush)
    // the old question is cancelled, and the route is put back to what is shown: A, no graph view
    expect(p.dialogs()).toHaveLength(0)
    expect(navigations).toEqual([ROUTE_A])
    // the router follows it: the page, the URL and the screen agree, the edits are kept, nothing asks again
    await p.render({ source: A })
    await p.act(flush)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ alive: true, source: A })
    expect(graphShown(p)).toBe(false)
    expect(p.dialogs()).toHaveLength(0)
    expect(navigations).toEqual([ROUTE_A])
    await p.unmount()
  })

  it('route: the yes resolves, then the identity changes before the page continues: nothing acts, one reconciliation', async () => {
    const c = sameClient()
    const useHive = await hive(c)
    const p = await mount({ source: A })
    await p.act(async () => frames[0].onDirty(true))
    await p.render({ source: B, view: 'graph' })
    await p.act(flush)
    seam.afterYes = () => void reinit(useHive, c)
    await p.act(async () => press(p.button(DISCARD_LABEL)!))
    await p.act(flush)
    expect(seam.afterYes).toBeNull()   // the gap was really hit
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ alive: true, source: A })
    expect(graphShown(p)).toBe(false)
    expect(navigations).toEqual([ROUTE_A])
    await p.unmount()
  })

  it('route: a re-init with no question open and the route already matching the screen navigates nowhere', async () => {
    const c = sameClient()
    const useHive = await hive(c)
    const p = await mount({ source: A })
    await p.act(async () => reinit(useHive, c))
    await p.act(flush)
    expect(navigations).toEqual([])
    await p.unmount()
  })

  // ---- the native form under the View menu
  const FORM_APP = 'omegadesign'   // forms/contract FORM_OVER_FRAME: Surface's form over the app's own interface
  async function formPage(c: object) {
    const useHive = await hive(c)
    useHive.setState({
      programs: [{ id: FORM_APP, name: 'Invented design', description: '', enabled: true, ui: { entry: 'index.html' } }] as never,
      programDetails: { [FORM_APP]: { describe: null } } as never,
    })
    const p = await mount({ id: FORM_APP, source: A })
    expect(forms).toHaveLength(1)
    expect(frames).toHaveLength(0)
    await p.act(async () => forms[0].onDirty!(true))
    return { useHive, p }
  }
  const choose = async (p: Awaited<ReturnType<typeof mount>>, label: string) => {
    // Legacy route/test vocabulary stays Studio; the design app's visible View label is Create.
    const currentLabel = label === 'Studio' ? 'Create' : label
    const item = menu.sections.find((s) => s.title === 'View')!.items.find((i) => i.label === currentLabel)!
    expect(item).toBeDefined()
    await p.act(async () => item.run())
    await p.act(flush)
  }
  const SWITCH_LABEL = 'Discard and switch'

  // ---- j3r43-o3 r1.13: view=studio (a live Studio session's canvas) mounts the app's OWN native frame on that source
  const studioChecked = () => menu.sections.find((x) => x.title === 'View')!.items.find((i) => i.label === 'Create') as unknown as { checked: boolean }
  async function formApp() {
    const useHive = await hive(sameClient())
    useHive.setState({
      programs: [{ id: FORM_APP, name: 'Invented design', description: '', enabled: true, ui: { entry: 'index.html' } }] as never,
      programDetails: { [FORM_APP]: { describe: null } } as never,
    })
  }
  it('r1.13: the route view=studio opens the native frame on the exact source (not Surface’s form)', async () => {
    await formApp()
    const p = await mount({ id: FORM_APP, source: A, view: 'studio' })
    await p.act(flush)
    expect(frames.filter((f) => f.alive).map((f) => f.source)).toEqual([A])
    expect(forms.filter((f) => f.alive)).toHaveLength(0)
    await p.unmount()
  })
  it('r1.13: an open page on the form follows a later view=studio to the native frame (clean: no question)', async () => {
    await formApp()
    const p = await mount({ id: FORM_APP, source: A })
    expect(frames).toHaveLength(0)
    await p.render({ id: FORM_APP, source: A, view: 'studio' })
    await p.act(flush)
    expect(frames.filter((f) => f.alive).map((f) => f.source)).toEqual([A])
    await p.unmount()
  })
  it('r1.13: Studio → Graph → back with view=studio shows the drawing again (own was already true)', async () => {
    await formApp()
    const p = await mount({ id: FORM_APP, source: A, view: 'studio' })
    await p.act(flush)
    expect(studioChecked().checked).toBe(true)
    await choose(p, 'Graph')
    expect(studioChecked().checked).toBe(false)
    await p.render({ id: FORM_APP, source: A, view: 'graph' })
    await p.act(flush)
    await p.render({ id: FORM_APP, source: A, view: 'studio' })
    await p.act(flush)
    expect(studioChecked().checked).toBe(true)                     // the native frame is the one on screen again
    await p.unmount()
  })

  it('form control: no identity change, "Discard and switch" to Graph unmounts the form (the switch works)', async () => {
    const { p } = await formPage(sameClient())
    await choose(p, 'Graph')
    expect(p.dialogs()).toHaveLength(1)
    expect(p.dialogs()[0].textContent).toMatch(/Switching the view discards them/)
    await p.act(async () => press(p.button(SWITCH_LABEL)!))
    await p.act(flush)
    expect(forms[0].alive).toBe(false)
    await p.unmount()
  })

  for (const target of ['Graph', 'Studio'] as const) {
    it(`form: a re-init while "switch to ${target}" is open answers it no at once; the form and its document stay`, async () => {
      const c = sameClient()
      const { useHive, p } = await formPage(c)
      await choose(p, target)
      expect(p.dialogs()).toHaveLength(1)
      await p.act(async () => reinit(useHive, c))
      await p.act(flush)
      expect(p.dialogs()).toHaveLength(0)
      expect(forms).toHaveLength(1)
      expect(forms[0].alive).toBe(true)
      expect(frames).toHaveLength(0)        // Studio did not take its place either
      expect(navigations).toEqual([])        // the route already says what is shown
      await p.unmount()
    })
    it(`form: the yes to "switch to ${target}" resolves, then the identity changes before the page continues: the form stays`, async () => {
      const c = sameClient()
      const { useHive, p } = await formPage(c)
      await choose(p, target)
      seam.afterYes = () => void reinit(useHive, c)
      await p.act(async () => press(p.button(SWITCH_LABEL)!))
      await p.act(flush)
      expect(seam.afterYes).toBeNull()   // the gap was really hit
      expect(forms).toHaveLength(1)
      expect(forms[0].alive).toBe(true)  // never unmounted for the earlier identity: its canvas document and history stay
      expect(frames).toHaveLength(0)
      await p.unmount()
    })
  }

  it('form race: the re-init lands k = 0..12 microtasks after the yes: the form goes only when the switch was committed first', async () => {
    const outcomes: string[] = []
    for (let k = 0; k <= 12; k++) {
      frames.length = 0
      forms.length = 0
      navigations.length = 0
      const c = sameClient()
      const { useHive, p } = await formPage(c)
      await choose(p, 'Graph')
      const yes = p.button(SWITCH_LABEL)!
      await p.act(async () => {
        press(yes)
        let chain: Promise<unknown> = Promise.resolve()
        for (let i = 0; i < k; i++) chain = chain.then(() => undefined)
        await chain.then(() => reinit(useHive, c))
        await flush()
      })
      await p.act(flush)
      expect(forms, `k=${k}`).toHaveLength(1)
      expect(navigations, `k=${k}`).toEqual([])
      outcomes.push(forms[0].alive ? 'kept' : 'switched')
      await p.unmount()
    }
    // both sides of the race were run: an early re-init keeps the form, a late one comes after the committed switch
    expect(outcomes[0]).toBe('kept')
    expect(outcomes.at(-1)).toBe('switched')
    // and the outcome changes once, at the commit (kept … kept, switched … switched)
    expect(outcomes.join(',')).toMatch(/^(kept,)*kept(,switched)+$/)
  })
})

describe('C5: live drawing menu availability', () => {
  it('a previously available Create menu reports a fresh refusal without preparing work', async () => {
    const client = {
      mode: 'sim' as const,
      studioSession: vi.fn(), studioPiece: vi.fn(), studioOutcome: vi.fn(), studioControl: vi.fn(),
      studioMount: vi.fn(), studioMountHeartbeat: vi.fn(), studioUnmount: vi.fn(), studioMountReadback: vi.fn(),
      studioRecordIntent: vi.fn(), askSubmitIntent: vi.fn(), askSteer: vi.fn(), studioSetupProposal: vi.fn(),
    }
    const setup = client.studioSetupProposal
    const useHive = await hive(client)
    useHive.setState({
      programs: [{ id: 'omegadesign', name: 'Invented Create', description: '', enabled: true, ui: { entry: 'index.html' } }] as never,
      programDetails: { omegadesign: { describe: null } } as never,
    })
    const previousToast = useHive.getState().toast
    const toast = vi.fn()
    useHive.setState({ toast })
    let p: Awaited<ReturnType<typeof mount>> | null = null
    try {
      p = await mount({ id: 'omegadesign' })
      await p.act(flush)
      expect(p.container.findAll((n) => n.getAttribute('data-drawing-entry') === 'available')).toHaveLength(1)
      const item = menu.sections.flatMap((section) => section.items).find((i) => i.label === 'Draw live in Create…')
      expect(item).toBeDefined()
      // Change the client in place, without a render: activation must not trust the displayed availability.
      delete (client as Partial<typeof client>).studioSetupProposal
      await p.act(async () => item!.run())
      // said under the Draw live button, never as a toast (Jon, 4 Nov: a refusal must be visible where he pressed)
      expect(toast).not.toHaveBeenCalled()
      expect(p.container.findAll((n) => n.getAttribute('data-drawing-note') !== null).map((n) => n.textContent)).toEqual(['This page cannot prepare the drawing confirmation on this hive.'])
      expect(setup).not.toHaveBeenCalled()
      for (const method of Object.values(client)) if (typeof method === 'function') expect(method).not.toHaveBeenCalled()
      expect(navigations).toEqual([])
    } finally {
      await p?.unmount()
      useHive.setState({ toast: previousToast })
    }
  })
})


const createLedger = (): import('../studioLive/api').Ledger => ({
  session_id: 'ss_invented', stream_id: 'stream_invented', state: 'active', reason: null,
  ask_turn_id: 'turn_invented', goal_id: 'goal_invented', proposal_artifact_id: 'proposal_invented',
  maker_id: 'maker_invented', swarm_id: 'swarm_invented', program_id: 'omegadesign', scene_id: null,
  payer: null, model: null, steps: [], directions: [], piece: null, piece_state: null, piece_source: null, mount_epoch: null,
  budget: { cap: 1, spent: 0, held: 0, unknown: 0, step_cap: 0.25, step_spent: 0, step_seconds: 0, monthly: [] },
  stop: { state: 'none', fenced_at: null, in_flight: 0, unknown_usd: 0, cancel_ack: null, maker_released: null,
    stop_failed: false, release_stale: false, message: null, finish_stopping: false },
})

describe('Create code host, actual ProgramPage with declared child/frame doubles', () => {
  it.each(['Works in', 'home switch'] as const)('%s delegates departure; Cancel keeps the bench and accepting navigates once', async action => {
    const other = 's_other'
    const store = await hive({ programHomes: async () => ({ homes: [{ swarm_id: other, why: 'configured' }] }) }, 'omegadesign')
    store.setState({ swarms: { ...store.getState().swarms, [other]: { ...store.getState().swarms[SWARM], id: other, name: 'Other home' } } })
    const p = await mount({ id: 'omegadesign', view: 'studio' })
    await p.act(flush)
    await p.act(async () => { menu.sections.flatMap(s => s.items).find(i => i.label === 'Code')!.run() })
    await p.act(flush)
    const choose = () => {
      if (action === 'Works in') menu.sections.find(s => s.title === 'Works in')!.items.find(i => i.label === 'Other home')!.run()
      else press(p.button('Other home')!)
    }
    const before = code.requested
    await p.act(async () => { choose() })
    expect(code.requested).toBe(before + 1)
    expect(navigations).toEqual([])
    // The declared child guard cancels by withholding the continuation. Actual dirty-draft Cancel is separately
    // exercised through Workbench in CreateCodeBench.mounted.test.tsx; this tests the parent's two entry points.
    code.pending = null
    expect(p.container.findAll(n => n.hasAttribute('data-code-bench-fixture'))).toHaveLength(1)
    expect(frames[0].alive).toBe(true)
    await p.act(async () => { choose() })
    expect(code.requested).toBe(before + 2)
    expect(navigations).toEqual([])
    await p.act(async () => { code.pending!() })
    expect(navigations).toEqual([{ name: 'program', id: 'omegadesign', swarm: other }])
  })
  it('keeps the actual drawing subtree mounted and routes parent Back through the child departure guard', async () => {
    await hive({}, 'omegadesign')
    const p = await mount({ id: 'omegadesign', view: 'studio' })
    const { useStudioLive } = await import('../studioLive/store')
    await p.act(async () => { useStudioLive.setState({ ledger: createLedger(), local: 'receiving' }) })
    expect(frames).toHaveLength(1)
    await p.act(async () => { menu.sections.flatMap(s => s.items).find(i => i.label === 'Code')!.run() })
    await p.act(flush)
    expect(p.container.findAll(n => n.hasAttribute('data-code-bench-fixture'))).toHaveLength(1)
    expect(frames).toHaveLength(1)
    expect(frames[0].alive).toBe(true)
    const stops = p.container.findAll(n => n.tagName === 'BUTTON' && n.textContent === 'Stop')
    expect(stops).toHaveLength(1)
    let stopParent = stops[0].parentNode
    while (stopParent && stopParent !== p.container) { expect(stopParent.hasAttribute('hidden')).toBe(false); stopParent = stopParent.parentNode }
    const frame = p.container.findAll(n => n.hasAttribute('data-frame'))[0]
    let parent = frame.parentNode
    let hidden = false
    while (parent && parent !== p.container) { hidden ||= parent.hasAttribute('hidden'); parent = parent.parentNode }
    expect(hidden).toBe(true)
    const before = code.requested
    await p.act(async () => { menu.sections.flatMap(s => s.items).find(i => i.label === 'Graph')!.run() })
    expect(code.requested).toBe(before + 1)
    expect(p.container.findAll(n => n.hasAttribute('data-code-bench-fixture'))).toHaveLength(1)
    expect(frames[0].alive).toBe(true)
    await p.act(async () => { code.pending!() })
    expect(p.container.findAll(n => n.hasAttribute('data-code-bench-fixture'))).toHaveLength(0)
    expect(frames).toHaveLength(1)
    expect(frames[0].alive).toBe(true)
  })
  it('an old departure cannot switch the new identity after a same-client re-init', async () => {
    const store = await hive({}, 'omegadesign')
    const p = await mount({ id: 'omegadesign', view: 'studio' })
    await p.act(async () => { menu.sections.flatMap(s => s.items).find(i => i.label === 'Code')!.run() })
    await p.act(flush)
    await p.act(async () => { menu.sections.flatMap(s => s.items).find(i => i.label === 'Graph')!.run() })
    const old = code.pending!
    await p.act(async () => { store.setState({ inits: store.getState().inits + 1 }) })
    await p.act(async () => { old() })
    expect(p.container.findAll(n => n.hasAttribute('data-code-bench-fixture'))).toHaveLength(1)
  })
})

describe('Draw live R3: the page continuation after the Ask turn (Dot FIX-FIRST on f7deb7e2)', () => {
  const liveClient = () => ({
    mode: 'live' as const,
    studioSession: vi.fn(), studioPiece: vi.fn(), studioOutcome: vi.fn(), studioControl: vi.fn(),
    studioMount: vi.fn(), studioMountHeartbeat: vi.fn(), studioUnmount: vi.fn(), studioMountReadback: vi.fn(),
    studioRecordIntent: vi.fn(), askSubmitIntent: vi.fn(), askSteer: vi.fn(), studioSetupProposal: vi.fn(),
  })
  const TURN = { operation_id: 'op_invented', title: 'a fox', detail: 'a fox', max_steps: 8, window_minutes: 20 }
  async function page() {
    const useHive = await hive(liveClient())
    useHive.setState({ programs: [{ id: 'omegadesign', name: 'Invented Create', description: '', enabled: true, ui: { entry: 'index.html' } }] as never, programDetails: { omegadesign: { describe: null } } as never })
    const { useAskStore } = await import('../../store/ask')
    useAskStore.setState({ settings: { swarm_id: null, thread_budget_usd: 5, capabilities: { conductor: true, memory: true, studio_sessions: true, studio_directions: true } } } as never)
    const p = await mount({ id: 'omegadesign' })
    await p.act(flush)
    const item = () => menu.sections.flatMap((s) => s.items).find((i) => i.label === 'Draw live in Create…')!
    return { useHive, p, item }
  }
  let release: (v: unknown) => void = () => {}
  let begun: unknown[][] = []
  let records = 0
  beforeEach(() => {
    begun = []; records = 0
    draw.words = 'a fox'
    draw.record = () => { records++; return new Promise((res) => { release = res }) }
    draw.begin = async (...a) => { begun.push(a) }
  })
  afterEach(() => { draw.record = null; draw.begin = null; draw.words = null })

  it('repeat presses while the first is in flight are one press: one Ask turn, one picker', async () => {
    const { p, item } = await page()
    expect(p.container.findAll((n) => n.getAttribute('data-drawing-entry') === 'available')).toHaveLength(1)
    await p.act(async () => { item().run(); item().run() })
    const entry = p.container.findAll((n) => n.tagName === 'BUTTON' && n.textContent === 'Sending your request…')
    expect(entry).toHaveLength(1)                                   // the entry waits, disabled, while the press runs
    expect(entry[0].getAttribute('disabled')).not.toBeNull()
    await p.act(async () => { item().run() })                       // the menu while busy joins the same press
    await p.act(async () => { release({ turn: TURN }); await flush() })
    expect(records).toBe(1)
    expect(begun).toEqual([['omegadesign', TURN]])
  })

  it('an identity change between the Ask turn resolving and the page continuing opens nothing', async () => {
    const { useHive, p, item } = await page()
    await p.act(async () => { item().run() })
    await p.act(async () => {
      release({ turn: TURN })
      useHive.setState({ session: 'someone-else' })              // before the continuation runs
      await flush()
    })
    expect(begun).toEqual([])
  })

  it('a new Ask thread between resolve and continuation opens nothing; the empty-Ask path is fenced the same way', async () => {
    const { p, item } = await page()
    const { useAskStore } = await import('../../store/ask')
    await p.act(async () => { item().run() })
    await p.act(async () => { release({ turn: TURN }); useAskStore.setState((s) => ({ epoch: s.epoch + 1 }) as never); await flush() })
    expect(begun).toEqual([])
    // the empty-Ask path: a recorded turn reused, then the identity changes before the continuation
    draw.words = ''
    draw.record = async () => { records++; return { turn: TURN } }
    useAskStore.setState({ log: [{ kind: 'turn', op: 'op_invented' }], turns: { op_invented: { op: 'op_invented', you: 'a fox', state: 'done' } } } as never)
    const { useHive } = await import('../../store/store')
    await p.act(async () => { item().run(); useHive.setState({ session: 'yet-another' }); await flush() })
    expect(begun).toEqual([])
  })
})


describe('Create shows its benches side by side (Jon 11-05: code and studio together; 10-31: Flow is a bench kind)', () => {
  it('the Create page names itself Create and shows Studio, Code and Flow at the top; each opens its bench there', async () => {
    const useHive = await hive({ mode: 'sim' })
    useHive.setState({ programs: [{ id: 'omegadesign', name: 'OmegaDesign', description: '', enabled: true, ui: { entry: 'index.html' } }] as never, programDetails: { omegadesign: { describe: null } } as never })
    const p = await mount({ id: 'omegadesign' })
    await p.act(flush)
    const benchTab = (label: string) => p.container.findAll((n) => n.getAttribute('role') === 'tab' && n.textContent === label)
    // MeTTa composes the bench tabs (program.metta, the tabs block): one tablist named Create benches
    const bar = p.container.findAll((n) => n.getAttribute('role') === 'tablist' && n.getAttribute('aria-label') === 'Create benches')
    expect(bar).toHaveLength(1)
    const tabs = p.container.findAll((n) => n.getAttribute('role') === 'tab').map((n) => [n.textContent, n.getAttribute('aria-selected')])
    expect(tabs).toEqual([['Studio', 'true'], ['Make', 'false'], ['Code', 'false'], ['Flow', 'false']])
    expect(p.container.findAll((n) => n.getAttribute('aria-label') === 'Create app')).toHaveLength(1)
    const codeTab = benchTab('Code')[0]
    await p.act(async () => { press(codeTab); await flush() })
    expect(benchTab('Code')[0].getAttribute('aria-selected')).toBe('true')
    // Flow: leaving Code asks the code bench first (its departure guard), then the Flow studio opens in Create
    const fixtures = (attr: string) => p.container.findAll((n) => n.hasAttribute(attr)).length
    code.pending = null
    await p.act(async () => { press(benchTab('Flow')[0]); await flush() })
    expect(code.pending, 'leaving Code asks the code bench first').toBeTruthy()
    await p.act(async () => { code.pending!(); code.pending = null; await flush() })
    const sel = () => p.container.findAll((n) => n.getAttribute('role') === 'tab').map((n) => n.getAttribute('aria-selected'))
    expect(sel()).toEqual(['false', 'false', 'false', 'true'])
    expect(fixtures('data-flow-studio-fixture')).toBe(1)
    expect(fixtures('data-code-bench-fixture')).toBe(0)
    // and back to Studio: the Flow studio goes, the app's own canvas shows again
    await p.act(async () => { press(benchTab('Studio')[0]); await flush() })
    expect(sel()).toEqual(['true', 'false', 'false', 'false'])
    expect(fixtures('data-flow-studio-fixture')).toBe(0)
    // Make: the plan canvas opens in Create, over the app's own canvas (kept, hidden)
    await p.act(async () => { press(benchTab('Make')[0]); await flush() })
    expect(sel()).toEqual(['false', 'true', 'false', 'false'])
    expect(fixtures('data-plan-canvas-fixture')).toBe(1)
  })
  it('other apps have no bench bar', async () => {
    await hive({ mode: 'sim' })
    const p = await mount({})
    await p.act(flush)
    expect(p.container.findAll((n) => n.getAttribute('aria-label') === 'Create benches')).toHaveLength(0)
  })
})
