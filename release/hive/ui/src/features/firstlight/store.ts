/**
 * First Light, playing (one journey at a time). It runs the script (script.ts) on the real hive screens against a
 * host: the live one (the person's own setup, through the routes in host.ts) or, on the simulator, the invented demo
 * one (demo.ts, labelled "simulated").
 *
 *  - The script only moves the screen, points and waits. Every real choice is the person's own press here (a role,
 *    keeping a look, a limit, asking a host for more, Wake). In demo mode the invented newcomer's presses are played
 *    for them, on the demo host only; a live journey never presses anything by itself.
 *  - Each beat ends ready, skipped or blocked, from the host's real answers. Progress is saved on the host (versioned;
 *    a 409 stale_onboarding adopts the record as it stands and says so). A save that fails never blocks the journey.
 *  - Bound to the person it started for: a change of person ends it at once (lib/identityEpoch), and every write after
 *    an await goes through the binding's commit.
 */
import { create } from 'zustand'
import { bindEpoch, onIdentityChange, type EpochBinding } from '../../lib/identityEpoch'
import { bindOperation, stopped } from '../../lib/boundOperation'
import { lookName, lookState, openGallery, previewLook, subscribeLook, withExperience, type UiPrefs } from '../../shell/uiVariant'
import { EXPERIENCES } from '../../experiences/registry'
import { liveEnv } from '../guided/store'
import { applyAction } from '../guided/driver'
import { useHive } from '../../store/store'
import { DEMO_APPS, DemoHost, type Persona } from './demo'
import { ASK_HOW_MAX, ASK_NAME_MAX, BLANK_PROGRESS, FlRefusal, asRefusal, cleanWords, firstName, liveHost, personaEditable, readProgress, startApp, type AppRef, type AskShape, type BoundWrite, type FlClient, type FlHost, type Hello, type MindRef, type MonthlyLimit, type Progress, type ProgressWrite, type Setup } from './host'
import { profileSaveCopy, unknownChargeCopy, type ProfileSaveState } from './conditionalCopy'
import { saveAskObserved } from './profileWrites'
import { refusalSentence, limitLine, payerLine, cents, TRANSIENT_MS, type Who } from './honest'
import { afterBeat, holds, beatsFromRecord, freshBeats, nextIndex, prevIndex, resumeBeat, roundResolved, startOf, waitsForPerson, type Beats, type Facts } from './journey'
import { BEAT_LINES, R2_BEATS, stepsFor, type Beat, type FlPath, type FlStep } from './script'

export type Mode = 'live' | 'demo'

export interface FlFacts {
  name: string | null
  host: string
  ownKeys: number
  limit: MonthlyLimit | null
  onlyMind: boolean | null
  mind: MindRef | null
  lookKept: boolean
  lookName: string | null
  greeted: boolean
  /** the hive's mind the ring points at (the demo points at the simulator's own personal mind) */
  mindOnScreen: string | null
  /** R3 beat 5: the apps ready for this person, the one to talk in first (null: not read, or unreadable) */
  apps: AppRef[] | null
  /** R3 beat 6: the person saved their Ask here; and its persona as it stood (to start from; null: not read yet) */
  askSaved: boolean
  askHow: string | null
}

export interface HelloRun {
  hello: Hello | null
  /** when Wake was pressed here (null: not yet) */
  postedAt: number | null
  refusal: { code: string; sentence: string } | null
  busy: boolean
  /** the time the view was last worked out at (so a render needs no clock) */
  at: number
}

export interface Run {
  /** Explicit U1 presentation only; never a host readiness badge. */
  u1?: { context: 'reading' | 'known' | 'unavailable'; model: string | null; busy: boolean; phase: 'editing' | 'waiting' | 'greeted'; error: string | null; profileSaved: boolean; saves?: ProfileSaveState; completion?: 'saving' | 'confirmed' | 'unknown'; completionToken?: number; limitPending?: number | null; limitUncertain?: boolean; limitChecking?: boolean; wakeUnknown?: boolean }
  id: number
  mode: Mode
  persona: Persona | null
  host: FlHost
  bind: EpochBinding
  path: FlPath
  steps: FlStep[]
  i: number
  status: 'loading' | 'playing' | 'paused' | 'ended'
  token: number
  facts: FlFacts
  beats: Beats
  progress: Progress | null
  notice: string | null
  hello: HelloRun
  /** a guest asking their host for more: `choosing`, the amounts are open (the journey holds still meanwhile) */
  ask: { busy: boolean; sent: { amount: number } | null; error: string | null; choosing: boolean }
  limit: { busy: boolean; error: string | null; other: boolean; limitPending?: number | null; limitUncertain?: boolean }
  /** R3 beat 6: saving the Ask */
  askForm: { busy: boolean; error: string | null; saves?: ProfileSaveState }
  loadError: string | null
  /** where the journey started (Stop goes nowhere; this is for "Back to where you were") */
  from: string
  /** beat 2: the look when it started (to see a keep), and whether we opened the gallery */
  lookAtStart: string | null
  galleryOpened: boolean
  /** demo: the preview the person had before the demo previewed a look (put back at the end) */
  previewBefore?: { p: UiPrefs | null }
  /** demo: a look to keep instead of the persona's (render smoke: every beat in the look under test) */
  demoLook?: string
}

export interface StartOpts {
  singleScreen?: boolean
  mode: Mode
  persona?: Persona
  /** start at this beat (the host's routes: #/first-light?beat=models) */
  beat?: string
  /** demo only: start at this step id (render smoke) */
  step?: string
  /** demo only: the look the demo keeps in beat 2 */
  look?: string
  /** demo only: start paused (the render smoke photographs a step before the demo plays on) */
  paused?: boolean
  /** tests only: the host to play against */
  host?: FlHost
}

/** The screen the journey moves (the real one: the guided demos' environment). Tests put a fake one in. */
export interface FlScreen {
  act(a: NonNullable<FlStep['do']>): void
  gallery(open: boolean): void
  galleryOpen(): boolean
  /** the saved look, as one comparable string (null: none) */
  savedLook(): string | null
  savedLookName(): string
  deviceOnly(): boolean
}
const realScreen: FlScreen = {
  act: (a) => void applyAction(a, liveEnv, liveEnv.picks()),
  gallery: (open) => openGallery(open),
  galleryOpen: () => lookState().galleryOpen,
  savedLook: () => {
    const s = lookState().saved
    return s ? `${s.experience ?? 'classic'}|${s.variant?.name ?? ''}|${s.layout ?? ''}` : null
  },
  savedLookName: () => lookName(lookState().saved),
  deviceOnly: () => lookState().deviceOnly === true,
}
let screen: FlScreen = realScreen
export function setFlScreen(s: FlScreen | null): void {
  screen = s ?? realScreen
}

interface FlState {
  run: Run | null
  start(o: StartOpts): Promise<boolean>
  next(): void
  back(): void
  toggle(): void
  stop(): void
  /**
   * "Not now": closes First Light and records it on the host as skipped (status 'skipped', compare-and-set on the
   * record's version), so it never opens by itself again for this person, on any device. Explicit ways in (the Me
   * page's "Meet your omega", #/first-light, the Ask) still open it. A finished record is never touched; demo writes nothing.
   */
  notNow(): void
  /** the person's choice at a choice step (a role, or a monthly amount) */
  choose(value: string | number): Promise<void>
  /** Later: this beat is skipped (it stays on Finish setting up) */
  skipBeat(): void
  /** beat 2: keep the look they already have */
  keepCurrent(): void
  /** beat 3: read the keys again (after adding one) */
  checkKey(): Promise<void>
  askForMore(amount: number): Promise<void>
  /** a guest opened (or closed) the amounts to ask their host for: the journey holds still while they are open */
  askChoosing(open: boolean): void
  wake(): Promise<void>
  reload(): Promise<void>
  /** go back to a beat (from beat 8's "Add a key" or "Ask for more"), played from its first step */
  goBeat(beat: Beat): void
  /** demo: the newcomer adds their invented key */
  demoAddKey(): Promise<void>
  /** demo: the newcomer keeps their look (a preview: never saved) */
  demoKeepLook(): void
  /** R3 beat 5: on from the apps (Next) */
  appsNext(): void
  /** R3 beat 5: open one of the apps now (First Light pauses, and remembers where it was) */
  openApp(id: string): void
  /** R3 beat 6: save the Ask's name and how it should be, on the person's own mind */
  saveAsk(shape: AskShape): Promise<void>
  /** The owner's tap on "Think with your … plan" (plans.ts): set their own mind's model to that plan's model. */
  thinkWith(model: string): Promise<void>
  wakeSingleScreen(shape: AskShape, monthly: number | null): Promise<void>
  finishSingleScreen(): Promise<void>
  /** demo: the newcomer describes their Ask */
  demoSaveAsk(): Promise<void>
  /** R3 hand-off: open the app to talk in, and end First Light */
  startTalking(): void
}

let seq = 0

/** Page-lifetime quarantine, not authority. It outlives runs/epochs/client objects,
 * but a person's intent is projected only after a current stable scope is known.
 * Never log/export these private keys or another person's amount. */
type LimitIntent = { amount: number; settled: boolean }
type LimitRead = Map<string, { intent: LimitIntent; settledAtStart: boolean }>
const limitIntents = new Map<string, LimitIntent>()
const UNKNOWN_LIMIT = "We couldn't confirm a spending limit here."
function limitScope(host: FlHost): string | null {
  try {
    const value = host.retainedMutationScope?.()
    if (!value || typeof value.host !== 'string' || typeof value.principal !== 'string' || !value.principal || value.principal.length > 256) return null
    const url = new URL(value.host)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) return null
    return JSON.stringify([url.origin + url.pathname.replace(/\/+$/, ''), value.principal])
  } catch { return null }
}
function sampleLimits(): LimitRead {
  return new Map([...limitIntents].map(([key, intent]) => [key, { intent, settledAtStart: intent.settled }]))
}
function limitProjection(host: FlHost): { limitPending: number | null; limitUncertain: boolean } {
  if (host instanceof DemoHost) return { limitPending: null, limitUncertain: false }
  const key = limitScope(host)
  if (key === null) return { limitPending: null, limitUncertain: limitIntents.size > 0 }
  const intent = limitIntents.get(key)
  return { limitPending: intent?.amount ?? null, limitUncertain: !!intent }
}
function acceptLimitRead(r: Run, sampled: LimitRead, setup: Setup) {
  const key = limitScope(r.host)
  const intent = key === null ? undefined : limitIntents.get(key)
  const before = key === null ? undefined : sampled.get(key)
  if (key !== null && intent && before?.intent === intent && before.settledAtStart
    && setup.own_keys > 0 && setup.limit?.enforced === true && setup.limit.enforced_by === 'own' && setup.limit.limit_usd === intent.amount) {
    r.bind.commit(() => { if (limitIntents.get(key) === intent) limitIntents.delete(key) })
  }
  return limitProjection(r.host)
}
/** Presentation only: an older retained amount is not a current claim during reconciliation. */
export const firstLightLimitLine = (r: Run): string => r.limit.limitUncertain ? UNKNOWN_LIMIT : limitLine(r.facts.limit, whoOf(r))
/** the person kept a look (set by the store; the look subscription below calls it) */
let lookChanged: () => void = () => {}
const noFacts = (): FlFacts => ({ name: null, host: 'your host', ownKeys: 0, limit: null, onlyMind: null, mind: null, lookKept: false, lookName: null, greeted: false, mindOnScreen: null, apps: null, askSaved: false, askHow: null })

export const factsOf = (r: Run): Facts => ({ path: r.path, onlyMind: r.facts.onlyMind, limit: r.facts.limit, lookKept: r.facts.lookKept, greeted: r.facts.greeted, beats: r.beats, apps: r.facts.apps ? r.facts.apps.length : null, askSaved: r.facts.askSaved })
export const whoOf = (r: Run): Who => ({ path: r.path, host: r.facts.host, ownKeys: r.facts.ownKeys })
export const stepOf = (r: Run | null): FlStep | undefined => (r ? r.steps[r.i] : undefined)
/**
 * followups-r8 (stand-in FL-R2 P2): the journey does not move on by itself while a guest is asking their host for more
 * (the amounts open, or the request on its way): the last guest step would otherwise take the card, and its controls,
 * away mid-choice. It moves on again, after the full time to read, once they are closed or the request is answered.
 */
export const autoHeld = (r: Run | null): boolean => !!r && r.steps[r.i]?.card === 'guest-limit' && (r.ask.busy || (r.ask.choosing && !r.ask.sent))

/** The live host on the current client; the demo host on the simulator (never the other way round). */
function hostFor(o: StartOpts): { host: FlHost; mode: Mode; persona: Persona | null } | null {
  const client = useHive.getState().client as (FlClient & { mode?: string }) | null
  if (!client) return null
  if (client.mode === 'sim') {
    const persona = o.persona ?? 'pip'
    return { host: new DemoHost(persona), mode: 'demo', persona }
  }
  if (o.mode === 'demo') return null // the invented newcomer never plays on a real hive
  // the minds this person can see on the hive, besides their own (the store's agents, as the map draws them)
  const others = (mindId: string | null) => {
    const agents = useHive.getState().agents
    return agents ? Object.keys(agents).filter((a) => a !== mindId).length : null
  }
  return { host: liveHost(client, others), mode: 'live', persona: null }
}

const pathOf = (own: { you_are_owner: boolean; your_access: string | null }): FlPath => (own.your_access === 'guest' ? 'guest' : own.you_are_owner ? 'owner' : 'member')

export const useFirstLight = create<FlState>()((set, get) => {
  /** The run, if it is still the one with this id and the same person is here. */
  const live = (id: number): Run | null => {
    const r = get().run
    return r && r.id === id && r.status !== 'ended' && r.bind.current() ? r : null
  }
  /** Change the run (only while it is still the same run and person). */
  const patch = (id: number, fn: (r: Run) => Partial<Run>) => {
    const r = live(id)
    if (!r) return
    r.bind.commit(() => set({ run: { ...r, ...fn(r) } }))
  }
  const setBeat = (id: number, beat: Beat, state: Beats[Beat]['state'], line: string | null) => patch(id, (r) => ({ beats: { ...r.beats, [beat]: { state, line } } }))

  // ---------------------------------------------------------------- saving progress (serialised; never blocks)
  let saving: Promise<unknown> = Promise.resolve()
  function projectLimit(id: number, pending: ReturnType<typeof limitProjection>) {
    patch(id, (x) => ({ limit: { ...x.limit, ...pending }, ...(x.u1 ? { u1: { ...x.u1, ...pending } } : {}) }))
  }
  /** Every real First Light own-key setter passes this one guarded dispatch. */
  async function dispatchOwnLimit(r: Run, amount: number, write: BoundWrite, setup: Setup, path: FlPath) {
    // Explicit invented DemoHost only; never a live-kind facade or a string mode claim.
    if (r.mode === 'demo' && r.host instanceof DemoHost) return write(() => r.host.setOwnLimit(amount))
    return write(async () => {
      if (path === 'guest' || setup.own_keys <= 0 || setup.limit === null || (setup.limit.enforced && setup.limit.enforced_by !== 'own')) throw new FlRefusal(403, 'own_key_required', 'Your own-key monthly scope is not confirmed.')
      const key = limitScope(r.host)
      if (key === null || limitIntents.has(key)) throw new FlRefusal(0, 'limit_unconfirmed', UNKNOWN_LIMIT)
      const intent: LimitIntent = { amount, settled: false }
      limitIntents.set(key, intent) // current bound synchronous run, BEFORE actual dispatch
      projectLimit(r.id, limitProjection(r.host))
      try { await write(() => r.host.setOwnLimit(amount)) } // renew the person/attempt fence after synchronous subscribers
      finally { intent.settled = true } // only this original private operation; no newer UI/marker mutation
    })
  }

  const save = (id: number, w: (p: Progress) => ProgressWrite, stillCurrent: () => boolean = () => true) => {
    const intended = live(id)
    const token = intended?.u1 ? intended.token : null
    saving = saving.then(async () => {
      const r = live(id)
      if (!r || !stillCurrent() || (token !== null && (r.token !== token || r.status !== 'playing'))) return
      const base = r.progress ?? BLANK_PROGRESS
      // followups-r8 (Kimi FL-R2 #1): the write is a bound operation, checked right before it is sent and on its answer
      const op = bindOperation(() => { const x = live(id); return !!x && stillCurrent() && (token === null || (x.token === token && x.status === 'playing')) })
      try {
        const p = await op.write(() => r.host.writeProgress(w(base), base.version))
        patch(id, () => ({ progress: p }))
      } catch (e) {
        if (!op.current() || stopped(e)) return
        const x = asRefusal(e)
        const current = x.code === 'stale_onboarding' ? readProgress(x.current) : null
        if (current) patch(id, (rr) => ({ progress: current, notice: refusalSentence('stale_onboarding', { path: rr.path, host: rr.facts.host }), beats: mergeRecord(rr.beats, current) }))
        else patch(id, () => ({ notice: 'Your progress couldn’t be saved just now, so it’s only on this screen. Nothing else is affected.' }))
      }
    })
    return saving
  }

  /** Only onboarding completion, serialized with other progress writes; never repeats a Wake. */
  function completeSingle(id: number): Promise<void> {
    const initial = live(id)
    if (!initial?.u1 || !initial.facts.greeted || !initial.facts.askSaved || (initial.u1.completion === 'saving' && initial.u1.completionToken === initial.token)) return Promise.resolve()
    const token = initial.token
    const ownsLock = () => { const x = live(id); return !!x?.u1 && x.token === token && x.u1.completionToken === token && x.u1.completion === 'saving' }
    patch(id, (x) => ({ u1: { ...x.u1!, completion: 'saving', completionToken: token, error: null } }))
    const completion = saving.then(async () => {
      const op = bindOperation(() => { const x = live(id); return ownsLock() && !!x && x.status === 'playing' && x.facts.greeted && x.facts.askSaved })
      try {
        const before = await op.write(() => initial.host.progress())
        let confirmed = before
        if (before.status !== 'finished' || !before.beats_done.includes('ask') || !before.beats_done.includes('hello')) {
          const done = [...new Set([...before.beats_done, 'ask' as Beat, 'hello' as Beat])]
          await op.write(() => initial.host.writeProgress({ status: 'finished', current_beat: 'hello', beats_done: done, beats_skipped: before.beats_skipped.filter((b) => b !== 'ask' && b !== 'hello') }, before.version))
          confirmed = await op.write(() => initial.host.progress())
        }
        if (confirmed.status !== 'finished' || !confirmed.beats_done.includes('ask') || !confirmed.beats_done.includes('hello')) throw new Error('completion_not_confirmed')
        if (op.current()) patch(id, (x) => ({ progress: confirmed, u1: { ...x.u1!, completion: 'confirmed', completionToken: undefined, error: null } }))
      } catch (e) {
        // A typed stop can precede the store's identity observer. Release only this still-current lock;
        // a stale old attempt cannot clear the completion state of a newer token.
        if (!ownsLock()) return
        patch(id, (x) => ({ u1: { ...x.u1!, completion: 'unknown', completionToken: undefined, error: stopped(e) ? 'Completion stopped before it could be confirmed. Save completion again; no further Wake request is sent.' : 'Your omega answered, but First Light completion could not be confirmed. Save completion again; this only records First Light progress.' } }))
      }
    })
    saving = completion
    return completion
  }
  /** A beat done (or skipped), with where the journey is now: one write, never both lists. */
  const record = (id: number, beat: Beat, as: 'done' | 'skipped', extra: ProgressWrite = {}) => {
    // where the journey goes next, worked out now (the write may land after the screen has moved on)
    const r = get().run
    const next = r && r.steps[r.i]?.beat === beat ? r.steps[afterBeat(r.steps, r.i, factsOf(r))]?.beat ?? null : null
    return save(id, (p) => {
      const done = p.beats_done.filter((b) => b !== beat)
      const skipped = p.beats_skipped.filter((b) => b !== beat)
      ;(as === 'done' ? done : skipped).push(beat)
      return { ...extra, beats_done: done, beats_skipped: skipped, current_beat: next ?? beat }
    })
  }

  // ---------------------------------------------------------------- reading the host

  async function refreshSetup(id: number): Promise<void> {
    const r = live(id)
    if (!r) return
    try {
      const token = r.token
      const op = bindOperation(() => { const x = live(id); return !!x && x.token === token && x.status === 'playing' })
      const sampled = sampleLimits()
      const s = await op.write(() => r.host.setup())
      const pending = acceptLimitRead(r, sampled, s)
      patch(id, (rr) => ({ facts: { ...rr.facts, ownKeys: s.own_keys, limit: s.limit, host: rr.path === 'guest' ? s.limit?.host_name ?? rr.facts.host : rr.facts.host }, limit: { ...rr.limit, ...pending }, ...(rr.u1 ? { u1: { ...rr.u1, ...pending } } : {}) }))
    } catch {
      /* the last answer stands; a beat never claims more than it last read */
      return
    }
    recheckWhen(id)
  }

  /**
   * followups-r8 (Kimi FL-R2 #2): a step's `when` was checked once, on entry. When what the host said changes while the
   * step is on screen (a limit no longer enforced), its caption no longer holds: the journey moves on to the step that
   * applies now (3.2g → 3.2gn), so no line keeps claiming what stopped being true.
   */
  function recheckWhen(id: number) {
    const r = live(id)
    const step = r ? r.steps[r.i] : undefined
    if (!r || !step?.when || holds(step.when, factsOf(r))) return
    enter(id, r.i)
  }

  // ---------------------------------------------------------------- moving through the steps

  /** Do what a step does on entry (move the screen, open the gallery), and settle the beat it leaves. */
  function enter(id: number, to: number) {
    const r = live(id)
    if (!r) return
    const from = r.steps[r.i]
    if (r.steps[to] && !holds(r.steps[to].when, factsOf(r))) {
      const j = nextIndex(r.steps, to, factsOf(r))
      return enter(id, j < 0 ? r.steps.length : j)
    }
    const step = r.steps[to]
    if (!step) return finish(id)
    if (from && from.beat !== step.beat) leaveBeat(id, from.beat)
    const rr = live(id)
    if (!rr) return
    const beats = rr.beats[step.beat].state === 'pending' ? { ...rr.beats, [step.beat]: { state: 'active' as const, line: null } } : rr.beats
    const firstOfLook = step.beat === 'look' && (!from || from.beat !== 'look')
    const ask = step.card === 'guest-limit' || !rr.ask.choosing ? rr.ask : { ...rr.ask, choosing: false }
    rr.bind.commit(() => set({ run: { ...rr, i: to, token: rr.token + 1, beats, ask, ...(firstOfLook ? { lookAtStart: screen.savedLook() } : {}) } }))
    // reached other than step by step (a resume, Back into a beat, a beat asked for): its beat's screen move is done again
    const act = step.do ?? (from && from.beat === step.beat && rr.i === to - 1 ? undefined : actionBefore(rr.steps, to))
    if (act) {
      if ('ui' in act && act.ui === 'gallery') {
        if (!screen.galleryOpen()) {
          screen.gallery(true)
          patch(id, () => ({ galleryOpened: true }))
        }
      } else screen.act(act)
    }
    if (step.wait?.for === 'key' || step.card === 'guest-limit' || step.card === 'limit' || step.card === 'own-limit') void refreshSetup(id)
    if (step.wait?.for === 'ask' && rr.facts.askHow === null) void readAskHow(id)
  }

  /** R3 beat 6: start from the whole persona; a failed read remains unknown and cannot propose a default. */
  async function readAskHow(id: number) {
    const r = live(id)
    const mindId = r?.facts.mind?.id
    if (!r || !mindId) return
    const how = await r.host.askHow(mindId).catch(() => null)
    if (how === null) return
    patch(id, (x) => x.facts.mind?.id === mindId ? { facts: { ...x.facts, askHow: x.facts.askHow ?? how } } : {})
  }

  async function readSingleProfile(id: number, token: number) {
    const r = live(id)
    const mindId = r?.facts.mind?.id
    if (!r?.u1 || !mindId || !r.host.profile) {
      if (r?.u1) patch(id, (x) => ({ u1: { ...x.u1!, context: 'unavailable', model: null, error: 'This hive could not provide your personal omega and current model. Read it again or open its settings.' } }))
      return
    }
    const op = bindOperation(() => { const x = live(id); return !!x?.u1 && x.token === token && x.status === 'playing' })
    try {
      const p = await op.write(() => r.host.profile!(mindId))
      if (p.id !== mindId || typeof p.name !== 'string' || typeof p.persona !== 'string') throw new FlRefusal(409, 'mind_changed', 'Your personal omega changed. Read its settings again.')
      patch(id, (x) => x.facts.mind?.id !== mindId ? {} : ({ facts: { ...x.facts, mind: { ...x.facts.mind!, name: p.name }, askHow: p.persona }, u1: { ...x.u1!, context: p.model ? 'known' : 'unavailable', model: p.model, error: p.model ? null : 'The hive has not identified a model for this omega. Choose one in its Model settings.' } }))
    } catch (e) {
      if (!op.current() || stopped(e)) return
      patch(id, (x) => ({ u1: { ...x.u1!, context: 'unavailable', model: null, error: 'Your current purpose and model could not be read. Nothing will be replaced with a guessed default.' } }))
    }
  }

  /** A beat ends: its state from what the host said (arrive and look settle at the person's choice). */
  function leaveBeat(id: number, beat: Beat) {
    const r = live(id)
    if (!r) return
    if (beat === 'look' && r.galleryOpened) {
      screen.gallery(false)
      patch(id, () => ({ galleryOpened: false }))
    }
    if (beat === 'apps' && r.beats.apps.state === 'active') {
      const n = r.facts.apps?.length ?? 0
      if (n > 0) {
        setBeat(id, 'apps', 'ready', n === 1 ? `${r.facts.apps![0].name} is ready for you.` : `${n} apps are ready for you.`)
        void record(id, 'apps', 'done')
      } else {
        setBeat(id, 'apps', 'skipped', BEAT_LINES.apps.none)
        void record(id, 'apps', 'skipped')
      }
      return
    }
    if (beat === 'ask' && r.beats.ask.state === 'active' && !r.facts.askSaved) {
      setBeat(id, 'ask', 'skipped', BEAT_LINES.ask.skipped)
      void record(id, 'ask', 'skipped')
      return
    }
    if (beat !== 'models' || r.beats.models.state !== 'active') return
    if (r.limit.limitUncertain) { setBeat(id, 'models', 'blocked', UNKNOWN_LIMIT); return }
    const w = whoOf(r)
    const l = r.facts.limit
    if (r.path === 'guest') {
      if (l?.enforced) {
        setBeat(id, 'models', 'ready', `Your limit here: ${cents(l.limit_usd ?? 0)} a month, on ${r.facts.host}’s key.`)
        void record(id, 'models', 'done')
      } else setBeat(id, 'models', 'blocked', limitLine(l, w))
      return
    }
    if (r.path === 'member') {
      if (l?.enforced || r.facts.ownKeys > 0) {
        setBeat(id, 'models', 'ready', l?.enforced ? limitLine(l, w) : payerLine(w))
        void record(id, 'models', 'done')
      } else setBeat(id, 'models', 'blocked', limitLine(l, w))
      return
    }
    // owner: ready only with a key of their own and an enforced limit; no key is "later"
    if (r.facts.ownKeys <= 0) {
      setBeat(id, 'models', 'skipped', BEAT_LINES.models.skipped)
      void record(id, 'models', 'skipped')
    } else if (l?.enforced) {
      setBeat(id, 'models', 'ready', `Your key is in. ${limitLine(l, w)}`)
      void record(id, 'models', 'done', { key_choice: 'own-key' })
    } else setBeat(id, 'models', 'blocked', `Your key is in, but no monthly limit is in force yet. ${r.limit.error ?? 'Choose one here.'}`)
  }

  function finish(id: number) {
    const r = live(id)
    if (!r) return
    leaveBeat(id, r.steps[r.i]?.beat ?? 'hello')
    const rr = live(id)
    if (!rr) return
    if (roundResolved(rr.beats)) void save(id, () => ({ status: 'finished', current_beat: 'hello' }))
    end(rr, 'ended')
  }

  function end(r: Run, status: 'ended') {
    stopPoll()
    if (r.galleryOpened) screen.gallery(false)
    if (r.previewBefore) previewLook(r.previewBefore.p)
    set({ run: { ...r, status, token: r.token + 1, galleryOpened: false, previewBefore: undefined } })
  }

  // ---------------------------------------------------------------- the hello

  let poll: ReturnType<typeof setTimeout> | null = null
  const stopPoll = () => {
    if (poll) clearTimeout(poll)
    poll = null
  }
  const POLL_MS = 1500
  const POLL_FOR_MS = 200_000

  function greeted(id: number, h: Hello) {
    stopPoll()
    const prior = live(id)
    if (prior?.u1 && h.mind.id !== prior.facts.mind?.id) {
      patch(id, (x) => ({ u1: { ...x.u1!, context: 'unavailable', busy: false, error: 'Your personal omega changed. The Wake result could not be confirmed; read it again.' } }))
      return
    }
    patch(id, (r) => ({ facts: { ...r.facts, greeted: true }, hello: { ...r.hello, hello: h, at: Date.now(), busy: false } }))
    if (prior?.u1) patch(id, (x) => ({ u1: { ...x.u1!, phase: 'greeted', busy: false } }))
    setBeat(id, 'hello', 'ready', 'Your mind is awake, and it said hello.')
    void refreshSetup(id)
    const r = live(id)
    if (!r) return
    if (r.u1) { void completeSingle(id); return }
    void save(id, (p) => {
      const done = [...p.beats_done.filter((b) => b !== 'hello'), 'hello' as Beat]
      const skipped = p.beats_skipped.filter((b) => b !== 'hello')
      const all = R2_BEATS.every((b) => b === 'hello' || done.includes(b) || skipped.includes(b) || r.beats[b].state === 'ready' || r.beats[b].state === 'skipped')
      return { beats_done: done, beats_skipped: skipped, current_beat: 'hello', ...(all ? { status: 'finished' as const } : {}) }
    })
    // on to the closing line, which applies now that the mind greeted
    const j = nextIndex(r.steps, r.i, factsOf(r))
    if (j >= 0 && r.status === 'playing') enter(id, j)
  }

  function startPoll(id: number) {
    stopPoll()
    const tick = async () => {
      const r = live(id)
      if (!r || r.facts.greeted) return
      const since = r.hello.postedAt ?? Date.now()
      let h: Hello | null = null
      const op = bindOperation(() => { const x = live(id); return !!x && (!x.u1 || (x.status === 'playing' && x.token === r.token)) })
      try {
        h = await op.write(() => r.host.helloGet())
      } catch (e) {
        if (stopped(e)) return
        h = r.hello.hello // a failed read changes nothing shown
      }
      const rr = live(id)
      if (!rr) return
      if (h && h.state === 'greeted') return greeted(id, h)
      patch(id, (x) => ({ hello: { ...x.hello, hello: h, at: Date.now() } }))
      if (Date.now() - since < POLL_FOR_MS) poll = setTimeout(() => void tick(), POLL_MS)
    }
    poll = setTimeout(() => void tick(), POLL_MS)
  }

  // ---------------------------------------------------------------- the person's acts

  async function setMonthly(id: number, amount: number) {
    const r = live(id)
    if (!r || r.status !== 'playing' || r.limit.busy) return
    const token = r.token
    patch(id, (x) => ({ limit: { ...x.limit, busy: true, error: null, other: false } }))
    const op = bindOperation(() => { const x = live(id); return !!x && x.status === 'playing' && x.token === token && x.limit.busy })
    try {
      const sampled = sampleLimits()
      const fresh = await op.write(() => r.host.setup())
      const pending = acceptLimitRead(r, sampled, fresh)
      projectLimit(id, pending)
      if (pending.limitUncertain) throw new FlRefusal(0, 'limit_unconfirmed', UNKNOWN_LIMIT)
      const own = await op.write(() => r.host.own())
      const path = pathOf(own)
      if (path !== r.path) throw new FlRefusal(409, 'own_key_required', 'Your spending context changed. Read the current setup again.')
      patch(id, (x) => ({ facts: { ...x.facts, ownKeys: fresh.own_keys, limit: fresh.limit } }))
      if (fresh.own_keys > 0) {
        await dispatchOwnLimit(r, amount, (send) => op.write(send), fresh, path)
        const readStarted = sampleLimits()
        const confirmed = await op.write(() => r.host.setup())
        const after = acceptLimitRead(r, readStarted, confirmed)
        projectLimit(id, after)
        patch(id, (x) => ({ facts: { ...x.facts, ownKeys: confirmed.own_keys, limit: confirmed.limit } }))
        if (after.limitUncertain || !confirmed.limit?.enforced || confirmed.limit.enforced_by !== 'own' || confirmed.limit.limit_usd !== amount) throw new FlRefusal(0, 'limit_unconfirmed', UNKNOWN_LIMIT)
      }
      // No-key proposals retain their original progress-only behavior. An own-key
      // choice is recorded only after its actual setter and matching readback.
      await op.write(() => save(id, () => ({ monthly_spend_usd: amount, ...(fresh.own_keys > 0 ? { key_choice: 'own-key' as const } : {}) }), op.current))
      patch(id, (x) => ({ facts: { ...x.facts, limit: x.facts.limit ? { ...x.facts.limit, chosen_usd: amount } : { done: false, enforced: false, enforced_by: null, limit_usd: null, spent_usd: null, chosen_usd: amount, host_name: null, pending_request: null } } }))
      const after = live(id)
      if (after && op.current()) {
        patch(id, (x) => ({ limit: { ...x.limit, busy: false } }))
        enter(id, nextOr(after))
      }
    } catch (e) {
      if (stopped(e) || !op.current()) return
      const failure = asRefusal(e)
      const pending = limitProjection(r.host)
      projectLimit(id, pending)
      const error = pending.limitUncertain || failure.code === 'limit_unconfirmed' ? UNKNOWN_LIMIT : refusalSentence(failure.code, { path: r.path, host: r.facts.host, fallback: failure.message })
      patch(id, (x) => ({ limit: { ...x.limit, error } }))
    } finally {
      patch(id, (x) => x.token === token ? { limit: { ...x.limit, busy: false } } : {})
    }
  }

  const nextOr = (r: Run) => {
    const j = nextIndex(r.steps, r.i, factsOf(r))
    return j < 0 ? r.steps.length : j
  }

  // ---------------------------------------------------------------- the store

  lookChanged = () => {
    const r = get().run
    if (!r || r.status === 'ended' || r.mode !== 'live') return
    const step = r.steps[r.i]
    if (step?.beat !== 'look' || r.facts.lookKept) return
    const now = screen.savedLook()
    if (now === r.lookAtStart) return
    // the person kept a look in the gallery (their own Keep, through the gallery's own save)
    const name = screen.savedLookName()
    const deviceOnly = screen.deviceOnly()
    patch(r.id, (x) => ({ facts: { ...x.facts, lookKept: true, lookName: name } }))
    setBeat(r.id, 'look', deviceOnly ? 'blocked' : 'ready', deviceOnly ? BEAT_LINES.look.blocked : BEAT_LINES.look.ready)
    if (!deviceOnly) void record(r.id, 'look', 'done')
    const rr = live(r.id)
    if (rr && rr.steps[rr.i]?.wait?.for === 'look') enter(rr.id, nextOr(rr))
  }

  async function wakeSingleScreen(shape: AskShape, monthly: number | null) {
    const r = live(get().run?.id ?? -1)
    if (!r?.u1 || r.mode !== 'live' || r.status !== 'playing' || r.u1.busy || r.u1.phase === 'greeted' || r.u1.context !== 'known' || !r.u1.model || (r.u1.phase === 'waiting' && !r.hello.hello?.retryable)) return
    const limitRunId = r.id
    const mindId = r.facts.mind?.id
    const name = cleanWords(shape.name, ASK_NAME_MAX)
    const fail = (words: string) => patch(r.id, (x) => ({ hello: { ...x.hello, busy: false }, u1: { ...x.u1!, error: words, busy: false, phase: 'editing' } }))
    if (!mindId || !name) return fail('Give your omega a name first.')
    if (shape.how !== null && !personaEditable(r.facts.askHow)) return fail('Your existing purpose cannot be edited here. A name-only save keeps it whole.')
    if (monthly !== null && (!Number.isFinite(monthly) || monthly < 0 || monthly > 10000)) return fail('Choose a finite monthly amount from $0 to $10,000.')
    patch(r.id, (x) => ({ u1: { ...x.u1!, busy: true, limitChecking: false, error: null, profileSaved: false, saves: undefined } }))
    const attemptToken = r.token
    const op = bindOperation(() => { const x = live(r.id); return !!x?.u1 && x.status === 'playing' && x.token === attemptToken && x.u1.busy })
    let wakeSent = false
    let limitSaved = false
    // Local request state only: retained amounts and unrelated profile/Wake work
    // cannot claim that a limit request is still in flight.
    async function limitRequest<T>(send: () => Promise<T>): Promise<T> {
      return op.write(async () => {
        patch(limitRunId, (x) => x.token === attemptToken ? ({ u1: { ...x.u1!, limitChecking: true } }) : {})
        try { return await send() }
        finally { patch(limitRunId, (x) => x.token === attemptToken ? ({ u1: { ...x.u1!, limitChecking: false } }) : {}) }
      })
    }
    try {
      const sampled = sampleLimits()
      const fresh = await limitRequest(() => r.host.setup())
      const pending = acceptLimitRead(r, sampled, fresh)
      projectLimit(r.id, pending)
      if (pending.limitUncertain) return fail(UNKNOWN_LIMIT)
      const own = await op.write(() => r.host.own())
      const profile = await op.write(() => r.host.profile!(mindId))
      if (profile.id !== mindId || typeof profile.name !== 'string' || typeof profile.persona !== 'string') throw new FlRefusal(409, 'mind_changed', 'Your personal omega could not be identified. Read it again.')
      if (profile.id !== mindId || profile.name !== r.facts.mind?.name || profile.model !== r.u1.model || profile.persona !== r.facts.askHow || pathOf(own) !== r.path || fresh.own_keys !== r.facts.ownKeys || fresh.limit?.enforced !== r.facts.limit?.enforced || fresh.limit?.enforced_by !== r.facts.limit?.enforced_by || fresh.limit?.limit_usd !== r.facts.limit?.limit_usd) {
        patch(r.id, (x) => ({ path: pathOf(own), facts: { ...x.facts, host: pathOf(own) === 'guest' ? fresh.limit?.host_name ?? own.owner_name ?? 'your host' : own.owner_name ?? x.facts.host, ownKeys: fresh.own_keys, limit: fresh.limit, askHow: profile.persona, mind: { ...x.facts.mind!, name: profile.name } }, u1: { ...x.u1!, context: profile.model ? 'known' : 'unavailable', model: profile.model } }))
        return fail('Your model, purpose or spending context changed. Review the current values and press Wake again.')
      }
      if (monthly !== null) {
        if (r.path === 'guest' || fresh.own_keys <= 0 || fresh.limit === null || (fresh.limit.enforced && fresh.limit.enforced_by !== 'own')) return fail('An own-key monthly total cannot be changed until its own-key scope is confirmed. Your host controls any guest allowance.')
        if (fresh.limit.enforced_by !== 'own' || fresh.limit.limit_usd !== monthly || !fresh.limit.enforced) {
          await limitRequest(() => dispatchOwnLimit(r, monthly, (send) => op.write(send), fresh, pathOf(own)))
          const sampled = sampleLimits()
          const confirmed = await limitRequest(() => r.host.setup())
          const pending = acceptLimitRead(r, sampled, confirmed)
          patch(r.id, (x) => ({ facts: { ...x.facts, ownKeys: confirmed.own_keys, limit: confirmed.limit }, limit: { ...x.limit, ...pending }, u1: { ...x.u1!, ...pending } }))
          if (pending.limitUncertain || !confirmed.limit?.enforced || confirmed.limit.enforced_by !== 'own' || confirmed.limit.limit_usd !== monthly) return fail('The monthly-total change could not be confirmed. It may have been saved; nothing was woken. Read it again.')
          limitSaved = true
        }
      }
      const how = shape.how === null ? null : cleanWords(shape.how, ASK_HOW_MAX) ?? ''
      const mind = await saveAskObserved(r.host, mindId, { name, how }, (send) => op.write(send), (saves) => {
        if (op.current()) patch(r.id, (x) => ({ u1: { ...x.u1!, saves } }))
      }, limitSaved)
      if (!op.current()) return
      patch(r.id, (x) => ({ facts: { ...x.facts, mind, askSaved: true, askHow: how ?? x.facts.askHow }, u1: { ...x.u1!, profileSaved: true } }))
      const postedAt = Date.now()
      const existing = await op.write(() => r.host.helloGet())
      if (existing && existing.mind.id !== mindId) throw new FlRefusal(409, 'mind_changed', 'The recorded greeting is for a changed omega. Read it again.')
      if (existing && (existing.state === 'greeted' || !existing.retryable || !r.u1.wakeUnknown)) {
        patch(r.id, (x) => ({ hello: { ...x.hello, hello: existing, postedAt, at: postedAt, busy: false }, u1: { ...x.u1!, phase: 'waiting', wakeUnknown: existing.retryable } }))
        setBeat(r.id, 'ask', 'ready', 'Your profile choices were recorded.')
        if (existing.state === 'greeted' && existing.greeting) greeted(r.id, existing)
        else startPoll(r.id)
        return
      }
      patch(r.id, (x) => ({ hello: { ...x.hello, postedAt, at: postedAt, busy: true, refusal: null }, u1: { ...x.u1!, phase: 'waiting' } }))
      wakeSent = true
      const hello = await op.write(() => r.host.helloWake())
      if (hello.mind.id !== mindId) throw new FlRefusal(409, 'mind_changed', 'The Wake result is for a changed omega. Read it again before continuing.')
      patch(r.id, (x) => ({ hello: { ...x.hello, hello, busy: false, at: Date.now() }, u1: { ...x.u1!, wakeUnknown: hello.retryable } }))
      setBeat(r.id, 'ask', 'ready', 'Your profile choices were recorded.')
      if (hello.state === 'greeted' && hello.greeting) greeted(r.id, hello)
      else startPoll(r.id)
    } catch (e) {
      if (!stopped(e)) {
        const x = asRefusal(e)
        if (x.code === 'mind_changed' && live(r.id)?.token === attemptToken) {
          patch(r.id, (y) => ({ u1: { ...y.u1!, context: 'unavailable', model: null } }))
        }
        // A later greeting/Wake failure still reads back the already-saved
        // profile, as U1 did before the shared per-write observer was extracted.
        if (op.current() && live(r.id)?.u1?.profileSaved && r.host.profile) {
          try {
            const profile = await op.write(() => r.host.profile!(mindId))
            if (profile.id === mindId && typeof profile.name === 'string' && typeof profile.persona === 'string') {
              patch(r.id, (y) => ({ u1: { ...y.u1!, saves: y.u1!.saves ? { ...y.u1!.saves, readback: { name: profile.name, purpose: profile.persona } } : undefined } }))
            }
          } catch { /* A missing readback proves neither rollback nor success. */ }
        }
        const current = live(r.id)
        const reason = limitProjection(r.host).limitUncertain || x.code === 'limit_unconfirmed' ? UNKNOWN_LIMIT : refusalSentence(x.code, { path: current?.path ?? r.path, host: current?.facts.host ?? r.facts.host, limit: current?.facts.limit ?? r.facts.limit, fallback: x.message })
        if (live(r.id)?.token === attemptToken && op.current()) {
          patch(r.id, (y) => ({ u1: { ...y.u1!, wakeUnknown: y.u1!.wakeUnknown || wakeSent } }))
          fail(wakeSent ? unknownChargeCopy(live(r.id)?.facts.mind?.name ?? name) : !current?.u1?.profileSaved && current?.u1?.saves ? profileSaveCopy(current.u1.saves) : reason)
        }
      } else if (live(r.id)?.token === attemptToken) fail('Stopped before completion. Earlier changes may already be saved; read the current state before trying again.')
    } finally {
      patch(r.id, (x) => x.token === attemptToken ? ({ u1: { ...x.u1!, busy: false, limitChecking: false } }) : {})
    }
  }

  return {
    run: null,
    wakeSingleScreen,
    async finishSingleScreen() { const r = live(get().run?.id ?? -1); if (r) await completeSingle(r.id) },

    async start(o) {
      const h = o.host ? { host: o.host, mode: o.host.kind, persona: o.persona ?? null } : hostFor(o)
      if (!h) return false
      const prev = get().run
      if (prev && prev.status !== 'ended') end(prev, 'ended')
      const bind = bindEpoch()
      const id = ++seq
      const run: Run = {
        id, mode: h.mode, persona: h.persona, host: h.host, bind, path: 'owner', steps: [], i: 0, status: 'loading', token: 1,
        facts: noFacts(), beats: freshBeats(), progress: null, notice: null,
        hello: { hello: null, postedAt: null, refusal: null, busy: false, at: Date.now() },
        ask: { busy: false, sent: null, error: null, choosing: false }, limit: { busy: false, error: null, other: false },
        askForm: { busy: false, error: null }, loadError: null, from: typeof window !== 'undefined' ? window.location.hash || '#/' : '#/', lookAtStart: null, galleryOpened: false,
        ...(h.mode === 'demo' && o.look ? { demoLook: o.look } : {}),
        ...(h.mode === 'live' && o.singleScreen ? { u1: { context: 'reading' as const, model: null, busy: false, phase: 'editing' as const, error: null, profileSaved: false } } : {}),
      }
      set({ run })
      await load(id, o)
      return true
    },

    next() {
      const r = get().run
      if (!r || r.status === 'ended' || r.status === 'loading') return
      const step = r.steps[r.i]
      // a step that waits for the person moves on only by their own act (a choice, a keep, Wake) or Later
      if (waitsForPerson(step) && step?.wait?.for !== 'first-answer') return
      if (step?.wait?.for === 'first-answer' && !r.facts.greeted) return
      enter(r.id, nextOr(r))
    },
    back() {
      const r = get().run
      if (!r || r.status === 'ended' || r.status === 'loading') return
      const j = prevIndex(r.steps, r.i, factsOf(r))
      if (j !== r.i && r.steps[j].beat === r.steps[r.i].beat) enter(r.id, j)
      else if (j !== r.i) {
        // back into an earlier beat: it is played again from its first step (its earlier result is kept until then)
        const b = r.steps[j].beat
        const at = startOf(r.steps, b, factsOf(r))
        patch(r.id, (x) => ({ beats: { ...x.beats, [b]: { state: 'active', line: null } } }))
        const rr = live(r.id)
        if (rr) enter(rr.id, at < 0 ? j : at)
      }
    },
    toggle() {
      const r = get().run
      if (!r || (r.status !== 'playing' && r.status !== 'paused')) return
      if (r.u1 && r.status === 'playing') stopPoll()
      set({ run: { ...r, status: r.status === 'paused' ? 'playing' : 'paused', token: r.token + 1, ...(r.status === 'playing' ? { limit: { ...r.limit, busy: false, error: r.limit.limitUncertain ? UNKNOWN_LIMIT : r.limit.error } } : {}), ...(r.u1 && r.status === 'playing' ? { u1: { ...r.u1, busy: false, limitChecking: false, phase: r.facts.greeted ? 'greeted' as const : 'editing' as const, completion: r.u1.completion === 'saving' ? 'unknown' as const : r.u1.completion, completionToken: undefined, error: 'Paused. Earlier changes or a Wake request may already be in progress; read the current state before trying again.' } } : {}) } })
    },
    stop() {
      const r = get().run
      if (!r) return
      if (r.status === 'ended') return set({ run: null })
      end(r, 'ended')
      set({ run: null })
    },
    notNow() {
      const r = get().run
      if (!r) return
      const host = r.host
      const write = r.mode === 'live' && host.kind === 'live'
      get().stop()
      if (!write) return
      // bound to the sign-in it began under (a different person signing in sends nothing); after any progress write
      // already queued (a completion in flight lands first, and a finished record is then left as it is)
      const op = bindOperation()
      saving = saving.then(async () => {
        try {
          let p = await op.write(() => host.progress())
          for (let tries = 0; tries < 2 && p.status !== 'finished' && p.status !== 'skipped'; tries++) {
            try {
              p = await op.write(() => host.writeProgress({ status: 'skipped' }, p.version))
            } catch (e) {
              if (stopped(e)) return
              const x = asRefusal(e)
              const current = x.code === 'stale_onboarding' ? readProgress(x.current) : null
              if (!current) return
              p = current
            }
          }
        } catch {
          /* not recorded: First Light may offer itself again on the landing; nothing else is affected */
        }
      })
    },

    async choose(value) {
      const r = get().run
      if (!r || r.status === 'ended' || r.status === 'loading') return
      const step = r.steps[r.i]
      if (step?.wait?.for !== 'choice') return
      if (step.wait.field === 'role') {
        const role = String(value) as Progress['role_path']
        if (role === 'admin' && r.path !== 'owner') return
        setBeat(r.id, 'arrive', 'ready', BEAT_LINES.arrive.ready)
        void record(r.id, 'arrive', 'done', { role_path: role })
        const rr = live(r.id)
        if (rr) enter(rr.id, nextOr(rr))
        return
      }
      if (value === 'other') return patch(r.id, (x) => ({ limit: { ...x.limit, other: true, error: null } }))
      const amount = Number(value)
      if (!Number.isFinite(amount) || amount < 0 || amount > 10000) return patch(r.id, (x) => ({ limit: { ...x.limit, error: refusalSentence('bad_limit', { path: r.path, host: r.facts.host }) } }))
      await setMonthly(r.id, Math.round(amount * 100) / 100)
    },

    skipBeat() {
      const r = get().run
      if (!r || r.status === 'ended' || r.status === 'loading') return
      const beat = r.steps[r.i]?.beat
      if (!beat) return
      const line = beat === 'arrive' ? BEAT_LINES.arrive.skipped : beat === 'look' ? BEAT_LINES.look.skipped : beat === 'models' ? (r.path === 'owner' && r.facts.ownKeys <= 0 ? BEAT_LINES.models.skipped : 'Later.') : beat === 'apps' ? BEAT_LINES.apps.skipped : beat === 'ask' ? BEAT_LINES.ask.skipped : BEAT_LINES.hello.skipped
      setBeat(r.id, beat, 'skipped', line)
      void record(r.id, beat, 'skipped', beat === 'arrive' ? { role_path: 'explorer' } : {})
      if (beat === 'hello') stopPoll()
      const rr = live(r.id)
      if (!rr) return
      const j = afterBeat(rr.steps, rr.i, factsOf(rr))
      if (j < 0) finish(rr.id)
      else enter(rr.id, j)
    },

    keepCurrent() {
      const r = get().run
      if (!r || r.steps[r.i]?.wait?.for !== 'look') return
      get().skipBeat()
    },

    async checkKey() {
      const r = get().run
      if (!r) return
      await refreshSetup(r.id)
      const rr = live(r.id)
      if (rr && rr.steps[rr.i]?.wait?.for === 'key' && rr.facts.ownKeys > 0) enter(rr.id, nextOr(rr))
    },

    askChoosing(open) {
      const r = get().run
      if (!r || r.status === 'ended' || r.ask.choosing === open) return
      patch(r.id, (x) => ({ ask: { ...x.ask, choosing: open } }))
    },

    async askForMore(amount) {
      const r = get().run
      if (!r || r.path !== 'guest' || r.ask.busy) return
      patch(r.id, (x) => ({ ask: { ...x.ask, busy: true, error: null } }))
      try {
        const req = await r.host.askForMore(amount)
        patch(r.id, (x) => ({ ask: { ...x.ask, busy: false, sent: { amount: req.amount_usd }, error: null, choosing: false } }))
      } catch (e) {
        if (stopped(e)) return
        const x = asRefusal(e)
        patch(r.id, (rr) => ({ ask: { ...rr.ask, busy: false, error: refusalSentence(x.code, { path: rr.path, host: rr.facts.host, fallback: x.message }) } }))
      }
      await refreshSetup(r.id)
    },

    async wake() {
      const r = get().run
      if (!r || r.status === 'ended' || r.hello.busy) return
      const step = r.steps[r.i]
      if (step?.beat !== 'hello') return
      const pending = limitProjection(r.host)
      projectLimit(r.id, pending)
      if (pending.limitUncertain) {
        patch(r.id, (x) => ({ hello: { ...x.hello, busy: false, refusal: { code: 'limit_unconfirmed', sentence: UNKNOWN_LIMIT } } }))
        return
      }
      const postedAt = Date.now()
      patch(r.id, (x) => ({ hello: { ...x.hello, busy: true, refusal: null, postedAt, at: postedAt } }))
      try {
        const op = bindOperation(() => live(r.id) !== null)
        const h = await op.write(() => r.host.helloWake())
        const rr = live(r.id)
        if (!rr) return
        if (h.state === 'greeted' && h.greeting) return greeted(r.id, h)
        patch(r.id, (x) => ({ hello: { ...x.hello, hello: h, busy: false, at: Date.now() } }))
        // on to "the mind, in its own words" (it shows what the host says, and nothing until it says it)
        const at = rr.steps.findIndex((s) => s.wait?.for === 'first-answer')
        if (at >= 0 && rr.i !== at) enter(r.id, at)
        startPoll(r.id)
      } catch (e) {
        if (stopped(e)) return
        const x = e instanceof FlRefusal ? e : asRefusal(e)
        const rr = live(r.id)
        if (!rr) return
        const sentence = refusalSentence(x.code, { path: rr.path, host: rr.facts.host, limit: rr.facts.limit, fallback: x.message })
        // no greeting is shown or said while the mind can't answer: the beat is blocked, with the reason
        patch(r.id, (y) => ({ hello: { ...y.hello, busy: false, refusal: { code: x.code, sentence }, hello: null, postedAt: null, at: Date.now() } }))
        setBeat(r.id, 'hello', 'blocked', sentence)
      }
    },

    async reload() {
      const r = get().run
      if (!r) return
      await load(r.id, { mode: r.mode, persona: r.persona ?? undefined })
    },

    goBeat(beat) {
      const r = get().run
      if (!r || r.status === 'ended' || r.status === 'loading') return
      const at = startOf(r.steps, beat, factsOf(r))
      if (at < 0) return
      patch(r.id, (x) => ({ beats: { ...x.beats, [beat]: { state: 'active', line: null } }, status: 'playing' }))
      enter(r.id, at)
    },

    appsNext() {
      const r = get().run
      if (!r || r.status === 'ended' || r.steps[r.i]?.wait?.for !== 'apps') return
      enter(r.id, nextOr(r))
    },

    openApp(appId) {
      const r = get().run
      if (!r || r.status === 'ended' || r.status === 'loading') return
      const app = r.facts.apps?.find((a) => a.id === appId)
      if (!app) return
      // beat 5 is done (the person opened one); the journey pauses here and picks up at Your Ask when they come back
      setBeat(r.id, 'apps', 'ready', `${app.name} is ready for you.`)
      void record(r.id, 'apps', 'done')
      const rr = live(r.id)
      if (!rr) return
      const j = afterBeat(rr.steps, rr.i, factsOf(rr))
      if (j >= 0) enter(rr.id, j)
      const r2 = live(r.id)
      if (r2) set({ run: { ...r2, status: 'paused', token: r2.token + 1 } })
      if (r.mode === 'live') screen.act({ go: { name: 'program', id: app.id } })
    },

    async saveAsk(shape) {
      const r = get().run
      if (!r || r.status === 'ended' || r.askForm.busy || r.steps[r.i]?.wait?.for !== 'ask') return
      const name = cleanWords(shape.name, ASK_NAME_MAX)
      if (!name) return patch(r.id, (x) => ({ askForm: { ...x.askForm, error: 'Give it a name first.' } }))
      // how: an intentional edit or an explicitly saved known-empty default (FirstLightLayer askToSave).
      const how = shape.how === null ? null : cleanWords(shape.how, ASK_HOW_MAX) ?? ''
      const mindId = r.facts.mind?.id
      if (!mindId) return patch(r.id, (x) => ({ askForm: { ...x.askForm, error: BEAT_LINES.ask.noMind } }))
      patch(r.id, () => ({ askForm: { busy: true, error: null, saves: undefined } }))
      const op = bindOperation(() => live(r.id) !== null)
      try {
        const mind = await saveAskObserved(r.host, mindId, { name, how }, (send) => op.write(send), (saves) => {
          if (op.current()) patch(r.id, (x) => ({ askForm: { ...x.askForm, saves } }))
        })
        if (!op.current()) return
        patch(r.id, (x) => ({ askForm: { ...x.askForm, busy: false, error: null }, facts: { ...x.facts, mind: { ...mind }, askSaved: true, askHow: how ?? x.facts.askHow } }))
      } catch (e) {
        if (stopped(e) || !op.current()) return
        const x = asRefusal(e)
        return patch(r.id, (rr) => ({ askForm: { ...rr.askForm, busy: false, error: rr.askForm.saves ? profileSaveCopy(rr.askForm.saves) : refusalSentence(x.code, { path: rr.path, host: rr.facts.host, fallback: x.message }) } }))
      }
      setBeat(r.id, 'ask', 'ready', `Your Ask is ${name}.`)
      void record(r.id, 'ask', 'done')
      const rr = live(r.id)
      if (rr) enter(rr.id, nextOr(rr))
    },

    async thinkWith(model) {
      const r = get().run
      const u = r?.u1
      const mindId = r?.facts.mind?.id
      if (!r || !u || !mindId || r.mode !== 'live' || r.path !== 'owner' || r.status !== 'playing' || u.busy || u.phase !== 'editing' || !r.host.useModel) return
      patch(r.id, (x) => ({ u1: { ...x.u1!, busy: true, error: null } }))
      const op = bindOperation(() => { const x = live(r.id); return !!x && x.status === 'playing' && x.facts.mind?.id === mindId })
      try {
        const now = await r.host.useModel(mindId, model, (send) => op.write(send))
        if (!op.current()) return
        patch(r.id, (x) => ({ u1: { ...x.u1!, busy: false, context: 'known', model: now, error: null } }))
      } catch (e) {
        if (stopped(e) || !op.current()) return
        const x = asRefusal(e)
        patch(r.id, (rr) => ({ u1: { ...rr.u1!, busy: false, error: refusalSentence(x.code, { path: rr.path, host: rr.facts.host, fallback: x.message || 'Your plan could not be chosen. Nothing changed.' }) } }))
      }
    },

    async demoSaveAsk() {
      const r = get().run
      if (!r || r.mode !== 'demo' || !(r.host instanceof DemoHost)) return
      await get().saveAsk(r.host.who.ask)
    },

    startTalking() {
      const r = get().run
      if (!r || r.status === 'ended') return
      const app = startApp(r.facts.apps)
      finish(r.id)
      // live only: the simulator's invented app opens nothing
      if (app && r.mode === 'live') screen.act({ go: { name: 'program', id: app.id } })
    },

    async demoAddKey() {
      const r = get().run
      if (!r || r.mode !== 'demo' || !(r.host instanceof DemoHost)) return
      r.host.addKey()
      await get().checkKey()
    },

    demoKeepLook() {
      const r = get().run
      if (!r || r.mode !== 'demo' || r.steps[r.i]?.wait?.for !== 'look') return
      const want = r.demoLook ?? (r.persona ? (r.host as DemoHost).who.look : 'classic')
      const offered = EXPERIENCES.find((e) => e.id === want)
      const before = r.previewBefore ?? { p: lookState().preview }
      if (offered && offered.id !== 'classic') previewLook(withExperience(lookState().saved, offered.id))
      else if (offered) previewLook(withExperience(lookState().saved, null))
      const name = offered ? (offered.id === 'classic' ? 'Classic' : offered.name) : 'This look'
      patch(r.id, (x) => ({ previewBefore: before, facts: { ...x.facts, lookKept: true, lookName: name } }))
      setBeat(r.id, 'look', 'ready', `${BEAT_LINES.look.ready} (simulated: only previewed here)`)
      void record(r.id, 'look', 'done')
      const rr = live(r.id)
      if (rr) enter(rr.id, nextOr(rr))
    },
  }

  // ---------------------------------------------------------------- loading

  async function load(id: number, o: StartOpts) {
    const r = live(id)
    if (!r) return
    const token = r.u1 ? r.token + 1 : r.token
    const op = bindOperation(() => { const x = live(id); return !!x && (!r.u1 || x.token === token) })
    const sampledLimits = sampleLimits()
    patch(id, (x) => ({ status: 'loading', loadError: null, ...(r.u1 ? { token, u1: { ...x.u1!, busy: false, limitChecking: false, completion: x.u1!.completion === 'saving' ? 'unknown' as const : x.u1!.completion, completionToken: undefined } } : {}) }))
    try {
      const [progress, setup, own, name, mind, apps] = await op.write(() => Promise.all([r.host.progress(), r.host.setup(), r.host.own(), r.host.personName(), r.host.mind().catch(() => null), r.host.apps().catch(() => null)]))
      const path = pathOf(own)
      const steps = stepsFor(path)
      const host = path === 'guest' ? setup.limit?.host_name ?? own.owner_name ?? 'your host' : own.owner_name ?? 'this hive’s owner'
      const others = r.host.otherMinds(mind?.id ?? null)
      // the demo points at the simulator's own personal mind on the hive behind (its figure); live, at theirs
      let onScreen = mind?.id ?? null
      if (r.mode === 'demo') {
        const c = useHive.getState().client as { myMind?: () => Promise<unknown> } | null
        const v = c?.myMind ? await c.myMind().catch(() => null) : null
        const m = v && typeof v === 'object' ? (v as { mind?: { id?: unknown } }).mind : null
        onScreen = typeof m?.id === 'string' ? m.id : null
      }
      const rr = live(id)
      if (!rr || !op.current()) return
      const beats = rr.mode === 'live' ? beatsFromRecord(progress.beats_done, progress.beats_skipped) : freshBeats()
      const facts: FlFacts = { ...noFacts(), name: firstName(name), host, ownKeys: setup.own_keys, limit: setup.limit, onlyMind: others === null ? null : others === 0, mind, mindOnScreen: onScreen, apps }
      const pending = acceptLimitRead(rr, sampledLimits, setup)
      rr.bind.commit(() => set({ run: { ...rr, path, steps, facts, beats, progress, limit: { ...rr.limit, ...pending }, status: 'playing', i: 0, ...(rr.u1 ? { u1: { ...rr.u1, ...pending } } : {}) } }))
      if (rr.u1) {
        patch(id, (x) => ({ i: -1, u1: { ...x.u1!, context: 'reading', model: null, error: null, phase: 'editing', limitChecking: false } }))
        await readSingleProfile(id, token)
        return
      }
      // where to start: a beat asked for, else where the record left off (live), else the beginning
      const asked = (R2_BEATS as readonly string[]).includes(o.beat ?? '') ? (o.beat as Beat) : null
      const notice = o.beat && !asked ? 'That part of First Light comes in a later version; here is what is ready now.' : null
      const run2 = live(id)!
      if (rr.mode === 'demo' && (o.step || asked)) await primeDemo(id, o.step ? stepBeat(run2.steps, o.step) : asked!, o.step).catch((e: unknown) => { if (!stopped(e)) throw e })
      const run3 = live(id)
      if (!run3) return
      const f = factsOf(run3)
      let at = 0
      if (rr.mode === 'demo' && o.step) at = Math.max(0, run3.steps.findIndex((s) => s.id === o.step))
      else if (asked) at = Math.max(0, startOf(run3.steps, asked, f))
      else if (rr.mode === 'live' && progress.status === 'in_progress') at = Math.max(0, startOf(run3.steps, resumeBeat(progress.current_beat, run3.beats), f))
      if (notice) patch(id, () => ({ notice }))
      if (rr.mode === 'demo' && o.paused) patch(id, () => ({ status: 'paused' }))
      patch(id, () => ({ i: -1 }))
      enter(id, at)
    } catch (e) {
      if (!op.current() || stopped(e)) return
      const x = asRefusal(e)
      // what went wrong, for whoever looks (the person sees the plain line below)
      if (!(e instanceof FlRefusal)) console.warn('First Light could not start:', e)
      const rr = live(id)
      if (!rr) return
      const line = x.code === 'person_required' ? 'First Light needs a signed-in person with an account here.' : BEAT_LINES.arrive.blocked
      rr.bind.commit(() => set({ run: { ...rr, status: 'playing', loadError: line, beats: { ...rr.beats, arrive: { state: 'blocked', line } } } }))
    }
  }

  function stepBeat(steps: FlStep[], id: string): Beat {
    return steps.find((s) => s.id === id)?.beat ?? 'arrive'
  }

  /** Demo only: play the invented newcomer's earlier beats at once (the render smoke opens a beat directly). */
  async function primeDemo(id: number, beat: Beat, stepId?: string) {
    const r = live(id)
    if (!r || !(r.host instanceof DemoHost)) return
    const host = r.host
    const who = host.who
    const op = bindOperation(() => live(id) !== null)
    // a step after its beat's own choice (3.6 after 3.4, 2.3 after 2.2): that beat's choice is played first too
    const at = stepId ? r.steps.findIndex((s) => s.id === stepId) : -1
    const pastChoice = at > 0 && r.steps.slice(0, at).some((s) => s.beat === beat && waitsForPerson(s))
    const order = R2_BEATS.indexOf(beat) + (pastChoice ? 1 : 0)
    if (order > 0) {
      setBeat(id, 'arrive', 'ready', BEAT_LINES.arrive.ready)
      await op.write(() => host.writeProgress({ role_path: who.role, beats_done: ['arrive'] }, 0))
    }
    if (order > 1) {
      const want = r.demoLook ?? who.look
      const offered = EXPERIENCES.find((e) => e.id === want)
      const name = offered ? (offered.id === 'classic' ? 'Classic' : offered.name) : null
      setBeat(id, 'look', 'ready', `${BEAT_LINES.look.ready} (simulated: only previewed here)`)
      patch(id, (x) => ({ facts: { ...x.facts, lookKept: true, lookName: name } }))
    }
    if (order > 2) {
      if (who.path === 'owner') {
        host.addKey()
        await op.write(() => host.setOwnLimit(who.monthly ?? 20))
      }
      await refreshSetup(id)
      const rr = live(id)
      if (rr && !pastChoice) setBeat(id, 'models', 'ready', who.path === 'guest' ? `Your limit here: ${cents(who.inviteLimit ?? 0)} a month, on ${who.host}’s key.` : `Your key is in. ${limitLine(rr.facts.limit, whoOf(rr))}`)
    }
    if (order > 3) setBeat(id, 'apps', 'ready', `${DEMO_APPS[0].name} is ready for you.`)
    if (order > 4) {
      const mind = await host.saveAsk(host.mindRef.id, who.ask, (send) => op.write(send))
      patch(id, (x) => ({ facts: { ...x.facts, mind, askSaved: true, askHow: who.ask.how } }))
      setBeat(id, 'ask', 'ready', `Your Ask is ${who.ask.name}.`)
    }
    const p = await host.progress()
    patch(id, () => ({ progress: p }))
  }
})

/** The nearest screen move at or before step `to`, within its beat (a read or harmless UI: safe to do again). */
function actionBefore(steps: readonly FlStep[], to: number): FlStep['do'] {
  for (let j = to; j >= 0 && steps[j].beat === steps[to].beat; j--) if (steps[j].do) return steps[j].do
  return undefined
}

/** The record's beats over what is on screen (a 409 shows where the journey stands now). */
function mergeRecord(b: Beats, p: Progress): Beats {
  const rec = beatsFromRecord(p.beats_done, p.beats_skipped)
  const out = { ...b }
  for (const id of R2_BEATS) if (rec[id].state !== 'pending') out[id] = rec[id]
  return out
}

subscribeLook(() => lookChanged())

/** A change of person clears the journey at once. Private quarantined intents stay
 * keyed by stable host/principal, never by the replaceable epoch/client wrapper. */
onIdentityChange(() => {
  const r = useFirstLight.getState().run
  if (!r) return
  if (r.galleryOpened) screen.gallery(false)
  if (r.previewBefore) previewLook(null)
  useFirstLight.setState({ run: null })
})

/** How the hello reads now (the layer re-works it each second while waiting). */
export const helloNow = (r: Run): { hello: Hello | null; postedAt: number | null; now: number } => ({ hello: r.hello.hello, postedAt: r.hello.postedAt, now: r.hello.at })

export { TRANSIENT_MS }
