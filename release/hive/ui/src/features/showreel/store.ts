/**
 * The demo showreel (Surface demo D4), demo mode only: a sequencer that plays the scenes (scenes.ts) through the Ask
 * conductor's own executor (conductor performLocal: navigate, open, point, tour.step) and the guided-demo runner
 * (features/guided: its caption, glow and controls), with a demo cursor and a draw layer around each step. 0 model
 * calls: every word it says or answers is in its script.
 *
 *  - It never starts on a real hive: start() refuses unless the client is the in-browser simulator in demo mode.
 *  - The person always wins (machine.ts): their input on the page takes over and it stops where it is; typing or
 *    speaking into the Ask pauses it and the Ask answers from the step's script; the guided caption's own controls
 *    (Pause, Next, Back, Stop) drive it too.
 *  - It runs under the Ask origin it started in; a change of client, session or sign-in ends it.
 */
import { create } from 'zustand'
import type { ActReason } from '../../api/ask'
import { href, openInDesign } from '../../lib/router'
import { askOrigin, useAskStore, type AskOrigin } from '../../store/ask'
import { useHive } from '../../store/store'
import type { GuideTarget } from '../guided/types'
import { clearDemoScripts, registerDemoScripts } from '../guided/scripts'
import { useGuide } from '../guided/store'
import { active, dwellMs, IDLE, reduceReel, type Reel, type ReelEvent } from './machine'
import { PLAYLIST, SCENE_SCRIPTS } from './scenes'
import { LAYER_NAMES, LAYERS, type DialogOpen, type LayerKind, type Mark, type PageMove, type ScriptAct, type ShowStep } from './types'
import { answerFor, hear, OFF_SCRIPT, startsShowreel } from './words'
import { isDemoClient } from './hook'


/** An act the runner hands to the conductor (a script act, or the tour step), with the step's op and seq. */
export type RunnerAct = ScriptAct | { kind: 'tour.step'; script: string; step: number }

/** Everything the runner does to the screen, injected (the real one is in ShowreelLayer; tests use their own). */
export interface ReelEnv {
  /** `alive`: whether this step still holds (the person has not taken over, paused or moved it); passed to the executor */
  act(act: RunnerAct, op: string, seq: number, origin: AskOrigin, alive: () => boolean): Promise<{ ok: boolean; reason?: ActReason }>
  /** the address of a page known only on the page (a team room, a design), read just before moving there, or null */
  place(move: PageMove): Promise<string | null>
  find(targets: GuideTarget[]): Element | null
  /** glide the demo cursor to it (a jump under reduced motion), and click when asked */
  cursor(el: Element, click: boolean): Promise<void>
  /** open a warning with the page's own opener (null: close the one the showreel opened, if it is still open) */
  dialog(open: DialogOpen | null): void
  draw(marks: Mark[]): void
  clear(): void
  say(text: string): void
  hush(): void
  sleep(ms: number): Promise<void>
}

export interface ReelAnswer {
  /** what the person asked */
  q: string
  text: string
  /** the playlist step it is about */
  at: number
  /** an answer to a why/what/click (offers Carry on and Show me more), or the plain off-script line */
  kind: 'step' | 'off'
}

interface ReelState {
  reel: Reel
  /** the playlist step's own note when it could not do what it says (an act refused) */
  note: string | null
  answer: ReelAnswer | null
  /** the layers of "how" for the step now: which layer is open, and how deep it has gone */
  layers: { at: LayerKind; deepest: number } | null
  voice: boolean
  start(opts?: { loop?: boolean }): boolean
  send(e: ReelEvent): void
  stop(): void
  /** open the layers of "how" (pauses the demo), at a layer, or one deeper */
  openLayers(at?: LayerKind): void
  deeper(): void
  /** back up out of the layers and carry on */
  closeLayers(): void
  /** put the layers away, staying paused */
  hideLayers(): void
  /** stop (if it still shows) and put the showreel away */
  close(): void
  setVoice(on: boolean): void
}

let origin: AskOrigin | null = null
let env: ReelEnv | null = null
/** the runner is moving the guided demo itself: its changes are not the person's */
let guideBusy = 0
/** the guided run and token the runner last placed */
let expected: { id: number; token: number } | null = null
let runs = 0

export const useReel = create<ReelState>()((set, get) => ({
  reel: IDLE,
  note: null,
  answer: null,
  layers: null,
  voice: false,

  start({ loop } = {}) {
    if (!isDemoClient(useHive.getState().client)) return false
    const o = askOrigin()
    if (!o.ok()) return false
    registerDemoScripts(SCENE_SCRIPTS, () => isDemoClient(useHive.getState().client))
    origin = o
    runs++
    expected = null
    set({ reel: reduceReel(get().reel, { type: 'start', total: PLAYLIST.length, loop }), note: null, answer: null, layers: null })
    return true
  },

  send(e) {
    const before = get().reel
    const reel = reduceReel(before, e)
    if (reel === before) return
    const moved = reel.token !== before.token
    set({ reel, ...(moved && reel.status === 'playing' ? { answer: null, note: null, layers: null } : {}) })
    if (reel.status !== 'playing') {
      env?.hush()
      // the guided caption shows where it stands: paused with it, or put away when it ends
      if (reel.status === 'paused' && e.type === 'pause') guided({ type: 'pause' })
      if (reel.status === 'took-over') guided({ type: 'takeover' })
    }
    if (reel.status === 'ended') finish()
  },

  stop() {
    get().send({ type: 'stop' })
  },

  openLayers(at = 'screen') {
    const r = get().reel
    if (!active(r)) return
    if (r.status === 'playing' || r.status === 'paused') get().send({ type: 'pause', why: 'layers' })
    const deepest = Math.max(get().layers?.deepest ?? 0, LAYERS.indexOf(at))
    set({ layers: { at, deepest } })
  },

  deeper() {
    const l = get().layers
    if (!l) return get().openLayers('screen')
    const i = Math.min(LAYERS.length - 1, LAYERS.indexOf(l.at) + 1)
    set({ layers: { at: LAYERS[i], deepest: Math.max(l.deepest, i) } })
  },

  closeLayers() {
    set({ layers: null })
    get().send({ type: 'resume' })
  },

  hideLayers() {
    set({ layers: null })
  },

  close() {
    get().send({ type: 'stop' })
    set((s) => ({ reel: { ...IDLE, loop: s.reel.loop, token: s.reel.token + 1 }, note: null, answer: null, layers: null }))
  },

  setVoice(on) {
    set({ voice: on })
    if (!on) env?.hush()
  },
}))

/** The playlist step showing now. */
export const stepNow = (r: Reel = useReel.getState().reel): ShowStep | null => (active(r) ? PLAYLIST[r.at]?.step ?? null : null)

function guided(e: Parameters<ReturnType<typeof useGuide.getState>['send']>[0]): void {
  const g = useGuide.getState()
  if (g.run?.kind !== 'demo' || !SCENE_IDS.has(g.run.script.id)) return
  guideBusy++
  try {
    g.send(e)
  } finally {
    guideBusy--
  }
}

function finish(): void {
  env?.dialog(null)
  env?.clear()
  env?.hush()
  expected = null
  const g = useGuide.getState()
  if (g.run?.kind === 'demo' && SCENE_IDS.has(g.run.script.id)) {
    guideBusy++
    try {
      g.close()
    } finally {
      guideBusy--
    }
  }
}

const SCENE_IDS = new Set(SCENE_SCRIPTS.map((s) => s.id))

// ---------------------------------------------------------------- the runner

export function setReelEnv(e: ReelEnv | null): void {
  env = e
  driven = ''
  drive()
}
let driven = ''

function drive(): void {
  const { reel } = useReel.getState()
  if (!env || reel.status !== 'playing') return
  const key = `${runs}:${reel.token}`
  if (key === driven) return
  driven = key
  void playStep(reel.token, env)
}
useReel.subscribe(drive)

/** Play the step at the reel's place now; everything after an await checks it still holds. */
export async function playStep(token: number, e: ReelEnv): Promise<void> {
  const o = origin
  const alive = () => {
    const r = useReel.getState().reel
    return r.token === token && r.status === 'playing' && !!o && o.ok()
  }
  if (!o || !o.ok()) return useReel.getState().send({ type: 'stop' })
  const { reel } = useReel.getState()
  const item = PLAYLIST[reel.at]
  if (!item) return
  const { scene, i, step } = item
  const op = `showreel:${runs}:${token}`
  let seq = 0
  const notes: string[] = []
  e.clear()
  // a warning the previous step opened is put away (one the person opened, or kept after taking over, is theirs)
  e.dialog(null)
  // 1. the cursor glides to what it clicks (a nav item, a button), when that is on screen
  const c = step.cursor ? e.find(step.cursor) : null
  if (c) await e.cursor(c, true)
  if (!alive()) return
  // 2. the move, through the conductor's executor
  for (const a of step.before ?? []) {
    const act = await resolveAct(a, e)
    if (!alive()) return
    if (!act) {
      notes.push(`Could not find ${('label' in a && a.label) || 'that page'} in this simulated hive.`)
      continue
    }
    const r = await e.act(act, op, ++seq, o, alive)
    if (!alive()) return
    if (!r.ok) notes.push(refusedWords(act, r.reason))
  }
  // the step's warning, opened with the page's own opener (the demo never presses anything in it)
  if (step.dialog) {
    e.dialog(step.dialog)
    if (!alive()) return
  }
  // 3. the guided step (its caption, glow and controls); a guided demo paused by the runner plays again first
  const g = useGuide.getState().run
  if (g?.kind === 'demo' && g.script.id === scene.id && g.m.status === 'paused') guided({ type: 'resume' })
  guideBusy++
  let shown: { ok: boolean; reason?: ActReason }
  try {
    shown = await e.act({ kind: 'tour.step', script: scene.id, step: i }, op, ++seq, o, alive)
  } finally {
    guideBusy--
  }
  const now = useGuide.getState().run
  expected = now?.kind === 'demo' ? { id: now.id, token: now.m.token } : null
  if (!alive()) return
  if (!shown.ok) notes.push('The caption for this step could not be shown here.')
  // 4. pointing, after the move
  for (const a of step.after ?? []) {
    await e.act(a, op, ++seq, o, alive)
    if (!alive()) return
  }
  // 5. the marks; the cursor moves to the first one
  if (step.draw?.length) {
    // the page may still be filling in what the mark is on (the guided step settles on its first target found)
    let m = e.find(step.draw[0].target)
    for (let k = 0; !m && k < 12; k++) {
      await e.sleep(150)
      if (!alive()) return
      m = e.find(step.draw[0].target)
    }
    if (m) await e.cursor(m, false)
    if (!alive()) return
    e.draw(step.draw)
  }
  useReel.setState({ note: notes.length ? notes.join(' ') : null })
  // 6. the voice, when on (off by default; captions always)
  if (useReel.getState().voice) e.say(step.guide.say)
  // 7. time to read it, then the next step
  await e.sleep(dwellMs(step.guide.say))
  if (!alive()) return
  useReel.getState().send({ type: 'done', token })
}

async function resolveAct(a: ScriptAct | PageMove, e: ReelEnv): Promise<ScriptAct | null> {
  if (a.kind !== 'team-room' && a.kind !== 'design') return a
  const hash = await e.place(a)
  return hash ? { kind: 'navigate', route: hash, label: a.label } : null
}

function refusedWords(act: RunnerAct, reason?: ActReason): string {
  const what = 'label' in act && act.label ? act.label : 'that'
  if (reason === 'stale_origin') return `Did not open ${what}: this page has unsaved changes.`
  if (reason === 'private') return `Did not open ${what}: it is private.`
  return `Could not open ${what} here.`
}

/**
 * The real reads for a page move, on the simulator only: a swarm's team room (the call the swarm page's Chat button
 * makes), or a design by its title among the swarm's recent Studio designs (the read the empty canvas makes).
 */
export async function placeOf(move: PageMove): Promise<string | null> {
  const client = useHive.getState().client
  if (!isDemoClient(client) || !client) return null
  try {
    if (move.kind === 'team-room') {
      if (!client.swarmRoom) return null
      const room = await client.swarmRoom(move.swarm)
      return href({ name: 'messages', room: room.id })
    }
    if (!client.swarmArtifacts) return null
    const found = (await client.swarmArtifacts(move.swarm, { kind: 'studio-source', limit: 6 })).find((a) => a.title === move.title)
    const route = found ? openInDesign({ artifact_id: found.artifact_id, revision: found.revision, digest: found.digest }, move.swarm) : undefined
    return route ? href(route) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- the client is no longer the demo simulator

/** A switch away from the demo simulator (a real hive's client): its scripts are forgotten and the showreel ends. */
useHive.subscribe((s, prev) => {
  if (s.client === prev.client || isDemoClient(s.client)) return
  clearDemoScripts()
  if (useReel.getState().reel.status !== 'idle') useReel.getState().close()
})

// ---------------------------------------------------------------- the guided caption's controls drive it too

useGuide.subscribe((g) => {
  if (guideBusy) return
  const s = useReel.getState()
  const r = s.reel
  if (r.status !== 'playing' && r.status !== 'paused') return
  const run = g.run
  // the person closed the demo, or asked for another one: the showreel ends
  if (!run || run.kind !== 'demo' || !SCENE_IDS.has(run.script.id)) {
    if (expected) s.send({ type: 'stop' })
    return
  }
  if (!expected) return
  if (run.m.status === 'paused') {
    if (run.m.paused === 'took-over') s.send({ type: 'takeover' })
    else if (r.status === 'playing') s.send({ type: 'pause', why: 'person' })
    return
  }
  if (run.m.status === 'ended') {
    // Finish on a scene's last step goes on to the next scene; Stop stops
    if (run.m.ended === 'done') s.send({ type: 'next' })
    else s.send({ type: 'stop' })
    return
  }
  if (run.id === expected.id && run.m.token === expected.token) return
  // the person used Next, Back, Resume or Play again on the caption: the showreel follows them there
  const at = PLAYLIST.findIndex((p) => p.scene.id === run.script.id && p.i === run.m.step)
  expected = { id: run.id, token: run.m.token }
  if (at < 0) return
  if (at === r.at && r.status === 'paused') s.send({ type: 'resume' })
  else if (at !== r.at) s.send({ type: 'goto', at })
})

// ---------------------------------------------------------------- what the Ask hears while it shows

/**
 * Words typed or spoken into the Ask (useAskField submit, before anything else). In demo mode "show me around"
 * starts the showreel. While it shows, the step's own script answers why / what / why-click, "how" opens the layers,
 * and the controls work by word; anything else gets OFF_SCRIPT (no model is asked). After a take-over, words that are
 * not about the demo go to the Ask as usual. Returns true when the showreel took the words.
 */
export function showreelWords(text: string, opts: { where?: string } = {}): boolean {
  const s = useReel.getState()
  const r = s.reel
  const say = (answer: string) => {
    const o = askOrigin()
    useAskStore.getState().addLocal(text, answer, { where: opts.where, origin: o })
    // the answer is in the showreel's bar too; on a phone the thread would cover the page it is about
    if (typeof window === 'undefined' || !window.matchMedia?.('(max-width: 767px)').matches) useAskStore.getState().setThreadOpen(true)
  }
  if (!active(r)) {
    if (!startsShowreel(text) || !isDemoClient(useHive.getState().client)) return false
    if (!s.start()) return false
    say('Here is the showreel: it plays the hive by itself. Click, scroll, touch or type on the page, or move the mouse a good way across it, and you take over (Tab, Shift and the like, and the showreel’s own buttons, do not). Typing here pauses it, so you can ask “why?”.')
    return true
  }
  const step = PLAYLIST[r.at]?.step
  const h = hear(text)
  switch (h.kind) {
    case 'why':
    case 'what':
    case 'click': {
      if (!step) return false
      if (r.status === 'playing') s.send({ type: 'pause', why: 'ask' })
      const answer = answerFor(h.kind, step)
      useReel.setState({ answer: { q: text, text: answer, at: r.at, kind: 'step' } })
      say(answer)
      return true
    }
    case 'how':
      if (s.layers) {
        s.deeper()
        say(`One layer deeper: ${LAYER_NAMES[useReel.getState().layers?.at ?? 'screen']}.`)
      } else {
        s.openLayers('screen')
        say('Opened the layers of how this step works, starting at the screen. Say “deeper” to go one layer down.')
      }
      return true
    case 'carry-on':
      if (s.layers) s.closeLayers()
      else s.send({ type: 'resume' })
      say('Carrying on.')
      return true
    case 'pause':
      s.send({ type: 'pause', why: 'ask' })
      say('Paused. Say “carry on” when you are ready.')
      return true
    case 'stop':
      s.stop()
      say('Stopped the showreel. Everything it showed is as it was.')
      return true
    case 'next':
    case 'back':
      s.send({ type: h.kind })
      return true
    case 'other':
      // after a take-over the Ask is the person's again
      if (r.status === 'took-over') return false
      if (r.status === 'playing') s.send({ type: 'pause', why: 'ask' })
      useReel.setState({ answer: { q: text, text: OFF_SCRIPT, at: r.at, kind: 'off' } })
      say(OFF_SCRIPT)
      return true
  }
}

/** Tests: back to nothing playing. */
export function resetReel(): void {
  useReel.setState({ reel: IDLE, note: null, answer: null, layers: null, voice: false })
  origin = null
  expected = null
  guideBusy = 0
  driven = ''
}
