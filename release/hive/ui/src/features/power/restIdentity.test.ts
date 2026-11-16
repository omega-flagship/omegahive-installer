import { describe, expect, it, vi } from 'vitest'
import { restInitial, restReducer, type RestView } from './rest'
import { readContext } from '../../lib/readContext'

/**
 * Review SURFACE_RESTING_40969CC B1 / PLATFORM_NEXT35 (their controlled actual-RestHost probe, extended): a RestHost
 * that stays mounted across a sign-in change must never show, summarise or act on the previous person's alerts. The
 * hooks and the store are controlled seams and effects are suppressed, so this proves the synchronous render boundary.
 * Identity is the store's own session primitive plus the client's credential handle (readContext(client, session)).
 */
const h = vi.hoisted(() => ({
  state: null as unknown,
  refs: [] as { current: unknown }[],
  slot: 0,
  hive: null as unknown as Record<string, unknown>,
  bus: [] as ((e: unknown) => void)[],
  navigated: [] as unknown[],
  faces: [] as Record<string, unknown>[],
}))
vi.mock('react', async (orig) => ({
  ...(await orig<typeof import('react')>()),
  useReducer: (_r: unknown, arg: unknown, init?: (a: unknown) => unknown) => {
    if (h.state === null) h.state = init ? init(arg) : arg
    return [h.state, (a: never) => (h.state = restReducer(h.state as RestView, a))]
  },
  useRef: (v: unknown) => {
    const i = h.slot++
    return h.refs[i] ?? (h.refs[i] = { current: v })
  },
  useState: (v: unknown) => [typeof v === 'function' ? (v as () => unknown)() : v, () => {}],
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
}))
vi.mock('../../store/store', () => {
  const useHive = Object.assign((fn: (s: unknown) => unknown) => fn(h.hive), { getState: () => h.hive })
  return { useHive, useHealthAlertCount: () => 0, hiveBus: { on: (f: (e: unknown) => void) => (h.bus.push(f), () => {}) } }
})
vi.mock('../../lib/useResource', () => ({ useAuthContext: (c: { authContext?: () => object } | null) => c?.authContext?.() ?? null }))
vi.mock('../../lib/router', () => ({ navigate: (r: unknown) => h.navigated.push(r) }))
vi.mock('../../store/ask', () => ({ useAskStore: { getState: () => ({ setThreadOpen: () => {} }) } }))
vi.mock('./menu', () => ({ useRestPrefs: (fn: (s: unknown) => unknown) => fn({ minutes: 2 }) }))
vi.mock('./OffScreen', () => ({ embodimentOf: () => 'classic' }))
vi.mock('./RestFaces', () => ({ RestFace: (p: Record<string, unknown>) => (h.faces.push(p), null) }))
import { RestHost } from './RestScreen'

/** A client with the person-session side: a new credential handle on every sign-in. */
const client = () => {
  let handle = {}
  return { mode: 'live', authContext: () => handle, signIn: () => (handle = {}) }
}
const A = client()
const B = client()
/** A store session as the store makes it: readContext(client, epoch), taken under the sign-in current at the time. */
const sessions: Record<string, string> = {}
const as = (c: object, name: string, ready = true, data: Record<string, unknown> = {}) => {
  sessions[name] ??= readContext(c, Object.keys(sessions).length + 1)
  h.hive = { client: c, session: sessions[name], inits: 1, ready, approvals: {}, agents: {}, thinking: {}, healthAlerts: {}, ...data }
}
let last: unknown = null
/** The onChip handed to the face, from the rendered tree. */
const findOnChip = (n: unknown): ((id: string) => void) | null => {
  if (!n || typeof n !== 'object') return null
  const props = (n as { props?: Record<string, unknown> }).props
  if (props && typeof props.onChip === 'function') return props.onChip as (id: string) => void
  const kids = props?.children
  for (const k of Array.isArray(kids) ? kids : [kids]) {
    const f = findOnChip(k)
    if (f) return f
  }
  return null
}
const render = (allowed = true) => {
  h.slot = 0
  h.faces = []
  last = RestHost({ experience: 'classic', allowed, reduced: true, onResting: () => {} })
  return JSON.stringify(last) + JSON.stringify(h.faces)
}
const restWithPrivateGoal = () => {
  render()
  h.state = restReducer(h.state as RestView, { type: 'tick', at: Date.now() + 600_000, idleMs: 120_000 })
  // admitted under the identity it was gathered under (the reducer's own ctx)
  h.state = restReducer(h.state as RestView, { type: 'alert', ctx: (h.state as RestView).ctx, admin: true, alert: { kind: 'goal', title: 'A PRIVATE GOAL', key: 'goal:a-private' } })
  expect(render()).toContain('A PRIVATE GOAL')
}
const fresh = () => {
  h.state = null
  h.refs = []
  h.bus = []
  h.navigated = []
}

describe('resting is bound to the sign-in it gathered under (Review B1)', () => {
  it('reviewer probe: a retained RestHost never displays A’s goal after a direct signed-in switch to B', () => {
    fresh()
    as(A, 'sA')
    restWithPrivateGoal()
    as(B, 'sB')
    expect(render()).not.toContain('A PRIVATE GOAL')
    // and nothing of A's remains to come back as a summary when B wakes it
    h.state = restReducer(h.state as RestView, { type: 'input', at: 200_000 })
    expect(render()).not.toContain('A PRIVATE GOAL')
    expect((h.state as RestView).summary).toBeNull()
  })

  it('A→B→A: returning to A does not bring A’s earlier alerts back', () => {
    fresh()
    as(A, 'sA')
    restWithPrivateGoal()
    as(B, 'sB')
    render()
    as(A, 'sA2')
    expect(render()).not.toContain('A PRIVATE GOAL')
  })

  it('a credential change on the same client (re-login without a logout) clears them too', () => {
    fresh()
    as(A, 'sA')
    restWithPrivateGoal()
    A.signIn()
    expect(render()).not.toContain('A PRIVATE GOAL')
  })

  it('through not-ready: the rest is purged, never woken into a summary of the old person’s items', () => {
    fresh()
    as(A, 'sA')
    restWithPrivateGoal()
    as(A, 'sA', false)
    render(false)
    // the host reacts to allowed=false (an effect in the app; applied here as the host would)
    h.state = restReducer(h.state as RestView, { type: 'reset', ctx: (h.state as RestView).ctx, at: 130_000 })
    expect((h.state as RestView).summary).toBeNull()
    as(B, 'sB')
    expect(render(true)).not.toContain('A PRIVATE GOAL')
  })

  it('an event that arrives after the switch, under the old identity, is never admitted', () => {
    fresh()
    as(A, 'sA')
    render()
    h.state = restReducer(h.state as RestView, { type: 'tick', at: Date.now() + 600_000, idleMs: 120_000 })
    const stale = (h.state as RestView).ctx
    as(B, 'sB')
    render()
    h.state = restReducer(h.state as RestView, { type: 'alert', ctx: stale, admin: true, alert: { kind: 'goal', title: 'A LATE GOAL', key: 'goal:late' } })
    expect(render()).not.toContain('A LATE GOAL')
  })

  it('a chip callback retained from A does nothing after the switch', () => {
    fresh()
    as(A, 'sA')
    restWithPrivateGoal()
    const onChip = findOnChip(last)!
    as(B, 'sB')
    onChip('goals')
    expect(h.navigated).toEqual([])
  })
})

it('reducer: an identity reset drops queue, showing, away, missed and summary at once', () => {
  let v = restReducer(restInitial(0, 'ctxA'), { type: 'tick', at: Date.now() + 600_000, idleMs: 120_000 })
  v = restReducer(v, { type: 'alert', ctx: 'ctxA', admin: true, alert: { kind: 'goal', title: 'X', key: 'goal:x' } })
  v = restReducer(v, { type: 'identity', ctx: 'ctxB', at: 130_000 })
  expect(v).toEqual({ ...restInitial(130_000, 'ctxB') })
})

describe('r3 (Kimi r2 sharpest): the ambient scene and counts are fenced to the same sign-in, frame by frame', () => {
  const A_HIVE = {
    agents: { a1: { id: 'a1', hue: 123, status: 'awake' }, a2: { id: 'a2', hue: 77, status: 'awake' } },
    thinking: { a1: 'llm' },
    approvals: { ap1: { id: 'ap1', status: 'pending' } },
  }
  const restNow = () => (h.state = restReducer(h.state as RestView, { type: 'tick', at: Date.now() + 600_000, idleMs: 120_000 }))

  it('under A, A’s hive is the scene (control)', () => {
    fresh()
    as(client(), 'sCtl', true, A_HIVE)
    render()
    restNow()
    const a = render()
    expect(a).toContain('"hues":[123,77]')
    expect(a).toContain('1 decision waiting')
    expect(a).toContain('2 minds awake')
  })

  it('B resting while the store still holds A’s minds and approvals (credential changed, store not yet re-read): none of A’s hive shows', () => {
    fresh()
    const C = client()
    as(C, 'sC1', true, A_HIVE)
    render()
    // the credential handle changes; the store has not yet dropped A's data (still A's session)
    C.signIn()
    render() // the rest state moves to B's sign-in
    restNow() // and B's page rests
    const mixed = render()
    expect(mixed).toContain('pw-rest')
    expect(mixed).not.toContain('123')
    expect(mixed).not.toContain('decision waiting')
    expect(mixed).not.toContain('2 minds awake')
  })

  it('the frame in which the sign-in changes draws nothing of the previous rest, and no ambient counts', () => {
    fresh()
    as(A, 'sA3', true, A_HIVE)
    render()
    restNow()
    expect(render()).toContain('"hues":[123,77]')
    A.signIn()
    const frame = render()
    expect(frame).not.toContain('123')
    expect(frame).not.toContain('decision waiting')
  })
})

describe('r4 (stand-in Review 4): the away bar goes when nothing is left to act on', () => {
  const awake = (alerts: { kind: string; title: string | null; key: string }[]) => {
    render()
    let v = restReducer(h.state as RestView, { type: 'tick', at: Date.now() + 600_000, idleMs: 120_000 })
    for (const alert of alerts) v = restReducer(v, { type: 'alert', ctx: v.ctx, admin: true, alert } as never)
    h.state = restReducer(v, { type: 'input', at: Date.now() + 700_000 })
  }
  it('“If a decision settles elsewhere, liveMissed removes its button, but the render still depends only on v.summary”: the bar goes', () => {
    fresh()
    as(A, 'sR4a', true, { approvals: { d1: { id: 'd1', status: 'pending' } } })
    awake([{ kind: 'decision', title: null, key: 'decision:d1' }])
    expect(render()).toContain('data-away')
    // settled elsewhere: nothing left to act on
    as(A, 'sR4a', true, { approvals: { d1: { id: 'd1', status: 'approved' } } })
    expect(render()).not.toContain('data-away')
  })
  it('“clicking the last live goal leaves the bar up if v.missed still contains a settled decision”: the bar goes', () => {
    fresh()
    as(A, 'sR4b', true, { approvals: {} })
    awake([{ kind: 'goal', title: 'G', key: 'goal:g1' }, { kind: 'decision', title: null, key: 'decision:d9' }])
    expect(render()).toContain('data-away')
    h.state = restReducer(h.state as RestView, { type: 'acted', chip: 'goals' })
    expect(render()).not.toContain('data-away')
  })
  it('history stays unchanged while other actions remain', () => {
    fresh()
    as(A, 'sR4c', true, { approvals: {} })
    awake([{ kind: 'goal', title: 'G', key: 'goal:g1' }, { kind: 'thread', title: null, key: 'thread:t1' }])
    const words = (h.state as RestView).summary!
    expect(render()).toContain(words)
    h.state = restReducer(h.state as RestView, { type: 'acted', chip: 'goals' })
    const after = render()
    expect(after).toContain('data-away')
    expect(after).toContain(words)
  })
})
