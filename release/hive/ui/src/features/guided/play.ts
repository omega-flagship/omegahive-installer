/**
 * Guided-play (Surface, r1; r1.1: target resolution, the Ask thread folded while a step plays): a guided demo started from the Ask plays itself through on the real page with the D4
 * showreel's cursor and marks (features/ink). Pure and injected, so it is tested without a browser.
 *
 * Each shown step: the cursor glides to what the step points at and "clicks" (a drawn ripple only), then one mark
 * (a circle, an arrow or an underline) appears on it with a few words; the step waits for its caption to be read
 * (machine dwellMs, store auto-advance), then the next one plays. A step with no target, or whose target is not on
 * the page, shows its caption only.
 *
 * Live hives too: it may move the page (the step's own reads and harmless UI, driver.ts) and point at things. It NEVER
 * presses anything: there is no click(), no dispatched event and no request anywhere in it; over a decision control
 * (Keep, Confirm, Delete, Send…) the cursor only points (ink isDecisionControl), and posting is not something it can do.
 *
 * The person always wins (inputVerdict): any click, scroll, tap or key on the page takes over (the demo pauses where
 * it is: "you took over"); typing in the Ask (or "/" that opens it) pauses it ("paused while you type"); the caption's own controls (Next,
 * Back, Pause, Stop) are theirs and are neither.
 */
import { fill, targetsOf, type Picks } from './driver'
import type { GuideStep, GuideTarget } from './types'
import type { Mark } from '../ink/ink'

/** The screen the player draws on (the real one is ink's glideTo / drawMarks; tests use their own). */
export interface PlayScreen {
  find(targets: GuideTarget[]): Element | null
  /** glide the cursor to it (a jump under reduced motion); `click` draws a ripple, never presses */
  glide(el: Element, click: boolean): Promise<void>
  draw(marks: Mark[]): void
  clear(): void
  sleep(ms: number): Promise<void>
  /** scroll it into view (only part of it shows): a page move, never a press */
  reveal(el: Element): void
}

/** how long a step's target may take to mount after its page move, and how often it is looked for (r1.1) */
export const MOUNT_MS = 2000
export const MOUNT_POLL_MS = 150
/** how long a found target may keep moving while the page around it fills in */
export const SETTLE_MS = 1200
/** a beat after a reveal, for the scroll to land */
export const REVEAL_MS = 450

/**
 * What a mark may point at: the step's own targets, never the Ask (its capsule or bar) and never the whole page (a
 * caption's fallback region). A step left with nothing shows its caption only (r1.1: the mark once ringed the Ask's
 * send button when the real target had not mounted yet).
 */
export function inkTargets(target: GuideStep['target']): GuideTarget[] {
  const out: GuideTarget[] = []
  for (const t of targetsOf(target)) {
    const rest: GuideTarget = { ...t }
    delete rest.ask
    if (rest.region === 'page') delete rest.region
    if (Object.keys(rest).length) out.push(rest)
  }
  return out
}

/** inside the Ask or the guide's own UI: never a mark's target */
const ours = (el: Element) => !!(el.closest('.ask-root') || el.closest('.guide-ui'))

/** A few words for a mark: the step's caption or first clause, cut at a word, never long. */
export function shortLabel(text: string, max = 38): string {
  const first = text.split(/(?<=[a-z0-9)’'])[.:;!?](?:\s|$)/i)[0].trim()
  if (first.length <= max) return first
  const cut = first.slice(0, max - 1)
  const at = cut.lastIndexOf(' ')
  return `${(at > 12 ? cut.slice(0, at) : cut).replace(/[,\s]+$/, '')}…`
}

/** Which mark suits a target of this size: an arrow at a big one, an underline under a wide short one, else a circle. */
export function markKind(box: { width: number; height: number }, vw: number, vh: number): Mark['kind'] {
  if (box.height > vh * 0.45 || box.width > vw * 0.8) return 'arrow'
  if (box.width > box.height * 4) return 'underline'
  return 'circle'
}

/** A target worth pointing at: on screen (at least 40 px of it, or all of a smaller one), and not the whole page. */
export function pointable(r: { top: number; bottom: number; width: number; height: number }, vw: number, vh: number): boolean {
  if (Math.min(vh, r.bottom) - Math.max(0, r.top) < Math.min(40, r.height)) return false
  return !(r.width > vw * 0.6 && r.height > vh * 0.6)
}

/**
 * Play the ink for one shown step. Returns what it did: 'drawn' (cursor and mark), 'caption' (no target, not on the
 * page, off screen, or the whole page: the caption only), or 'gone' (the step was superseded part way: nothing more is drawn).
 */
export async function playInk(step: GuideStep, picks: Picks, screen: PlayScreen, alive: () => boolean, view = { width: 1440, height: 900 }): Promise<'drawn' | 'caption' | 'gone'> {
  screen.clear()
  const targets = inkTargets(step.target)
  if (!targets.length) return 'caption'
  // the target may still be mounting after the step's page move: looked for again, briefly
  const el = await mounted(targets, screen, alive)
  if (el === 'gone') return 'gone'
  if (!el) return 'caption'
  // the page around it may still be filling in (a section above it loading pushes it down): wait for it to settle
  if ((await settled(el, screen, alive)) === 'gone') return 'gone'
  // only part of it shows (below the fold, under the window's edge): brought into view first (not a reading step:
  // the driver lays those out itself)
  if (!step.read && needsReveal(el.getBoundingClientRect(), view.height)) {
    screen.reveal(el)
    await screen.sleep(REVEAL_MS)
    if (!alive()) return 'gone'
  }
  // nothing to point at: a target still off screen (under a sheet, say), or as big as the page
  if (!pointable(el.getBoundingClientRect(), view.width, view.height)) return 'caption'
  // a reading step is pointed at, not clicked (the person reads it)
  await screen.glide(el, !step.read)
  if (!alive()) return 'gone'
  const r = el.getBoundingClientRect()
  const label = shortLabel(step.caption ?? fill(step.say, picks))
  screen.draw([{ kind: markKind(r, view.width, view.height), target: targets, label, el }])
  return 'drawn'
}

/** The step's target once it is on the page (never inside the Ask or the guide's own UI), null after MOUNT_MS. */
async function mounted(targets: GuideTarget[], screen: PlayScreen, alive: () => boolean): Promise<Element | null | 'gone'> {
  for (let waited = 0; ; waited += MOUNT_POLL_MS) {
    if (!alive()) return 'gone'
    const found = screen.find(targets)
    if (found && !ours(found)) return found
    if (waited >= MOUNT_MS) return null
    await screen.sleep(MOUNT_POLL_MS)
  }
}

/** Until the target stops moving (the same place twice running), up to SETTLE_MS. */
async function settled(el: Element, screen: PlayScreen, alive: () => boolean): Promise<'ok' | 'gone'> {
  let last = el.getBoundingClientRect().top
  for (let waited = 0; waited < SETTLE_MS; waited += MOUNT_POLL_MS) {
    await screen.sleep(MOUNT_POLL_MS)
    if (!alive()) return 'gone'
    const now = el.getBoundingClientRect().top
    if (Math.abs(now - last) < 1) return 'ok'
    last = now
  }
  return 'ok'
}

/** Less of it on screen than it needs (its height, up to half the window): bring it into view. */
export function needsReveal(r: { top: number; bottom: number; height: number }, vh: number): boolean {
  const shown = Math.min(vh, r.bottom) - Math.max(0, r.top)
  return shown < Math.min(r.height, vh * 0.5) * 0.8
}

/**
 * The Ask's thread is folded while a step plays itself, so what the step shows is not under it (r1.1), and put back
 * as the person had it when the demo pauses (they took over, or type in the Ask), ends or is closed. Only a thread the
 * demo folded is reopened; a change of person drops it (nothing is reopened for someone else).
 */
export class ThreadFold {
  private folded = false
  /** the run in which the person reopened the thread the demo folded: it stays open for the rest of that run (r1.2a) */
  private kept: { run: unknown } | null = null
  constructor(private ask: { open(): boolean; set(open: boolean): void }) {}
  /** a step of `run` plays: fold the thread if it is open, unless the person reopened it during this run */
  step(run: unknown = null): void {
    if (this.kept && this.kept.run !== run) this.kept = null
    if (this.kept) return
    if (this.folded && this.ask.open()) {
      // the demo folded it and it is open again: only the person opens it mid-run, so it is theirs until the run ends
      this.folded = false
      this.kept = { run }
      return
    }
    if (!this.ask.open()) return
    this.ask.set(false)
    this.folded = true
  }
  /**
   * paused, ended or closed: the thread back as it was. A run that ended (or was closed) also forgets the person's
   * keep (followups-r5, Kimi r4), so `keeps()` never answers for a finished run; a pause keeps it (r1.2a: resumed,
   * the thread they reopened is still theirs).
   */
  restore(o: { ended?: boolean } = {}): void {
    if (o.ended) this.kept = null
    if (!this.folded) return
    this.folded = false
    this.ask.set(true)
  }
  /** another person: forget it */
  drop(): void {
    this.folded = false
    this.kept = null
  }
  /** the person reopened the thread during `run`: nothing in that run folds it again (the read steps' fold too) */
  keeps(run: unknown): boolean {
    return !!this.kept && this.kept.run === run
  }
  get isFolded(): boolean {
    return this.folded
  }
}

/** keys that are not input (moving focus, holding a modifier) */
const NOT_INPUT = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab']

export interface InputLike {
  type: string
  isTrusted: boolean
  key?: string
  target: EventTarget | null
}

/**
 * What the person's own input means while a demo plays: 'takeover' (a click, scroll, tap or key on the page), 'pause'
 * (typing in the Ask while it plays itself), or null (the demo's own controls, the Ask otherwise, synthetic events,
 * modifier keys and Tab).
 */
export function inputVerdict(e: InputLike, playing: boolean): 'takeover' | 'pause' | null {
  if (!e.isTrusted) return null
  if (e.type === 'keydown' && NOT_INPUT.includes(e.key ?? '')) return null
  const t = e.target instanceof Element ? e.target : null
  if (t?.closest('.guide-ui')) return null
  if (t?.closest('.ask-root')) return playing && e.type === 'keydown' ? 'pause' : null
  // "/" opens the Ask (to ask about the step): a pause, not a take-over, as in the showreel
  if (playing && e.type === 'keydown' && e.key === '/') return 'pause'
  return 'takeover'
}
