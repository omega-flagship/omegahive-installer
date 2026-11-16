import { create } from 'zustand'
import { ApiError, type ConnectionState, type HiveClient } from '../../api/client'
import type { DecisionResult } from '../../lib/decisionGate'
import { readPowerEvent, readResult, readStatus, resultWords, type NameOf, type PowerState, type PowerStatus } from './api'
import { ended, gateClient, PowerGate, replaced } from './gate'
import { INITIAL, powerReducer, type PowerAction, type PowerView } from './machine'

/**
 * The power store: one per page. It owns the gate (what the rest of the page may call while off), reads power on load
 * and on every (re)connect, follows hive.power, and runs the three admin actions. Experiences only draw it.
 */
export interface PowerHooks {
  /** The hive came back on after being off on this page: read everything again (the store's hydrate). */
  woken?: () => void
  /** The hive went off on this page: everything read before may be stale (drop transient notices). */
  wentOff?: () => void
  /** A plain notice (the Wake all result). */
  notify?: (n: { tone: 'success' | 'error' | 'info'; title: string; body?: string }) => void
  /** Mind names the page already holds (results carry ids only). */
  nameOf?: NameOf
}

interface PowerStore extends PowerView {
  dispatch(a: PowerAction): void
  /** GET /api/hive/power (and who is asking): on load, on every reconnect, and when a held call needs it. */
  load(): Promise<void>
  /** The off screen's Ω: POST on, through the light-up. */
  press(): Promise<void>
  /** Turn the hive off (the confirm's decision). */
  turnOff(): Promise<DecisionResult>
  /** Wake all: restore the latest snapshot without the black screen (the confirm's decision). */
  wakeAll(): Promise<DecisionResult>
  /** Which power dialog is open (only an admin can open off or wake; anyone signed in sets their own rest). */
  dialog: 'off' | 'wake' | 'rest' | null
  openDialog(d: 'off' | 'wake' | 'rest' | null): void
}

type PowerClient = Pick<HiveClient, 'needsAuth' | 'subscribe' | 'onConnection' | 'connect' | 'getPower' | 'setPower' | 'me' | 'onAuthChange'>

/** A hive.power transition the page has seen (an event, or a current POST answer), in the order seen. */
interface Seen {
  state: PowerState
  since: string | null
  seq: number
}

/**
 * f0b412fc B1: everything one identity (this client, signed in as this principal) holds. A new client or a sign-out
 * replaces it whole: an answer, retry or recovery that began under an earlier one finds `ok()` false and does nothing.
 */
interface Generation {
  id: number
  client: PowerClient | null
  hooks: PowerHooks
  /** The operation in flight per target state: a retry after a lost answer reuses it (the host is idempotent on it). */
  ops: Partial<Record<PowerState, string>>
  /** The read in flight, if any (one at a time). */
  loading: Promise<void> | null
  /** Counts every transition seen (hive.power, or a current POST answer). */
  seq: number
  /** f0b412fc B2: the newest transition seen. A read or answer older than it never replaces it. */
  latest: Seen | null
}

let raw: PowerClient | null = null
let unsub: (() => void)[] = []
let gate = new PowerGate()
let genSeq = 0
let gen: Generation = fresh(null, {})

function fresh(client: PowerClient | null, hooks: PowerHooks): Generation {
  return { id: ++genSeq, client, hooks, ops: {}, loading: null, seq: 0, latest: null }
}

/** Capture before the first await; after each await, act only while `ok()` (same client, same signed-in identity). */
function bind(): { g: Generation; c: PowerClient | null; ok: () => boolean } {
  const g = gen
  const c = raw
  return { g, c, ok: () => gen === g && raw === c }
}

const opId = (g: Generation, state: PowerState) => (g.ops[state] ??= `power:${state}:${crypto.randomUUID()}`)
// no answer, or any 5xx: the outcome is unknown (never "it stayed off")
const lost = (err: unknown) => !(err instanceof ApiError) || err.status === 0 || err.status >= 500
const errWords = (err: unknown) => (err instanceof Error ? err.message : String(err))
const time = (since: string | null) => (since ? Date.parse(since) : NaN)

/** a is known to be a later transition than b (both timestamps readable and a's is later). */
const later = (a: string | null, b: string | null) => {
  const x = time(a)
  const y = time(b)
  return Number.isFinite(x) && Number.isFinite(y) && x > y
}

/**
 * Record a transition as seen: it becomes the newest unless something newer is already known. Answers whether it was
 * admitted (db4b3f9 B1): only an admitted transition may reach the gate, hydrate or release held requests.
 */
function observe(g: Generation, state: PowerState, since: string | null): boolean {
  g.seq++
  if (g.latest && later(g.latest.since, since)) return false
  g.latest = { state, since, seq: g.seq }
  return true
}

/**
 * f0b412fc B2: has a transition newer than this request's own been seen since it started (at `seq`)? Its own is the
 * one with the same state and since. Anything else seen meanwhile supersedes it unless its timestamp is known earlier.
 */
function superseded(g: Generation, seq: number, state: PowerState, since: string | null): boolean {
  const l = g.latest
  if (!l || l.seq <= seq) return false
  if (since !== null && l.state === state && l.since === since) return false
  return !later(since, l.since)
}

/**
 * A GET that started when `seq` transitions had been seen: valid unless a transition seen since might be newer than
 * what it read (then the newest seen stays, and it is read again).
 */
function readValid(g: Generation, seq: number, s: PowerStatus): boolean {
  const l = g.latest
  if (!l || l.seq <= seq) return true
  if (s.state === l.state && s.since !== null && s.since === l.since) return true
  return later(s.since, l.since)
}

/** What an action answers when the person signed out, or the page's client changed, before its answer came. */
const SESSION_CHANGED: DecisionResult = { unsettled: 'You signed out (or the connection was replaced) before the answer came back, so it is not shown here. Sign in to see the hive’s power now.' }

const sinceOf = (body: unknown): string | null => {
  const since = (body as { since?: unknown } | null)?.since
  return typeof since === 'string' && since.trim() ? since.trim() : null
}

export const usePower = create<PowerStore>()((set, get) => ({
  ...INITIAL,
  dialog: null,
  dispatch(a) {
    const before = get()
    const next = powerReducer(before, a)
    if (next !== before) set(next)
    const prev = gate.state
    gate.set(next.gate)
    if (prev === 'off' && next.gate === 'on') gen.hooks.woken?.()
    if (prev !== 'off' && next.gate === 'off') {
      gen.hooks.wentOff?.()
      // the events socket stays open while off (Platform): hive.power is how the page learns it is back
      raw?.connect()
      // no dialog of ours outlives the hive going off except Off's own (its answer is still coming)
      if (get().dialog === 'wake' || get().dialog === 'rest') set({ dialog: null })
    }
  },
  load() {
    const b = bind()
    const { g, c } = b
    if (g.loading) return g.loading
    if (!c || c.needsAuth()) return Promise.resolve()
    const at = g.seq
    let again = false
    let done = false
    let mine: Promise<void> | undefined = undefined
    mine = (async () => {
      try {
        if (get().admin === null && c.me) {
          // me() 409 auth_context_changed (Platform 439efb9) means the sign-in changed mid-read: the credential observer
          // below has already ended this generation, so b.ok() is false here and the new generation reads its own
          const me = await c.me().catch(() => null)
          if (!b.ok()) return
          if (me) get().dispatch({ type: 'admin', admin: me.kind === 'password' || me.role === 'admin' })
        }
        if (!c.getPower) {
          get().dispatch({ type: 'unreadable' })
          return
        }
        const s = readStatus(await c.getPower())
        if (!b.ok()) return
        if (!s) get().dispatch({ type: 'unreadable' })
        else if (readValid(g, at, s)) get().dispatch({ type: 'status', status: s })
        // a transition seen mid-read may be newer than what was read: keep it, and read once more
        else again = true
      } catch (err) {
        if (!b.ok()) return
        // signed out: stay unknown until sign-in; anything else: an older host or no answer, never a stranded page
        if (!(err instanceof ApiError && err.status === 401)) get().dispatch({ type: 'unreadable' })
      } finally {
        // this read's own marker only: a later identity's (or a later read's) is not ours to clear
        done = true
        if (g.loading === mine) g.loading = null
      }
      // an event landed mid-read: read once more, so `by` and the snapshot follow the latest change
      if (b.ok() && (again || g.seq !== at)) void get().load()
    })()
    if (!done) g.loading = mine
    return mine
  },
  async press() {
    const b = bind()
    const { g, c } = b
    if (!c?.setPower || get().wake !== 'idle' || get().admin !== true || get().gate !== 'off') return
    get().dispatch({ type: 'press' })
    const at = g.seq
    try {
      const body = await c.setPower({ state: 'on', operation_id: opId(g, 'on') })
      if (!b.ok()) return
      const r = readResult('on', body)
      delete g.ops.on
      // the answer (a replay's included: the host redoes a run cut short, so its counts may differ) is the report;
      // it is the hive's state only if nothing newer was seen while it was in flight
      const since = sinceOf(body)
      const current = !superseded(g, at, 'on', since) && observe(g, 'on', since)
      if (current) get().dispatch({ type: 'event', state: 'on', since })
      get().dispatch({ type: 'answered', result: r, current })
      // the true state is then read afresh (a superseded answer leaves the newest seen until that read is valid)
      void get().load()
    } catch (err) {
      if (!b.ok()) return
      if (!lost(err)) {
        delete g.ops.on
        get().dispatch({ type: 'failed', on: false, note: `The hive stayed off: ${errWords(err)}` })
        return
      }
      // no answer: read where the hive is, and say only that
      const s = await recover(b)
      if (!b.ok()) return
      if (s?.state === 'on') {
        delete g.ops.on
        get().dispatch({ type: 'status', status: s })
        get().dispatch({ type: 'failed', on: true, note: 'The hive is on. Its answer about which minds woke was lost on the way back.' })
      } else get().dispatch({ type: 'failed', on: false, note: 'We could not confirm the hive came on. Pressing again repeats the same request; it will not be done twice.' })
    }
  },
  async turnOff() {
    const b = bind()
    const { g, c } = b
    if (!c?.setPower) return 'This hive cannot be turned off from here (it has no power route).'
    const at = g.seq
    try {
      const body = await c.setPower({ state: 'off', operation_id: opId(g, 'off') })
      if (!b.ok()) return SESSION_CHANGED
      const r = readResult('off', body)
      delete g.ops.off
      const since = sinceOf(body)
      // f0b412fc B2: the answer is the hive's state only if nothing newer was seen meanwhile (never unconditionally)
      if (!superseded(g, at, 'off', since) && observe(g, 'off', since)) {
        get().dispatch({ type: 'event', state: 'off', since })
        get().dispatch({ type: 'offAnswered', result: r })
      } else {
        // the report of what this request did, without its (older) state
        const w = resultWords(r, g.hooks.nameOf)
        g.hooks.notify?.({ tone: w.ok ? 'info' : 'error', title: w.headline, body: [...w.detail, 'The hive’s power has changed again since.'].join(' ') })
      }
      void get().load()
      return true
    } catch (err) {
      if (!b.ok()) return SESSION_CHANGED
      if (!lost(err)) {
        delete g.ops.off
        return errWords(err)
      }
      const recheck = async (): Promise<DecisionResult> => {
        if (!b.ok()) return SESSION_CHANGED
        const s = await recover(b)
        if (!b.ok()) return SESSION_CHANGED
        if (s?.state === 'off') {
          delete g.ops.off
          get().dispatch({ type: 'status', status: s })
          return true
        }
        return { unsettled: 'We still cannot confirm the hive turned off.', recheck }
      }
      return { unsettled: 'No answer came back, so we cannot say whether the hive turned off. Checking again reads its state.', recheck }
    }
  },
  async wakeAll() {
    const b = bind()
    const { g, c } = b
    if (!c?.setPower) return 'This hive has no power route yet.'
    try {
      const body = await c.setPower({ state: 'on', operation_id: opId(g, 'on') })
      if (!b.ok()) return SESSION_CHANGED
      const r = readResult('on', body)
      delete g.ops.on
      const w = resultWords(r, g.hooks.nameOf)
      g.hooks.notify?.({ tone: w.ok ? 'success' : 'error', title: w.headline, body: w.detail.join(' ') || undefined })
      void get().load()
      return true
    } catch (err) {
      if (!b.ok()) return SESSION_CHANGED
      if (!lost(err)) {
        delete g.ops.on
        return errWords(err)
      }
      return { unsettled: 'No answer came back, so we cannot say which minds woke. Trying again repeats the same request; nothing is done twice.' }
    }
  },
  openDialog(d) {
    if ((d === 'off' || d === 'wake') && (get().admin !== true || get().gate === 'off')) return
    set({ dialog: d })
    // the snapshot count shown in Wake all is read fresh
    if (d === 'wake') void get().load()
  },
}))

/** After a lost answer: read where the hive is, under the same identity; an outdated or foreign read counts as none. */
async function recover(b: ReturnType<typeof bind>): Promise<PowerStatus | null> {
  if (!b.ok() || !b.c?.getPower) return null
  const at = b.g.seq
  const s = await b.c.getPower().then(readStatus, () => null)
  if (!b.ok() || !s || !readValid(b.g, at, s)) return null
  return s
}

/** The signed-in identity ended (sign-out, or the host answered unauthorized): nothing begun under it acts again. */
function signedOut(client: PowerClient): void {
  if (raw !== client) return
  gen = fresh(client, gen.hooks)
  gate.end(ended())
  usePower.setState({ ...INITIAL, dialog: null })
}

/**
 * Install power on a freshly created client: returns the gated client the rest of the page uses. Subscribes to
 * hive.power and to the connection (a reconnect reads power again), on the raw client so nothing here is gated.
 */
export function installPower<C extends HiveClient>(client: C, h: PowerHooks = {}): C {
  unsub.forEach((u) => u())
  unsub = []
  // f0b412fc B1: the earlier client's identity ends; its held calls settle unrun, and its gate refuses from now on
  gate.end(replaced(), true)
  raw = client
  gen = fresh(client, h)
  gate = new PowerGate()
  usePower.setState({ ...INITIAL, dialog: null })
  const mine = gate
  mine.need = () => {
    if (gate === mine) void usePower.getState().load()
  }
  unsub.push(
    client.subscribe((e) => {
      if (raw !== client) return
      const p = readPowerEvent(e)
      if (!p) return
      // db4b3f9 B1: an older transition than one already seen changes nothing (no gate, no hydrate, no release)
      if (!observe(gen, p.state, p.since)) return
      usePower.getState().dispatch({ type: 'event', state: p.state, since: p.since })
      // the event carries no `by`: one GET (open while off) says who
      void usePower.getState().load()
    }),
  )
  let was: ConnectionState | null = null
  unsub.push(
    client.onConnection((s) => {
      if (raw !== client) return
      if (s === 'open' && was !== 'open') void usePower.getState().load()
      if (s === 'unauthorized') signedOut(client)
      was = s
    }),
  )
  // Review db4b3f9/1e92645 identity follow-up: the generation is bound to the client's synchronous credential observer
  // too, so a re-login without a logout in between, or another tab's sign-in or sign-out, ends the earlier identity at
  // once: its answers, retries and held calls never act under the new one. Then power is read under the new sign-in.
  if (client.onAuthChange)
    unsub.push(
      client.onAuthChange(() => {
        if (raw !== client) return
        signedOut(client)
        if (!client.needsAuth()) void usePower.getState().load()
      }),
    )
  return gateClient(client, gate, () => signedOut(client))
}

/** For tests: the gate the installed client goes through. */
export const powerGate = (): PowerGate => gate
