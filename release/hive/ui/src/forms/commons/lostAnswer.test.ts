import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Review B1 (Commons f0818d8): a challenge or investigate-gap posts a goal. When the answer is lost or late, or the
// program fails after it posted, the dialog must not say "Nothing changed; you can try again." These regressions run
// the assembled path on INVENTED sim data (nothing leaves the page): the real SimClient and its commons program (which
// really posts the goal), the real store, the host's own act (features/programs/ProgramForm, rendered under the same
// minimal React stand-in as HostConfirm.test.ts), the Commons decision (useCommons.decideAsk, which useCommons.decide
// is), its gate (askDecision) and the words the DecisionDialog shows for the result (lib/decisionGate.decisionShown).
const R = vi.hoisted(() => ({ slots: [] as unknown[], i: 0, effects: [] as ({ deps?: unknown[]; cleanup?: unknown } | undefined)[], ei: 0, pending: [] as (() => void)[] }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const slot = (init: () => unknown) => {
    const n = R.i++
    if (!(n in R.slots)) R.slots[n] = init()
    return n
  }
  const m = {
    ...actual,
    useState: (init: unknown) => {
      const n = slot(() => (typeof init === 'function' ? (init as () => unknown)() : init))
      return [R.slots[n], (v: unknown) => { R.slots[n] = typeof v === 'function' ? (v as (p: unknown) => unknown)(R.slots[n]) : v }]
    },
    useRef: (v: unknown) => R.slots[slot(() => ({ current: v }))],
    useCallback: (f: unknown) => f,
    useMemo: (f: () => unknown) => f(),
    useSyncExternalStore: (_s: unknown, get: () => unknown) => get(),
    useDebugValue: () => undefined,
    useEffect: (fn: () => unknown, deps?: unknown[]) => {
      const n = R.ei++
      const prev = R.effects[n]
      if (!prev || !deps || !prev.deps || deps.some((d, k) => !Object.is(d, prev.deps![k])))
        R.pending.push(() => {
          if (typeof prev?.cleanup === 'function') (prev.cleanup as () => void)()
          R.effects[n] = { deps, cleanup: fn() }
        })
    },
    useLayoutEffect: (fn: () => unknown, deps?: unknown[]) => {
      const n = R.ei++
      const prev = R.effects[n]
      if (!prev || !deps || !prev.deps || deps.some((d, k) => !Object.is(d, prev.deps![k])))
        R.pending.push(() => {
          if (typeof prev?.cleanup === 'function') (prev.cleanup as () => void)()
          R.effects[n] = { deps, cleanup: fn() }
        })
    },
  }
  return { ...m, default: m }
})
vi.mock('../../store/store', async () => {
  const actual = await vi.importActual<typeof import('../../store/store')>('../../store/store')
  const hook = Object.assign((sel: (s: ReturnType<typeof actual.useHive.getState>) => unknown) => sel(actual.useHive.getState()), actual.useHive)
  return { ...actual, useHive: hook }
})

import type { ReactElement } from 'react'
import { ApiError } from '../../api/client'
import { SimClient } from '../../api/sim/SimClient'
import type { Program, ProgramDescription } from '../../api/types'
import { ProgramForm } from '../../features/programs/ProgramForm'
/** ProgramForm renders its ready body (Design parent r2, adopted in r4); the stand-in renders both, in order, each pass. */
const formBody = (p: Parameters<typeof ProgramForm>[0]): unknown => {
  const ready = ProgramForm(p) as ReactElement<Record<string, unknown>>
  return (ready.type as (q: Record<string, unknown>) => unknown)(ready.props)
}
import { decisionShown, NOTHING_CHANGED, type DecisionResult, type DecisionUnsettled } from '../../lib/decisionGate'
import { useHive } from '../../store/store'
import type { FormActResult } from '../contract'
import { GOAL_MAY_BE_POSTED, GOAL_READ_AGAIN, seenOf, type Ask, type AskAction } from './gate'
import { buildSky, unfold } from './model'
import { decideAsk, runAct, type Outcome } from './useCommons'

const ID = 'commons-explorer'
const SWARM = 's_lyra'
const program = { id: ID, name: 'Commons Explorer' } as Program
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)) }
const later = (ms: number) => new Promise((r) => setTimeout(r, ms))

type FormAct = (action: string, items: string[], params?: Record<string, unknown>, ctx?: unknown) => Promise<FormActResult>

let a: SimClient
let d: ProgramDescription
let formAct: FormAct
let unmount: () => void

function render<T>(hook: () => T) {
  R.slots = []
  R.effects = []
  R.i = 0
  R.ei = 0
  R.pending = []
  const out = hook()
  R.pending.forEach((f) => f())
  return { out, unmount: () => R.effects.forEach((e) => typeof e?.cleanup === 'function' && (e.cleanup as () => void)()) }
}

beforeEach(async () => {
  a = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
  a.simSession = 'person'
  await useHive.getState().init(a)
  d = (await a.program(ID)).describe as ProgramDescription
  await useHive.getState().openProgram(ID, SWARM)
  useHive.setState((x) => ({ programDetails: { ...x.programDetails, [ID]: { ...(x.programDetails[ID] ?? {}), describe: d } as never } }))
  const h = render(() => formBody({ form: 'commons', program, swarmId: SWARM, grammar: 'classic' }))
  const tree = h.out as ReactElement<{ children: ReactElement<{ children: ReactElement<{ act: FormAct }> }>[] }>
  formAct = tree.props.children[0].props.children.props.act
  unmount = h.unmount
  await flush()
})
afterEach(() => {
  unmount()
  a.disconnect()
  vi.restoreAllMocks()
})

/** The decision as Commons opens it: the belief (or its gap) as the program's own view shows it. */
async function askFor(action: AskAction): Promise<Ask> {
  const overview = await a.programView(ID, { swarm_id: SWARM, focus: null })
  const sky = buildSky(overview, d)
  for (const star of sky.stars) {
    const detail = await a.programView(ID, { swarm_id: SWARM, focus: star.id, stage: 'unfold' })
    const u = unfold(detail, star.id, d)
    if (!u) continue
    const target = action === 'challenge' ? u.star.id : u.gaps[0]?.id
    const seen = target ? seenOf(u, action, target) : undefined
    if (target && seen) return { action, target, belief: u.star.id, seen, sources: u.star.sources.map((s) => s.label), seq: 1 }
  }
  throw new Error(`no belief in the sim commons offers ${action}`)
}

const goalCount = async () => (await a.listGoals(SWARM)).length

/** useCommons.decide, with the host's act: decideAsk over runAct(ProgramForm's act). */
async function decide(ask: Ask) {
  const said: Omit<Outcome, 'at'>[] = []
  const reload = vi.fn()
  const r = await decideAsk(ask, { act: (action, items, rev, confirmed) => runAct(formAct, action, items, rev, confirmed), reload, say: (o) => said.push(o) })
  return { r, said, reload, shown: decisionShown(r) }
}

/** The program really posts the goal, then the answer is lost (or late, or the program fails after posting). */
function postThen(fail: () => unknown, delayMs = 0) {
  const real = a.programAct.bind(a)
  return vi.spyOn(a, 'programAct').mockImplementation(async (...args) => {
    await real(...args)
    if (delayMs) await later(delayMs)
    throw fail()
  })
}

const LOST: [string, () => unknown, number][] = [
  ['a lost answer (status 0, network)', () => new ApiError(0, 'network', 'Failed to fetch'), 0],
  ['an unreadable 2xx answer (answer_unreadable)', () => new ApiError(0, 'answer_unreadable', 'The hive answered but its answer could not be read (SyntaxError).'), 0],
  ['a gateway that lost the answer (502)', () => new ApiError(502, 'bad_gateway', 'Bad gateway'), 0],
  ['a gateway timeout (504)', () => new ApiError(504, 'gateway_timeout', 'Gateway timeout'), 0],
  ['a program 500 after it posted the goal', () => new ApiError(500, 'program_error', 'commons-explorer raised after create_goal'), 0],
  ['a raw fetch failure', () => new TypeError('Failed to fetch'), 0],
  ['a delayed answer that then times out', () => new DOMException('The operation timed out.', 'TimeoutError'), 40],
  ['a delayed answer that is then lost', () => new ApiError(0, 'network', 'Failed to fetch'), 40],
]

describe.each<AskAction>(['challenge', 'investigate-gap'])('Review B1: %s through useCommons, its gate and the dialog', (action) => {
  it.each(LOST)('%s: the goal was posted; the dialog says it may have been, never "Nothing changed"', async (_name, fail, delayMs) => {
    const ask = await askFor(action)
    const before = await goalCount()
    const spy = postThen(fail, delayMs)
    const goals = vi.spyOn(useHive.getState(), 'loadGoals')
    const { r, said, reload, shown } = await decide(ask)
    expect(goals).toHaveBeenCalledWith(SWARM, true)    // the host reads the swarm's goals again: the new one may be there
    expect(spy).toHaveBeenCalledTimes(1)                // one delivery: nothing was sent again
    expect(await goalCount()).toBe(before + 1)          // the goal really was posted
    expect(shown.kind).toBe('unsettled')
    const u = (r as DecisionUnsettled)
    expect(u.unsettled).toBe(GOAL_MAY_BE_POSTED)
    expect(JSON.stringify(shown)).not.toContain(NOTHING_CHANGED)
    expect(reload).toHaveBeenCalled()                   // the belief is read again
    expect(said).toEqual([expect.objectContaining({ tone: 'info', goals: true, text: expect.stringContaining(GOAL_MAY_BE_POSTED) })])
    // "Check again": the belief is read again; a posted goal does not show on it, so the person is pointed to the goals
    expect(u.recheck).toBeTypeOf('function')
    const again = await u.recheck!()
    expect(again).toEqual({ unsettled: GOAL_READ_AGAIN })
    expect(reload).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(decisionShown(again))).not.toContain(NOTHING_CHANGED)
  })

  it('a delayed answer that does arrive: posted, the dialog closes, the outcome names the goal', async () => {
    const ask = await askFor(action)
    const before = await goalCount()
    const real = a.programAct.bind(a)
    vi.spyOn(a, 'programAct').mockImplementation(async (...args) => {
      await later(40)
      return real(...args)
    })
    const { r, said } = await decide(ask)
    expect(r).toBe(true)
    expect(await goalCount()).toBe(before + 1)
    expect(said[0]).toMatchObject({ tone: 'good', goal: expect.stringMatching(/./) })
  })

  it('a known no (the program says the commons is stale): nothing was posted, so "Nothing changed" is true', async () => {
    const ask = await askFor(action)
    const before = await goalCount()
    const { r, shown, reload } = await decide({ ...ask, seen: { ...ask.seen, 'commons revision': 'r-old' } })
    expect(typeof r).toBe('string')
    expect(shown).toEqual({ kind: 'error', text: expect.stringContaining(NOTHING_CHANGED) })
    expect(await goalCount()).toBe(before)
    expect(reload).toHaveBeenCalled()
  })

  it('a plain error before anything was sent: shown as written, with no claim either way', async () => {
    const ask = await askFor(action)
    vi.spyOn(a, 'programAct').mockRejectedValue(new Error('the client broke'))
    const { r, shown } = await decide(ask)
    expect(r).toEqual({ failed: 'the client broke' })
    expect(shown).toEqual({ kind: 'error', text: 'the client broke' })
  })
})

describe('Review B1: the host confirm path (an app whose describe asks for confirm) carries the unknown outcome too', () => {
  it('lost answer after posting, the re-ask is closed: Commons says the goal may have been posted', async () => {
    // the hive may mark these actions confirm: true; then the form's own dialog is the confirm and the host mints
    const confirmed: ProgramDescription = { ...d, actions: d.actions.map((x) => (x.id === 'challenge' ? { ...x, confirm: true, person_activity: false } : x)) }
    useHive.setState((x) => ({ programDetails: { ...x.programDetails, [ID]: { ...(x.programDetails[ID] ?? {}), describe: confirmed } as never } }))
    const h = render(() => formBody({ form: 'commons', program, swarmId: SWARM, grammar: 'classic' }))
    type Tree = ReactElement<{ children: [ReactElement<{ children: ReactElement<{ act: FormAct }> }>, ReactElement<{ onClose: () => void }> | null] }>
    const act = (h.out as Tree).props.children[0].props.children.props.act
    await flush()
    const ask = await askFor('challenge')
    const before = await goalCount()
    // the sim's commons does not ask for confirm, so its mint is stood in for; the program still really posts the goal
    vi.spyOn(a, 'confirmAct').mockResolvedValue({ confirm_token: 'sim-token' } as never)
    const real = a.programAct.bind(a)
    const sends = vi.spyOn(a, 'programAct').mockImplementation(async (id, body) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { confirm_token: _t, ...plain } = body
      await real(id, plain)
      throw new ApiError(0, 'network', 'Failed to fetch')
    })
    const said: Omit<Outcome, 'at'>[] = []
    const pending = decideAsk(ask, { act: (ac, items, rev, c) => runAct(act, ac, items, rev, c), reload: () => undefined, say: (o) => said.push(o) })
    await flush()
    // the host asks again (the earlier attempt may have had its effect); the person closes it
    R.i = 0
    R.ei = 0
    const again = formBody({ form: 'commons', program, swarmId: SWARM, grammar: 'classic' }) as Tree
    const reask = again.props.children[1]
    expect(reask).toBeTruthy()
    reask!.props.onClose()
    const r: DecisionResult = await pending
    expect(sends).toHaveBeenCalledTimes(1)               // sent once, with the minted token; never again
    expect(sends.mock.calls[0][1].confirm_token).toBe('sim-token')
    expect(await goalCount()).toBe(before + 1)
    expect(r).toMatchObject({ unsettled: GOAL_MAY_BE_POSTED })
    expect(JSON.stringify(decisionShown(r))).not.toContain(NOTHING_CHANGED)
    h.unmount()
  })
})
