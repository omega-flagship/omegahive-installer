import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { readHeader, readPresets, type MapFailure, type MapNode, type Read, type RepoMapApi } from '../../../api/repoMap'
import { PRESET_LIST } from '../../../api/sim/repoMap'

/**
 * Workbench Map r1: the REAL RevisionMap component, driven through a revision change while requests made for the
 * previous revision are still out (Code's P1 finding on 9b399eb). This repo's tests run in node without a DOM
 * library, so RevisionMap is called on a minimal hook runtime (state, refs, memo, effects with deps and cleanup; the
 * same approach as lib/closeHome.render.test.ts) and its returned element tree is inspected. Every request goes to a
 * fake api whose answers the test releases one by one, in any order. Synthetic nodes only.
 */

// ---- a minimal hook runtime: one component, state kept across renders, effects run after each render ----------------
const rt = { slots: [] as { v?: unknown; deps?: unknown[]; current?: unknown }[], i: 0, effects: [] as { deps?: unknown[]; cleanup?: () => void }[], ei: 0, queue: [] as (() => void)[], dirty: false }
const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]))
vi.mock('react', async (orig) => {
  const real = await orig<typeof import('react')>()
  const memo = <T,>(f: () => T, deps?: unknown[]): T => {
    const k = rt.i++
    const s = rt.slots[k]
    if (s && same(s.deps, deps)) return s.v as T
    const v = f()
    rt.slots[k] = { v, deps }
    return v
  }
  const effect = (f: () => void | (() => void), deps?: unknown[]) => {
    const k = rt.ei++
    const e = rt.effects[k]
    if (e && deps && same(e.deps, deps)) return
    rt.queue.push(() => {
      rt.effects[k]?.cleanup?.()
      const c = f()
      rt.effects[k] = { deps, cleanup: typeof c === 'function' ? c : undefined }
    })
  }
  return {
    ...real,
    useState: <T,>(init: T | (() => T)) => {
      const k = rt.i++
      if (!rt.slots[k]) rt.slots[k] = { v: typeof init === 'function' ? (init as () => T)() : init }
      const s = rt.slots[k]
      return [s.v as T, (v: T | ((p: T) => T)) => {
        const nv = typeof v === 'function' ? (v as (p: T) => T)(s.v as T) : v
        if (!Object.is(nv, s.v)) {
          s.v = nv
          rt.dirty = true
        }
      }]
    },
    useRef: <T,>(init: T) => {
      const k = rt.i++
      if (!rt.slots[k]) rt.slots[k] = { current: init }
      return rt.slots[k]
    },
    useMemo: memo,
    useCallback: <T,>(f: T, deps?: unknown[]) => memo(() => f, deps),
    useEffect: effect,
    useLayoutEffect: effect,
  }
})
const fill: { set: ((t: string) => void) | null } = { set: null }
vi.mock('../canvas/askBridge', () => ({ useAskRoom: () => ({ room: 0, present: false }) }))
const screen = { width: 1440 }
vi.mock('../../lab/useWidth', () => ({ useWidth: () => [{ current: null }, screen.width] }))
vi.mock('../../ask/fields', () => ({ useAskFillable: (_id: string, _l: string, _k: string, set: (t: string) => void) => void (fill.set = set) }))
vi.mock('../../ask/view', async (orig) => ({ ...(await orig<typeof import('../../ask/view')>()), useAskView: () => undefined }))
const hive: { client: object | null } = { client: null }
vi.mock('../../../store/store', () => ({ useHive: (pick: (s: { client: object | null }) => unknown) => pick({ client: hive.client }) }))
// This minimal store drives the map revision state machine. Page's live session row has its own mounted tests.
vi.mock('../../studioLive/DirectingStudio', () => ({ StudioLiveBar: () => null }))
vi.mock('../../../lib/router', async (orig) => ({ ...(await orig<typeof import('../../../lib/router')>()), navigate: vi.fn() }))

const { default: MapView, MapRoot, RevisionMap } = await import('./MapView')
const { SPACE_POLL_MAX, spacePollDelay } = await import('./model')
const { DriftCard, FailureCard, ItemList, MapGraph, NodeCard, Panel, PresetComposer, QueryCard, StateBand } = await import('./parts')

type Props = Parameters<typeof RevisionMap>[0]
/** Render any component of this module on the hook runtime until its state settles. */
function renderAny<P>(comp: (p: P) => unknown, props: P): ReactElement {
  for (let n = 0; n < 60; n++) {
    rt.i = 0
    rt.ei = 0
    rt.dirty = false
    rt.queue = []
    const tree = comp(props) as ReactElement
    const q = rt.queue
    q.forEach((f) => f())
    if (!rt.dirty) return tree
  }
  throw new Error('did not settle')
}
function render(props: Props): ReactElement {
  for (let n = 0; n < 60; n++) {
    rt.i = 0
    rt.ei = 0
    rt.dirty = false
    rt.queue = []
    const tree = RevisionMap(props) as ReactElement
    const q = rt.queue
    q.forEach((f) => f())
    if (!rt.dirty) return tree
  }
  throw new Error('did not settle')
}
async function settle(props: Props): Promise<ReactElement> {
  for (let k = 0; k < 10; k++) await new Promise((r) => setTimeout(r, 0))
  return render(props)
}
function find(tree: ReactNode, type: unknown): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = []
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (!isValidElement(n)) return
    const el = n as ReactElement<Record<string, unknown>>
    if (el.type === type) out.push(el)
    walk(el.props.children as ReactNode)
  }
  walk(tree)
  return out
}

// ---- a fake api: every request waits until the test answers it --------------------------------------------------------
interface Call {
  name: string
  args: unknown[]
  answer: (r: Read<unknown>) => void
}
function fakeApi() {
  const calls: Call[] = []
  const mk = (name: string) => (...args: unknown[]) => new Promise<Read<unknown>>((answer) => calls.push({ name, args, answer }))
  const api = { list: mk('list'), header: mk('header'), nodes: mk('nodes'), node: mk('node'), presets: mk('presets'), query: mk('query'), drift: mk('drift') } as unknown as RepoMapApi
  const take = (name: string, sha?: string) => {
    const i = calls.findIndex((c) => c.name === name && (sha === undefined || c.args.includes(sha)))
    if (i < 0) throw new Error(`no pending ${name}${sha ? ` for ${sha}` : ''}: ${calls.map((c) => c.name).join(',')}`)
    return calls.splice(i, 1)[0]
  }
  return { api, calls, take }
}

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const header = (sha: string) => readHeader({ repo: 'synthetic', sha, schema: 'repo-map/1', state: 'partial', reason: 'bounded', extractor: { id: 'omegacode.repository_map', version: '1', parser: null }, counts: { nodes: 1, edges: 0, nodes_by_kind: { def: 1 } } })
const node = (id: string, label: string): MapNode => ({ id, kind: 'def', label, source_digest: 'd', refs: [{ path: id.slice(4, id.indexOf('::')), line: 1, excerpt: `def ${label}():` }] })
const page = (nodes: MapNode[]) => ({ ok: true as const, value: { nodes, truncated: false, next_cursor: null } })
const presets = readPresets({ presets: PRESET_LIST })
const OLD = node('def:old.py::build', 'build')
const NEW = node('def:new.py::build', 'build')
const revisions = [A, B].map((sha) => ({ ...header(sha), pin: null }))

let onClose: ReturnType<typeof vi.fn<(f: MapFailure) => void>>
beforeEach(() => {
  screen.width = 1440
  hive.client = null
  rt.slots = []
  rt.effects = []
  fill.set = null
  onClose = vi.fn<(f: MapFailure) => void>()
})

/** Open revision A with its map read, then run a source search there that finds the old `build`. */
async function revisionAWithQuery() {
  const f = fakeApi()
  const propsA: Props = { api: f.api, repo: 'synthetic', sha: A, revisions, onClose }
  render(propsA)
  f.take('header', A).answer({ ok: true, value: header(A) })
  f.take('presets').answer({ ok: true, value: presets })
  await settle(propsA)
  f.take('nodes', A).answer(page([]))
  await settle(propsA)
  fill.set!('find build')
  let tree = render(propsA)
  const composer = find(tree, PresetComposer)[0]
  expect((composer.props.plan as { preset: string }).preset).toBe('source-search')
  ;(composer.props.onRun as () => void)()
  tree = render(propsA)
  return { f, propsA, tree }
}
const planOf = (tree: ReactElement) => find(tree, PresetComposer)[0]?.props.plan as { params: Record<string, string>; note: string | null } | undefined

describe('a revision change while requests for the old revision are out', () => {
  it('a stale query’s nodes are never resolved: not while the new revision loads, and not as a false ambiguity after', async () => {
    const { f, propsA } = await revisionAWithQuery()
    f.take('query', A).answer({ ok: true, value: { nodes: [OLD], edges: [], truncated: false, next_cursor: null, basis_note: null, state: 'ready' } })
    let tree = await settle(propsA)
    expect(find(tree, QueryCard)).toHaveLength(1)
    // same revision: the query's node resolves (control)
    fill.set!('what calls build')
    expect(planOf(render(propsA))?.params).toEqual({ node_id: OLD.id })

    // the person opens revision B; its header arrives, its nodes are still loading
    const propsB: Props = { ...propsA, sha: B }
    render(propsB)
    f.take('header', B).answer({ ok: true, value: header(B) })
    tree = await settle(propsB)
    expect(find(tree, QueryCard)).toHaveLength(0)
    fill.set!('what calls build')
    let plan = planOf(render(propsB))
    expect(plan?.params).toEqual({ node_id: 'build' })
    expect(plan?.note).toContain('build is a name, not a node id or path')

    // B's nodes arrive: the one `build` at B resolves; the hidden old one never makes it ambiguous
    f.take('nodes', B).answer(page([NEW]))
    await settle(propsB)
    fill.set!('what calls build')
    plan = planOf(render(propsB))
    expect(plan?.params).toEqual({ node_id: NEW.id })
    expect(plan?.note).toBeNull()
  })

  it('a late failure of the old revision’s query never closes or errors the newer map', async () => {
    const { f, propsA } = await revisionAWithQuery()
    const propsB: Props = { ...propsA, sha: B }
    render(propsB)
    f.take('header', B).answer({ ok: true, value: header(B) })
    await settle(propsB)
    f.take('query', A).answer({ ok: false, failure: { kind: 'not_found' } })
    const tree = await settle(propsB)
    expect(onClose).not.toHaveBeenCalled()
    expect(find(tree, FailureCard)).toHaveLength(0)
    expect(find(tree, Panel).some((p) => p.props.title === 'The query did not run')).toBe(false)
    expect(find(tree, StateBand)).toHaveLength(1)
  })

  it('a late denial of the old revision’s header never closes the newer map', async () => {
    const f = fakeApi()
    const propsA: Props = { api: f.api, repo: 'synthetic', sha: A, revisions, onClose }
    render(propsA)
    const propsB: Props = { ...propsA, sha: B }
    render(propsB)
    f.take('header', A).answer({ ok: false, failure: { kind: 'denied' } })
    await settle(propsB)
    expect(onClose).not.toHaveBeenCalled()
    f.take('header', B).answer({ ok: true, value: header(B) })
    const tree = await settle(propsB)
    expect(find(tree, StateBand)).toHaveLength(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a late old-revision node detail never shows on the newer revision', async () => {
    const f = fakeApi()
    const propsA: Props = { api: f.api, repo: 'synthetic', sha: A, revisions, onClose }
    render(propsA)
    f.take('header', A).answer({ ok: true, value: header(A) })
    f.take('presets').answer({ ok: true, value: presets })
    await settle(propsA)
    f.take('nodes', A).answer(page([OLD]))
    let tree = await settle(propsA)
    // select the old node through the picture's own handler, then change revision before its detail answers
    const graph = find(tree, MapGraph)[0]
    ;(graph.props.onSelect as (id: string) => void)(OLD.id)
    render(propsA)
    const propsB: Props = { ...propsA, sha: B }
    render(propsB)
    f.take('node', A).answer({ ok: true, value: { node: OLD, edges: [], neighbours: [], truncated: false, next_cursor: null } })
    f.take('header', B).answer({ ok: true, value: header(B) })
    tree = await settle(propsB)
    expect(find(tree, NodeCard)).toHaveLength(0)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a result over the host’s page bound is an honest refusal ("too large for one page"), never an empty result', async () => {
    const { f, propsA } = await revisionAWithQuery()
    f.take('query', A).answer({ ok: false, failure: { kind: 'too_large' } })
    const tree = await settle(propsA)
    expect(onClose).not.toHaveBeenCalled()
    expect(find(tree, QueryCard)).toHaveLength(0)
    const panel = find(tree, Panel).find((p) => p.props.title === 'The query did not run')
    expect(panel).toBeDefined()
    const words = find(panel!.props.children as ReactNode, 'p')[0].props.children as unknown[]
    expect(words.join('')).toContain('Result too large for one page')
    expect(words.join('')).toContain('not an empty result')
  })

  it('a still-pending denial for the CURRENT revision does close the map (fail closed is kept)', async () => {
    const f = fakeApi()
    const propsA: Props = { api: f.api, repo: 'synthetic', sha: A, revisions, onClose }
    render(propsA)
    f.take('header', A).answer({ ok: false, failure: { kind: 'denied' } })
    await settle(propsA)
    expect(onClose).toHaveBeenCalledWith({ kind: 'denied' })
  })
})

// ---------------------------------------------------------------------------------------------------- r1.1
const C = 'c'.repeat(40)
const AB = 'a'.repeat(20) + 'b'.repeat(20)
const NO_FIT_WORDS = 'No preset fits these words. Choose one below and fill it in.'
const queryAnswer = (nodes: MapNode[]) => ({ ok: true as const, value: { nodes, edges: [], truncated: false, next_cursor: null, basis_note: null, state: 'ready' } })

describe('r1.1: every continuation is bound to repo + revision + generation (stand-in P2-4)', () => {
  it('A → B → A: the first visit’s late query answer never lands on the third visit', async () => {
    const { f, propsA } = await revisionAWithQuery()
    const first = f.take('query', A)
    const propsB: Props = { ...propsA, sha: B }
    render(propsB)
    render(propsA)
    f.take('header', A).answer({ ok: true, value: header(A) })
    await settle(propsA)
    first.answer(queryAnswer([OLD]))
    let tree = await settle(propsA)
    expect(find(tree, QueryCard)).toHaveLength(0)
    // and a late failure of that first query never closes or errors the third visit
    const { f: g, propsA: pa } = await revisionAWithQuery()
    const q1 = g.take('query', A)
    render({ ...pa, sha: B })
    render(pa)
    q1.answer({ ok: false, failure: { kind: 'not_found' } })
    tree = await settle(pa)
    expect(onClose).not.toHaveBeenCalled()
    expect(find(tree, Panel).some((p) => p.props.title === 'The query did not run')).toBe(false)
  })

  it('a repo change that keeps the sha is a new target: the other repo’s answer never lands', async () => {
    const { f, propsA } = await revisionAWithQuery()
    const q = f.take('query', A)
    const other: Props = { ...propsA, repo: 'another-repo' }
    render(other)
    f.take('header', A).answer({ ok: true, value: header(A) })
    await settle(other)
    q.answer(queryAnswer([OLD]))
    const tree = await settle(other)
    expect(find(tree, QueryCard)).toHaveLength(0)
  })
})

describe('r1.1: revision-bound plans, notes and failures (stand-in P2-2, Kimi K1/K3)', () => {
  it('a plan resolved at A is never run at B: it is planned again from the words against B', async () => {
    const f = fakeApi()
    const propsA: Props = { api: f.api, repo: 'synthetic', sha: A, revisions, onClose }
    render(propsA)
    f.take('header', A).answer({ ok: true, value: header(A) })
    f.take('presets').answer({ ok: true, value: presets })
    await settle(propsA)
    f.take('nodes', A).answer(page([OLD]))
    await settle(propsA)
    fill.set!('what calls build')
    expect(planOf(render(propsA))?.params).toEqual({ node_id: OLD.id })

    const propsB: Props = { ...propsA, sha: B }
    render(propsB)
    f.take('header', B).answer({ ok: true, value: header(B) })
    await settle(propsB)
    // before B's nodes arrive: the name is not a node here yet, so the plan says so instead of carrying OLD's id
    let plan = planOf(render(propsB))
    expect(plan?.params.node_id).not.toBe(OLD.id)
    f.take('nodes', B).answer(page([NEW]))
    const tree = await settle(propsB)
    plan = planOf(tree)
    expect(plan?.params).toEqual({ node_id: NEW.id })
    ;(find(tree, PresetComposer)[0].props.onRun as () => void)()
    render(propsB)
    const sent = f.take('query', B)
    expect(JSON.stringify(sent.args)).not.toContain(OLD.id)
    expect(JSON.stringify(sent.args)).toContain(NEW.id)
  })

  it('an edited plan without words is cleared on a revision change (nothing to re-resolve, nothing stale to run)', async () => {
    const f = fakeApi()
    const propsA: Props = { api: f.api, repo: 'synthetic', sha: A, revisions, onClose }
    render(propsA)
    f.take('header', A).answer({ ok: true, value: header(A) })
    f.take('presets').answer({ ok: true, value: presets })
    await settle(propsA)
    f.take('nodes', A).answer(page([OLD]))
    let tree = await settle(propsA)
    // reveal the composer, then pick a preset and type the node id by hand
    const chip = find(tree, 'button').find((b) => 'data-map-ask-open' in b.props)
    ;(chip!.props.onClick as () => void)()
    tree = render(propsA)
    ;(find(tree, PresetComposer)[0].props.onPlan as (p: unknown) => void)({ preset: 'imports', params: { node_id: OLD.id }, note: null })
    expect(planOf(render(propsA))?.params).toEqual({ node_id: OLD.id })
    const propsB: Props = { ...propsA, sha: B }
    render(propsB)
    f.take('header', B).answer({ ok: true, value: header(B) })
    tree = await settle(propsB)
    expect(planOf(tree)).toBeNull()
  })

  it('a query failure at A is not shown at B', async () => {
    const { f, propsA } = await revisionAWithQuery()
    f.take('query', A).answer({ ok: false, failure: { kind: 'bad_request', message: 'nope' } })
    let tree = await settle(propsA)
    expect(find(tree, Panel).some((p) => p.props.title === 'The query did not run')).toBe(true)
    const propsB: Props = { ...propsA, sha: B }
    render(propsB)
    f.take('header', B).answer({ ok: true, value: header(B) })
    tree = await settle(propsB)
    expect(find(tree, Panel).some((p) => p.props.title === 'The query did not run')).toBe(false)
  })
})

describe('r1.1: drift (Kimi K2, K6)', () => {
  async function atB(revs = revisions) {
    const f = fakeApi()
    const props: Props = { api: f.api, repo: 'synthetic', sha: B, revisions: revs, onClose }
    render(props)
    f.take('header', B).answer({ ok: true, value: header(B) })
    f.take('presets').answer({ ok: true, value: presets })
    await settle(props)
    f.take('nodes', B).answer(page([NEW]))
    await settle(props)
    return { f, props }
  }
  const item = (id: string) => ({ id, basis: 'id absent in from', node: { id, kind: 'def', label: id, source_digest: null }, from: null, to: null })
  const driftPage = (ids: string[], next: string | null) => ({ ok: true as const, value: { from: A, to: B, basis_note: null, added: ids.map(item), removed: [], changed: [], moved: [], truncated: next !== null, next_cursor: next } })

  it('a truncated comparison pages on with More, joining each list', async () => {
    const { f, props } = await atB()
    fill.set!(`what changed since ${A}`)
    let tree = render(props)
    ;(find(tree, PresetComposer)[0].props.onRun as () => void)()
    render(props)
    f.take('drift').answer(driftPage(['def:x'], 'c1'))
    tree = await settle(props)
    const card = find(tree, DriftCard)[0]
    expect(card.props.onMore).toBeTypeOf('function')
    ;(card.props.onMore as () => void)()
    render(props)
    const next = f.take('drift')
    expect(next.args[3]).toEqual({ cursor: 'c1' })
    next.answer(driftPage(['def:y'], null))
    tree = await settle(props)
    const view = find(tree, DriftCard)[0].props.view as { added: { id: string }[] }
    expect(view.added.map((a) => a.id)).toEqual(['def:x', 'def:y'])
    expect(find(tree, DriftCard)[0].props.onMore).toBeUndefined()
  })

  it('a sha prefix runs only when it names exactly one revision; otherwise "choose the exact revision"', async () => {
    const revs = [A, AB, B].map((sha) => ({ ...header(sha), pin: null }))
    const { f, props } = await atB(revs)
    fill.set!('what changed since aaaa')
    let tree = render(props)
    ;(find(tree, PresetComposer)[0].props.onRun as () => void)()
    tree = render(props)
    expect(find(tree, PresetComposer)[0].props.runWhy).toBe('2 revisions start with aaaa: choose the exact revision.')
    expect(f.calls.some((c) => c.name === 'drift')).toBe(false)
    fill.set!('what changed since aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    tree = render(props)
    ;(find(tree, PresetComposer)[0].props.onRun as () => void)()
    render(props)
    expect(f.take('drift').args.slice(0, 3)).toEqual(['synthetic', A, B])
    fill.set!('what changed since aaaaaaaaaaaaaaaaaaaab')
    tree = render(props)
    ;(find(tree, PresetComposer)[0].props.onRun as () => void)()
    render(props)
    expect(f.take('drift').args.slice(0, 3)).toEqual(['synthetic', AB, B])
    void C
  })
})

describe('r1.1: the root (stand-in P2-1) and identity remount', () => {
  type RootProps = Parameters<typeof MapRoot>[0]
  it('a closed map reopens when the person opens another revision, and again when they come back', async () => {
    const f = fakeApi()
    const at = (sha: string): RootProps => ({ api: f.api, repo: 'synthetic', sha })
    renderAny(MapRoot, at(A))
    let tree: ReactElement
    f.take('list').answer({ ok: true, value: revisions })
    tree = await (async () => {
      for (let k = 0; k < 10; k++) await new Promise((r) => setTimeout(r, 0))
      return renderAny(MapRoot, at(A))
    })()
    expect(tree.type).toBe(RevisionMap)
    ;(tree.props as Props).onClose({ kind: 'not_found' })
    tree = renderAny(MapRoot, at(A))
    expect(find(tree, FailureCard)).toHaveLength(1)
    tree = renderAny(MapRoot, at(B))
    expect(tree.type).toBe(RevisionMap)
    expect((tree.props as Props).sha).toBe(B)
    tree = renderAny(MapRoot, at(A))
    expect(tree.type).toBe(RevisionMap)
  })

  it('a sign-in change remounts the whole map (its key is the identity the reads were made under)', () => {
    hive.client = { name: 'first' }
    const one = renderAny(MapView, { repo: 'synthetic', sha: A })
    hive.client = { name: 'second' }
    const two = renderAny(MapView, { repo: 'synthetic', sha: A })
    expect(one.type).toBe(MapRoot)
    expect(one.key).not.toBe(two.key)
    hive.client = { name: 'second-again' }
    expect(renderAny(MapView, { repo: 'synthetic', sha: A }).key).not.toBe(two.key)
  })
})

describe('r1.1: phone first paint (Kimi K7)', () => {
  it('before the canvas is measured, a narrow screen draws the list, not the picture', async () => {
    screen.width = 0
    vi.stubGlobal('window', { matchMedia: (q: string) => ({ matches: q === '(max-width: 759px)' }) })
    try {
      const f = fakeApi()
      const props: Props = { api: f.api, repo: 'synthetic', sha: A, revisions, onClose }
      render(props)
      f.take('header', A).answer({ ok: true, value: header(A) })
      f.take('presets').answer({ ok: true, value: presets })
      await settle(props)
      f.take('nodes', A).answer(page([OLD]))
      const tree = await settle(props)
      expect(find(tree, ItemList)).toHaveLength(1)
      expect(find(tree, MapGraph)).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('r1.1: the repo space mount is re-read while it settles, bounded (host r1.2)', () => {
  const flush = async () => {
    for (let k = 0; k < 20; k++) await Promise.resolve()
  }
  const withSpaceHeader = (sha: string, space: Record<string, unknown>) => readHeader({ repo: 'synthetic', sha, schema: 'repo-map/1', state: 'ready', reason: '', extractor: { id: 'omegacode.repository_map', version: '1', parser: null }, counts: { nodes: 1, edges: 0, nodes_by_kind: { def: 1 } }, space })
  it('mounting → re-read → mounted, then no more reads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const f = fakeApi()
      const props: Props = { api: f.api, repo: 'synthetic', sha: A, revisions, onClose }
      render(props)
      f.take('header', A).answer({ ok: true, value: withSpaceHeader(A, { id: 's', kind: 'read-only', status: 'mounting', atoms: 0, added: 5, total: 23 }) })
      f.take('presets').answer({ ok: true, value: presets })
      await flush()
      let tree = render(props)
      // ruling 1: the revision is ready, so the map is complete whatever the native space is doing
      expect((find(tree, StateBand)[0].props.v as { complete: boolean }).complete).toBe(true)
      expect(f.calls.filter((c) => c.name === 'header')).toHaveLength(0)
      vi.advanceTimersByTime(3000)
      f.take('header', A).answer({ ok: true, value: withSpaceHeader(A, { id: 's', kind: 'read-only', status: 'mounted', atoms: 23 }) })
      await flush()
      tree = render(props)
      expect((find(tree, StateBand)[0].props.space as { status: string }).status).toBe('mounted')
      expect((find(tree, StateBand)[0].props.v as { complete: boolean }).complete).toBe(true)
      vi.advanceTimersByTime(60000)
      render(props)
      expect(f.calls.filter((c) => c.name === 'header')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('a space that never settles is read at most SPACE_POLL_MAX times, then the person can check again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const f = fakeApi()
      const props: Props = { api: f.api, repo: 'synthetic', sha: A, revisions, onClose }
      const queued = () => ({ ok: true as const, value: withSpaceHeader(A, { id: 's', kind: 'read-only', status: 'queued', atoms: 0 }) })
      render(props)
      f.take('header', A).answer(queued())
      f.take('presets').answer({ ok: true, value: presets })
      await flush()
      render(props)
      let reads = 0
      let waited = 0
      for (let k = 0; k < 40; k++) {
        // the back-off: nothing just before each delay, one read exactly at it
        vi.advanceTimersByTime(spacePollDelay(k) - 1)
        expect(f.calls.some((c) => c.name === 'header')).toBe(false)
        vi.advanceTimersByTime(1)
        waited += spacePollDelay(k)
        const pending = f.calls.findIndex((c) => c.name === 'header')
        if (pending < 0) break
        reads++
        f.calls.splice(pending, 1)[0].answer(queued())
        await flush()
        render(props)
      }
      expect(reads).toBe(SPACE_POLL_MAX)
      expect(SPACE_POLL_MAX).toBe(25)
      expect(waited).toBeLessThanOrEqual(240_000 + spacePollDelay(SPACE_POLL_MAX))
      let tree = render(props)
      const band = find(tree, StateBand)[0]
      expect((band.props.recheck as { stopped: boolean }).stopped).toBe(true)
      ;(band.props.recheck as { onRecheck: () => void }).onRecheck()
      tree = render(props)
      expect((find(tree, StateBand)[0].props.recheck as { stopped: boolean }).stopped).toBe(false)
      vi.advanceTimersByTime(3000)
      expect(f.calls.filter((c) => c.name === 'header')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------------------------------- r1.2
describe('r1.2: busy, notes and plans belong to the visit (stand-in r1.1 P2/P3, Kimi r1.1 #6/#9)', () => {
  const busyOf = (tree: ReactElement) => find(tree, PresetComposer)[0]?.props.busy as boolean
  it('a late answer for A never re-enables B’s controls while B’s own request is out', async () => {
    const { f, propsA } = await revisionAWithQuery()
    expect(busyOf(render(propsA))).toBe(true)
    const propsB: Props = { ...propsA, sha: B }
    render(propsB)
    f.take('header', B).answer({ ok: true, value: header(B) })
    await settle(propsB)
    f.take('nodes', B).answer(page([NEW]))
    let tree = await settle(propsB)
    expect(busyOf(tree)).toBe(false)
    fill.set!('find build')
    tree = render(propsB)
    ;(find(tree, PresetComposer)[0].props.onRun as () => void)()
    expect(busyOf(render(propsB))).toBe(true)
    f.take('query', A).answer(queryAnswer([OLD]))
    tree = await settle(propsB)
    expect(busyOf(tree)).toBe(true)
    f.take('query', B).answer(queryAnswer([NEW]))
    tree = await settle(propsB)
    expect(busyOf(tree)).toBe(false)
    expect(find(tree, QueryCard)).toHaveLength(1)
  })

  it('a failure note at A is cleared on leaving A, so it does not come back on return', async () => {
    const { f, propsA } = await revisionAWithQuery()
    f.take('query', A).answer({ ok: false, failure: { kind: 'bad_request', message: 'nope' } })
    let tree = await settle(propsA)
    expect(find(tree, Panel).some((p) => p.props.title === 'The query did not run')).toBe(true)
    fill.set!('make it faster')
    expect(find(render(propsA), PresetComposer)[0].props.why).toBe(NO_FIT_WORDS)
    const propsB: Props = { ...propsA, sha: B }
    render(propsB)
    f.take('header', B).answer({ ok: true, value: header(B) })
    await settle(propsB)
    // back at A, with A's map read again (so the page is drawn and the notes would show if they had been kept)
    render(propsA)
    f.take('header', A).answer({ ok: true, value: header(A) })
    await settle(propsA)
    f.take('nodes', A).answer(page([OLD]))
    tree = await settle(propsA)
    expect(find(tree, StateBand)).toHaveLength(1)
    let composer = find(tree, PresetComposer)[0]
    if (!composer) {
      ;(find(tree, 'button').find((b) => 'data-map-ask-open' in b.props)!.props.onClick as () => void)()
      tree = render(propsA)
      composer = find(tree, PresetComposer)[0]
    }
    expect(composer).toBeDefined()
    expect(find(tree, Panel).some((p) => p.props.title === 'The query did not run')).toBe(false)
    expect(composer.props.why).not.toBe(NO_FIT_WORDS)
  })

  it('a plan dropped by a revision change says so: “build” isn’t among this revision’s loaded nodes', async () => {
    const f = fakeApi()
    const propsA: Props = { api: f.api, repo: 'synthetic', sha: A, revisions, onClose }
    render(propsA)
    f.take('header', A).answer({ ok: true, value: header(A) })
    f.take('presets').answer({ ok: true, value: presets })
    await settle(propsA)
    f.take('nodes', A).answer(page([OLD]))
    await settle(propsA)
    fill.set!('what calls build')
    expect(planOf(render(propsA))?.params).toEqual({ node_id: OLD.id })
    const propsB: Props = { ...propsA, sha: B }
    render(propsB)
    f.take('header', B).answer({ ok: true, value: header(B) })
    let tree = await settle(propsB)
    expect(find(tree, PresetComposer)[0].props.why).toBe('Plan cleared: “build” isn’t among this revision’s loaded nodes.')
    f.take('nodes', B).answer(page([NEW]))
    tree = await settle(propsB)
    expect(find(tree, PresetComposer)[0].props.why).toBe('Plan made again for this revision from your words.')
  })

  it('a hand-made plan with no words is cleared visibly', async () => {
    const f = fakeApi()
    const propsA: Props = { api: f.api, repo: 'synthetic', sha: A, revisions, onClose }
    render(propsA)
    f.take('header', A).answer({ ok: true, value: header(A) })
    f.take('presets').answer({ ok: true, value: presets })
    await settle(propsA)
    f.take('nodes', A).answer(page([OLD]))
    let tree = await settle(propsA)
    ;(find(tree, 'button').find((b) => 'data-map-ask-open' in b.props)!.props.onClick as () => void)()
    tree = render(propsA)
    ;(find(tree, PresetComposer)[0].props.onPlan as (p: unknown) => void)({ preset: 'imports', params: { node_id: OLD.id }, note: null })
    const propsB: Props = { ...propsA, sha: B }
    render(propsB)
    f.take('header', B).answer({ ok: true, value: header(B) })
    tree = await settle(propsB)
    expect(find(tree, PresetComposer)[0].props.why).toBe(`Plan cleared: it was made for another revision. Choose a preset again (it named ${OLD.id}).`)
  })

  it('a full 40-character sha goes to the host as it is, even when it is not in the list (the host decides)', async () => {
    const f = fakeApi()
    const props: Props = { api: f.api, repo: 'synthetic', sha: B, revisions, onClose }
    render(props)
    f.take('header', B).answer({ ok: true, value: header(B) })
    f.take('presets').answer({ ok: true, value: presets })
    await settle(props)
    f.take('nodes', B).answer(page([NEW]))
    await settle(props)
    const unlisted = 'd'.repeat(40)
    fill.set!(`what changed since ${unlisted}`)
    let tree = render(props)
    ;(find(tree, PresetComposer)[0].props.onRun as () => void)()
    render(props)
    const d = f.take('drift')
    expect(d.args.slice(0, 3)).toEqual(['synthetic', unlisted, B])
    d.answer({ ok: false, failure: { kind: 'not_found' } })
    tree = await settle(props)
    expect(onClose).not.toHaveBeenCalled()
    expect(find(tree, Panel).some((p) => p.props.title === 'Previous revision unavailable')).toBe(true)
  })

  it('a re-read of the native space that answers after the visit moved on is dropped (A → B → A)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const flush = async () => {
        for (let k = 0; k < 20; k++) await Promise.resolve()
      }
      const f = fakeApi()
      const propsA: Props = { api: f.api, repo: 'synthetic', sha: A, revisions, onClose }
      const sp = (status: string) => ({ ok: true as const, value: readHeader({ repo: 'synthetic', sha: A, schema: 'repo-map/1', state: 'ready', reason: '', extractor: { id: 'omegacode.repository_map', version: '1', parser: null }, space: { id: 's', kind: 'read-only', status, atoms: status === 'incomplete' ? null : 0 } }) })
      render(propsA)
      f.take('header', A).answer(sp('mounting'))
      f.take('presets').answer({ ok: true, value: presets })
      await flush()
      render(propsA)
      vi.advanceTimersByTime(spacePollDelay(0))
      const late = f.take('header', A)
      render({ ...propsA, sha: B })
      render(propsA)
      late.answer(sp('incomplete'))
      await flush()
      const tree = render(propsA)
      expect((find(tree, StateBand)[0]?.props.space as { status: string } | undefined)?.status).not.toBe('incomplete')
    } finally {
      vi.useRealTimers()
    }
  })
})
