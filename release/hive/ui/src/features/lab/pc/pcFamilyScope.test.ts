/**
 * lab-pc-band r1, Code's preflight (PC_FAMILY_SCOPE_PREFLIGHT_20261012): a result belongs to one read (client, person
 * session, source team, read generation). The real usePcFamily runs on a minimal hook runtime (state, effects with
 * deps and cleanup, refs), the same approach as lib/closeHome.render.test.ts. r1.3: homes answers are also released out of
 * order (reversed completion), and the visibility listener runs on Node's real EventTarget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Slot = { deps: unknown[]; cleanup?: (() => void) | void } | unknown
const rt = { slots: [] as Slot[], cursor: 0, effects: [] as (() => void)[] }
vi.mock('react', async (orig) => {
  const real = await orig<typeof import('react')>()
  return {
    ...real,
    useState: (init: unknown) => {
      const i = rt.cursor++
      if (!(i in rt.slots)) rt.slots[i] = typeof init === 'function' ? (init as () => unknown)() : init
      return [rt.slots[i], (v: unknown) => (rt.slots[i] = typeof v === 'function' ? (v as (p: unknown) => unknown)(rt.slots[i]) : v)]
    },
    useEffect: (fn: () => (() => void) | void, deps?: unknown[]) => {
      const i = rt.cursor++
      const prev = rt.slots[i] as { deps?: unknown[]; cleanup?: (() => void) | void } | undefined
      if (!prev || !deps || !prev.deps || deps.some((d, n) => d !== prev.deps![n]))
        rt.effects.push(() => {
          prev?.cleanup?.()
          rt.slots[i] = { deps, cleanup: fn() }
        })
    },
    useCallback: <T,>(fn: T) => fn,
    useRef: (init: unknown) => {
      const i = rt.cursor++
      if (!(i in rt.slots)) rt.slots[i] = { current: init }
      return rt.slots[i]
    },
  }
})
let store: Record<string, unknown>
vi.mock('../../../store/store', () => ({ useHive: (sel: (s: unknown) => unknown) => sel(store) }))

const { usePcFamily, HOMES_RECHECK_MS, RETURN_ASK_MIN_MS, homesFailureWords } = await import('./PcFamily')
const { ApiError } = await import('../../../api/client')

type Req = { swarm: string; resolve: (g: unknown) => void; reject: (e: unknown) => void }
let reqs: Req[]
const client = () => ({ programView: (_p: string, b: { swarm_id: string }) => new Promise((resolve, reject) => reqs.push({ swarm: b.swarm_id, resolve, reject })) })
const graph = (tag: string) => ({ items: [{ id: `report-${tag}`, kind: 'contribution', label: tag, text: `from ${tag}`, meta: { state: 'recorded-claim', evidence: [], adoption_authorized: false } }], notes: [] })
/** one render of a hook (passed as a value, as lib/closeHome.render.test.ts does), then its effects */
const step = <T,>(hook: () => { state: T }): T => {
  rt.cursor = 0
  const v = hook()
  while (rt.effects.length) rt.effects.shift()!()
  return v.state
}
const render = () => step(usePcFamily)
/** the same, keeping the whole answer (state and retry) */
const stepAll = <T,>(hook: () => T): T => {
  rt.cursor = 0
  const v = hook()
  while (rt.effects.length) rt.effects.shift()!()
  return v
}
const flush = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve()
}
const ids = (s: ReturnType<typeof render>) => (s.kind === 'served' ? s.bands.reports.map((r) => r.id) : [])
const archiveA = () => (store.swarms = { A: { id: 'A', archived_at: '2026-10-12T00:00:00Z' }, B: { id: 'B' } })

beforeEach(() => {
  rt.slots = []
  rt.effects = []
  reqs = []
  store = { client: client(), session: 'p1', programs: [{ id: 'omegaevolve', enabled: true, error: null }], programsError: null, swarms: { A: { id: 'A' } } }
})

async function loadA() {
  expect(render().kind).toBe('loading')
  expect(reqs[0].swarm).toBe('A')
  reqs[0].resolve(graph('A'))
  await flush()
  const s = render()
  expect(ids(s)).toEqual(['report-A'])
  expect(s.kind === 'served' && s.source.swarm).toBe('A')
}

/** a homes route whose answer the test changes; every ask is counted */
function withHomes(first: string) {
  const h = { answer: first, asked: 0 }
  store.client = { ...client(), programHomes: async () => (h.asked++, { program: 'omegaevolve', homes: [{ swarm_id: h.answer, why: 'set up here' }] }) }
  return h
}
/** render until the view for `home` is requested and served */
async function serve(home: string, n: number) {
  render()
  await flush()
  render()
  await flush()
  expect(reqs[n]?.swarm).toBe(home)
  reqs[n].resolve(graph(home))
  await flush()
  const s = render()
  expect(s.kind === 'served' && s.source.swarm).toBe(home)
  return s
}

describe('r1.2: the homes are asked again while shown, and a new answer is never shown as the old (Kimi #1, M12)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { document?: unknown }).document
  })
  it('(a) the homes answer flips with no Retry: loading, then the new home; H1 is never shown as current after the flip', async () => {
    const h = withHomes('H1')
    await serve('H1', 0)
    h.answer = 'H2'
    vi.advanceTimersByTime(HOMES_RECHECK_MS)
    await flush()
    expect(render()).toEqual({ kind: 'loading' })   // not H1's result under the new answer
    await flush()
    expect(reqs.map((r) => r.swarm)).toEqual(['H1', 'H2'])
    expect(render()).toEqual({ kind: 'loading' })
    reqs[0].resolve(graph('H1-late'))   // a second, late H1 answer changes nothing
    reqs[1].resolve(graph('H2'))
    await flush()
    const s = render()
    expect(s.kind === 'served' && s.source.swarm).toBe('H2')
    expect(ids(s)).toEqual(['report-H2'])
  })
  it('(a2) an unchanged answer keeps the result and reads nothing again', async () => {
    const h = withHomes('H1')
    await serve('H1', 0)
    vi.advanceTimersByTime(HOMES_RECHECK_MS * 2)
    await flush()
    const s = render()
    expect(ids(s)).toEqual(['report-H1'])
    expect(reqs).toHaveLength(1)
    expect(h.asked).toBe(3)
  })
  it('(b) fallback A with home H1, then B (its homes answer lands while B’s view is pending), then A again: loading, not A’s old result', async () => {
    withHomes('H1')
    store.swarms = { A: { id: 'A' }, B: { id: 'B' } }
    await serve('H1', 0)
    store.swarms = { A: { id: 'A', archived_at: 'x' }, B: { id: 'B' } }   // fallback is now B
    expect(render()).toEqual({ kind: 'loading' })
    await flush()
    expect(render()).toEqual({ kind: 'loading' })   // B's homes answered; B's view pending
    expect(reqs).toHaveLength(2)
    store.swarms = { A: { id: 'A' }, B: { id: 'B' } }   // back to A
    expect(render()).toEqual({ kind: 'loading' })
    await flush()
    expect(render()).toEqual({ kind: 'loading' })   // A's homes answered again: still A's old result is not shown
    expect(reqs).toHaveLength(3)
    reqs[2].resolve(graph('A-again'))
    await flush()
    expect(ids(render())).toEqual(['report-A-again'])
  })
  it('the recheck stops on an identity change and while the tab is hidden', async () => {
    const h = withHomes('H1')
    await serve('H1', 0)
    expect(h.asked).toBe(1)
    store.session = 'p2'   // identity change: the old interval is cleared, a new one starts
    render()
    await flush()
    const after = h.asked
    vi.advanceTimersByTime(HOMES_RECHECK_MS)
    await flush()
    expect(h.asked).toBe(after + 1)   // one interval, not two
    const listeners: (() => void)[] = []
    ;(globalThis as { document?: unknown }).document = { visibilityState: 'hidden', addEventListener: (_: string, f: () => void) => listeners.push(f), removeEventListener: () => undefined }
    store.session = 'p3'
    render()
    await flush()
    const hidden = h.asked
    vi.advanceTimersByTime(HOMES_RECHECK_MS * 3)
    await flush()
    expect(h.asked).toBe(hidden)   // hidden: no rechecks
    ;(globalThis as { document?: { visibilityState: string } }).document!.visibilityState = 'visible'
    listeners.at(-1)!()
    await flush()
    expect(h.asked).toBe(hidden + 1)   // asked again on returning to the tab
  })
  it('Retry asks the homes again and moves to a different answer', async () => {
    const h = withHomes('H1')
    await serve('H1', 0)
    h.answer = 'H2'
    // r1.4: Retry re-reads the current home's view and re-asks the homes in the same epoch (r1.5: if not asked
    // under 10 s ago)
    vi.advanceTimersByTime(RETURN_ASK_MIN_MS)
    stepAll(usePcFamily).retry()
    expect(render()).toEqual({ kind: 'loading' })
    await flush()
    expect(render()).toEqual({ kind: 'loading' })
    await flush()
    expect(reqs.map((r) => r.swarm)).toEqual(['H1', 'H1', 'H2'])
    reqs[1].resolve(graph('H1-retry'))   // read for the key the new answer replaced: dropped
    reqs[2].resolve(graph('H2'))
    await flush()
    expect(ids(render())).toEqual(['report-H2'])
  })
})

/** a homes route whose answers the test releases, in any order */
function homesCtl() {
  const c = { pending: [] as { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] }
  store.client = { ...client(), programHomes: () => new Promise((resolve, reject) => c.pending.push({ resolve, reject })) }
  const answer = (i: number, swarm: string) => c.pending[i].resolve({ program: 'omegaevolve', homes: [{ swarm_id: swarm, why: 'set up here' }] })
  return { c, answer }
}
/** Node's real EventTarget as the document, with a settable visibilityState */
function realDocument(state: 'visible' | 'hidden') {
  const doc = Object.assign(new EventTarget(), { visibilityState: state })
  const add = vi.spyOn(doc, 'addEventListener')
  const remove = vi.spyOn(doc, 'removeEventListener')
  ;(globalThis as { document?: unknown }).document = doc
  return { doc, add, remove, show: (v: 'visible' | 'hidden') => ((doc.visibilityState = v), doc.dispatchEvent(new Event('visibilitychange'))) }
}

describe('r1.3: homes answers in order, identity epochs, homes errors, the tab', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { document?: unknown }).document
  })
  it('reversed completion: an older homes answer landing after a newer one never wins', async () => {
    const { c, answer } = homesCtl()
    render()
    answer(0, 'H1')
    await flush()
    render()
    await flush()
    reqs[0].resolve(graph('H1'))
    await flush()
    expect(ids(render())).toEqual(['report-H1'])
    vi.advanceTimersByTime(HOMES_RECHECK_MS)   // ask 2 (slow, would say H1)
    vi.advanceTimersByTime(HOMES_RECHECK_MS)   // ask 3 (fast, says H2)
    expect(c.pending).toHaveLength(3)
    answer(2, 'H2')
    await flush()
    render()
    await flush()
    expect(reqs.map((r) => r.swarm)).toEqual(['H1', 'H2'])
    reqs[1].resolve(graph('H2'))
    await flush()
    expect(ids(render())).toEqual(['report-H2'])
    answer(1, 'H1')   // the older ask lands last
    await flush()
    const s = render()
    await flush()
    expect(ids(s)).toEqual(['report-H2'])
    expect(ids(render())).toEqual(['report-H2'])
    expect(reqs).toHaveLength(2)   // H1 was not read again
  })
  it('A → B → A before B’s homes answer lands: loading, never A’s old result (stand-in)', async () => {
    const { c, answer } = homesCtl()
    store.swarms = { A: { id: 'A' }, B: { id: 'B' } }
    render()
    answer(0, 'H1')
    await flush()
    render()
    await flush()
    reqs[0].resolve(graph('A-first'))
    await flush()
    expect(ids(render())).toEqual(['report-A-first'])
    store.swarms = { A: { id: 'A', archived_at: 'x' }, B: { id: 'B' } }   // B: its homes are asked, not answered
    expect(render()).toEqual({ kind: 'loading' })
    expect(c.pending).toHaveLength(2)
    store.swarms = { A: { id: 'A' }, B: { id: 'B' } }   // back to A before B's answer
    expect(render()).toEqual({ kind: 'loading' })
    expect(render()).toEqual({ kind: 'loading' })
    answer(1, 'H1')   // B's late answer: dropped (its epoch ended)
    answer(2, 'H1')   // A's new answer, the same home as before
    await flush()
    expect(render()).toEqual({ kind: 'loading' })   // the fresh A read is pending; the old A result is not shown
    await flush()
    expect(reqs).toHaveLength(2)
    reqs[1].resolve(graph('A-again'))
    await flush()
    expect(ids(render())).toEqual(['report-A-again'])
  })
  it('H1 → H2 → H1 within one epoch: the first H1 result is not shown again; H1 is read afresh (homes generation)', async () => {
    const { answer } = homesCtl()
    render()
    answer(0, 'H1')
    await flush()
    render()
    await flush()
    reqs[0].resolve(graph('H1-first'))
    await flush()
    expect(ids(render())).toEqual(['report-H1-first'])
    vi.advanceTimersByTime(HOMES_RECHECK_MS)
    answer(1, 'H2')
    await flush()
    render()
    await flush()
    reqs[1].resolve(graph('H2'))
    await flush()
    expect(ids(render())).toEqual(['report-H2'])
    vi.advanceTimersByTime(HOMES_RECHECK_MS)
    answer(2, 'H1')
    await flush()
    expect(render()).toEqual({ kind: 'loading' })   // not the first H1 result
    await flush()
    expect(reqs.map((r) => r.swarm)).toEqual(['H1', 'H2', 'H1'])
    reqs[2].resolve(graph('H1-again'))
    await flush()
    expect(ids(render())).toEqual(['report-H1-again'])
  })
  it('H1 → H2 → H1 before H2’s view lands: nothing read before the newest homes answer is shown (homes generation)', async () => {
    const { answer } = homesCtl()
    render()
    answer(0, 'H1')
    await flush()
    render()
    await flush()
    reqs[0].resolve(graph('H1-first'))
    await flush()
    expect(ids(render())).toEqual(['report-H1-first'])
    vi.advanceTimersByTime(HOMES_RECHECK_MS)
    answer(1, 'H2')
    await flush()
    expect(render()).toEqual({ kind: 'loading' })
    await flush()   // H2's view read is pending
    vi.advanceTimersByTime(HOMES_RECHECK_MS)
    answer(2, 'H1')
    await flush()
    expect(render()).toEqual({ kind: 'loading' })   // not H1-first: it was read before two newer answers
    await flush()
    expect(reqs.map((r) => r.swarm)).toEqual(['H1', 'H2', 'H1'])
    reqs[1].resolve(graph('H2-late'))   // the abandoned H2 read lands: dropped
    reqs[2].resolve(graph('H1-again'))
    await flush()
    expect(ids(render())).toEqual(['report-H1-again'])
  })
  it('a homes route that fails is an error with Retry, never "no home"; Retry asks again', async () => {
    const { c, answer } = homesCtl()
    render()
    c.pending[0].reject(new ApiError(500, 'program_error', 'homes broke'))
    await flush()
    const s = render()
    expect(s).toEqual({ kind: 'failed', why: homesFailureWords(new ApiError(500, 'program_error', 'homes broke')) })
    expect(s.kind === 'failed' && s.why).toContain('homes broke')
    expect(JSON.stringify(s)).not.toContain('names no home')
    expect(reqs).toHaveLength(0)   // no view read from a guessed swarm
    stepAll(usePcFamily).retry()
    render()
    answer(1, 'H1')
    await flush()
    render()
    await flush()
    reqs[0].resolve(graph('H1'))
    await flush()
    expect(ids(render())).toEqual(['report-H1'])
  })
  it('after a good answer, a failed recheck keeps the answer (no flapping)', async () => {
    const { c, answer } = homesCtl()
    render()
    answer(0, 'H1')
    await flush()
    render()
    await flush()
    reqs[0].resolve(graph('H1'))
    await flush()
    vi.advanceTimersByTime(HOMES_RECHECK_MS)
    c.pending[1].reject(new Error('flap'))
    await flush()
    expect(ids(render())).toEqual(['report-H1'])
    expect(reqs).toHaveLength(1)
  })
  it('a late view answer for an earlier key never replaces the current one', async () => {
    const { answer } = homesCtl()
    render()
    answer(0, 'H1')
    await flush()
    render()
    await flush()   // H1's view read is pending
    vi.advanceTimersByTime(HOMES_RECHECK_MS)
    answer(1, 'H2')
    await flush()
    render()
    await flush()
    expect(reqs.map((r) => r.swarm)).toEqual(['H1', 'H2'])
    reqs[1].resolve(graph('H2'))
    await flush()
    expect(ids(render())).toEqual(['report-H2'])
    reqs[0].resolve(graph('H1-late'))
    await flush()
    expect(ids(render())).toEqual(['report-H2'])
  })
  it('the visibilitychange listener is registered on the document and removed when the epoch ends (Node EventTarget)', async () => {
    const d = realDocument('visible')
    homesCtl()
    render()
    expect(d.add).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    const listener = d.add.mock.calls[0][1]
    store.session = 'p2'
    render()
    expect(d.remove).toHaveBeenCalledWith('visibilitychange', listener)
    expect(d.add).toHaveBeenCalledTimes(2)
  })
  it('the interval is cleared while hidden and restarted on return; only "visible" counts (not prerender)', async () => {
    const d = realDocument('visible')
    const { c } = homesCtl()
    render()
    expect(vi.getTimerCount()).toBe(1)
    d.show('hidden')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(HOMES_RECHECK_MS * 3)
    expect(c.pending).toHaveLength(1)
    d.show('visible')
    expect(vi.getTimerCount()).toBe(1)
    expect(c.pending).toHaveLength(2)   // asked on return
    ;(d.doc as unknown as { visibilityState: string }).visibilityState = 'prerender'
    d.doc.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0)
    expect(c.pending).toHaveLength(2)
  })
})

describe('r1.4: Retry keeps the epoch, staleness is disclosed, the tab asks only when shown', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date(2026, 9, 12, 10, 42, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { document?: unknown }).document
  })
  /** H1 answered and its view served */
  async function servedH1() {
    const ctl = homesCtl()
    render()
    ctl.answer(0, 'H1')
    await flush()
    render()
    await flush()
    return ctl
  }
  it('good homes → view fails → Retry → homes fails: still the kept answer, marked stale (Kimi’s 4 steps)', async () => {
    const { c } = await servedH1()
    reqs[0].reject(new ApiError(500, 'program_error', 'view broke'))   // 2. the view fails
    await flush()
    const failed = stepAll(usePcFamily)
    expect(failed.state).toEqual({ kind: 'failed', why: 'view broke' })
    vi.advanceTimersByTime(RETURN_ASK_MIN_MS)   // r1.5: past the 10 s window, so this Retry re-asks the homes
    failed.retry()   // 3. Retry: the view again, in the same epoch
    render()
    await flush()
    expect(c.pending).toHaveLength(2)   // the homes are re-asked too
    c.pending[1].reject(new Error('homes flaked'))   // 4. the homes fail
    await flush()
    expect(render()).toEqual({ kind: 'loading' })   // not the homes error: the kept answer stands
    expect(reqs.map((r) => r.swarm)).toEqual(['H1', 'H1'])
    reqs[1].resolve(graph('H1'))
    await flush()
    const s = render()
    expect(ids(s)).toEqual(['report-H1'])
    expect(s.kind === 'served' && s.source.lastConfirmed).toBe(new Date(2026, 9, 12, 10, 42, 0).getTime())
  })
  it('a failed recheck marks the kept answer stale; the next good answer clears it without a re-read', async () => {
    const { c, answer } = await servedH1()
    reqs[0].resolve(graph('H1'))
    await flush()
    expect(render()).toMatchObject({ kind: 'served', source: { swarm: 'H1' } })
    expect((render() as { source: { lastConfirmed?: number } }).source.lastConfirmed).toBeUndefined()
    vi.advanceTimersByTime(HOMES_RECHECK_MS)
    c.pending[1].reject(new Error('flap'))
    await flush()
    const stale = render()
    expect(stale.kind === 'served' && stale.source.lastConfirmed).toBe(new Date(2026, 9, 12, 10, 42, 0).getTime())
    vi.advanceTimersByTime(HOMES_RECHECK_MS)
    answer(2, 'H1')
    await flush()
    const fresh = render()
    expect(fresh.kind === 'served' && fresh.source.lastConfirmed).toBeUndefined()
    expect(reqs).toHaveLength(1)
  })
  it('a Retry after a homes failure still starts a new epoch (the full reset is kept for that branch)', async () => {
    const { c, answer } = homesCtl()
    render()
    c.pending[0].reject(new Error('down'))
    await flush()
    const f = stepAll(usePcFamily)
    expect(f.state.kind).toBe('failed')
    f.retry()
    render()
    answer(1, 'H1')
    await flush()
    render()
    await flush()
    reqs[0].resolve(graph('H1'))
    await flush()
    expect(ids(render())).toEqual(['report-H1'])
  })
  it('a hidden tab asks nothing until it is shown', async () => {
    const d = realDocument('hidden')
    const { c } = homesCtl()
    render()
    await flush()
    expect(c.pending).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(render()).toEqual({ kind: 'loading', waitingForTab: true })   // followups-r7: waiting, not reading
    d.show('visible')
    expect(c.pending).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
  })
  it('hidden → visible within 10 s of the last ask does not ask again; the interval still restarts', async () => {
    const d = realDocument('visible')
    const { c } = homesCtl()
    render()
    expect(c.pending).toHaveLength(1)
    d.show('hidden')
    vi.advanceTimersByTime(RETURN_ASK_MIN_MS - 1000)
    d.show('visible')
    expect(c.pending).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    d.show('hidden')
    vi.advanceTimersByTime(RETURN_ASK_MIN_MS)
    d.show('visible')
    expect(c.pending).toHaveLength(2)
  })
  it('convergence: an identity change rendered twice advances the epoch once and sends exactly one homes ask', async () => {
    const { c, answer } = homesCtl()
    render()
    answer(0, 'H1')
    await flush()
    render()
    await flush()
    reqs[0].resolve(graph('H1'))
    await flush()
    store.session = 'p2'
    render()
    render()
    await flush()
    expect(c.pending).toHaveLength(2)   // one new ask, not two
    answer(1, 'H1')
    await flush()
    render()
    render()
    await flush()
    expect(reqs).toHaveLength(2)   // one new view read for the one new epoch
  })
})

describe('r1.5: Retry backpressure, the stale Retry, held view results', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date(2026, 9, 12, 10, 42, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { document?: unknown }).document
  })
  /** H1 answered and served (fresh) */
  async function freshH1() {
    const ctl = homesCtl()
    render()
    ctl.answer(0, 'H1')
    await flush()
    render()
    await flush()
    reqs[0].resolve(graph('H1'))
    await flush()
    expect(ids(render())).toEqual(['report-H1'])
    return ctl
  }
  it('Retry twice (a render between, no flush): exactly one homes ask and one view read; busy until it settles', async () => {
    const { c, answer } = await freshH1()
    vi.advanceTimersByTime(RETURN_ASK_MIN_MS)
    stepAll(usePcFamily).retry()
    const mid = stepAll(usePcFamily)
    expect(mid.retryBusy).toBe(true)
    mid.retry()   // ignored: a Retry is in flight
    render()
    expect(c.pending).toHaveLength(2)
    expect(reqs).toHaveLength(2)
    answer(1, 'H1')
    reqs[1].resolve(graph('H1-retry'))
    await flush()
    const done = stepAll(usePcFamily)
    expect(ids(done.state)).toEqual(['report-H1-retry'])
    expect(done.retryBusy).toBe(false)
    expect(c.pending).toHaveLength(2)
    expect(reqs).toHaveLength(2)
  })
  it('a view Retry within 10 s of the last homes ask re-reads the view only (the window survives the effect re-run)', async () => {
    const { c } = await freshH1()
    vi.advanceTimersByTime(RETURN_ASK_MIN_MS - 2000)
    stepAll(usePcFamily).retry()
    render()
    await flush()
    expect(c.pending).toHaveLength(1)   // no new homes ask
    expect(reqs).toHaveLength(2)
    reqs[1].resolve(graph('H1-retry'))
    await flush()
    const s = stepAll(usePcFamily)
    expect(ids(s.state)).toEqual(['report-H1-retry'])
    expect(s.retryBusy).toBe(false)
  })
  it('the stale Retry re-asks the homes only: no view re-read, no remount; an unchanged answer clears "stale"', async () => {
    const { c, answer } = await freshH1()
    vi.advanceTimersByTime(HOMES_RECHECK_MS)
    c.pending[1].reject(new Error('flap'))
    await flush()
    const stale = stepAll(usePcFamily)
    expect(stale.state.kind === 'served' && stale.state.source.lastConfirmed).toBeTypeOf('number')
    stale.retry()
    const busy = stepAll(usePcFamily)
    expect(busy.state.kind).toBe('served')   // still shown while the homes are asked: no remount
    expect(busy.retryBusy).toBe(true)
    expect(c.pending).toHaveLength(3)
    expect(reqs).toHaveLength(1)
    answer(2, 'H1')
    await flush()
    const fresh = stepAll(usePcFamily)
    expect(fresh.state.kind === 'served' && fresh.state.source.lastConfirmed).toBeUndefined()
    expect(fresh.retryBusy).toBe(false)
    expect(reqs).toHaveLength(1)   // no re-read
  })
  it('after a view Retry, a view answer that lands before the homes answer is held: H1 view first, then homes H2 (stand-in #1)', async () => {
    const { c, answer } = await freshH1()
    vi.advanceTimersByTime(RETURN_ASK_MIN_MS)
    stepAll(usePcFamily).retry()
    expect(render()).toEqual({ kind: 'loading' })
    await flush()
    expect(c.pending).toHaveLength(2)
    expect(reqs.map((r) => r.swarm)).toEqual(['H1', 'H1'])
    reqs[1].resolve(graph('H1-retry'))   // the view lands first
    await flush()
    expect(render()).toEqual({ kind: 'loading' })   // held: the homes answer for this Retry has not settled
    answer(1, 'H2')   // then the homes: a different home
    await flush()
    expect(render()).toEqual({ kind: 'loading' })
    await flush()
    expect(reqs.map((r) => r.swarm)).toEqual(['H1', 'H1', 'H2'])
    reqs[2].resolve(graph('H2'))
    await flush()
    expect(ids(render())).toEqual(['report-H2'])
  })
  it('the same ordering with an unchanged home shows the held view result once the homes answer settles', async () => {
    const { answer } = await freshH1()
    vi.advanceTimersByTime(RETURN_ASK_MIN_MS)
    stepAll(usePcFamily).retry()
    render()
    await flush()
    reqs[1].resolve(graph('H1-retry'))
    await flush()
    expect(render()).toEqual({ kind: 'loading' })
    answer(1, 'H1')
    await flush()
    expect(ids(render())).toEqual(['report-H1-retry'])
    expect(reqs).toHaveLength(2)
  })
})

describe('r1.6: one source for busy and the latch; Retry always recovers (Kimi, stand-in)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date(2026, 9, 13, 10, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { document?: unknown }).document
  })
  async function freshH1() {
    const ctl = homesCtl()
    render()
    ctl.answer(0, 'H1')
    await flush()
    render()
    await flush()
    reqs[0].resolve(graph('H1'))
    await flush()
    expect(ids(render())).toEqual(['report-H1'])
    return ctl
  }
  /** run every effect cleanup, as an unmount does */
  const unmount = () => {
    for (const sl of rt.slots) (sl as { cleanup?: () => void } | undefined)?.cleanup?.()
    rt.slots = []
  }
  it('a Retry with no other pending shows busy exactly when presses are ignored, and is free the render it shows free', async () => {
    const { c, answer } = await freshH1()
    expect(stepAll(usePcFamily).retryBusy).toBe(false)   // nothing pending: not busy, even with reads in flight later
    vi.advanceTimersByTime(RETURN_ASK_MIN_MS)
    const first = stepAll(usePcFamily)
    first.retry()
    first.retry()   // the same closure, same render: the state it reads already says pending
    const busy = stepAll(usePcFamily)
    expect(busy.retryBusy).toBe(true)
    busy.retry()   // shown busy: ignored
    render()
    expect(c.pending).toHaveLength(2)
    expect(reqs).toHaveLength(2)
    answer(1, 'H1')
    reqs[1].resolve(graph('H1-retry'))
    await flush()
    const free = stepAll(usePcFamily)
    expect(free.retryBusy).toBe(false)
    free.retry()   // shown free: taken, in this very render's closure
    expect(stepAll(usePcFamily).retryBusy).toBe(true)
    await flush()
    expect(reqs.length).toBe(3)
  })
  it('repeated rejection: each failed Retry ends not busy, and the next Retry is taken', async () => {
    const { c, answer } = await freshH1()
    vi.advanceTimersByTime(RETURN_ASK_MIN_MS)
    stepAll(usePcFamily).retry()
    render()
    await flush()
    reqs[1].reject(new ApiError(500, 'program_error', 'view broke'))
    await flush()
    expect(stepAll(usePcFamily).retryBusy).toBe(true)   // the failed view waits for this Retry's homes answer (r1.5)
    answer(1, 'H1')
    await flush()
    const failed1 = stepAll(usePcFamily)
    expect(failed1.state).toEqual({ kind: 'failed', why: 'view broke' })
    expect(failed1.retryBusy).toBe(false)
    failed1.retry()   // within 10 s of the last homes ask: the view only
    render()
    await flush()
    expect(c.pending).toHaveLength(2)
    reqs[2].reject(new ApiError(500, 'program_error', 'broke again'))
    await flush()
    const failed2 = stepAll(usePcFamily)
    expect(failed2.state).toEqual({ kind: 'failed', why: 'broke again' })
    expect(failed2.retryBusy).toBe(false)
    failed2.retry()
    render()
    expect(reqs).toHaveLength(4)
  })
  it('an identity change during a Retry: the new identity loads, and busy clears when it has', async () => {
    const { answer } = await freshH1()
    vi.advanceTimersByTime(RETURN_ASK_MIN_MS)
    stepAll(usePcFamily).retry()
    render()
    expect(stepAll(usePcFamily).retryBusy).toBe(true)
    store.session = 'p2'   // a new person session mid-Retry
    render()
    await flush()
    const asked = reqs.length
    answer(2, 'H1')   // the new epoch's homes answer (the Retry's own homes ask, #1, is now stale)
    await flush()
    render()
    await flush()
    expect(reqs.length).toBe(asked + 1)
    reqs[reqs.length - 1].resolve(graph('H1-p2'))
    await flush()
    const s = stepAll(usePcFamily)
    expect(ids(s.state)).toEqual(['report-H1-p2'])
    expect(s.retryBusy).toBe(false)
  })
  it('unmount with reads pending: late answers change nothing, and a new mount starts not busy', async () => {
    const { c } = await freshH1()
    vi.advanceTimersByTime(RETURN_ASK_MIN_MS)
    stepAll(usePcFamily).retry()
    render()
    expect(stepAll(usePcFamily).retryBusy).toBe(true)
    unmount()
    c.pending[1].resolve({ program: 'omegaevolve', homes: [{ swarm_id: 'H9', why: 'late' }] })
    reqs[1].resolve(graph('late'))
    await flush()
    expect(rt.slots).toEqual([])   // nothing was written back into the unmounted hook
    const fresh = stepAll(usePcFamily)
    expect(fresh.retryBusy).toBe(false)
    expect(fresh.state).toEqual({ kind: 'loading' })
  })
})

describe('a result belongs to one read', () => {
  it('A is not shown while B is pending: loading', async () => {
    await loadA()
    archiveA()
    const during = render()
    expect(reqs[1].swarm).toBe('B')
    expect(during).toEqual({ kind: 'loading' })
    reqs[1].resolve(graph('B'))
    await flush()
    const after = render()
    expect(ids(after)).toEqual(['report-B'])
    expect(after.kind === 'served' && after.source.swarm).toBe('B')
  })
  it('a late A reply after B is selected is dropped', async () => {
    expect(render().kind).toBe('loading')
    archiveA()
    expect(render().kind).toBe('loading')
    expect(reqs.map((r) => r.swarm)).toEqual(['A', 'B'])
    reqs[0].resolve(graph('A'))   // late: A answers after B was chosen
    await flush()
    expect(render()).toEqual({ kind: 'loading' })
    reqs[1].resolve(graph('B'))
    await flush()
    expect(ids(render())).toEqual(['report-B'])
  })
  it('B refused or failing shows an honest state, never A’s data', async () => {
    await loadA()
    archiveA()
    render()
    reqs[1].reject(new ApiError(403, 'program_refused', 'not in this team'))
    await flush()
    const refused = render()
    expect(refused.kind).toBe('not-served')
    expect(ids(refused)).toEqual([])
    store.swarms = { A: { id: 'A', archived_at: 'x' }, B: { id: 'B', archived_at: 'x' }, C: { id: 'C' } }
    render()
    reqs[2].reject(new ApiError(500, 'program_error', 'broke'))
    await flush()
    expect(render()).toEqual({ kind: 'failed', why: 'broke' })
  })
  it('a new person session or a new client reads again', async () => {
    await loadA()
    store.session = 'p2'
    expect(render()).toEqual({ kind: 'loading' })
    reqs[1].resolve(graph('A2'))
    await flush()
    expect(ids(render())).toEqual(['report-A2'])
    store.client = client()
    expect(render()).toEqual({ kind: 'loading' })
  })
})

describe('followups-r7 item 5: a band whose tab opened hidden says it is waiting for the tab, not reading', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { document?: unknown }).document
  })
  it('hidden with nothing asked: waiting, for as long as it stays hidden; shown: the first ask starts and it is reading', async () => {
    const d = realDocument('hidden')
    const { c, answer } = homesCtl()
    expect(render()).toEqual({ kind: 'loading', waitingForTab: true })
    await flush()
    vi.advanceTimersByTime(10 * HOMES_RECHECK_MS)   // a long time hidden: still nothing asked, still waiting
    expect(c.pending).toHaveLength(0)
    expect(render()).toEqual({ kind: 'loading', waitingForTab: true })
    d.show('visible')
    expect(c.pending).toHaveLength(1)
    expect(render()).toEqual({ kind: 'loading' })   // the ask has started: reading
    answer(0, 'H1')
    await flush()
    render()
    await flush()
    expect(reqs[0]?.swarm).toBe('H1')
    expect(render()).toEqual({ kind: 'loading' })
    reqs[0].resolve(graph('H1'))
    await flush()
    expect(ids(render())).toEqual(['report-H1'])
  })
  it('hidden AFTER the first ask started (mid-read): still reading, never "waiting"', async () => {
    const d = realDocument('visible')
    const { c } = homesCtl()
    expect(render()).toEqual({ kind: 'loading' })
    expect(c.pending).toHaveLength(1)
    d.show('hidden')
    expect(render()).toEqual({ kind: 'loading' })
  })
  it('opened visible: reading from the first render (the wait copy never flashes)', () => {
    realDocument('visible')
    homesCtl()
    expect(render()).toEqual({ kind: 'loading' })
  })
  it('a client with no homes route reads the view at once, hidden or not: reading', () => {
    realDocument('hidden')
    expect(render()).toEqual({ kind: 'loading' })
    expect(reqs).toHaveLength(1)
  })
})
