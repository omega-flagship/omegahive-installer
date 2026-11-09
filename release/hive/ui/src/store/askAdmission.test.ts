import { currentEpoch } from '../lib/identityEpoch'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// the page's location, played in node: navigate() moves the hash, as the router does
const loc = { hash: '#/', search: '', pathname: '/' }
const store = new Map<string, string>()
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false }), localStorage: storage, addEventListener: vi.fn(), removeEventListener: vi.fn() })
vi.stubGlobal('localStorage', storage)
vi.mock('../lib/router', async (orig) => {
  const real = await orig<typeof import('../lib/router')>()
  return { ...real, navigate: (r: import('../lib/router').Route) => void (loc.hash = real.href(r)) }
})

const { useHive } = await import('./store')
const { CHECK_BACKOFF_MS, CHECK_TRIES, SILENCE_MS, threadRows, useAskStore, askRetryContext } = await import('./ask')
const { ApiError } = await import('../api/client')
const { AskRefusal } = await import('../api/ask')
const { LiveClient } = await import('../api/live')
type AskEvent = import('../api/ask').AskEvent
type AskBody = import('../api/ask').AskBody
type HiveClient = import('../api/client').HiveClient

/**
 * Review B1 of the Ask release 45392df (PLATFORM_ASK_RELEASE_45392DF_REVIEW_VERDICT_20261006): an Ask whose admission
 * is not known (no answer, an unreadable 200, a 5xx after the host may have committed) is never closed as refused and
 * never sent again under a new operation_id. Each scenario runs against a synthetic host that admits each
 * operation_id at most once per person (as hive/core/ask.py does: a replay of the same id and body returns the
 * original turn) and counts admissions. Invented data only, no network, no model.
 */
let frames: Record<string, AskEvent[]> = {}
const thread = { id: 'ses_ask1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0.25, spent_usd: 0 }
function frame(op: string, seq: number, f: Record<string, unknown>): AskEvent {
  const e = { type: 'ask', operation_id: op, turn_id: `t_${op}`, principal: 'user:p_ada', seq, at: '2026-10-06T10:00:00Z', ...f } as unknown as AskEvent
  ;(frames[op] ??= []).push(e)
  return e
}

/** What the synthetic host does with the nth POST /api/ask (1-based). */
type Step = 'ok' | 'lost-before' | 'lost-after' | 'raw-after' | '500-after' | '503-after' | 'busy-other' | 'rate-limited' | 'hang'
interface Host {
  client: HiveClient
  /** every POST /api/ask body, in order */
  posts: AskBody[]
  /** operations the host admitted (each once) */
  admitted: Set<string>
  /** how many admissions the host made (a replay is not one) */
  admissions: () => number
  /** hold back GET /api/ask/{op} until released */
  holdReads: () => { release: () => void; fail: () => void }
  /** an original that is still in transit lands at the start of the next POST (a delayed admission) */
  landLater: () => void
}
function fakeHost(script: (n: number) => Step): Host {
  const admitted = new Set<string>()
  const posts: AskBody[] = []
  let count = 0
  let late: AskBody | null = null
  let hold: Promise<void> | null = null
  let holdFail = false
  const admit = (b: AskBody) => {
    if (admitted.has(b.operation_id)) return
    admitted.add(b.operation_id)
    count++
    frame(b.operation_id, 1, { phase: 'accepted', thread })
    frame(b.operation_id, 2, { phase: 'answer', text: `Answer to ${b.text}` })
  }
  const view = (op: string, after = 0) => ({ operation_id: op, turn_id: `t_${op}`, thread, state: 'accepted' as const, events: (frames[op] ?? []).filter((e) => e.seq > after), more: false })
  const client = {
    mode: 'sim',
    ask: vi.fn(async (b: AskBody) => {
      if (late) {
        // the original, still in transit when its sender gave up on it, reaches the host first
        admit(late)
        late = null
      }
      posts.push(structuredClone(b))
      const step = script(posts.length)
      if (step === 'hang') return new Promise(() => undefined)
      if (step === 'lost-before') {
        if (posts.length === 1 && hostLandsLate) late = structuredClone(b)
        throw new ApiError(0, 'network', 'Failed to fetch')
      }
      if (step === 'busy-other') throw new AskRefusal(409, 'ask_busy', 'busy', { operation_id: 'ask:someone:else' })
      if (step === 'rate-limited') throw new AskRefusal(429, 'rate_limited', 'host text')
      admit(b)
      if (step === 'lost-after') throw new ApiError(0, 'network', 'Failed to fetch')
      if (step === 'raw-after') throw new SyntaxError('Unexpected end of JSON input')
      if (step === '500-after') throw new AskRefusal(500, 'internal', 'host text')
      if (step === '503-after') throw new AskRefusal(503, 'unavailable', 'host text')
      return view(b.operation_id)
    }),
    askTurn: vi.fn(async (op: string, after = 0) => {
      if (hold) {
        await hold
        if (holdFail) throw new AskRefusal(404, 'not_available', 'no such turn')
      }
      if (!admitted.has(op)) throw new AskRefusal(404, 'not_available', 'no such turn')
      return view(op, after)
    }),
  } as unknown as HiveClient
  let hostLandsLate = false
  return {
    client,
    posts,
    admitted,
    admissions: () => count,
    holdReads: () => {
      let release!: () => void
      hold = new Promise<void>((r) => (release = r))
      return { release: () => release(), fail: () => ((holdFail = true), release()) }
    },
    landLater: () => void (hostLandsLate = true),
  }
}

let n = 0
async function start(client: HiveClient, principal = 'user:p_ada') {
  useHive.setState({ client, session: `session-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session, principal)
}
const ctx = { route: 'hive', experience: 'classic' }
const rows = () => threadRows(useAskStore.getState())
const text = () => JSON.stringify(rows())
const ops = (h: Host) => new Set(h.posts.map((b) => b.operation_id))
const turn = (op: string) => useAskStore.getState().turns[op]
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
/** exactly one operation, admitted once, and every POST was the same original body */
function oneOperation(h: Host) {
  expect(ops(h).size).toBe(1)
  expect(h.admissions()).toBe(1)
  for (const b of h.posts) expect(b).toEqual(h.posts[0])
}

beforeEach(() => {
  frames = {}
  loc.hash = '#/'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false }), localStorage: storage, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('localStorage', storage)
  useAskStore.getState().reset()
})

// ---------------------------------------------------------------- Review's witness, as written

describe('Review witness (45392df admission probe)', () => {
  function fakeClient(over: Partial<HiveClient> = {}): HiveClient {
    return {
      mode: 'sim',
      ask: vi.fn(async (b: { operation_id: string }) => ({ operation_id: b.operation_id, turn_id: 't1', thread, state: 'accepted' as const })),
      askTurn: vi.fn(async (op: string, after = 0) => ({ operation_id: op, turn_id: 't1', events: (frames[op] ?? []).filter((e) => e.seq > after), more: false })),
      askTakeover: vi.fn(async () => ({})),
      ...over,
    } as unknown as HiveClient
  }
  it('Review: a lost admission answer must not retry as a second operation', async () => {
    const calls: string[] = []
    const client = fakeClient({ ask: vi.fn(async (body: { operation_id: string }) => {
      calls.push(body.operation_id)
      throw new Error('response body lost after host admission')
    }) as never })
    await start(client)
    await useAskStore.getState().send('synthetic question', { route: 'hive', experience: 'classic' })
    await retryCurrent()
    expect(new Set(calls).size).toBe(1)
  })
})

// ---------------------------------------------------------------- the scenarios Review asked for


describe('client-only original admission receipts', () => {
  it('real admit sends nothing and removes its unsent turn when publication synchronously changes the epoch', async () => {
    vi.useFakeTimers()
    const h = fakeHost(() => 'ok')
    await start(h.client)
    const words = 'Keep these words until an operation can actually be issued'
    let original: string | null = null
    const unsubscribe = useAskStore.subscribe((s) => {
      if (original || !s.open || s.turns[s.open]?.you !== words) return
      original = s.open
      useAskStore.setState({ epoch: s.epoch + 1 })
    })
    try {
      const a = await useAskStore.getState().admit(words, ctx, { newTurnOnly: true })
      expect(original).not.toBeNull()
      expect(a).toEqual({ admitted: false, reason: 'not_admitted' })
      expect(h.client.ask).not.toHaveBeenCalled()
      expect(h.posts).toHaveLength(0)
      expect(useAskStore.getState().turns[original!]).toBeUndefined()
      expect(useAskStore.getState().open).toBeNull()
      expect(text()).not.toContain(words)
      await vi.advanceTimersByTimeAsync(SILENCE_MS + 1)
      expect(h.client.askTurn).not.toHaveBeenCalled()
      expect(h.posts).toHaveLength(0)
    } finally {
      unsubscribe()
    }
  })

  it('real admit removes its cloned unsent row when publication copies the row and changes the epoch', async () => {
    vi.useFakeTimers()
    const h = fakeHost(() => 'ok')
    await start(h.client)
    const words = 'These copied original words were never sent'
    let original: string | null = null
    const unsubscribe = useAskStore.subscribe((s) => {
      if (original || !s.open || s.turns[s.open]?.you !== words) return
      original = s.open
      const own = s.turns[original]
      useAskStore.setState({
        epoch: s.epoch + 1,
        turns: { ...s.turns, [original]: { ...own, events: [...own.events], outcomes: { ...own.outcomes }, notes: [...own.notes], steers: [...own.steers], ahead: [...own.ahead] } },
      })
    })
    try {
      const a = await useAskStore.getState().admit(words, ctx, { newTurnOnly: true })
      expect(original).not.toBeNull()
      expect(a).toEqual({ admitted: false, reason: 'not_admitted' })
      expect(h.client.ask).not.toHaveBeenCalled()
      expect(h.posts).toHaveLength(0)
      expect(useAskStore.getState().turns[original!]).toBeUndefined()
      expect(useAskStore.getState().log.some((entry) => entry.kind === 'turn' && entry.op === original)).toBe(false)
      expect(useAskStore.getState().open).toBeNull()
      expect(text()).not.toContain(words)
      await vi.advanceTimersByTimeAsync(SILENCE_MS + 1)
      expect(h.client.askTurn).not.toHaveBeenCalled()
      expect(h.posts).toHaveLength(0)
    } finally {
      unsubscribe()
    }
  })

  it('real admit preserves reworded unsent words locally when publication changes the epoch', async () => {
    vi.useFakeTimers()
    const h = fakeHost(() => 'ok')
    await start(h.client)
    const words = 'The original unpublished words'
    const edited = 'The same person’s reworded unpublished words'
    let original: string | null = null
    const unsubscribe = useAskStore.subscribe((s) => {
      if (original || !s.open || s.turns[s.open]?.you !== words) return
      original = s.open
      useAskStore.setState({ epoch: s.epoch + 1, turns: { ...s.turns, [original]: { ...s.turns[original], you: edited } } })
    })
    try {
      const a = await useAskStore.getState().admit(words, ctx, { newTurnOnly: true })
      expect(original).not.toBeNull()
      expect(a).toEqual({ admitted: false, reason: 'not_admitted' })
      expect(h.client.ask).not.toHaveBeenCalled()
      expect(h.posts).toHaveLength(0)
      expect(useAskStore.getState().turns[original!]).toBeUndefined()
      expect(useAskStore.getState().open).toBeNull()
      const retained = rows().filter((row) => row.kind === 'you' && row.text === edited)
      expect(retained).toHaveLength(1)
      expect(retained[0].op).toBeUndefined()
      expect(text()).toContain('These words were not sent.')
      expect(useAskStore.getState().log.some((entry) => entry.kind === 'turn' && entry.op === original)).toBe(false)
      await vi.advanceTimersByTimeAsync(SILENCE_MS + 1)
      expect(h.client.askTurn).not.toHaveBeenCalled()
      expect(h.posts).toHaveLength(0)
    } finally {
      unsubscribe()
    }
  })

  it('real admit keeps authenticated publication-time progress and its same-operation silence readback on epoch rejection', async () => {
    vi.useFakeTimers()
    const h = fakeHost(() => 'ok')
    const readback = vi.fn(async (op: string, after = 0) => ({ operation_id: op, turn_id: `t_${op}`, thread, state: 'accepted' as const, events: (frames[op] ?? []).filter((e) => e.seq > after), more: false }))
    ;(h.client as unknown as { askTurn: unknown }).askTurn = readback
    await start(h.client)
    const words = 'Keep the original authenticated progress in this publication window'
    let original: string | null = null
    const unsubscribe = useAskStore.subscribe((s) => {
      if (original || !s.open || s.turns[s.open]?.you !== words) return
      original = s.open
      useAskStore.getState().onEvent(frame(original, 1, { phase: 'accepted', thread }))
      useAskStore.setState({ epoch: useAskStore.getState().epoch + 1 })
    })
    try {
      const a = await useAskStore.getState().admit(words, ctx, { newTurnOnly: true })
      expect(original).not.toBeNull()
      expect(a).toEqual({ admitted: false, reason: 'not_admitted' })
      expect(h.client.ask).not.toHaveBeenCalled()
      expect(h.posts).toHaveLength(0)
      expect(turn(original!)).toMatchObject({ state: 'open', lastSeq: 1 })
      expect(turn(original!).events).toHaveLength(1)
      expect(turn(original!).events[0]).toMatchObject({ operation_id: original, phase: 'accepted' })
      expect(useAskStore.getState().open).toBe(original)
      await vi.advanceTimersByTimeAsync(SILENCE_MS + 1)
      expect(readback).toHaveBeenCalledTimes(1)
      expect(readback).toHaveBeenCalledWith(original, 1)
      expect(turn(original!)).toMatchObject({ state: 'open', lastSeq: 1 })
      expect(turn(original!).events).toHaveLength(1)
      expect(h.posts).toHaveLength(0)
    } finally {
      unsubscribe()
    }
  })

  it('real admit does not POST or overwrite another person’s rows when publication switches the binding', async () => {
    vi.useFakeTimers()
    const h = fakeHost(() => 'ok')
    await start(h.client)
    const words = 'The original person’s unsent words'
    let switched = false
    const unsubscribe = useAskStore.subscribe((s) => {
      if (switched || !s.open || s.turns[s.open]?.you !== words) return
      switched = true
      useAskStore.getState().bind(useHive.getState().session, 'user:p_other')
      useAskStore.getState().addLocal('The other person’s question', 'The other person’s retained answer')
    })
    try {
      const a = await useAskStore.getState().admit(words, ctx, { newTurnOnly: true })
      expect(switched).toBe(true)
      expect(a).toEqual({ admitted: false, reason: 'not_admitted' })
      expect(h.client.ask).not.toHaveBeenCalled()
      expect(h.posts).toHaveLength(0)
      expect(useAskStore.getState().bound?.principal).toBe('user:p_other')
      expect(text()).toContain('The other person’s question')
      expect(text()).toContain('The other person’s retained answer')
      expect(text()).not.toContain(words)
      await vi.advanceTimersByTimeAsync(SILENCE_MS + 1)
      expect(h.client.askTurn).not.toHaveBeenCalled()
      expect(h.posts).toHaveLength(0)
    } finally {
      unsubscribe()
    }
  })

  it('real admit reconciles a lost POST answer with successful original readback, not its first unknown callback', async () => {
    const h = fakeHost(() => 'lost-after')
    await start(h.client)
    const a = await useAskStore.getState().admit('One retained original', ctx, { newTurnOnly: true })
    expect(a).toEqual({ admitted: true, op: h.posts[0].operation_id, principal: 'user:p_ada' })
    oneOperation(h)
    expect(h.posts).toHaveLength(1)
  })

  it('definite original refusal is editable proof; generic errors/unknown are not silently made refused', async () => {
    const h = fakeHost(() => 'rate-limited')
    await start(h.client)
    const a = await useAskStore.getState().admit('Definitively refused', ctx, { newTurnOnly: true })
    expect(a.admitted).toBe(false)
    if (a.admitted) throw new Error('Synthetic host refused the original')
    expect(a.reason).toBe('refused')
    expect(a.receipt?.op).toBe(h.posts[0].operation_id)
    expect(useAskStore.getState().admissionOf(a.receipt!)).toMatchObject({ admitted: false, reason: 'refused' })
    expect(h.posts).toHaveLength(1)
  })

  it('unknown receipt is not state/hydration DATA; copied, foreign and reset receipts cannot qualify or start another operation', async () => {
    const h = fakeHost(() => 'lost-before')
    h.client.askTurn = vi.fn(async () => { throw new AskRefusal(403, 'forbidden', 'Synthetic read refusal') })
    await start(h.client)
    const a = await useAskStore.getState().admit('Keep original identity', ctx, { newTurnOnly: true })
    if (a.admitted || !a.receipt) throw new Error('Synthetic unknown must retain its receipt')
    const r = a.receipt
    expect(useAskStore.getState().admissionOf(r)).toMatchObject({ admitted: false, reason: 'unknown', receipt: r })
    expect(useAskStore.getState().admissionOf(JSON.parse(JSON.stringify(r)))).toEqual({ admitted: false, reason: 'unknown' })
    expect(useAskStore.getState().admissionOf({ ...r, principal: 'user:p_other' })).toEqual({ admitted: false, reason: 'unknown' })
    await useAskStore.getState().steerTo(r.op, 'Held words', ctx, { onOperation: vi.fn(), admission: vi.fn() })
    const held = turn(r.op).held![0].opts
    expect(held).not.toHaveProperty('onOperation')
    expect(held).not.toHaveProperty('admission')
    expect(turn(r.op)).not.toHaveProperty('receipt')
    expect(Object.keys(useAskStore.getState())).not.toContain('admissionReceipts')
    useAskStore.getState().reset()
    useAskStore.getState().bind(useHive.getState().session, 'user:p_ada')
    expect(useAskStore.getState().admissionOf(r)).toEqual({ admitted: false, reason: 'unknown' })
    expect(h.posts).toHaveLength(1)
  })

  it('a typed frame for a different principal cannot confirm the private original receipt', async () => {
    const h = fakeHost(() => 'lost-before')
    h.client.askTurn = vi.fn(async () => { throw new AskRefusal(403, 'forbidden', 'Synthetic read refusal') })
    await start(h.client)
    const a = await useAskStore.getState().admit('Original person only', ctx, { newTurnOnly: true })
    if (a.admitted || !a.receipt) throw new Error('Synthetic original must stay unknown')
    const r = a.receipt
    useAskStore.getState().onEvent({ type: 'ask', operation_id: r.op, turn_id: `t_${r.op}`, principal: 'user:p_other', seq: 1, phase: 'accepted', at: '2026-10-06T10:00:00Z', thread })
    expect(useAskStore.getState().admissionOf(r)).toMatchObject({ admitted: false, reason: 'unknown', receipt: r })
    expect(h.posts).toHaveLength(1)
  })

  it.each([
    ['missing', 'ask_busy'], ['unknown', 'ask_busy'],
    ['missing', 'operation_conflict'], ['unknown', 'operation_conflict'],
  ] as const)('a %s read plus same-id %s placeholder is not positive receipt proof', async (read, code) => {
    const h = fakeHost(() => 'lost-before')
    h.client.askTurn = vi.fn(async () => { throw read === 'missing' ? new AskRefusal(404, 'not_available', 'Synthetic missing read') : new ApiError(0, 'network', 'Synthetic unknown read') })
    h.client.ask = vi.fn(async (body: AskBody) => {
      h.posts.push(structuredClone(body))
      if (h.posts.length === 1) throw new ApiError(0, 'network', 'Synthetic lost POST response')
      if (code === 'ask_busy') throw new AskRefusal(409, code, 'Synthetic same-id busy', { operation_id: body.operation_id })
      throw new ApiError(409, code, 'Synthetic operation conflict')
    })
    await start(h.client)
    const a = await useAskStore.getState().admit('Keep the original unconfirmed', ctx, { newTurnOnly: true })
    await flush()
    if (a.admitted || !a.receipt) throw new Error('A manufactured placeholder must not qualify admission')
    expect(a.reason).toBe('unknown')
    expect(useAskStore.getState().admissionOf(a.receipt)).toMatchObject({ admitted: false, reason: 'unknown', receipt: a.receipt })
    expect(turn(a.receipt.op).state).toBe('open') // retained legacy display semantics are separate from proof
    expect(h.posts).toHaveLength(2)
    expect(ops(h).size).toBe(1)
    expect(h.posts[1]).toEqual(h.posts[0])
    useAskStore.getState().onEvent(frame(a.receipt.op, 1, { phase: 'accepted', thread }))
    expect(useAskStore.getState().admissionOf(a.receipt)).toEqual({ admitted: true, op: a.receipt.op, principal: 'user:p_ada' })
    expect(h.posts).toHaveLength(2)
  })

  it('a later actual exact-op recover readback with zero new events can confirm a placeholder-held original', async () => {
    const h = fakeHost(() => 'lost-before')
    h.client.askTurn = vi.fn(async () => { throw new AskRefusal(404, 'not_available', 'Synthetic missing read') })
    h.client.ask = vi.fn(async (body: AskBody) => {
      h.posts.push(structuredClone(body))
      if (h.posts.length === 1) throw new ApiError(0, 'network', 'Synthetic lost POST response')
      throw new ApiError(409, 'operation_conflict', 'Synthetic operation conflict')
    })
    await start(h.client)
    const a = await useAskStore.getState().admit('Later readback proof only', ctx, { newTurnOnly: true })
    await flush()
    if (a.admitted || !a.receipt) throw new Error('The original must remain unknown without proof')
    h.client.askTurn = vi.fn(async (op: string) => ({ operation_id: op, turn_id: `t_${op}`, thread, state: 'accepted' as const, events: [], more: false }))
    await useAskStore.getState().recover(a.receipt.op)
    expect(useAskStore.getState().admissionOf(a.receipt)).toEqual({ admitted: true, op: a.receipt.op, principal: 'user:p_ada' })
    expect(turn(a.receipt.op).events).toEqual([])
    expect(h.posts).toHaveLength(2)
    expect(ops(h).size).toBe(1)
  })

  it.each(['null', 'foreign'] as const)('a successful initial %s POST body is not original-operation admission proof', async (kind) => {
    const h = fakeHost(() => 'lost-before')
    const foreign = { operation_id: 'ask:foreign', turn_id: 't_foreign', thread, conductor: false, events: [], more: false }
    // Deliberately malformed synthetic transport values exercise only the private identity boundary.
    h.client.ask = vi.fn(async (body: AskBody) => {
      h.posts.push(structuredClone(body))
      return kind === 'null' ? null : foreign
    }) as unknown as NonNullable<HiveClient['ask']>
    h.client.askTurn = vi.fn(async () => { throw new AskRefusal(403, 'forbidden', 'Synthetic read refusal') })
    await start(h.client)
    const a = await useAskStore.getState().admit('Require the actual response identity', ctx, { newTurnOnly: true })
    if (a.admitted || !a.receipt) throw new Error('A null/foreign response is not positive proof')
    expect(a.reason).toBe('unknown')
    expect(h.posts).toHaveLength(1)
    expect(useAskStore.getState().admissionOf(a.receipt)).toMatchObject({ admitted: false, reason: 'unknown', receipt: a.receipt })
    useAskStore.getState().onEvent(frame(a.receipt.op, 1, { phase: 'accepted', thread }))
    expect(useAskStore.getState().admissionOf(a.receipt)).toEqual({ admitted: true, op: a.receipt.op, principal: 'user:p_ada' })
    expect(h.posts).toHaveLength(1)
  })

  it.each([
    ['null', 'ask_busy'], ['null', 'operation_conflict'],
    ['foreign', 'ask_busy'], ['foreign', 'operation_conflict'],
  ] as const)('a successful %s read cannot qualify itself or carry a true flag into %s recovery', async (kind, code) => {
    const h = fakeHost(() => 'lost-before')
    const foreign = { operation_id: 'ask:foreign', turn_id: 't_foreign', thread, state: 'accepted' as const, events: [], more: false }
    h.client.askTurn = vi.fn(async () => kind === 'null' ? null : foreign) as unknown as NonNullable<HiveClient['askTurn']>
    h.client.ask = vi.fn(async (body: AskBody) => {
      h.posts.push(structuredClone(body))
      if (h.posts.length === 1) throw new ApiError(0, 'network', 'Synthetic lost original POST response')
      if (code === 'ask_busy') throw new AskRefusal(409, code, 'Synthetic same-id busy', { operation_id: body.operation_id })
      throw new ApiError(409, code, 'Synthetic operation conflict')
    })
    await start(h.client)
    const a = await useAskStore.getState().admit('Do not trust an arbitrary read body', ctx, { newTurnOnly: true })
    await flush()
    if (a.admitted || !a.receipt) throw new Error('Only matching actual proof may confirm the receipt')
    expect(a.reason).toBe('unknown')
    expect(h.posts).toHaveLength(kind === 'null' ? 2 : 1) // only null follows the existing same-id fallback
    expect(ops(h).size).toBe(1)
    if (h.posts.length === 2) expect(h.posts[1]).toEqual(h.posts[0])
    expect(useAskStore.getState().admissionOf(a.receipt)).toMatchObject({ admitted: false, reason: 'unknown', receipt: a.receipt })
    const before = h.posts.length
    h.client.askTurn = vi.fn(async (op: string) => ({ operation_id: op, turn_id: `t_${op}`, thread, state: 'accepted' as const, events: [], more: false }))
    await useAskStore.getState().recover(a.receipt.op)
    expect(useAskStore.getState().admissionOf(a.receipt)).toEqual({ admitted: true, op: a.receipt.op, principal: 'user:p_ada' })
    expect(h.posts).toHaveLength(before)
  })

  it.each(['null', 'foreign'] as const)('a successful same-id retry with a %s body stays unknown until matching original frame proof', async (kind) => {
    const h = fakeHost(() => 'lost-before')
    h.client.askTurn = vi.fn(async () => { throw new AskRefusal(404, 'not_available', 'Synthetic missing read') })
    const foreign = { operation_id: 'ask:foreign', turn_id: 't_foreign', thread, conductor: false, events: [], more: false }
    h.client.ask = vi.fn(async (body: AskBody) => {
      h.posts.push(structuredClone(body))
      if (h.posts.length === 1) throw new ApiError(0, 'network', 'Synthetic lost original POST response')
      return kind === 'null' ? null : foreign
    }) as unknown as NonNullable<HiveClient['ask']>
    await start(h.client)
    const a = await useAskStore.getState().admit('Same request still needs matching proof', ctx, { newTurnOnly: true })
    await flush()
    if (a.admitted || !a.receipt) throw new Error('A null/foreign same-id response cannot confirm admission')
    expect(a.reason).toBe('unknown')
    expect(h.posts).toHaveLength(2)
    expect(h.posts[1]).toEqual(h.posts[0])
    useAskStore.getState().onEvent(frame(a.receipt.op, 1, { phase: 'accepted', thread }))
    expect(useAskStore.getState().admissionOf(a.receipt)).toEqual({ admitted: true, op: a.receipt.op, principal: 'user:p_ada' })
    expect(h.posts).toHaveLength(2)
  })

  it('an actual contract-shaped accepted frame without principal confirms only the current authentic original receipt', async () => {
    const h = fakeHost(() => 'lost-before')
    h.client.askTurn = vi.fn(async () => { throw new AskRefusal(403, 'forbidden', 'Synthetic read refusal') })
    await start(h.client)
    const a = await useAskStore.getState().admit('Actual no-principal contract frame', ctx, { newTurnOnly: true })
    if (a.admitted || !a.receipt) throw new Error('Synthetic original should initially be unknown')
    const ordinary = { type: 'ask', operation_id: a.receipt.op, turn_id: `t_${a.receipt.op}`, seq: 1, at: '2026-10-06T10:00:00Z', phase: 'accepted', thread }
    expect(ordinary).not.toHaveProperty('principal')
    useAskStore.getState().onEvent(ordinary)
    expect(useAskStore.getState().admissionOf(a.receipt)).toEqual({ admitted: true, op: a.receipt.op, principal: 'user:p_ada' })
    useAskStore.getState().onEvent({ ...ordinary })
    expect(turn(a.receipt.op).events).toHaveLength(1)
    expect(h.posts).toHaveLength(1)
  })

  it.each([null, 7, undefined, 'user:p_other'] as const)('a supplied invalid/foreign principal %s cannot confirm an unknown receipt', async (principal) => {
    const h = fakeHost(() => 'lost-before')
    h.client.askTurn = vi.fn(async () => { throw new AskRefusal(403, 'forbidden', 'Synthetic read refusal') })
    await start(h.client)
    const a = await useAskStore.getState().admit('Current bound original only', ctx, { newTurnOnly: true })
    if (a.admitted || !a.receipt) throw new Error('Synthetic original should remain unknown')
    useAskStore.getState().onEvent({ type: 'ask', operation_id: a.receipt.op, turn_id: `t_${a.receipt.op}`, seq: 1, at: '2026-10-06T10:00:00Z', phase: 'accepted', thread, principal })
    expect(useAskStore.getState().admissionOf(a.receipt)).toMatchObject({ admitted: false, reason: 'unknown', receipt: a.receipt })
    expect(h.posts).toHaveLength(1)
  })

  it('three unknown checks retain the same body/id; explicit checkAgain resolves only that original and no automatic fresh request', async () => {
    vi.useFakeTimers()
    const h = fakeHost(() => 'lost-before')
    await start(h.client)
    const a = await useAskStore.getState().admit('Still unknown', ctx, { newTurnOnly: true })
    if (a.admitted || !a.receipt) throw new Error('Synthetic unknown must retain its receipt')
    await vi.advanceTimersByTimeAsync(CHECK_BACKOFF_MS[0] + CHECK_BACKOFF_MS[1])
    expect(turn(a.receipt.op).unsure?.state).toBe('unresolved')
    expect(h.posts).toHaveLength(CHECK_TRIES + 1) // initial POST plus the existing same-id recovery attempts
    expect(ops(h).size).toBe(1)
    for (const b of h.posts) expect(b).toEqual(h.posts[0])
    h.client.askTurn = vi.fn(async (op: string) => ({ operation_id: op, turn_id: `t_${op}`, thread, state: 'accepted' as const, events: [frame(op, 1, { phase: 'accepted', thread })], more: false }))
    await useAskStore.getState().checkAgain(a.receipt.op)
    expect(useAskStore.getState().admissionOf(a.receipt)).toEqual({ admitted: true, op: a.receipt.op, principal: 'user:p_ada' })
    expect(ops(h).size).toBe(1)
  })
})

describe('B1 (45392df): an Ask of unknown admission is recovered as the original, never admitted twice', () => {
  it('delayed admission: the original lands late; the check sends the same request under the same id and gets it back', async () => {
    const h = fakeHost((i) => (i === 1 ? 'lost-before' : 'ok'))
    h.landLater()
    await start(h.client)
    await useAskStore.getState().send('slow question', ctx)
    const op = h.posts[0].operation_id
    await vi.waitFor(() => expect(turn(op).state).toBe('open'))
    await retryCurrent()
    await useAskStore.getState().send('and another thing', ctx)
    await flush()
    oneOperation(h)
    expect(text()).toContain('Answer to slow question')
    expect(rows().some((r) => r.kind === 'refused')).toBe(false)
  })

  it('delayed admission: while the first answer is still in flight, Try again and new words send nothing new', async () => {
    const h = fakeHost((i) => (i === 1 ? 'hang' : 'ok'))
    await start(h.client)
    void useAskStore.getState().send('slow question', ctx)
    await flush()
    const op = h.posts[0].operation_id
    expect(turn(op).state).toBe('sending')
    await retryCurrent()
    await useAskStore.getState().send('more words', ctx)
    await flush()
    expect(h.posts).toHaveLength(1)
    expect(ops(h).size).toBe(1)
  })

  it('lost admission (status 0): the turn stays open as the admitted one, read back by its id; Try again sends nothing new', async () => {
    const h = fakeHost((i) => (i === 1 ? 'lost-after' : 'ok'))
    await start(h.client)
    await useAskStore.getState().send('lost question', ctx)
    const op = h.posts[0].operation_id
    await vi.waitFor(() => expect(turn(op).state).toBe('open'))
    expect(h.client.askTurn).toHaveBeenCalledWith(op, 0)
    await retryCurrent()
    await flush()
    oneOperation(h)
    expect(h.posts).toHaveLength(1)
    expect(text()).toContain('Answer to lost question')
    expect(rows().some((r) => r.kind === 'refused')).toBe(false)
  })

  it('ask-takeover r4: a takeover while admission is being checked is kept and sent once the check finds the turn', async () => {
    const h = fakeHost((i) => (i === 1 ? 'lost-after' : 'ok'))
    const askTakeover = vi.fn(async (op: string) => ({ operation_id: op, turn_id: `t_${op}`, state: 'taken_over', ended_at: '2026-10-08T21:00:00Z' }))
    ;(h.client as unknown as { askTakeover: typeof askTakeover }).askTakeover = askTakeover
    const reads = h.holdReads()
    await start(h.client)
    const sent = useAskStore.getState().send('lost question', ctx)
    await flush()
    const op = h.posts[0].operation_id
    expect(turn(op).state).toBe('checking')
    useAskStore.getState().personTookOver()
    expect(turn(op).tookOver).toBe(true)
    expect(askTakeover).not.toHaveBeenCalled()   // admission not known: the host may have no turn to end yet
    reads.release()
    await sent
    await vi.waitFor(() => expect(turn(op).state).toBe('open'))
    await flush()
    expect(askTakeover).toHaveBeenCalledTimes(1)
    expect(askTakeover).toHaveBeenCalledWith(op)
    expect(turn(op).takeover).toBe('sent')
  })

  it('200 with an unreadable body (LiveClient): answer_unreadable, never refused; recovered by its id, one admission', async () => {
    const posted: AskBody[] = []
    const admitted = new Set<string>()
    let count = 0
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      if (init?.method === 'GET' && path === '/api/auth/me') {
        return new Response(JSON.stringify({ principal: 'user:p_ada', role: 'member' }), { status: 200 })
      }
      // The real sender resolves its answerer before POST. This no-target fixture still reaches the host's Ask
      // route; a blanket 404 here prevents dispatch and never exercises an unreadable admission response.
      if (init?.method === 'GET' && (path === '/api/me/ask' || path === '/api/me/mind')) {
        return new Response(JSON.stringify(path === '/api/me/mind' ? { mind: null } : { swarm_id: null }), { status: 200 })
      }
      if (init?.method === 'POST' && path === '/api/ask') {
        const b = JSON.parse(String(init.body)) as AskBody
        posted.push(b)
        if (!admitted.has(b.operation_id)) {
          admitted.add(b.operation_id)
          count++
          frame(b.operation_id, 1, { phase: 'accepted', thread })
          frame(b.operation_id, 2, { phase: 'answer', text: 'Answer read back' })
        }
        return new Response('{"operation_id": "ask:tru', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      const op = decodeURIComponent(path.replace('/api/ask/', ''))
      if (init?.method === 'GET' && admitted.has(op)) {
        const after = Number(new URL(url).searchParams.get('after') ?? 0)
        return new Response(JSON.stringify({ operation_id: op, turn_id: `t_${op}`, thread, state: 'accepted', events: (frames[op] ?? []).filter((e) => e.seq > after), more: false }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: { code: 'not_available', message: 'no' } }), { status: 404 })
    })
    vi.stubGlobal('fetch', fetch)
    const client = new LiveClient('http://hive.test')
    await expect(client.ask({ operation_id: 'ask:probe:1', text: 'probe', context: ctx, via: 'typed' })).rejects.toMatchObject({ status: 0, code: 'answer_unreadable' })
    posted.length = 0
    count = 0
    await start(client as unknown as HiveClient)
    await useAskStore.getState().send('unreadable question', ctx)
    const op = posted[0].operation_id
    await vi.waitFor(() => expect(turn(op).state).toBe('open'))
    await retryCurrent()
    await flush()
    expect(new Set(posted.map((b) => b.operation_id)).size).toBe(1)
    expect(posted).toHaveLength(1)
    expect(count).toBe(1)
    expect(text()).toContain('Answer read back')
    expect(rows().some((r) => r.kind === 'refused')).toBe(false)
  })

  it('a raw decode error from the client (not the host’s answer) is unknown too, never refused', async () => {
    const h = fakeHost((i) => (i === 1 ? 'raw-after' : 'ok'))
    await start(h.client)
    await useAskStore.getState().send('raw question', ctx)
    const op = h.posts[0].operation_id
    await vi.waitFor(() => expect(turn(op).state).toBe('open'))
    await retryCurrent()
    oneOperation(h)
    expect(rows().some((r) => r.kind === 'refused')).toBe(false)
  })

  it.each(['500-after', '503-after'] as const)('post-effect %s: not refused, recovered as the admitted turn, one admission', async (step) => {
    const h = fakeHost((i) => (i === 1 ? step : 'ok'))
    await start(h.client)
    await useAskStore.getState().send(`question ${step}`, ctx)
    const op = h.posts[0].operation_id
    await vi.waitFor(() => expect(turn(op).state).toBe('open'))
    await retryCurrent()
    await flush()
    oneOperation(h)
    expect(h.posts).toHaveLength(1)
    expect(text()).toContain(`Answer to question ${step}`)
    expect(rows().some((r) => r.kind === 'refused')).toBe(false)
  })

  it('retry after the original completes: the original is recovered and answered first; only then is a new request a new id', async () => {
    const h = fakeHost((i) => (i === 1 ? 'lost-after' : 'ok'))
    await start(h.client)
    await useAskStore.getState().send('first question', ctx)
    const op1 = h.posts[0].operation_id
    await vi.waitFor(() => expect(turn(op1).state).toBe('open'))
    // still open: Try again is not a second request
    await retryCurrent()
    expect(h.posts).toHaveLength(1)
    // the host finishes the original
    useAskStore.getState().onEvent(frame(op1, 3, { phase: 'done', spent_usd: 0.01 }))
    expect(turn(op1).state).toBe('done')
    expect(h.admissions()).toBe(1)
    // a genuinely new request now: a new id, admitted once
    await retryCurrent()
    expect(h.posts).toHaveLength(2)
    const op2 = h.posts[1].operation_id
    expect(op2).not.toBe(op1)
    expect(h.admissions()).toBe(2)
    expect([...h.admitted]).toEqual([op1, op2])
  })

  it('a known refusal of the same request settles it as refused (existing words); only then may Try again use a new id', async () => {
    const h = fakeHost((i) => (i === 1 ? 'lost-before' : i === 2 ? 'rate-limited' : 'ok'))
    await start(h.client)
    await useAskStore.getState().send('limited question', ctx)
    const op1 = h.posts[0].operation_id
    await vi.waitFor(() => expect(turn(op1).state).toBe('refused'))
    // the check sent the ORIGINAL again (same id, same body), and nothing was admitted
    expect(h.posts).toHaveLength(2)
    expect(h.posts[1]).toEqual(h.posts[0])
    expect(h.admissions()).toBe(0)
    expect(rows().find((r) => r.kind === 'refused')).toMatchObject({ reason: 'rate_limited' })
    await retryCurrent()
    expect(h.posts).toHaveLength(3)
    expect(h.posts[2].operation_id).not.toBe(op1)
    expect(h.admissions()).toBe(1)
  })

  it('a 409 ask_busy for another turn is not a disposition of the original: it stays unknown, never refused, never re-id’d', async () => {
    vi.useFakeTimers()
    const h = fakeHost((i) => (i === 1 ? 'lost-before' : 'busy-other'))
    await start(h.client)
    await useAskStore.getState().send('busy question', ctx)
    const op = h.posts[0].operation_id
    for (let i = 0; i < CHECK_TRIES; i++) await vi.advanceTimersByTimeAsync(Math.max(...CHECK_BACKOFF_MS) + 10)
    expect(turn(op).state).toBe('checking')
    expect(rows().find((r) => r.kind === 'checking')).toMatchObject({ state: 'failed' })
    expect(rows().some((r) => r.kind === 'refused')).toBe(false)
    await retryCurrent()
    await useAskStore.getState().send('new words meanwhile', ctx)
    expect(ops(h).size).toBe(1)
    for (const b of h.posts) expect(b).toEqual(h.posts[0])
    expect(text()).toContain('Held until the hive confirms')
  })

  it('words typed while checking are held, never dropped, and sent as a new request once the original is refused', async () => {
    const h = fakeHost((i) => (i === 1 ? 'lost-before' : i === 2 ? 'rate-limited' : 'ok'))
    const read = h.holdReads()
    await start(h.client)
    const sent = useAskStore.getState().send('first question', ctx)
    await flush()
    const op1 = h.posts[0].operation_id
    expect(turn(op1).state).toBe('checking')
    // the person keeps typing while it is checked: nothing is sent yet
    await useAskStore.getState().send('and also this', ctx)
    expect(h.posts).toHaveLength(1)
    expect(turn(op1).held?.map((x) => x.text)).toEqual(['and also this'])
    expect(text()).toContain('Held until the hive confirms')
    read.fail()
    await sent
    await vi.waitFor(() => expect(h.posts).toHaveLength(3))
    // the original was re-sent unchanged and refused; only then were the held words sent, as their own new request
    expect(h.posts[1]).toEqual(h.posts[0])
    expect(h.posts[2].text).toBe('and also this')
    expect(h.posts[2].operation_id).not.toBe(op1)
    expect(turn(op1).held).toBeUndefined()
    expect(h.admissions()).toBe(1)
  })

  it('identity switch while unresolved: the old answer never lands under the new person, and nothing is re-sent as them', async () => {
    const h = fakeHost((i) => (i === 1 ? 'lost-after' : 'ok'))
    const read = h.holdReads()
    await start(h.client, 'user:ann')
    const sent = useAskStore.getState().send('ANN PRIVATE QUESTION', ctx)
    await flush()
    const op = h.posts[0].operation_id
    expect(turn(op).state).toBe('checking')
    // Bob signs in on the same client while Ann's request is being checked
    useAskStore.getState().bind(useHive.getState().session, 'user:bob')
    read.fail()
    await sent
    await flush()
    expect(useAskStore.getState().turns[op]).toBeUndefined()
    expect(rows()).toHaveLength(0)
    // no resubmission under Bob, and Try again has nothing of Ann's to send
    await retryCurrent()
    expect(h.posts).toHaveLength(1)
    // the original's frames, arriving late, attach to nothing
    useAskStore.getState().onEvent(frames[op][1])
    expect(text()).not.toContain('ANN PRIVATE QUESTION')
    expect(h.admissions()).toBe(1)
  })

  it('identity switch while a later check is scheduled: the timer sends nothing under the new person', async () => {
    vi.useFakeTimers()
    const h = fakeHost(() => 'lost-before')
    await start(h.client, 'user:ann')
    await useAskStore.getState().send('ANN PRIVATE QUESTION', ctx)
    const before = h.posts.length
    expect(before).toBe(2)
    useAskStore.getState().bind(useHive.getState().session, 'user:bob')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.posts).toHaveLength(before)
    expect(ops(h).size).toBe(1)
    expect(rows()).toHaveLength(0)
  })

  it('a known 4xx at the first send is still refused at once, with the page’s own words', async () => {
    const h = fakeHost(() => 'rate-limited')
    await start(h.client)
    await useAskStore.getState().send('too many', ctx)
    const op = h.posts[0].operation_id
    expect(turn(op).state).toBe('refused')
    expect(h.posts).toHaveLength(1)
    expect(rows().find((r) => r.kind === 'refused')).toMatchObject({ reason: 'rate_limited' })
    expect(h.client.askTurn).not.toHaveBeenCalled()
  })
})

describe('words held while checking (Review 5a8b47f: r2 coverage)', () => {
  type SteerCall = { op: string; text: string }
  /** the synthetic host also takes words mid-answer, recording each steer in order */
  function withSteer(h: Host): SteerCall[] {
    const calls: SteerCall[] = []
    ;(h.client as unknown as { askSteer: unknown }).askSteer = vi.fn(async (op: string, b: { steer_id: string; text: string }) => {
      calls.push({ op, text: b.text })
      return { steer_id: b.steer_id, operation_id: op }
    })
    return calls
  }

  it('admitted after all: held words go in as steering on that same turn, with no new request', async () => {
    const h = fakeHost((i) => (i === 1 ? 'lost-after' : 'ok'))
    const steers = withSteer(h)
    const read = h.holdReads()
    await start(h.client)
    const sent = useAskStore.getState().send('first question', ctx)
    await flush()
    const op = h.posts[0].operation_id
    expect(turn(op).state).toBe('checking')
    await useAskStore.getState().send('make it shorter', ctx)
    expect(steers).toHaveLength(0)
    read.release()
    await sent
    await vi.waitFor(() => expect(steers).toHaveLength(1))
    expect(steers[0]).toEqual({ op, text: 'make it shorter' })
    expect(h.posts).toHaveLength(1)
    oneOperation(h)
    expect(turn(op).held).toBeUndefined()
  })

  it('several held words are released in the order typed, each exactly once', async () => {
    const h = fakeHost((i) => (i === 1 ? 'lost-after' : 'ok'))
    const steers = withSteer(h)
    const read = h.holdReads()
    await start(h.client)
    const sent = useAskStore.getState().send('first question', ctx)
    await flush()
    const op = h.posts[0].operation_id
    for (const w of ['one', 'two', 'three']) await useAskStore.getState().send(w, ctx)
    expect(turn(op).held?.map((x) => x.text)).toEqual(['one', 'two', 'three'])
    read.release()
    await sent
    await vi.waitFor(() => expect(steers).toHaveLength(3))
    expect(steers.map((s) => s.text)).toEqual(['one', 'two', 'three'])
    // nothing more arrives later, and nothing was posted as a new request
    for (let i = 0; i < 5; i++) await flush()
    expect(steers).toHaveLength(3)
    oneOperation(h)
  })

  it('identity reset while checking: held words are dropped with the turn and nothing is sent', async () => {
    const h = fakeHost((i) => (i === 1 ? 'lost-after' : 'ok'))
    const steers = withSteer(h)
    const read = h.holdReads()
    await start(h.client, 'user:ann')
    const sent = useAskStore.getState().send('ANN FIRST', ctx)
    await flush()
    const op = h.posts[0].operation_id
    await useAskStore.getState().send('ANN HELD WORDS', ctx)
    expect(turn(op).held).toHaveLength(1)
    useAskStore.getState().bind(useHive.getState().session, 'user:bob')
    read.release()
    await sent
    for (let i = 0; i < 5; i++) await flush()
    expect(useAskStore.getState().turns[op]).toBeUndefined()
    expect(steers).toHaveLength(0)
    expect(h.posts).toHaveLength(1)
    expect(JSON.stringify(h.posts)).not.toContain('ANN HELD WORDS')
  })
})

describe('held words keep their custody (Review 82d6fbe B1)', () => {
  type Steer = { op: string; text: string }
  function steerable(h: Host, gate?: Promise<void>): Steer[] {
    const calls: Steer[] = []
    ;(h.client as unknown as { askSteer: unknown }).askSteer = vi.fn(async (op: string, b: { steer_id: string; text: string }) => {
      calls.push({ op, text: b.text })
      if (gate && calls.length === 1) await gate
      return { steer_id: b.steer_id, operation_id: op }
    })
    return calls
  }
  async function heldOn(h: Host, principal: string, words: string[]) {
    const read = h.holdReads()
    await start(h.client, principal)
    const sent = useAskStore.getState().send('original', ctx)
    await flush()
    const op = h.posts[0].operation_id
    for (const w of words) await useAskStore.getState().send(w, ctx)
    expect(turn(op).held?.map((x) => x.text)).toEqual(words)
    return { op, read, sent }
  }

  it('Review probe: an identity reset before the deferred release sends none of the old person’s words', async () => {
    const h = fakeHost(() => 'lost-before')
    const steers = steerable(h)
    const { op, read, sent } = await heldOn(h, 'user:ann', ['ANN HELD PRIVATE'])
    useAskStore.getState().onEvent(frame(op, 1, { phase: 'accepted', thread }))
    useAskStore.getState().bind('new-session', 'user:bob')
    await flush()
    expect(h.posts.filter((x) => x.text === 'ANN HELD PRIVATE')).toHaveLength(0)
    expect(steers).toHaveLength(0)
    read.fail()
    await sent
    await flush()
    expect(JSON.stringify(h.posts)).not.toContain('ANN HELD PRIVATE')
  })

  it('same client, same session, another person bound: nothing is released', async () => {
    const h = fakeHost(() => 'lost-before')
    const steers = steerable(h)
    const { op, read, sent } = await heldOn(h, 'user:ann', ['ANN WORDS'])
    useAskStore.getState().onEvent(frame(op, 1, { phase: 'accepted', thread }))
    useAskStore.getState().bind(useHive.getState().session, 'user:bob')
    for (let i = 0; i < 5; i++) await flush()
    expect(steers).toHaveLength(0)
    expect(h.posts).toHaveLength(1)
    read.fail()
    await sent
  })

  it('a reset during the first delayed steering answer drops the rest', async () => {
    const h = fakeHost(() => 'lost-before')
    let open!: () => void
    const steers = steerable(h, new Promise<void>((r) => (open = r)))
    const { op, read, sent } = await heldOn(h, 'user:ann', ['one', 'two', 'three'])
    useAskStore.getState().onEvent(frame(op, 1, { phase: 'accepted', thread }))
    await vi.waitFor(() => expect(steers).toHaveLength(1))
    useAskStore.getState().reset()
    open()
    for (let i = 0; i < 5; i++) await flush()
    expect(steers.map((s) => s.text)).toEqual(['one'])
    expect(h.posts).toHaveLength(1)
    read.fail()
    await sent
  })

  it('admitted: held words steer the original turn even while another turn is the open one, in order, once', async () => {
    const h = fakeHost(() => 'lost-before')
    const steers = steerable(h)
    const { op, read, sent } = await heldOn(h, 'user:ann', ['first held', 'second held'])
    // a competing turn becomes the open one (another tab rejoined, say)
    useAskStore.setState((s) => ({ open: 'ask:other', turns: { ...s.turns, 'ask:other': { ...s.turns[op], op: 'ask:other', state: 'open', held: undefined, unsure: undefined } } }))
    useAskStore.getState().onEvent(frame(op, 1, { phase: 'accepted', thread }))
    await vi.waitFor(() => expect(steers).toHaveLength(2))
    expect(steers).toEqual([{ op, text: 'first held' }, { op, text: 'second held' }])
    for (let i = 0; i < 5; i++) await flush()
    expect(steers).toHaveLength(2)
    expect(h.posts).toHaveLength(1)
    read.fail()
    await sent
  })

  it('refused while another request is running: nothing is retargeted to it, and the thread says so', async () => {
    const h = fakeHost((i) => (i === 1 ? 'lost-before' : 'rate-limited'))
    const steers = steerable(h)
    const { op, read, sent } = await heldOn(h, 'user:ann', ['for the first one'])
    useAskStore.setState((s) => ({ open: 'ask:other', turns: { ...s.turns, 'ask:other': { ...s.turns[op], op: 'ask:other', state: 'open', held: undefined, unsure: undefined } } }))
    read.fail()
    await sent
    await vi.waitFor(() => expect(turn(op).state).toBe('refused'))
    for (let i = 0; i < 5; i++) await flush()
    expect(steers).toHaveLength(0)
    expect(h.posts.filter((b) => b.text === 'for the first one')).toHaveLength(0)
    expect(text()).toContain('another request is running now')
  })
})

describe('a late accepted frame (Review 82d6fbe: kept, with regressions)', () => {
  it('early refusal, then the host accepts it after all: shown as the admitted turn', async () => {
    const h = fakeHost(() => 'rate-limited')
    await start(h.client)
    await useAskStore.getState().send('q', ctx)
    const op = h.posts[0].operation_id
    expect(turn(op).state).toBe('refused')
    useAskStore.getState().onEvent(frame(op, 1, { phase: 'accepted', thread }))
    expect(turn(op).state).toBe('open')
    expect(turn(op).refusedEarly).toBeUndefined()
    expect(useAskStore.getState().open).toBe(op)
  })

  it('stopped by the person, then accepted: stays stopped', async () => {
    const h = fakeHost(() => 'hang')
    ;(h.client as unknown as { askStop: unknown }).askStop = vi.fn(async () => {
      throw new ApiError(0, 'network', 'Failed to fetch')
    })
    await start(h.client)
    void useAskStore.getState().send('q', ctx)
    await flush()
    const op = h.posts[0].operation_id
    await useAskStore.getState().stop()
    expect(turn(op)).toMatchObject({ state: 'refused', refusedEarly: 'stopped' })
    useAskStore.getState().onEvent(frame(op, 1, { phase: 'accepted', thread }))
    expect(turn(op)).toMatchObject({ state: 'refused', refusedEarly: 'stopped' })
  })

  it('a duplicate accepted frame is applied once', async () => {
    const h = fakeHost(() => 'rate-limited')
    await start(h.client)
    await useAskStore.getState().send('q', ctx)
    const op = h.posts[0].operation_id
    const e = frame(op, 1, { phase: 'accepted', thread })
    useAskStore.getState().onEvent(e)
    useAskStore.getState().onEvent(e)
    expect(turn(op).lastSeq).toBe(1)
    expect(turn(op).events).toHaveLength(1)
  })

  it('another turn is active: the late admitted turn is shown but does not take the open pointer', async () => {
    const h = fakeHost((i) => (i === 1 ? 'rate-limited' : 'hang'))
    await start(h.client)
    await useAskStore.getState().send('first', ctx)
    const op1 = h.posts[0].operation_id
    void useAskStore.getState().send('second', ctx)
    await flush()
    const op2 = h.posts[1].operation_id
    expect(useAskStore.getState().open).toBe(op2)
    useAskStore.getState().onEvent(frame(op1, 1, { phase: 'accepted', thread }))
    expect(turn(op1).state).toBe('open')
    expect(useAskStore.getState().open).toBe(op2)
  })
})

describe('Kimi K3 (kimi-ask-release-c2) corrections', () => {
  it('(1) a read the host refuses (403) is not "no such turn": nothing is re-sent, and the person may check again', async () => {
    const h = fakeHost(() => 'lost-before')
    ;(h.client as unknown as { askTurn: unknown }).askTurn = vi.fn(async () => {
      throw new AskRefusal(403, 'forbidden', 'not yours')
    })
    await start(h.client)
    await useAskStore.getState().send('q', ctx)
    const op = h.posts[0].operation_id
    await vi.waitFor(() => expect(turn(op).unsure?.state).toBe('unresolved'))
    expect(h.posts).toHaveLength(1)
    expect(turn(op).state).toBe('checking')
    expect(rows().some((r) => r.kind === 'refused')).toBe(false)
  })

  it('(1) a read answered 404 (no such turn) re-sends the same request under the same id', async () => {
    const h = fakeHost((i) => (i === 1 ? 'lost-before' : 'ok'))
    await start(h.client)
    await useAskStore.getState().send('q', ctx)
    const op = h.posts[0].operation_id
    await vi.waitFor(() => expect(turn(op).state).toBe('open'))
    expect(h.posts).toHaveLength(2)
    oneOperation(h)
  })

  it('(2) a 200 that parses but is not this request’s acceptance is unknown (status 0), never accepted or refused', async () => {
    const bodies = [{}, { operation_id: 'ask:someone:else', turn_id: 't' }, { operation_id: 'ask:probe:2' }, []]
    for (const answer of bodies) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } })))
      const client = new LiveClient('http://hive.test')
      await expect(client.ask({ operation_id: 'ask:probe:2', text: 'probe', context: ctx, via: 'typed' })).rejects.toMatchObject({ status: 0, code: 'answer_unreadable' })
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ operation_id: 'ask:probe:2', turn_id: 't_x', thread, state: 'accepted' }), { status: 200 })))
    await expect(new LiveClient('http://hive.test').ask({ operation_id: 'ask:probe:2', text: 'probe', context: ctx, via: 'typed' })).resolves.toMatchObject({ operation_id: 'ask:probe:2' })
  })

  it('(3) an early-refused turn reopens on its first frame even when that frame is not "accepted" or a gap is ahead of it', async () => {
    const h = fakeHost(() => 'rate-limited')
    await start(h.client)
    await useAskStore.getState().send('q', ctx)
    const op = h.posts[0].operation_id
    expect(turn(op).state).toBe('refused')
    // a later frame arrives before the first: it waits ahead; then the first (thinking, not "accepted") arrives
    const later = frame(op, 2, { phase: 'answer', text: 'Answer after all' })
    const first = frame(op, 1, { phase: 'thinking', step: 'Reading' })
    useAskStore.getState().onEvent(later)
    useAskStore.getState().onEvent(first)
    await vi.waitFor(() => expect(turn(op).lastSeq).toBe(2))
    expect(turn(op).refusedEarly).toBeUndefined()
    expect(turn(op).ahead).toHaveLength(0)
    expect(text()).toContain('Answer after all')
  })
})

// ---------------------------------------------------------------- Review probe (next29 06ce9e7 B1), verbatim

it('Review: credential replacement without store reinit discards held private Ask words', async () => {
  const h = fakeHost(() => 'lost-before')
  const read = h.holdReads()
  let credential = {}
  const listeners = new Set<() => void>()
  const steers: string[] = []
  Object.assign(h.client, { authContext: () => credential, onAuthChange: (f: () => void) => { listeners.add(f); return () => listeners.delete(f) }, askSteer: async (_op: string, b: {text: string}) => { steers.push(b.text); return {} } })
  await start(h.client, 'user:ann')
  const sent = useAskStore.getState().send('original', ctx)
  await flush()
  const op = h.posts[0].operation_id
  await useAskStore.getState().send('ANN PRIVATE HELD', ctx)
  useAskStore.getState().onEvent(frame(op, 1, { phase: 'accepted', thread }))
  credential = {}
  listeners.forEach(f => f())
  await flush()
  expect(steers).toEqual([])
  expect(useAskStore.getState().bound).toBeNull()
  read.fail(); await sent
})

/** The current rendered request in these store-only protocol scenarios. Retained UI authority is tested separately. */
function retryCurrent() {
  const state = useAskStore.getState()
  const op = [...state.log].reverse().find(row => row.kind === 'turn')
  const request = op?.kind === 'turn' ? op.op : 'no-rendered-request'
  return state.retryLast(request, currentEpoch(), askRetryContext(request, currentEpoch()))
}
