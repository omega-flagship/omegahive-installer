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
import { ASK_HOW_MAX, ASK_NAME_MAX, BLANK_PROGRESS, FlRefusal, asRefusal, cleanWords, firstName, liveHost, readProgress, startApp, type AppRef, type AskShape, type FlClient, type FlHost, type Hello, type MindRef, type MonthlyLimit, type Progress, type ProgressWrite } from './host'
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
  limit: { busy: boolean; error: string | null; other: boolean }
  /** R3 beat 6: saving the Ask */
  askForm: { busy: boolean; error: string | null }
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
  /** demo: the newcomer describes their Ask */
  demoSaveAsk(): Promise<void>
  /** R3 hand-off: open the app to talk in, and end First Light */
  startTalking(): void
}

let seq = 0
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
  const save = (id: number, w: (p: Progress) => ProgressWrite) => {
    saving = saving.then(async () => {
      const r = live(id)
      if (!r) return
      const base = r.progress ?? BLANK_PROGRESS
      // followups-r8 (Kimi FL-R2 #1): the write is a bound operation, checked right before it is sent and on its answer
      const op = bindOperation(() => live(id) !== null)
      try {
        const p = await op.write(() => r.host.writeProgress(w(base), base.version))
        patch(id, () => ({ progress: p }))
      } catch (e) {
        if (stopped(e)) return
        const x = asRefusal(e)
        const current = x.code === 'stale_onboarding' ? readProgress(x.current) : null
        if (current) patch(id, (rr) => ({ progress: current, notice: refusalSentence('stale_onboarding', { path: rr.path, host: rr.facts.host }), beats: mergeRecord(rr.beats, current) }))
        else patch(id, () => ({ notice: 'Your progress couldn’t be saved just now, so it’s only on this screen. Nothing else is affected.' }))
      }
    })
    return saving
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
      const s = await r.host.setup()
      patch(id, (rr) => ({ facts: { ...rr.facts, ownKeys: s.own_keys, limit: s.limit, host: rr.path === 'guest' ? s.limit?.host_name ?? rr.facts.host : rr.facts.host } }))
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

  /** R3 beat 6: the persona the person's own mind has now, so the form starts from it (a failed read starts empty). */
  async function readAskHow(id: number) {
    const r = live(id)
    const mindId = r?.facts.mind?.id
    if (!r || !mindId) return
    const how = await r.host.askHow(mindId).catch(() => '')
    patch(id, (x) => ({ facts: { ...x.facts, askHow: x.facts.askHow ?? how } }))
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
    patch(id, (r) => ({ facts: { ...r.facts, greeted: true }, hello: { ...r.hello, hello: h, at: Date.now(), busy: false } }))
    setBeat(id, 'hello', 'ready', 'Your mind is awake, and it said hello.')
    void refreshSetup(id)
    const r = live(id)
    if (!r) return
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
      const op = bindOperation(() => live(id) !== null)
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
    if (!r) return
    patch(id, (x) => ({ limit: { ...x.limit, busy: true, error: null, other: false } }))
    let error: string | null = null
    // followups-r8 (Kimi FL-R2 #1): the limit and the progress after it are one operation, each write bound (save binds
    // its own): checked right before it is sent, so nothing is sent for this run once the person or run changed
    const op = bindOperation(() => live(id) !== null)
    if (r.facts.ownKeys > 0) {
      try {
        await op.write(() => r.host.setOwnLimit(amount))
      } catch (e) {
        if (stopped(e)) return
        const x = asRefusal(e)
        error = refusalSentence(x.code, { path: r.path, host: r.facts.host, fallback: x.message })
      }
    }
    if (!live(id)) return
    await save(id, () => ({ monthly_spend_usd: amount, ...(r.facts.ownKeys > 0 ? { key_choice: 'own-key' as const } : {}) }))
    await refreshSetup(id)
    patch(id, (x) => ({ limit: { ...x.limit, busy: false, error } }))
    const rr = live(id)
    if (!rr) return
    // the chosen amount is what the person said; the limit named next is only what the host enforces
    patch(id, (x) => ({ facts: { ...x.facts, limit: x.facts.limit ? { ...x.facts.limit, chosen_usd: amount } : { done: false, enforced: false, enforced_by: null, limit_usd: null, spent_usd: null, chosen_usd: amount, host_name: null, pending_request: null } } }))
    // a key of their own, but the host refused the limit: they stay at the choice, with the reason, to try again
    if (error) return
    const after = live(id)
    if (after) enter(id, nextOr(after))
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

  return {
    run: null,

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
      set({ run: { ...r, status: r.status === 'paused' ? 'playing' : 'paused', token: r.token + 1 } })
    },
    stop() {
      const r = get().run
      if (!r) return
      if (r.status === 'ended') return set({ run: null })
      end(r, 'ended')
      set({ run: null })
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
      // how: null unless the person edited the field (FirstLightLayer askToSave); never derived from what was read
      const how = shape.how === null ? null : cleanWords(shape.how, ASK_HOW_MAX) ?? ''
      const mindId = r.facts.mind?.id
      if (!mindId) return patch(r.id, (x) => ({ askForm: { ...x.askForm, error: BEAT_LINES.ask.noMind } }))
      patch(r.id, () => ({ askForm: { busy: true, error: null } }))
      const op = bindOperation(() => live(r.id) !== null)
      try {
        const mind = await r.host.saveAsk(mindId, { name, how }, (send) => op.write(send))
        patch(r.id, (x) => ({ askForm: { busy: false, error: null }, facts: { ...x.facts, mind: { ...mind }, askSaved: true, askHow: how ?? x.facts.askHow } }))
      } catch (e) {
        if (stopped(e)) return
        const x = asRefusal(e)
        return patch(r.id, (rr) => ({ askForm: { busy: false, error: refusalSentence(x.code, { path: rr.path, host: rr.facts.host, fallback: x.message }) } }))
      }
      setBeat(r.id, 'ask', 'ready', `Your Ask is ${name}.`)
      void record(r.id, 'ask', 'done')
      const rr = live(r.id)
      if (rr) enter(rr.id, nextOr(rr))
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
    patch(id, () => ({ status: 'loading', loadError: null }))
    try {
      const [progress, setup, own, name, mind, apps] = await Promise.all([r.host.progress(), r.host.setup(), r.host.own(), r.host.personName(), r.host.mind().catch(() => null), r.host.apps().catch(() => null)])
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
      if (!rr) return
      const beats = rr.mode === 'live' ? beatsFromRecord(progress.beats_done, progress.beats_skipped) : freshBeats()
      const facts: FlFacts = { ...noFacts(), name: firstName(name), host, ownKeys: setup.own_keys, limit: setup.limit, onlyMind: others === null ? null : others === 0, mind, mindOnScreen: onScreen, apps }
      rr.bind.commit(() => set({ run: { ...rr, path, steps, facts, beats, progress, status: 'playing', i: 0 } }))
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

/** A change of person: the journey is gone at once, before anything renders the new person. */
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
