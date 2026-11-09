import { create } from 'zustand'
import { onIdentityChange } from '../lib/identityEpoch'
import { readRestPrefs } from '../features/power/rest'
import { focusAskField } from '../features/ask/askField'

/**
 * One experience from rest to Pro (Surface PLAN_ONE_EXPERIENCE_REST_TO_PRO_R1, round 1). CANDIDATE.
 *
 * The shell owns the state, the one Ask, power and what moves between the states; each experience draws every state
 * in its own engine, materials and motion (ExperienceDef.phases). There is no shared skinned component here: this
 * module is state, the pure rules for moving between the states, and the gesture recogniser an experience spreads on
 * its own Ω, whatever that Ω looks like.
 *
 *  - rest   the Ω alone and the faint question. Nothing else is drawn.
 *  - awake  the Ω named, the one field (the shell's Ask), a few apps, Pro one gesture away, power.
 *  - pro    the experience exactly as already built.
 *
 * Resting is this view only: the minds and their work are not touched, and it is not a lock.
 */
export type ShellPhase = 'rest' | 'awake' | 'pro'

/**
 * What can move the state: a tap or an upward swipe on the Ω, a key typed at rest, the Pro control, the power control,
 * Back, and `idle`: the person's idle time ran out (the existing idle owner, features/power RestHost, delegates its rest
 * to a phased experience instead of drawing its own); `urgent`: a decision or a budget refusal that wakes a rest;
 * `navigate`: a direct navigation gesture (a drag or a wheel on the sky) that takes the view one step on at once (r2).
 */
export type PhaseEvent = 'omega-tap' | 'omega-swipe' | 'type' | 'pro' | 'back' | 'power' | 'idle' | 'urgent' | 'navigate'

/**
 * The rules, as a pure function (shell/phase.test.ts). Reversing always goes back toward rest: Pro returns to awake
 * (flying back in to the Ω), awake rests on power. Pro is reached only from awake, so the journey stays one motion.
 */
export function nextPhase(phase: ShellPhase, ev: PhaseEvent): ShellPhase {
  // idle rests the view from anywhere (the Pro view stays bookmarked: waking and choosing Pro returns to it)
  if (ev === 'idle') return 'rest'
  switch (phase) {
    case 'rest':
      return ev === 'omega-tap' || ev === 'omega-swipe' || ev === 'type' || ev === 'urgent' || ev === 'navigate' ? 'awake' : 'rest'
    case 'awake':
      if (ev === 'omega-swipe' || ev === 'pro' || ev === 'navigate') return 'pro'
      if (ev === 'power' || ev === 'back') return 'rest'
      return 'awake'
    case 'pro':
      return ev === 'back' || ev === 'power' ? 'awake' : 'pro'
  }
}

/** The named transitions (UiNext in the parts space: experiences/parts/shell.metta). */
export function transitionOf(from: ShellPhase, to: ShellPhase): 'wake' | 'settle' | 'fly-out' | 'fly-in' | null {
  if (from === 'rest' && to === 'awake') return 'wake'
  if ((from === 'awake' || from === 'pro') && to === 'rest') return 'settle'
  if (from === 'awake' && to === 'pro') return 'fly-out'
  if (from === 'pro' && to === 'awake') return 'fly-in'
  return null
}

interface PhaseState {
  /** Whether the current experience takes part (it has phases, and this build and person opted into the candidate). */
  phased: boolean
  phase: ShellPhase
  /** The state before the last move (null: none yet), for the experience's choreography. */
  from: ShellPhase | null
  /** performance.now() of the last move. */
  at: number
  /** Pro has been reached once on this page: a first entry reveals the overview, later ones restore the person's view. */
  proSeen: boolean
  /**
   * 'idle' only while the current rest was begun by the idle time itself (a real move from awake or Pro): that rest, and
   * only that one, wakes on an urgent event. Never an opening rest, one the person chose, or another identity's.
   */
  restBy: 'idle' | null
  /** Identity reset remains authoritative while saved-look loading mounts fallback and restored experiences. */
  identityRest: boolean
  /** The urgent wake (features/power): wakes only an idle-begun rest; otherwise nothing moves. */
  wakeUrgent(): ShellPhase
  send(ev: PhaseEvent): ShellPhase
  /**
   * Set by the experience host only. Not phased: always Pro, which is today's behaviour. `experience` names who takes
   * part: an app opened full screen unmounts the experience, and coming back to the same experience resumes the state
   * the person left (r2; an app is a visit, not a fresh start). Another experience, or another identity, starts at rest.
   */
  setPhased(phased: boolean, experience?: string, landing?: 'awake' | 'pro'): void
  /** Where a phased experience was when it last stepped out (an app opened over it), for the same experience's return. */
  resume: { experience: string; phase: ShellPhase; proSeen: boolean; restBy: 'idle' | null; at: number } | null
}

/**
 * A kept place goes stale after the same idle horizon the rest timer uses (Kimi r2 #5): a return later than the person's
 * rest minutes is a fresh entry (at rest), as the idle time would have rested the view. 0 minutes (never rest) never expires.
 */
export function resumeExpired(at: number, nowMs: number, minutes: number): boolean {
  return minutes > 0 && nowMs - at >= minutes * 60_000
}

const now = () => (typeof performance === 'undefined' ? 0 : performance.now())

export const usePhase = create<PhaseState>()((set, get) => ({
  phased: false,
  phase: 'pro',
  from: null,
  at: 0,
  proSeen: false,
  restBy: null,
  identityRest: false,
  send(ev) {
    const s = get()
    // Idle and urgent are system events. Even a no-op person intent ends the identity handoff.
    if (s.identityRest && ev !== 'idle' && ev !== 'urgent') set({ identityRest: false })
    if (!s.phased) return s.phase
    const to = nextPhase(s.phase, ev)
    // only a real move sets who began a rest; a no-op (idle while already resting) keeps the rest as it was
    if (to !== s.phase) set({ phase: to, from: s.phase, at: now(), proSeen: s.proSeen || to === 'pro', restBy: to === 'rest' && ev === 'idle' ? 'idle' : null })
    return to
  },
  wakeUrgent() {
    const s = get()
    return s.phased && s.phase === 'rest' && s.restBy === 'idle' ? s.send('urgent') : s.phase
  },
  resume: null,
  setPhased(phased, experience, landing) {
    const s = get()
    if (s.phased === phased) return
    if (phased) {
      // entering a phased experience starts at rest, unless it is the same experience coming back from an app within
      // the idle horizon
      const back = !s.identityRest && s.resume && experience && s.resume.experience === experience && !resumeExpired(s.resume.at, Date.now(), readRestPrefs().minutes) ? s.resume : null
      // (contract R1.1 §7: the host passes the person's landing, awake or Pro; without one, rest as before)
      set({ phased, phase: s.identityRest ? 'rest' : back?.phase ?? landing ?? 'rest', from: null, at: now(), proSeen: back?.proSeen ?? false, restBy: back?.phase === 'rest' ? back.restBy : null, resume: null })
      return
    }
    // leaving one is always Pro (today's behaviour, nothing else changes); its place is kept for its own return
    set({ phased, phase: 'pro', from: null, at: now(), proSeen: false, restBy: null, resume: !s.identityRest && experience ? { experience, phase: s.phase, proSeen: s.proSeen, restBy: s.restBy, at: Date.now() } : null })
  },
}))

// a different person (or sign-in) never inherits this view's place: back to rest, with no Pro bookmark
export function resetForIdentity(): void {
  const s = usePhase.getState()
  if (s.phased) usePhase.setState({ phase: 'rest', from: null, at: now(), proSeen: false, restBy: null, resume: null, identityRest: true })
  else usePhase.setState({ restBy: null, resume: null, identityRest: true })
}
onIdentityChange(resetForIdentity)

/** Actions for props-only phase renderers; state remains owned by the shell. */
export function sendPhase(event: PhaseEvent): void {
  usePhase.getState().send(event)
}

/**
 * The candidate's opt-in. Production builds never carry it (registry UNREVIEWED_ALLOWED compiles the phases out); in
 * the dev server and the surface-preview build it is still off until asked for with `?phases=1` (kept for this tab),
 * so nobody on a current hive sees anything new unless they opt in. `?phases=0` turns it off again.
 */
export function phasesOptedIn(search: string = typeof location === 'undefined' ? '' : location.search, store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeSession()): boolean {
  const asked = new URLSearchParams(search).get('phases')
  try {
    if (asked === '1') store?.setItem(OPT_KEY, '1')
    else if (asked === '0') store?.removeItem(OPT_KEY)
  } catch {
    /* storage refused: the URL alone decides */
  }
  if (asked === '1') return true
  if (asked === '0') return false
  try {
    return store?.getItem(OPT_KEY) === '1'
  } catch {
    return false
  }
}
const OPT_KEY = 'omegahive.candidate.phases'
const OFF_KEY = 'omegahive.phases.off'

/**
 * Released phases (ExperienceDef.phasesReviewed): on by default; `?phases=0` turns them off for this tab (kept), and
 * `?phases=1` turns them back on. Where the person lands within them (awake or Pro) is their `landing` pref.
 */
export function releasedPhasesOn(search: string = typeof location === 'undefined' ? '' : location.search, store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeSession()): boolean {
  const asked = new URLSearchParams(search).get('phases')
  try {
    if (asked === '0') store?.setItem(OFF_KEY, '1')
    else if (asked === '1') store?.removeItem(OFF_KEY)
  } catch {
    /* storage refused: the URL alone decides */
  }
  if (asked === '0') return false
  if (asked === '1') return true
  try {
    return store?.getItem(OFF_KEY) !== '1'
  } catch {
    return true
  }
}
function safeSession(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/** Pointer travel (px) that counts as a swipe; less is a tap. */
export const SWIPE_PX = 36

/**
 * The Ω gesture as a pure reading of one press (tested): up by at least SWIPE_PX and mostly vertical is a swipe, a
 * short travel is a tap, anything else (a drag sideways) is neither.
 */
export function readGesture(dx: number, dy: number): 'tap' | 'swipe' | null {
  if (-dy >= SWIPE_PX && Math.abs(dx) < -dy) return 'swipe'
  if (Math.hypot(dx, dy) < 10) return 'tap'
  return null
}

type PointerLike = { clientX: number; clientY: number; pointerId: number }

/**
 * Every pointer down on the page, wherever it landed (r2.1 smoke: a pinch whose second finger lands on another element
 * was read by the sky as a one-finger drag, and went to Pro). `crowd` counts the moments a second pointer joined, so a
 * press can tell that another finger came down anywhere while it was held. Fed by window capture listeners (installed
 * on first use, by a phased view only) and by the presses themselves; adding or lifting a known pointer is a no-op.
 */
export function pointerHub() {
  const down = new Set<number>()
  let crowd = 0
  return {
    down(id: number) {
      if (down.has(id)) return
      down.add(id)
      if (down.size > 1) crowd += 1
    },
    up(id: number) {
      down.delete(id)
    },
    count: () => down.size,
    crowd: () => crowd,
  }
}
export type PointerHub = ReturnType<typeof pointerHub>
const PAGE_POINTERS = pointerHub()
let pageListening = false
function listenPage(): void {
  if (pageListening || typeof window === 'undefined') return
  pageListening = true
  const opts = { capture: true, passive: true } as const
  window.addEventListener('pointerdown', (e) => PAGE_POINTERS.down(e.pointerId), opts)
  window.addEventListener('pointerup', (e) => PAGE_POINTERS.up(e.pointerId), opts)
  window.addEventListener('pointercancel', (e) => PAGE_POINTERS.up(e.pointerId), opts)
}

/**
 * One press, one finger (tested): the travel of a press that was the only pointer down on the page from start to finish.
 * A press another finger joined, anywhere on the page (a pinch, a two-finger pan), is the browser's own (it zooms or
 * scrolls the page) and reads as nothing, not as a tap, a swipe or navigation (stand-in r2 #1, Kimi r2 #2). A cancelled
 * press reads as nothing too.
 */
export function onePointerPress(hub: PointerHub = PAGE_POINTERS) {
  if (hub === PAGE_POINTERS) listenPage()
  let start: { x: number; y: number; id: number; crowd: number } | null = null
  return {
    down(e: PointerLike) {
      hub.down(e.pointerId)
      start = hub.count() > 1 ? null : { x: e.clientX, y: e.clientY, id: e.pointerId, crowd: hub.crowd() }
    },
    /** The travel of a whole one-finger press, or null. */
    up(e: PointerLike): { dx: number; dy: number } | null {
      const s = start
      hub.up(e.pointerId)
      if (!s || s.id !== e.pointerId) return null
      start = null
      if (hub.crowd() !== s.crowd) return null
      return { dx: e.clientX - s.x, dy: e.clientY - s.y }
    },
    cancel(e: { pointerId: number }) {
      if (start?.id === e.pointerId) start = null
      hub.up(e.pointerId)
    },
  }
}

/** A wheel that is navigation: a trackpad pinch arrives as a wheel with ctrlKey held, and is the page's zoom, never navigation (Kimi r2 #2). */
export function wheelIsNavigation(e: { ctrlKey: boolean }): boolean {
  return !e.ctrlKey
}

/**
 * Props an experience spreads on its OWN Ω element (a button it draws however it likes): tap, upward swipe, Enter and
 * Space all send the shell's events. The element must be a real button, so keyboard and screen readers reach it.
 */
export function omegaGesture(opts: { onTap?: () => void; onSwipe?: () => void; hub?: PointerHub } = {}) {
  const press = onePointerPress(opts.hub)
  const tap = opts.onTap ?? (() => void usePhase.getState().send('omega-tap'))
  const swipe = opts.onSwipe ?? (() => void usePhase.getState().send('omega-swipe'))
  let handled = false
  return {
    onPointerDown: (e: PointerLike & { currentTarget?: { setPointerCapture(id: number): void } }) => {
      // An upward swipe can finish outside the Omega's bounds; its release still belongs to this press.
      e.currentTarget?.setPointerCapture(e.pointerId)
      press.down(e)
      handled = false
    },
    onPointerUp: (e: PointerLike) => {
      const t = press.up(e)
      // a finger of a pinch (or of a cancelled press) lifting reads as nothing
      if (!t) return
      const g = readGesture(t.dx, t.dy)
      if (g === 'swipe') {
        handled = true
        swipe()
      } else if (g === 'tap') {
        handled = true
        tap()
      }
    },
    onPointerCancel: (e: { pointerId: number }) => {
      press.cancel(e)
    },
    // keyboard (and a click that no pointer press produced, e.g. a screen reader's activation)
    onClick: () => {
      if (handled) {
        handled = false
        return
      }
      tap()
    },
  }
}

/** The shell's one Ask field on the page (the same element in every state; it is never remounted). Every skin's field
 * carries `data-ask-input`; the old `.ask-root .ask-input` matched Classic's field only (contract R1 §5). */
export { ASK_FIELD as ASK_INPUT } from '../features/ask/askField'

/**
 * Wake into the one Ask: the view wakes, and the Ask's own field takes focus in this same task, so the key that woke it
 * (a keystroke at rest) or the invitation that was pressed lands there. The root's state is written at once (the host
 * writes the same in its layout effect) because a field hidden at rest cannot take focus until it is shown.
 */
export function wakeIntoAsk(ev: PhaseEvent = 'type'): boolean {
  const s = usePhase.getState()
  if (!s.phased) return false
  const to = s.send(ev)
  if (typeof document === 'undefined') return false
  document.documentElement.dataset.shellPhase = to
  return focusAskField()
}

/**
 * "Your apps" at rest (Jon 2 Nov, apps first in every look): one visible control wakes the look straight into its apps,
 * and the first app takes focus once the awake view is drawn, so reaching an app (Create among them) from rest is never a
 * hidden step. Returns whether the view is awake.
 */
export function wakeIntoApps(): boolean {
  const s = usePhase.getState()
  if (!s.phased) return false
  // only rest moves (rest → awake); awake stays awake (Kimi P2 on 74df4002: 'navigate' from awake is Pro), and from Pro
  // the press never moves the view
  const to = s.phase === 'rest' ? s.send('navigate') : s.phase
  if (to !== 'awake') return false
  if (typeof document === 'undefined') return true
  document.documentElement.dataset.shellPhase = to
  const first = () => [...document.querySelectorAll<HTMLElement>('[data-intent="apps.open"], [data-intent="apps.more"]')].find((b) => !b.closest('[hidden], [inert], [aria-hidden="true"]'))
  let tries = 0
  const land = () => { const b = first(); if (b) b.focus({ preventScroll: false }); else if (++tries < 10) requestAnimationFrame(land) }
  requestAnimationFrame(land)
  return true
}

/** A keystroke that should wake the rest and be typed into the Ask (printable, no modifier, not already in a field). */
export function typesIntoAsk(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; isComposing?: boolean; defaultPrevented?: boolean }, target: EventTarget | null): boolean {
  // a control that took the key for itself keeps it (Kimi r1 #5): the Ask only gets keys nothing else used
  if (e.defaultPrevented) return false
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false
  if (e.key.length !== 1 || e.key === ' ') return false
  const t = target as HTMLElement | null
  return !(t && typeof t === 'object' && 'tagName' in t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)))
}

/** A phased experience is at rest: notices wait (restNotices) and nothing on the page polls (askMeasure, RestScreen). */
export const restHolds = (s: { phased: boolean; phase: string }): boolean => s.phased && s.phase === 'rest'
