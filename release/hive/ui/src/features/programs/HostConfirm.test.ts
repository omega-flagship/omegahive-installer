import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Review B1 (b47b1aa / next23): a host confirm is bound to the identity it was admitted under. These regressions run
// the real controller, the real store (useHive.init) and two real SimClients (INVENTED sim data; nothing leaves the
// page). The hooks (useHostConfirm, useConfirmedProgramAct, ProgramForm's act) run under a minimal React stand-in that
// keeps hook slots and runs effects and their cleanups, so mount, re-render and unmount are the real hook code.
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
  // zustand's own React binding is not in this module graph: the stand-in reads the real store through the selector
  const hook = Object.assign((sel: (s: ReturnType<typeof actual.useHive.getState>) => unknown) => sel(actual.useHive.getState()), actual.useHive)
  return { ...actual, useHive: hook }
})

import type { ReactElement } from 'react'
import { ApiError } from '../../api/client'
import { SimClient } from '../../api/sim/SimClient'
import type { Program, ProgramActBody, ProgramDescription } from '../../api/types'
import { CLOSED_RUNNING, IDENTITY_CHANGED, IDENTITY_CHANGED_SENT, prepareConfirm, RECHECK, type ConfirmIntent } from '../../lib/hostConfirm'
import { sessionKey } from '../../store/programSession'
import { useHive } from '../../store/store'
import { finalAsResult, HostConfirmController, useConfirmedProgramAct, useHostConfirm, type HostConfirmFinal } from './HostConfirm'
import { ProgramForm } from './ProgramForm'

function render<T>(hook: () => T) {
  R.slots = []
  R.effects = []
  const out = { current: undefined as unknown as T }
  const once = () => {
    R.i = 0
    R.ei = 0
    R.pending = []
    out.current = hook()
    R.pending.forEach((f) => f())
  }
  once()
  return {
    get current() { return out.current },
    rerender: once,
    unmount: () => R.effects.forEach((e) => typeof e?.cleanup === 'function' && (e.cleanup as () => void)()),
  }
}

function sim() {
  const s = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
  s.simSession = 'person'
  s.programsHost.installInvented('ledger-fixture')
  return s
}
const deferred = () => {
  let open!: () => void
  const promise = new Promise<void>((r) => { open = r })
  return { promise, open }
}
// WebCrypto digests settle on the task queue, not as microtasks
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)) }
const settledOf = (p: Promise<HostConfirmFinal>) => {
  const box: { f?: HostConfirmFinal } = {}
  void p.then((f) => { box.f = f })
  return box
}
const intentOf = (programId: string, body: ProgramActBody, d: ProgramDescription | null): ConfirmIntent => {
  const p = prepareConfirm(programId, body, d)
  if (!p.ok) throw new Error(p.message)
  return p.intent
}
const describeOf = async (s: SimClient, id: string) => (await s.program(id)).describe as ProgramDescription
const note = (): ProgramActBody => ({ swarm_id: 's_lyra', action: 'note', items: [] })
const watch = (s: SimClient) => ({ mint: vi.spyOn(s, 'confirmAct'), act: vi.spyOn(s, 'programAct'), deliver: vi.spyOn(s.programsHost, 'act') })

/** A controller wired the way the hook wires it: every store change re-checks the identity. */
function controller(scope = { programId: 'ledger-fixture', swarmId: 's_lyra' as string | null }) {
  const c = new HostConfirmController(scope)
  c.attach()
  const stop = useHive.subscribe(() => c.check())
  return { c, stop }
}

let a: SimClient
let b: SimClient
let d: ProgramDescription
beforeEach(async () => {
  a = sim()
  b = sim()
  await useHive.getState().init(a)
  d = await describeOf(a, 'ledger-fixture')
})
afterEach(() => vi.restoreAllMocks())

describe('B1: an intent is bound to the client, store session, init, app and swarm it was admitted under', () => {
  it('A → B → A: the dialog opened under A is cancelled at the switch, and its retained confirm mints or acts nowhere (not on B, not on the new A)', async () => {
    const { c, stop } = controller()
    const wa = watch(a)
    const wb = watch(b)
    const asked = settledOf(c.ask(intentOf('ledger-fixture', note(), d)))
    const seq = c.snapshot()!.seq
    await useHive.getState().init(b)
    await flush()
    expect(asked.f).toEqual({ kind: 'stale', sent: false, message: IDENTITY_CHANGED })
    expect(c.snapshot()).toBeNull()   // the dialog closed
    await useHive.getState().init(a)   // back to A: a NEW session for A
    await c.confirm(seq)                // the retained dialog's press
    for (const w of [wa, wb]) {
      expect(w.mint).not.toHaveBeenCalled()
      expect(w.act).not.toHaveBeenCalled()
    }
    stop()
  })

  it('the review probe: even without the store notification, a press after A → B mints and acts on neither', async () => {
    const c = new HostConfirmController({ programId: 'ledger-fixture', swarmId: 's_lyra' })   // no subscription
    c.attach()
    const wa = watch(a)
    const wb = watch(b)
    const asked = settledOf(c.ask(intentOf('ledger-fixture', note(), d)))
    const seq = c.snapshot()!.seq
    await useHive.getState().init(b)
    await c.confirm(seq)
    await flush()
    expect(asked.f).toMatchObject({ kind: 'stale', sent: false })
    for (const w of [wa, wb]) {
      expect(w.mint).not.toHaveBeenCalled()
      expect(w.act).not.toHaveBeenCalled()
    }
  })

  it('same-client reset: init again on the SAME client (same session string, new init) cancels the intent', async () => {
    const { c, stop } = controller()
    const wa = watch(a)
    const asked = settledOf(c.ask(intentOf('ledger-fixture', note(), d)))
    const seq = c.snapshot()!.seq
    const session = useHive.getState().session
    await useHive.getState().init(a)
    expect(useHive.getState().session).toBe(session)   // Surface R: same client, same session; only inits moved
    await flush()
    expect(asked.f).toMatchObject({ kind: 'stale', sent: false })
    await c.confirm(seq)
    expect(wa.mint).not.toHaveBeenCalled()
    stop()
  })

  it('identity change while the mint is in flight: cancelled at once; the minted token is discarded and nothing is acted', async () => {
    const { c, stop } = controller()
    const gate = deferred()
    const realMint = a.confirmAct.bind(a)
    const mint = vi.spyOn(a, 'confirmAct').mockImplementation(async (...args) => { await gate.promise; return realMint(...args) })
    const wa = { act: vi.spyOn(a, 'programAct'), deliver: vi.spyOn(a.programsHost, 'act') }
    const wb = watch(b)
    const asked = settledOf(c.ask(intentOf('ledger-fixture', note(), d)))
    const pressed = c.confirm(c.snapshot()!.seq)
    await flush()
    expect(mint).toHaveBeenCalledTimes(1)
    await useHive.getState().init(b)
    await flush()
    expect(asked.f).toEqual({ kind: 'stale', sent: false, message: IDENTITY_CHANGED })   // before the mint even answered
    gate.open()
    await pressed
    await flush()
    expect(wa.act).not.toHaveBeenCalled()
    expect(wa.deliver).not.toHaveBeenCalled()
    expect(wb.mint).not.toHaveBeenCalled()
    expect(wb.act).not.toHaveBeenCalled()
    expect(c.snapshot()).toBeNull()
    stop()
  })

  it('identity change during lost-answer handling: no recovery check, no re-opened dialog, no new mint; the caller hears "may already have had its effect"', async () => {
    const { c, stop } = controller()
    const realAct = a.programAct.bind(a)
    const act = vi.spyOn(a, 'programAct').mockImplementation(async (id, body) => {
      await realAct(id, body)   // the hive did it ...
      await useHive.getState().init(b)   // ... the person switched connection meanwhile ...
      throw new ApiError(0, 'network', 'Network error')   // ... and the answer was lost
    })
    const mint = vi.spyOn(a, 'confirmAct')
    const wb = watch(b)
    const bytes = new TextEncoder().encode('invented')
    const body = { swarm_id: 's_lyra', action: 'attach', items: [], idempotency_key: 'k1', file: { name: 'a.txt', mime: 'text/plain', size: bytes.byteLength, content_base64: btoa('invented') } }
    const asked = settledOf(c.ask(intentOf('ledger-fixture', body, d)))
    await c.confirm(c.snapshot()!.seq)
    await flush()
    expect(asked.f).toEqual({ kind: 'stale', sent: true, message: IDENTITY_CHANGED_SENT })
    expect(act).toHaveBeenCalledTimes(1)   // no recovery check under any identity
    expect(mint).toHaveBeenCalledTimes(1)
    expect(c.snapshot()).toBeNull()        // never re-opened
    expect(wb.mint).not.toHaveBeenCalled()
    expect(wb.act).not.toHaveBeenCalled()
    stop()
  })

  it('identity change while the repeat confirm is open (after a lost answer): it closes; its retained press does nothing', async () => {
    const { c, stop } = controller()
    const realAct = a.programAct.bind(a)
    vi.spyOn(a, 'programAct').mockImplementation(async (id, body) => { await realAct(id, body); throw new ApiError(0, 'network', 'lost') })   // every answer lost
    const mint = vi.spyOn(a, 'confirmAct')
    const asked = settledOf(c.ask(intentOf('ledger-fixture', note(), d)))   // confirm: true only: no recovery check
    await c.confirm(c.snapshot()!.seq)
    const again = c.snapshot()!
    expect(again.intent.prior).toBe('lost')   // the fresh dialog with the repeat-risk words
    await useHive.getState().init(b)
    await flush()
    expect(asked.f).toEqual({ kind: 'stale', sent: true, message: IDENTITY_CHANGED_SENT })   // the earlier attempt may have acted
    await c.confirm(again.seq)
    expect(mint).toHaveBeenCalledTimes(1)
    stop()
  })

  it('a late lost answer after the intent was cancelled can never re-open a dialog or replace a newer one', async () => {
    const { c, stop } = controller()
    const gate = deferred()
    vi.spyOn(a, 'programAct').mockImplementation(async () => { await gate.promise; throw new ApiError(0, 'network', 'lost') })
    const first = settledOf(c.ask(intentOf('ledger-fixture', note(), d)))
    const pressed = c.confirm(c.snapshot()!.seq)
    await flush()
    c.cancelAll()   // the frame that asked went away
    await flush()
    expect(first.f).toMatchObject({ kind: 'stale', sent: true })
    const second = settledOf(c.ask(intentOf('ledger-fixture', note(), d)))   // a newer confirm is open
    const newer = c.snapshot()!
    gate.open()
    await pressed
    await flush()
    expect(c.snapshot()).toEqual(newer)   // untouched
    expect(second.f).toBeUndefined()
    stop()
  })

  it('a change of app or swarm cancels; an intent for another swarm than the host is never admitted', async () => {
    const { c, stop } = controller()
    const asked = settledOf(c.ask(intentOf('ledger-fixture', note(), d)))
    c.setScope({ programId: 'ledger-fixture', swarmId: 's_forge' })
    await flush()
    expect(asked.f).toMatchObject({ kind: 'stale', sent: false })
    expect(await c.ask(intentOf('ledger-fixture', note(), d))).toMatchObject({ kind: 'stale', sent: false })   // s_lyra intent, s_forge host
    stop()
  })

  it('preconfirmed (a form’s own confirm): an identity change during its mint stops it before the act', async () => {
    const { c, stop } = controller()
    const gate = deferred()
    const realMint = a.confirmAct.bind(a)
    vi.spyOn(a, 'confirmAct').mockImplementation(async (...args) => { await gate.promise; return realMint(...args) })
    const act = vi.spyOn(a, 'programAct')
    const asked = settledOf(c.ask(intentOf('ledger-fixture', note(), d), {}, { preconfirmed: true }))
    await flush()
    await useHive.getState().init(b)
    gate.open()
    await flush()
    expect(asked.f).toMatchObject({ kind: 'stale', sent: false })
    expect(act).not.toHaveBeenCalled()
    stop()
  })
})

describe('B1 through the assembled hooks (mount, identity change, unmount)', () => {
  it('useHostConfirm: unmount during the mint cancels; the late mint is never acted on and nothing re-renders a dialog', async () => {
    const gate = deferred()
    const realMint = a.confirmAct.bind(a)
    vi.spyOn(a, 'confirmAct').mockImplementation(async (...args) => { await gate.promise; return realMint(...args) })
    const act = vi.spyOn(a, 'programAct')
    const h = render(() => useHostConfirm('ledger-fixture', 's_lyra'))
    const asked = settledOf(h.current.ask(intentOf('ledger-fixture', note(), d)))
    h.rerender()
    const dialog = h.current.dialog as ReactElement<{ onConfirm: () => Promise<unknown> }>
    expect(dialog).toBeTruthy()
    const pressed = dialog.props.onConfirm()
    await flush()
    h.unmount()
    await flush()
    expect(asked.f).toMatchObject({ kind: 'stale', sent: false })
    gate.open()
    await pressed
    await flush()
    expect(act).not.toHaveBeenCalled()
    expect(h.current.isOpen()).toBe(false)
    expect(await h.current.ask(intentOf('ledger-fixture', note(), d))).toMatchObject({ kind: 'stale' })   // an unmounted host admits nothing
  })

  it('useHostConfirm: the reviewer’s probe shape — ask under A, re-render under B, press the retained dialog: B is never called', async () => {
    const h = render(() => useHostConfirm('ledger-fixture', 's_lyra'))
    const asked = settledOf(h.current.ask(intentOf('ledger-fixture', note(), d)))
    h.rerender()
    const retained = h.current.dialog as ReactElement<{ onConfirm: () => Promise<unknown> }>
    const wa = watch(a)
    const wb = watch(b)
    await useHive.getState().init(b)
    h.rerender()
    expect(h.current.dialog).toBeNull()
    await retained.props.onConfirm()
    await flush()
    expect(asked.f).toMatchObject({ kind: 'stale', sent: false })
    for (const w of [wa, wb]) {
      expect(w.mint).not.toHaveBeenCalled()
      expect(w.act).not.toHaveBeenCalled()
    }
    h.unmount()
  })

  it('useConfirmedProgramAct (the generic program host): an identity change mid-confirm writes nothing to any session', async () => {
    const key = sessionKey('ledger-fixture', 's_lyra')
    await useHive.getState().openProgram('ledger-fixture', 's_lyra')
    useHive.setState((x) => ({ programDetails: { ...x.programDetails, 'ledger-fixture': { ...(x.programDetails['ledger-fixture'] ?? {}), describe: d } as never } }))
    const h = render(() => useConfirmedProgramAct('ledger-fixture', 's_lyra'))
    const before = useHive.getState().programSessions[key]
    expect(before).toBeTruthy()
    const done = h.current.act(key, 'note', [])
    await flush()
    h.rerender()
    expect(h.current.dialog).toBeTruthy()
    const wb = watch(b)
    await useHive.getState().init(b)
    await done
    expect(wb.mint).not.toHaveBeenCalled()
    expect(useHive.getState().programSessions[key]).toBeUndefined()   // B's store got nothing from A's confirm
    h.unmount()
  })

  it('ProgramForm act (a form that already confirmed: ctx.confirmed): unmount during the mint → nothing acted, nothing refreshed', async () => {
    const program = { id: 'ledger-fixture', name: 'Ledger fixture' } as Program
    await useHive.getState().openProgram('ledger-fixture', 's_lyra')
    useHive.setState((x) => ({ programDetails: { ...x.programDetails, 'ledger-fixture': { ...(x.programDetails['ledger-fixture'] ?? {}), describe: d } as never } }))
    const gate = deferred()
    const realMint = a.confirmAct.bind(a)
    vi.spyOn(a, 'confirmAct').mockImplementation(async (...args) => { await gate.promise; return realMint(...args) })
    const act = vi.spyOn(a, 'programAct')
    // ProgramForm renders its ready body (Design parent r2); the stand-in renders both, in order, each pass
    const h = render(() => {
      const ready = ProgramForm({ form: 'commons', program, swarmId: 's_lyra', grammar: 'classic' }) as ReactElement<Record<string, unknown>>
      return (ready.type as (p: Record<string, unknown>) => unknown)(ready.props)
    })
    const tree = h.current as ReactElement<{ children: ReactElement<{ children: ReactElement<{ act: (...x: unknown[]) => Promise<{ status: string; message?: string }> }> }>[] }>
    const formAct = tree.props.children[0].props.children.props.act
    await flush()   // the form's own mount effects (openProgram) settle first
    const refresh = vi.spyOn(useHive.getState(), 'programRefresh')
    const goals = vi.spyOn(useHive.getState(), 'loadGoals')
    const r = formAct('note', [], {}, { confirmed: true })
    await flush()
    h.unmount()
    gate.open()
    const out = await r
    await flush()
    expect(out).toEqual({ status: 'refused', message: IDENTITY_CHANGED })
    expect(act).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(goals).not.toHaveBeenCalled()
  })
})

describe('Kimi r2 #3: a still-running intent is shown as still in progress, offered only a further check', () => {
  let saved: number[]
  beforeEach(() => { saved = RECHECK.delaysMs; RECHECK.delaysMs = [0, 0, 0] })
  afterEach(() => { RECHECK.delaysMs = saved })
  const attach = (): ProgramActBody => ({ swarm_id: 's_lyra', action: 'attach', items: [], idempotency_key: 'k-still', file: { name: 'n.txt', mime: 'text/plain', size: 1, content_base64: 'eA==' } })
  const running = () => new ApiError(409, 'in_progress', 'this person request is still running')

  it('lost answer, then in_progress through the re-checks: a "still in progress" dialog with no confirm; Check again mints nothing; closing says it may still finish', async () => {
    const { c, stop } = controller()
    const mint = vi.spyOn(a, 'confirmAct')
    const deliver = vi.spyOn(a.programsHost, 'act')
    const sends = vi.spyOn(a, 'programAct')
    sends.mockRejectedValueOnce(new ApiError(0, 'network', 'Network error'))
    for (let i = 0; i < 4; i++) sends.mockRejectedValueOnce(running())
    const asked = settledOf(c.ask(intentOf('ledger-fixture', attach(), d)))
    await c.confirm(c.snapshot()!.seq)
    await flush()
    const v = c.snapshot()!
    expect(v.stillRunning).toBe(true)
    expect(v.intent.prior).toBe('running')
    expect(asked.f).toBeUndefined()
    expect(mint).toHaveBeenCalledTimes(1)
    // the person's "Check again": still running (bounded checks), same token, no mint, the dialog stays "still in progress"
    for (let i = 0; i < 3; i++) sends.mockRejectedValueOnce(running())
    await c.confirm(v.seq)
    await flush()
    expect(c.snapshot()!.stillRunning).toBe(true)
    expect(mint).toHaveBeenCalledTimes(1)
    expect(new Set(sends.mock.calls.map((x) => x[1].confirm_token)).size).toBe(1)
    expect(deliver).not.toHaveBeenCalled()
    // closing: declined, running; the words say it may still finish
    c.close(c.snapshot()!.seq)
    await flush()
    expect(asked.f).toEqual({ kind: 'declined', uncertain: true, running: true })
    // Review B1 (commons f0818d8): it may still finish, so the form reads it as unknown, never as a known no
    expect(finalAsResult(asked.f!)).toEqual({ status: 'refused', message: CLOSED_RUNNING, unknown: true })
    stop()
  })

  it('Check again after it finished: the recorded result, no second dialog, no mint', async () => {
    const { c, stop } = controller()
    const mint = vi.spyOn(a, 'confirmAct')
    const sends = vi.spyOn(a, 'programAct')
    sends.mockRejectedValueOnce(new ApiError(0, 'network', 'Network error'))
    for (let i = 0; i < 4; i++) sends.mockRejectedValueOnce(running())
    const asked = settledOf(c.ask(intentOf('ledger-fixture', attach(), d)))
    await c.confirm(c.snapshot()!.seq)
    await flush()
    expect(c.snapshot()!.stillRunning).toBe(true)
    sends.mockResolvedValueOnce({ status: 'done', message: 'received n.txt' })
    await c.confirm(c.snapshot()!.seq)
    await flush()
    expect(asked.f).toEqual({ kind: 'done', result: { status: 'done', message: 'received n.txt' } })
    expect(c.snapshot()).toBeNull()
    expect(mint).toHaveBeenCalledTimes(1)
    stop()
  })
})

describe('r4 (Design source-reference r1, done in place): a source change retires the old source’s callbacks and confirm', () => {
  const RETIRED = { status: 'refused', message: 'This app view is no longer open. Reopen it before acting.' }
  type Act = (...x: unknown[]) => Promise<{ status: string; message?: string }>
  const ref = (artifact_id: string, revision: number) => ({ artifact_id, revision, digest: 'sha256:' + String(revision).repeat(64) })
  async function body(start: Record<string, unknown> | undefined) {
    const program = { id: 'ledger-fixture', name: 'Ledger fixture' } as Program
    await useHive.getState().openProgram('ledger-fixture', 's_lyra')
    useHive.setState((x) => ({ programDetails: { ...x.programDetails, 'ledger-fixture': { ...(x.programDetails['ledger-fixture'] ?? {}), describe: d } as never } }))
    const state = { source: start, keys: [] as unknown[] }
    const h = render(() => {
      const ready = ProgramForm({ form: 'commons', program, swarmId: 's_lyra', grammar: 'classic', source: state.source as never }) as ReactElement<Record<string, unknown>>
      state.keys.push(ready.key)
      return (ready.type as (p: Record<string, unknown>) => unknown)(ready.props)
    })
    const actOf = () => (h.current as ReactElement<{ children: ReactElement<{ children: ReactElement<{ act: Act }> }>[] }>).props.children[0].props.children.props.act
    await flush()
    return { h, state, actOf, to: (s: Record<string, unknown> | undefined) => { state.source = s; h.rerender() } }
  }
  it('A→B→A: callbacks rendered for an earlier source refuse; the current one acts; the body is not remounted', async () => {
    const b = await body(ref('ar_a', 1))
    const actA1 = b.actOf()
    b.to(ref('ar_b', 1))
    const actB = b.actOf()
    b.to(ref('ar_a', 1))
    const actA2 = b.actOf()
    expect(await actA1('note', [], {}, { confirmed: true })).toEqual(RETIRED)
    expect(await actB('note', [], {}, { confirmed: true })).toEqual(RETIRED)
    expect(await actA2('note', [], {}, { confirmed: true })).not.toEqual(RETIRED)
    expect(new Set(b.state.keys).size).toBe(1)   // one ready body throughout: the form keeps its own state and receipts
    b.h.unmount()
  })
  it('an equal source with its keys in another order is the same source: retained callbacks keep working', async () => {
    const b = await body(ref('ar_a', 1))
    const act = b.actOf()
    const same = ref('ar_a', 1)
    b.to({ digest: same.digest, revision: same.revision, artifact_id: same.artifact_id })
    expect(await act('note', [], {}, { confirmed: true })).not.toEqual(RETIRED)
    b.h.unmount()
  })
  it('a confirm open for source A closes when B opens: nothing is minted or sent for A', async () => {
    const b = await body(ref('ar_a', 1))
    const mint = vi.spyOn(a, 'confirmAct')
    const deliver = vi.spyOn(a, 'programAct')
    const pending = b.actOf()('note', [], {})   // the host asks first (note takes the host confirm)
    await flush()
    b.to(ref('ar_b', 1))
    expect(await pending).toEqual({ status: 'refused', message: IDENTITY_CHANGED })
    expect(mint).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    b.h.unmount()
  })
  it('stand-in r4 B1 (parent lifetime): after a StrictMode replay a retained act stays retired; a fresh one acts', async () => {
    const b = await body(ref('ar_a', 1))
    const before = b.actOf()
    b.h.unmount()
    expect(await before('note', [], {}, { confirmed: true })).toEqual(RETIRED)
    R.effects = []   // StrictMode replay: the same body's setups run again (slots kept)
    b.h.rerender()
    await flush()
    expect(await before('note', [], {}, { confirmed: true })).toEqual(RETIRED)   // must not come back to life
    b.h.rerender()   // the replay publishes fresh callbacks
    expect(await b.actOf()('note', [], {}, { confirmed: true })).not.toEqual(RETIRED)
    b.h.unmount()
  })
  it('no source after a source (the empty canvas) also retires the old callbacks', async () => {
    const b = await body(ref('ar_a', 1))
    const act = b.actOf()
    b.to(undefined)
    expect(await act('note', [], {}, { confirmed: true })).toEqual(RETIRED)
    b.h.unmount()
  })
})
