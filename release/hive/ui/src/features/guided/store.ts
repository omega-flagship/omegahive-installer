/**
 * The guided demo now playing (or the honest answer for a demo that is not built yet). One at a time, fenced like
 * the Ask: it runs under the Ask origin it started in (store/ask askOrigin: client, store session, init count,
 * principal, sign-in and Ask epoch). When that no longer holds (someone else signs in, the session changes, the Ask
 * thread is reset) the demo ends at once and shows nothing more.
 *
 * Whatever the demo opened for show (an experience preview, the Change UI gallery, search, help,
 * a menu) is put back when it ends. Pages it moved to stay where they are; "Back to where you were" returns.
 *
 * Identity (lib/identityEpoch, stand-in r1 P1 x2): every run is also bound to the identity epoch it started under, and
 * a change of person clears it synchronously (onIdentityChange), whatever its status: a finished or stopped demo's
 * transcript (swarm names, belief text) is gone before anyone sees the new person. What the demo captured to put back
 * (the earlier person's preview, a menu it pressed) is DISCARDED then, never run: putting it back would show the
 * earlier person's look, or press the new person's controls. Only what the demo itself opened is closed (its preview,
 * the gallery, search, help). Every write after an await goes through the binding's commit().
 *
 * The person always wins over the conductor (stand-in r1 P2): every control they use (buttons, keys, typed words)
 * holds the conductor first (holdConductor), so its later tour.step acts are answered stale_origin, never replayed.
 */
import { plural } from '../../lib/plural'
import { create } from 'zustand'
import { bindEpoch, onIdentityChange, STALE, type EpochBinding } from '../../lib/identityEpoch'
import { parse } from '../../lib/router'
import { lookState, openGallery, previewLook, withExperience, type UiPrefs } from '../../shell/uiVariant'
import { askOrigin, moveAsMind, useAskStore, type AskOrigin } from '../../store/ask'
import { useHive } from '../../store/store'
import { placeReading, scrollerOf, startReflow, visibleBand, wholeShift, type ReadingPlacement, type ReadingRoom } from './reading'
import type { Box } from '../../tour/place'
import { useIntro } from '../../tour/introStore'
import { pick } from '../../tour/script'
import { bankedScript, loadBanked, TOOLS_APP } from './banked'
import { fill, findIn, playStep, TARGET_MS, type GuideEnv, type Picks } from './driver'
import { ThreadFold } from './play'
import { reduceGuide, startMachine, type GuideEvent, type GuideMachine } from './machine'
import { guideControl, type GuideControl, type GuideIntent } from './match'
import { scriptById } from './scripts'
import type { GuideScript } from './types'

export type GuideRun =
  | {
      kind: 'demo'
      id: number
      script: GuideScript
      m: GuideMachine
      origin: AskOrigin
      /** the identity epoch it started under */
      bind: EpochBinding
      /** where the person was when it started */
      from: string
      picks: Picks
      /** what was said, step by step (the thread card) */
      said: string[]
      /** the step's honest note, and whether its target was found */
      note: string | null
      found: boolean | null
      /** the Ask turn whose conductor placed it (tour.step), if any */
      op?: string
      /** guided-play: started from the Ask, it plays itself through with the demo cursor and marks (play.ts) */
      play?: boolean
    }
  | {
      kind: 'answer'
      id: number
      /** the stub asked about (null: a topic with no demo, or the list of demos) */
      script: GuideScript | null
      topic: string
      text: string
      near: GuideScript[]
      origin: AskOrigin
      bind: EpochBinding
    }

interface PlayOpts {
  origin?: AskOrigin
  /** the identity it was asked under (default: now) */
  bind?: EpochBinding
  auto?: boolean
  /** start at this step (the conductor's tour.step) */
  at?: number
  /** the Ask turn whose conductor plays it */
  op?: string
  /** guided-play: it plays itself through with the demo cursor and marks */
  play?: boolean
}

interface GuideState {
  run: GuideRun | null
  /** a demo the person asked for: a ready one plays (its steps read first when banked); otherwise an honest answer */
  start(intent: GuideIntent, opts: { you: string; where?: string; origin?: AskOrigin; auto?: boolean; note?: string }): Promise<boolean>
  /** play a script whose steps are known (prepared): a "nearest" offer, "show what exists today", a tour.step */
  play(script: GuideScript, opts?: PlayOpts): boolean
  send(e: GuideEvent): void
  control(c: GuideControl): boolean
  /** the step with this token has finished its action and wait */
  stepDone(token: number, r: { found: boolean; note: string | null }): void
  backToStart(): void
  close(): void
}

let seq = 0
/**
 * What the demo opened for show, and how to undo it:
 *  - `restore` puts back the person's own state captured before (their earlier preview, a menu it pressed). Only ever
 *    run for the same person it was captured for.
 *  - `drop` (optional) only closes what the demo itself opened, capturing nothing (no preview, gallery shut). Run
 *    instead when the person changed: nothing captured for the earlier person is put back, no control is pressed.
 */
interface Undo {
  restore: () => void
  drop?: () => void
}
const restores = new Map<string, Undo>()
/** the identity the captured state belongs to (set with the first capture) */
let restoresBind: EpochBinding | null = null
const capture = (key: string, undo: Undo) => {
  if (!restores.size) restoresBind = bindEpoch()
  restores.set(key, undo)
}
const quietly = (fn: () => void) => {
  try {
    fn()
  } catch {
    /* best effort: nothing it opened is consequential */
  }
}
/** Put back what the demo opened (the same person), or, if the person changed, discard it all (dropAll). */
const restoreAll = () => {
  if (restoresBind && !restoresBind.current()) return dropAll()
  const all = [...restores.values()]
  restores.clear()
  restoresBind = null
  for (const u of all) quietly(u.restore)
  before = undefined
}
/** Discard every captured restoration without running it; close only what the demo opened. */
function dropAll(): void {
  const all = [...restores.values()]
  restores.clear()
  restoresBind = null
  before = undefined
  for (const u of all) if (u.drop) quietly(u.drop)
}
/** when the demo last moved the page itself (its own moves are not the person taking over) */
export let selfMoveAt = 0

export function picksNow(): Picks {
  const s = useHive.getState()
  const p = pick(s)
  return { mind: p.dot ? { id: p.dot.id, name: p.dot.name } : null, swarm: p.swarm ? { id: p.swarm.id, name: p.swarm.name } : null, belief: p.belief?.statement ?? null }
}

export const listAnswer = 'These demos are ready. Say “show me how … works”, or pick one:'
export const unknownAnswer = (topic: string) => `I don’t have a guided demo for “${topic}” yet. Here are the nearest real ones:`

export const useGuide = create<GuideState>()((set, get) => {
  const end = () => restoreAll()
  return {
    run: null,

    async start(intent, { you, where, origin = askOrigin(), auto, note }) {
      const bind = bindEpoch()
      if (!origin.ok()) return false
      const ask = useAskStore.getState()
      if (intent.kind === 'script' && intent.script.status === 'ready') {
        const script = await prepare(intent.script)
        // after the await: the run and the thread row are written only if the same person is still here (one tick)
        const ok = bind.commit(() => {
          // guided-play: a demo asked for in the Ask plays itself through (auto-advance, the cursor and marks)
          if (!origin.ok() || !get().play(script, { origin, auto: auto ?? true, bind, play: true })) return false
          const a = useAskStore.getState()
          a.addLocal(you, `${note ? `${note} ` : ''}Guided demo: ${script.title} (${plural(script.steps.length, 'step')}). It plays by itself; click, scroll or press a key on the page to take over, or type here to pause it. Next, Back, Pause and Stop are below.`, { where, origin })
          a.setThreadOpen(true)
          return true
        })
        return ok === true
      }
      // not built yet, unknown, or "which demos are there": an honest answer, no screen moves
      get().close()
      const id = ++seq
      // the row in the thread is for words the person typed; a conductor's tour.step has its own turn row
      const say = (text: string) => void (you && ask.addLocal(you, text, { where, origin }))
      if (intent.kind === 'script') {
        const s = intent.script
        const near = (s.nearest ?? []).map(scriptById).filter((x): x is GuideScript => !!x && x.status === 'ready')
        set({ run: { kind: 'answer', id, script: s, topic: intent.topic, text: s.answer ?? `${s.title} is being built.`, near, origin, bind } })
        say(`${s.title}: no guided demo yet (${s.needs ?? 'being built'}). The honest answer is below.`)
      } else if (intent.kind === 'unknown') {
        set({ run: { kind: 'answer', id, script: null, topic: intent.topic, text: unknownAnswer(intent.topic), near: intent.near, origin, bind } })
        say(`No guided demo for “${intent.topic}” yet. The nearest ones are below.`)
      } else {
        set({ run: { kind: 'answer', id, script: null, topic: '', text: listAnswer, near: intent.near, origin, bind } })
        say(`${intent.near.length} guided demos are ready. They are listed below.`)
      }
      ask.setThreadOpen(true)
      return true
    },

    play(script, { origin = askOrigin(), bind = bindEpoch(), auto = false, at = 0, op, play } = {}) {
      if (!origin.ok() || !bind.current() || !script.steps.length) return false
      const cur = get().run
      const from = cur?.kind === 'demo' ? cur.from : window.location.hash || '#/'
      if (cur?.kind === 'demo') end()
      set({ run: { kind: 'demo', id: ++seq, script, m: startMachine(script.steps.length, auto, at), origin, bind, from, picks: picksNow(), said: [], note: null, found: null, ...(op ? { op } : {}), ...(play ? { play } : {}) } })
      return true
    },

    send(e) {
      const r = get().run
      if (r?.kind !== 'demo') return
      // fenced whatever its status (running, paused, finished or stopped): nothing of the demo stays
      if (e.type === 'fenced' || !r.origin.ok() || !r.bind.current()) {
        end()
        set({ run: null })
        return
      }
      const m = reduceGuide(r.m, e)
      if (m === r.m) return
      if (m.status === 'ended') end()
      // a step that starts again (back, resume, restart) is said again; its note and target are found again
      const restarted = m.token !== r.m.token && m.status === 'running'
      set({ run: { ...r, m, ...(restarted ? { note: null, found: null } : {}), ...(e.type === 'restart' ? { said: [], picks: picksNow() } : {}) } })
    },

    control(c) {
      const r = get().run
      if (r?.kind !== 'demo') return false
      if (c === 'stop' && r.m.status === 'ended') {
        get().close()
        return true
      }
      get().send({ type: c === 'resume' ? 'resume' : c })
      return true
    },

    stepDone(token, { found, note }) {
      const r = get().run
      if (r?.kind !== 'demo' || r.m.token !== token || r.m.status !== 'running') return
      if (!r.origin.ok() || !r.bind.current()) return get().send({ type: 'fenced' })
      const step = r.script.steps[r.m.step]
      const text = step ? fill(step.say, r.picks) : ''
      // a demo placed mid-way (tour.step) has said only the steps it showed; each stays at its own index
      const said = r.said.slice(0, r.m.step)
      said[r.m.step] = text
      set({ run: { ...r, m: reduceGuide(r.m, { type: 'ready', token }), said, found, note } })
    },

    backToStart() {
      const r = get().run
      if (r?.kind !== 'demo' || !r.origin.ok() || !r.bind.current()) return
      selfMoveAt = Date.now()
      moveAsMind(parse(r.from))
    },

    close() {
      end()
      set({ run: null })
    },
  }
})

/** The Ask's words while a demo plays: "next", "back", "stop"… control it. Returns true when they did. */
export function controlFromWords(text: string): boolean {
  const run = useGuide.getState().run
  if (!run) return false
  const c = guideControl(text)
  if (!c) return false
  if (run.kind === 'answer') {
    if (c !== 'stop') return false
    useGuide.getState().close()
    return true
  }
  // every typed control is the person's: the conductor yields first (Next, Back, Restart as much as Pause and Stop)
  holdConductor()
  return useGuide.getState().control(c)
}

/** turns whose conductor the person took the demo from (their later tour.step acts are answered stale_origin) */
const held = new Set<string>()

/**
 * The person used a control on a demo the orchestrator is driving (Back, Next, Finish, Pause, Stop, Restart, Close,
 * by button, key or words): its conductor moves the screen no more this turn (the Ask's own takeover; its later
 * tour.step acts are answered stale_origin), so a step it scheduled cannot override Back, rewind a Next, or replay
 * a demo the person finished or closed.
 */
export function holdConductor(): void {
  const r = useGuide.getState().run
  if (r?.kind !== 'demo' || !r.op) return
  held.add(r.op)
  if (held.size > 50) held.delete(held.values().next().value!)
  if (useAskStore.getState().open === r.op) useAskStore.getState().personTookOver()
}

/** What the person's controls do: the conductor yields, then the demo follows the person. */
export type PersonAct = 'next' | 'back' | 'toggle' | 'pause' | 'resume' | 'stop' | 'restart' | 'close' | 'backToStart' | { auto: boolean }
export function personAct(a: PersonAct): void {
  holdConductor()
  const g = useGuide.getState()
  if (a === 'close') g.close()
  else if (a === 'backToStart') g.backToStart()
  else if (typeof a === 'object') g.send({ type: 'auto', on: a.auto })
  else g.send({ type: a })
}

// ---------------------------------------------------------------- preparing a script

/** A script ready to play: a banked one has its steps read from the hive's Tools catalogue first (a read). */
export async function prepare(base: GuideScript): Promise<GuideScript> {
  if (!base.banked) return base
  const h = useHive.getState()
  const swarm = picksNow().swarm?.id ?? null
  const enabled = (h.programs ?? []).some((p) => p.id === TOOLS_APP && p.enabled && !p.error)
  return bankedScript(base, await loadBanked(base.banked, h.client, enabled, swarm))
}

/** Play a script after preparing it (the honest answer's "nearest" and "what exists today" buttons). */
export async function playPrepared(base: GuideScript, opts: PlayOpts = {}): Promise<boolean> {
  const origin = opts.origin ?? askOrigin()
  const bind = opts.bind ?? bindEpoch()
  const script = await prepare(base)
  return bind.commit(() => origin.ok() && useGuide.getState().play(script, { ...opts, origin, bind })) === true
}

// ---------------------------------------------------------------- driving the steps

/**
 * The environment steps play in. GuideLayer installs the real one (liveEnv) when it mounts; until then nothing is
 * driven (no screen to show it on). Each running step is played once per (run, token); a superseded step stops.
 */
let env: GuideEnv | null = null
let driven = ''
/** the step each run last played, so a step reached by a jump (tour.step, Back, Resume) is set up again */
const lastPlayed = new Map<number, number>()

/**
 * A step's screen action. A step without one shows what the step before it opened; reached in order (Next), that is
 * already on screen. Reached any other way (the conductor placing it mid-demo, Back, Resume after the person moved
 * away), the nearest earlier action is done again first. Every action is a read or harmless UI, so repeating one is
 * safe (a move to the page already shown changes nothing; a menu is only pressed to reach the state asked for).
 */
export function actionFor(steps: GuideScript['steps'], at: number, previous: number | undefined): GuideScript['steps'][number]['do'] {
  if (steps[at]?.do || previous === at - 1) return steps[at]?.do
  for (let i = at - 1; i >= 0; i--) if (steps[i].do) return steps[i].do
  return undefined
}
export function setGuideEnv(e: GuideEnv | null): void {
  env = e
  driven = ''
  drive()
}
function drive() {
  const r = useGuide.getState().run
  if (!env || r?.kind !== 'demo' || r.m.status !== 'running') return
  const key = `${r.id}:${r.m.token}`
  if (key === driven) return
  driven = key
  const { id, m } = r
  const step = { ...r.script.steps[m.step], do: actionFor(r.script.steps, m.step, lastPlayed.get(id)) }
  lastPlayed.set(id, m.step)
  if (lastPlayed.size > 20) lastPlayed.delete(lastPlayed.keys().next().value!)
  const alive = () => {
    const now = useGuide.getState().run
    return now?.kind === 'demo' && now.id === id && now.m.token === m.token && now.m.status === 'running' && now.origin.ok() && now.bind.current()
  }
  void playStep(step, env, alive).then(
    (res) => {
      if (alive()) useGuide.getState().stepDone(m.token, { found: !!res.el, note: res.note })
    },
    () => {
      if (alive()) useGuide.getState().stepDone(m.token, { found: false, note: null })
    },
  )
}
useGuide.subscribe(drive)

// ---------------------------------------------------------------- the conductor's tour.step

export type TourStepAnswer = { ok: true; reason?: 'reduced_motion_skipped' } | { ok: false; reason: 'not_declared' | 'blocked' | 'stale_origin' }

/** turns whose conductor placed a tour step (their fallback is not needed) */
const conducted = new Set<string>()

/** Resolves once the step placed under (run id, token) is shown or superseded, or after `ms`. */
function shown(id: number, token: number, ms: number): Promise<'shown' | 'gone' | 'waiting'> {
  return new Promise((resolve) => {
    const timer: { id?: ReturnType<typeof setTimeout> } = {}
    const check = (): boolean => {
      const r = useGuide.getState().run
      if (r?.kind !== 'demo' || r.id !== id || r.m.token !== token) return finish('gone')
      if (r.m.status !== 'running') return finish(r.m.status === 'ready' ? 'shown' : 'gone')
      return false
    }
    const finish = (v: 'shown' | 'gone' | 'waiting') => {
      unsub()
      clearTimeout(timer.id)
      resolve(v)
      return true
    }
    const unsub = useGuide.subscribe(() => void check())
    if (check()) return
    timer.id = setTimeout(() => finish('waiting'), ms)
  })
}

/**
 * The conductor's `tour.step {script, step}` (vocabulary v1): place the guided demo `script` at `step` (0-based) and
 * play that step on screen. Screen-only, like every act: it moves pages, previews and points, never decides, spends or
 * runs anything. The person always wins: a demo they paused, or took over, is not moved (blocked / stale_origin).
 *  - unknown script or step out of range: not_declared, nothing changes;
 *  - a demo not built yet (temporal): its honest "being built" answer is shown, and the act answers blocked;
 *  - otherwise ok once the step is shown (its target found or honestly not), or still waiting for the person.
 */
export async function tourStep(scriptId: string, step: number, origin: AskOrigin, op?: string, reduced = false, alive: () => boolean = () => true): Promise<TourStepAnswer> {
  const bind = bindEpoch()
  const base = scriptById(scriptId)
  if (!base || !Number.isInteger(step) || step < 0) return { ok: false, reason: 'not_declared' }
  if (op) conducted.add(op)
  if (!origin.ok()) return { ok: false, reason: 'stale_origin' }
  // the person took this demo from the conductor (a control, by button, key or words): it is theirs now
  if ((op && held.has(op)) || !alive()) return { ok: false, reason: 'stale_origin' }
  const g = useGuide.getState()
  if (base.status !== 'ready') {
    if (step !== 0) return { ok: false, reason: 'not_declared' }
    await g.start({ kind: 'script', script: base, topic: base.title }, { you: '', origin })
    return { ok: false, reason: 'blocked' }
  }
  const cur = g.run
  if (cur?.kind === 'demo' && cur.script.id === scriptId && cur.m.status !== 'ended') {
    if (cur.m.status === 'paused') return cur.m.paused === 'took-over' ? { ok: false, reason: 'stale_origin' } : { ok: false, reason: 'blocked' }
    if (step >= cur.m.total) return { ok: false, reason: 'not_declared' }
    useGuide.setState({ run: { ...cur, ...(op ? { op } : {}) } })
    g.send({ type: 'goto', step })
  } else {
    const script = await prepare(base)
    // after the await: placed only if the same person is here and the person has not taken it since (one tick)
    const placed = bind.commit(() => {
      if (!origin.ok() || (op && held.has(op)) || !alive()) return 'stale_origin' as const
      if (step >= script.steps.length) return 'not_declared' as const
      // guided-play: an Ask turn's conductor places the steps itself (no auto-advance here), and its steps get the demo
      // cursor and marks too; the showreel draws its own (its ops are `showreel:…`)
      return useGuide.getState().play(script, { origin, bind, at: step, op, play: !op?.startsWith('showreel:') }) ? null : ('stale_origin' as const)
    })
    if (placed === STALE) return { ok: false, reason: 'stale_origin' }
    if (placed) return { ok: false, reason: placed }
  }
  const r = useGuide.getState().run
  if (r?.kind !== 'demo') return { ok: false, reason: 'blocked' }
  if (!env) return { ok: false, reason: 'blocked' }
  const s = r.script.steps[r.m.step]
  const wait = s?.wait
  // a step that waits for the person is placed now; the conductor need not wait with it
  const ms = wait?.for === 'you' ? 0 : (wait?.for === 'time' ? wait.ms : wait?.ms ?? TARGET_MS) + 1500
  const out = r.m.status === 'running' ? await shown(r.id, r.m.token, ms) : 'shown'
  if (!origin.ok() || !alive()) return { ok: false, reason: 'stale_origin' }
  if (out === 'gone') {
    const now = useGuide.getState().run
    return now?.kind === 'demo' && now.m.status === 'paused' && now.m.paused === 'took-over' ? { ok: false, reason: 'stale_origin' } : { ok: false, reason: 'blocked' }
  }
  return reduced ? { ok: true, reason: 'reduced_motion_skipped' } : { ok: true }
}

/**
 * A demo the person asked for was handed to the orchestrator (its conductor drives it with tour.step). When that turn
 * ends without placing a single step (a hive whose conductor does not drive tours yet, or a refusal), the same demo
 * plays here, locally, and says so. Not when the person took over, or someone else is signed in now.
 */
export function expectConducted(op: string, intent: Extract<GuideIntent, { kind: 'script' }>, ctx: { you: string; where?: string; origin: AskOrigin }): void {
  const check = () => {
    const t = useAskStore.getState().turns[op]
    if (t && t.state !== 'done' && t.state !== 'refused') return
    unsub()
    if (conducted.has(op) || !ctx.origin.ok() || t?.tookOver) return
    void useGuide.getState().start(intent, { ...ctx, note: 'The orchestrator did not guide this one, so it plays here.' })
  }
  const unsub = useAskStore.subscribe(check)
  check()
}

// ---------------------------------------------------------------- the real screen

/** the person's own preview before the demo previewed anything (undefined: the demo has previewed nothing) */
let before: { preview: UiPrefs | null } | undefined
function previewExperience(id: string | null) {
  const { saved, preview } = lookState()
  if (!before) {
    before = { preview }
    capture('experience', {
      // the person's own look, exactly as before the demo (their earlier preview included)
      restore: () => {
        if (before) previewLook(before.preview)
        before = undefined
      },
      // another person now: the demo's preview goes, the earlier person's is never put back
      drop: () => previewLook(null),
    })
  }
  if (id === null) {
    // back to the person's own: exactly the look they had before the demo
    const u = restores.get('experience')
    restores.delete('experience')
    if (u) quietly(u.restore)
    return
  }
  const base: UiPrefs | null = before?.preview ?? saved
  previewLook(withExperience(base, id)) // the same choice as Change UI and the Ask
}

/**
 * The reveal after a reading step reflowed its sheet (store liveEnv.reveal): deferred while the sheet opens, and
 * FENCED to the run, step and person it was made for (Root 173503Z). It does nothing, and its timer is cleared, once
 * any of these holds: the run ended (Finish, Stop, fenced), a new run or another step started (its token moved), the
 * person changed (identity epoch; the Ask origin), or the target left the page. It never presses anything itself.
 */
interface DeferredReveal {
  timer: ReturnType<typeof setTimeout>
  id: number
  token: number
  bind: EpochBinding
  el: Element
}
let deferred: DeferredReveal | null = null
export function cancelDeferredReveal(): void {
  if (deferred) clearTimeout(deferred.timer)
  deferred = null
}
function deferredHolds(d: DeferredReveal): boolean {
  const r = useGuide.getState().run
  return r?.kind === 'demo' && r.id === d.id && r.m.token === d.token && (r.m.status === 'running' || r.m.status === 'ready') && d.bind.current() && r.bind.current() && r.origin.ok() && d.el.isConnected
}
function deferReveal(el: Element, ms: number): void {
  cancelDeferredReveal()
  const r = useGuide.getState().run
  if (r?.kind !== 'demo') return
  const d: DeferredReveal = { id: r.id, token: r.m.token, bind: bindEpoch(), el, timer: setTimeout(() => {
    if (deferred !== d) return
    deferred = null
    if (deferredHolds(d)) liveEnv.reveal(el, true)
  }, ms) }
  deferred = d
}
/** whether a deferred reveal is pending (tests) */
export const deferredRevealPending = (): boolean => deferred !== null
useGuide.subscribe(() => {
  if (deferred && !deferredHolds(deferred)) cancelDeferredReveal()
})
onIdentityChange(cancelDeferredReveal)

/**
 * Make room to read `el` when its view cannot hold it (Root 173503Z, 184433Z), once per reading step (the caller keeps
 * the once: driver reveal at the step's start, GuideLayer's ReadingRoom on every later settled measurement):
 *  - a phone sheet at its peek height (a short screen) opens to full height by its own Expand control (aria-expanded),
 *    put back when the demo ends for the same person;
 *  - a panel without one (a short desktop window) lets its yielding bands step aside for the step (startReflow).
 * Then the target is revealed again, deferred and fenced (deferReveal). False: nothing could be done, or was needed.
 */
export function makeRoomToRead(el: Element): boolean {
  const r = el.getBoundingClientRect()
  // a phone sheet at its peek height may leave no room at all to read in (a short screen): the reading
  // arrangement reflows, the sheet opens to full height (its own Expand control, aria-expanded), and is put back
  // when the demo ends; then the target is revealed again in the room that made
  const band = visibleBand(el)
  const snap = el.closest('.xc-frame')?.querySelector<HTMLElement>('[data-tour="sheet-snap"][aria-expanded="false"]')
  if (band.bottom - band.top < Math.min(r.height, window.innerHeight / 3) && snap) {
    capture('sheet-snap', {
      restore: () => {
        if (snap.isConnected && snap.getAttribute('aria-expanded') === 'true') snap.click()
      },
    })
    snap.click()
    deferReveal(el, 450)
    return true
  }
  // a panel with no such control (a short desktop window): the bands it lets step aside do so for this step
  // (guided/reading startReflow; ended with the step or the demo), then the target is revealed again
  const root = document.documentElement
  if (band.bottom - band.top < r.height && root.dataset.guideReflow === undefined && el.closest('.xc-frame')?.querySelector('[data-reading-yields]')) {
    startReflow(root)
    deferReveal(el, 60)
    return true
  }
  return false
}

/**
 * A reading step's caption layout from the target as measured now (GuideLayer Caption, on every settled measurement):
 * the placement (guided/reading placeReading, in the target's view), and, the first time this step's target no
 * longer fits that view, the room made for it (makeRoomToRead), once per step, run and person (`room`, `key`), never
 * while a reveal for it is still pending.
 */
export function layoutReading(el: Element, size: { width: number; height: number }, viewport: { width: number; height: number }, controls: Box[], region: Box | null, room: ReadingRoom, key: string, mayMove = true): { placement: ReadingPlacement; target: Box; roomMade: boolean } {
  const b = el.getBoundingClientRect()
  const target = { left: b.left, top: b.top, width: b.width, height: b.height }
  const placement = placeReading(target, size, viewport, controls, region, visibleBand(el), 1 / (window.devicePixelRatio || 1))
  const roomMade = mayMove && !deferredRevealPending() && room.observe(key, !placement.scrolls) && makeRoomToRead(el)
  return { placement, target, roomMade }
}

/**
 * Whether a reading step may MOVE the page (scroll, reflow, make room) now: only while it plays (ready). Paused, by
 * the person's own input (took-over) or by Pause, stopped or finished: it still measures and draws its caption and
 * highlight, but never scrolls, reflows or makes room, so the person's own scrolling stands (stand-in r6 P2). It moves
 * again only when the tour resumes on that step (a new token: the driver reveals it afresh).
 */
export const readingMayMove = (run: GuideRun | null): boolean => run?.kind === 'demo' && run.m.status === 'ready'

/**
 * A reading step's caption layout and its corrective scroll (GuideLayer Caption): the placement from the target as
 * measured now; when the step may move the page, the room made once (layoutReading), else the target scrolled clear
 * of the caption, a few tries per step (a scroller may stop short). `tries` keeps the attempts per run and token.
 */
export function readingStepLayout(el: Element, size: { width: number; height: number }, viewport: { width: number; height: number }, controls: Box[], region: Box | null, room: ReadingRoom, run: Extract<GuideRun, { kind: 'demo' }>, epoch: number, tries: { current: string }): { placement: ReadingPlacement; target: Box; roomMade: boolean } {
  const move = readingMayMove(run)
  const lay = layoutReading(el, size, viewport, controls, region, room, `${run.id}:${run.m.token}:${epoch}`, move)
  const r = lay.placement
  if (move && !lay.roomMade && r.shift) {
    const at = `${run.id}:${run.m.token}`
    const n = tries.current.startsWith(`${at}#`) ? Number(tries.current.split('#')[1]) : 0
    if (n < 3) {
      tries.current = `${at}#${n + 1}`
      scrollerOf(el)?.scrollBy({ top: r.shift, behavior: 'auto' })
    }
  }
  return lay
}

/** The environment a demo plays in: the router, the stores and the document. */
export const liveEnv: GuideEnv = {
  go(route) {
    // the demo's moves are the mind's: neither the Ask's takeover watch nor the demo's own reads them as the person's
    selfMoveAt = Date.now()
    moveAsMind(route)
  },
  picks: () => useGuide.getState().run?.kind === 'demo' ? (useGuide.getState().run as Extract<GuideRun, { kind: 'demo' }>).picks : picksNow(),
  appEnabled: (id) => (useHive.getState().programs ?? []).some((p) => p.id === id && p.enabled && !p.error),
  ui(kind) {
    const h = useHive.getState()
    // each only closes what it opened, so it is the same for the person or another (restore and drop alike)
    if (kind === 'gallery') {
      const close = () => openGallery(false)
      capture('gallery', { restore: close, drop: close })
      openGallery(true)
    } else if (kind === 'palette') {
      const close = () => useHive.getState().setPalette(false)
      capture('palette', { restore: close, drop: close })
      h.setPalette(true)
    } else if (kind === 'help') {
      const close = () => useIntro.getState().setHelp(false)
      capture('help', { restore: close, drop: close })
      useIntro.getState().setHelp(true)
    } else if (kind === 'ask-bar') {
      // a reading step: the thread folds to its bar so what it points at is readable. Not put back afterwards (the
      // thread is the person's; reopening it over what they are reading is theirs to do, one press on the bar)
      // a thread the person reopened during this played demo stays open for the rest of it (r1.2a)
      const r = useGuide.getState().run
      if (r?.kind === 'demo' && threadFold.keeps(r.id)) return
      if (useAskStore.getState().threadOpen) useAskStore.getState().setThreadOpen(false)
    } else {
      for (const k of ['gallery', 'palette', 'help']) {
        const u = restores.get(k)
        restores.delete(k)
        if (u) quietly(u.restore)
      }
    }
  },
  experience: previewExperience,
  press(name, open) {
    const el = document.querySelector<HTMLElement>(`[data-tour="${CSS.escape(name)}"]`)
    // only a disclosure (a menu or drawer) is ever pressed, and only to reach the state asked for
    const state = el?.getAttribute('aria-expanded')
    if (!el || state === null || (state === 'true') === open) return
    // put back by pressing it again: only for the same person (no drop: another person's controls are never pressed)
    capture(`press:${name}`, {
      restore: () => {
        const now = document.querySelector<HTMLElement>(`[data-tour="${CSS.escape(name)}"]`)
        if (now?.getAttribute('aria-expanded') === String(open)) now.click()
      },
    })
    el.click()
  },
  find: (targets, p) => findIn(document, targets, p),
  reveal(el, whole) {
    const r = el.getBoundingClientRect()
    if (whole) {
      if (makeRoomToRead(el)) return
      // a reading step wants all of it inside its scroller's visible box (so clear of a band the panel keeps below its
      // scroll area, a live log say) and above the Ask's band (ui/overlays ASK_RESERVE)
      const shift = wholeShift(r, visibleBand(el), 1 / (window.devicePixelRatio || 1))
      if (shift) scrollerOf(el)?.scrollBy({ top: shift, behavior: 'auto' })
      return
    }
    if (r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches || lookState().saved?.variant?.motion === 'none'
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}

// ---------------------------------------------------------------- a change of person

/**
 * Registered with the identity epoch (synchronous, inside the change itself): the demo, finished or not, is gone
 * before anything renders the new person; what it captured for the earlier person is discarded, never run; the
 * conductor bookkeeping of the earlier person's turns goes with it.
 */
export function fenceIdentity(): void {
  dropAll()
  held.clear()
  conducted.clear()
  lastPlayed.clear()
  driven = ''
  if (useGuide.getState().run) useGuide.setState({ run: null })
}
onIdentityChange(fenceIdentity)

/** the Ask thread a playing demo folded (play.ts ThreadFold); a change of person forgets it */
export const threadFold = new ThreadFold({ open: () => useAskStore.getState().threadOpen, set: (open) => useAskStore.getState().setThreadOpen(open) })
onIdentityChange(() => threadFold.drop())
