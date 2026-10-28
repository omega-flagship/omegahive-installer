/**
 * Quiet: resting mode (the owner, 2026-10-05: "when no user input for some time it just goes into a resting animation while
 * it works quietly in the background and subtle alerts are displayed along with a clock"; Ask design §resting).
 *
 * Pure. Built ONLY from events this page received while resting; it carries counts and titles, never a body (no
 * message, Ask answer, note or app content), because a resting screen may be on a visible screen.
 */

import { plural } from '../../lib/plural'

export type RestAlertKind = 'ask' | 'goal' | 'thread' | 'power' | 'decision'
export interface RestAlert {
  kind: RestAlertKind
  /** A title only (a goal's title); null when the event has none we may show. */
  title: string | null
  /** De-duplicates repeats of the same thing (a goal re-sent, many frames of one answer). */
  key: string
}

export interface RestView {
  resting: boolean
  lastInput: number
  /** Alerts still to show, one at a time, oldest first. */
  queue: RestAlert[]
  /** The alert on screen. */
  showing: RestAlert | null
  /** Everything received while resting (for the summary). */
  away: RestAlert[]
  /** The "While you were away: …" line, after waking (null when nothing happened). */
  summary: string | null
  /** What that line is about (kept after waking so each kind is still a way in). */
  missed: RestAlert[]
  /**
   * The sign-in everything above was gathered under (readContext(client, store session): the client instance, its
   * credential handle and the store's session). Review B1: alerts, counts, the summary and their ways in belong to that
   * identity only; on any change they are dropped at once (the `identity` action), never shown or acted on again.
   */
  ctx: string
}

export const restInitial = (now: number, ctx = ''): RestView => ({ resting: false, lastInput: now, queue: [], showing: null, away: [], summary: null, missed: [], ctx })

export type RestAction =
  | { type: 'input'; at: number }
  /** `lastInput` from the page (inputs while awake are tracked outside the state, so moving the mouse never re-renders). */
  | { type: 'tick'; at: number; idleMs: number; blocked?: boolean; lastInput?: number }
  /**
   * `ctx`: the identity the event arrived under; an alert for any other identity is never admitted. `admin`: the
   * viewer's scope as it arrives; what this viewer is not shown (people's asks, for non-admins) is never recorded, so
   * neither the line nor the history ("While you were away") can carry it.
   */
  | { type: 'alert'; alert: RestAlert; ctx: string; admin: boolean }
  /** A sign-in change (or the page losing its sign-in): everything gathered is dropped, bound to `ctx` from now on. */
  | { type: 'identity'; ctx: string; at: number }
  /** The page may no longer rest (not ready, power off): purge, never wake into a summary. */
  | { type: 'reset'; ctx: string; at: number }
  | { type: 'urgent'; at: number }
  | { type: 'next' }
  | { type: 'clearSummary' }
  /** One way in was taken: only that kind leaves the actions; the history stays until dismissed or nothing is left. */
  | { type: 'acted'; chip: RestChipId }

/** The viewer scope every recorded alert passes (the same rule liveAlerts and restCounts apply): asks are admin business. */
const inScope = (a: RestAlert, admin: boolean): boolean => admin || a.kind !== 'ask'

/** Stand-in Review 4: the away bar shows while it has words AND at least one live action; nothing left to act on, it goes. */
export const awayBarShown = (summary: string | null, liveActions: number): boolean => !!summary && liveActions > 0

const cap = (t: string, n = 60) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t)

export function restReducer(v: RestView, a: RestAction): RestView {
  switch (a.type) {
    case 'input':
    case 'urgent':
      // any input wakes; an urgent item (a decision, a budget refusal) wakes too, so it surfaces as it always does
      if (!v.resting) return a.type === 'input' ? { ...v, lastInput: a.at } : v
      return { ...v, resting: false, lastInput: a.at, queue: [], showing: null, away: [], summary: awaySummary(v.away), missed: v.away }
    case 'tick':
      if (v.resting || a.blocked || a.idleMs <= 0 || a.at - Math.max(v.lastInput, a.lastInput ?? 0) < a.idleMs) return v
      return { ...v, resting: true, queue: [], showing: null, away: [], summary: null, missed: [] }
    case 'identity':
    case 'reset':
      return restInitial(a.at, a.ctx)
    case 'alert': {
      if (a.ctx !== v.ctx || !v.resting || !inScope(a.alert, a.admin) || v.away.some((x) => x.key === a.alert.key)) return v
      const away = [...v.away, a.alert]
      return v.showing ? { ...v, away, queue: [...v.queue, a.alert] } : { ...v, away, showing: a.alert }
    }
    case 'next':
      return { ...v, showing: v.queue[0] ?? null, queue: v.queue.slice(1) }
    case 'clearSummary':
      return { ...v, summary: null, missed: [] }
    case 'acted': {
      const kinds = CHIP_KINDS[a.chip]
      const missed = v.missed.filter((x) => !kinds.includes(x.kind))
      return missed.length ? { ...v, missed } : { ...v, missed, summary: null }
    }
  }
}

const WORDS: Record<RestAlertKind, [string, string]> = {
  ask: ['ask waiting', 'asks waiting'],
  goal: ['task done', 'tasks done'],
  thread: ['thread answered', 'threads answered'],
  power: ['power change', 'power changes'],
  decision: ['decision waiting', 'decisions waiting'],
}

/** "While you were away: 2 tasks done (“Ship the map”, “Tidy notes”), 1 ask waiting." Null when nothing came. */
export function awaySummary(away: RestAlert[]): string | null {
  if (!away.length) return null
  const parts = (['decision', 'goal', 'ask', 'thread', 'power'] as const)
    .map((k) => {
      const xs = away.filter((x) => x.kind === k)
      if (!xs.length) return null
      const titles = xs.map((x) => x.title).filter((t): t is string => !!t)
      const shown = titles.slice(0, 2).map((t) => `“${cap(t, 40)}”`)
      const more = titles.length - shown.length
      return `${xs.length} ${WORDS[k][xs.length === 1 ? 0 : 1]}${shown.length ? ` (${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''})` : ''}`
    })
    .filter(Boolean)
  return `While you were away: ${parts.join(', ')}.`
}

/** The one line an alert shows while resting. */
export function alertLine(a: RestAlert): string {
  if (a.kind === 'goal') return a.title ? `Task done: ${cap(a.title)}` : 'A task is done'
  if (a.kind === 'ask') return 'An ask is waiting for you'
  if (a.kind === 'power') return 'Minds were woken'
  if (a.kind === 'decision') return 'A decision is waiting for you'
  return 'A thread was answered'
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null)
const title = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? cap(v.trim().replace(/\s+/g, ' '), 80) : null)

/**
 * A subtle alert for an event this page received, or null. Only titles are read: a goal's title, never its detail;
 * a person ask's kind, never its note; an Ask answer's existence, never its text.
 */
export function restAlertFor(e: unknown): RestAlert | null {
  const o = rec(e)
  if (!o) return null
  if (o.type === 'goal.updated') {
    const g = rec(o.goal)
    if (g && g.status === 'done' && typeof g.id === 'string') return { kind: 'goal', title: title(g.title), key: `goal:${g.id}` }
  }
  if (o.type === 'person_request.created') {
    const r = rec(o.request)
    if (r && r.status === 'pending' && typeof r.id === 'string') return { kind: 'ask', title: null, key: `ask:${r.id}` }
  }
  if (o.type === 'ask' && o.phase === 'answer' && typeof o.operation_id === 'string') return { kind: 'thread', title: null, key: `thread:${o.operation_id}` }
  // a decision waits quietly (Surface resting brief: "approvals waiting" are a subtle alert); the minds wait for it
  if (o.type === 'approval.created') {
    const ap = rec(o.approval)
    if (ap && ap.status === 'pending' && typeof ap.id === 'string') return { kind: 'decision', title: null, key: `decision:${ap.id}` }
  }
  // the hive is on while this page rests, so an "on" is a Wake all; an "off" ends the rest (the off screen wins)
  if (o.type === 'hive.power' && o.state === 'on') return { kind: 'power', title: null, key: `power:${typeof o.since === 'string' ? o.since : o.at ?? ''}` }
  return null
}

/**
 * Items that end the rest, so they surface as they always do: budget refusals (a mind is being stopped from working).
 * Decisions no longer do: they wait as a count among the subtle alerts (the Inbox count, always shown while resting).
 */
export function isUrgent(e: unknown): boolean {
  const o = rec(e)
  if (!o) return false
  if (o.type === 'budget.refused') return true
  // a decision that needs the person comes straight through (the approved Quiet design): it wakes the page
  if (o.type === 'approval.created') return rec(o.approval)?.status === 'pending'
  return false
}

// ---- the person's own setting (this browser) ----

const PREF = 'omegahive.rest'
export const REST_CHOICES = [1, 2, 5, 10, 0] as const
export interface RestPrefs {
  /** Minutes without input before resting; 0 = never. */
  minutes: number
}
export function readRestPrefs(): RestPrefs {
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(PREF)
    const v = raw ? (JSON.parse(raw) as Partial<RestPrefs>) : null
    if (v && typeof v.minutes === 'number' && v.minutes >= 0 && v.minutes <= 120) return { minutes: v.minutes }
  } catch {
    /* unreadable: the default */
  }
  return { minutes: 2 }
}
export function writeRestPrefs(p: RestPrefs): void {
  try {
    window.localStorage.setItem(PREF, JSON.stringify(p))
  } catch {
    /* this page only */
  }
}

// ---- what may start a rest, and what ends one (pure; RestScreen.tsx reads the page into these shapes) ----

/** What the page is doing right now that a rest must never interrupt or cover. */
export interface RestProbe {
  /** The tab is in the background (nothing to show; the idle check waits). */
  hidden: boolean
  /** A dialog or confirm is open (aria-modal): a rest never covers one. */
  modal: boolean
  /** A press or drag is in progress. */
  pointerDown: boolean
  /** An input method is composing. */
  composing: boolean
  /** The focused field holds words not yet sent: the person is mid-typing. */
  draft: boolean
}
export const restBlocked = (p: RestProbe): boolean => p.hidden || p.modal || p.pointerDown || p.composing || p.draft

/** An input the page saw while resting, reduced to what decides waking. */
export interface RestInput {
  type: 'pointermove' | 'pointerdown' | 'touchstart' | 'keydown' | 'wheel' | 'input' | 'scroll'
  /** keydown: the key, and whether a command modifier was held. */
  key?: string
  mod?: boolean
  /** pointer: where it is now (screen px). */
  x?: number
  y?: number
  /** The press began on the rest itself (it wakes at once; a shield catches its click so it never lands on the page). */
  onRest?: boolean
  /** The press began on one of the rest's alerts (its click wakes and goes there). */
  onChip?: boolean
  /** The keystroke is going into a text field already. */
  intoField?: boolean
}

/** A pointer that moved less than this did not move: some browsers send a move when the layer appears under it. */
export const MOVE_SLOP = 4

/**
 * Whether an input wakes the rest, and whether its keystroke should be handed to the Ask (a printable key typed with
 * no text field focused). The input itself is never consumed: the keystroke goes on to wherever it was going.
 */
export function wakeFor(e: RestInput, lastPointer: { x: number; y: number } | null): { wake: boolean; typeIntoAsk: boolean; shield: boolean } {
  const no = { wake: false, typeIntoAsk: false, shield: false }
  switch (e.type) {
    case 'pointermove': {
      if (e.x === undefined || e.y === undefined || !lastPointer) return no
      return { ...no, wake: Math.hypot(e.x - lastPointer.x, e.y - lastPointer.y) > MOVE_SLOP }
    }
    case 'pointerdown':
    case 'touchstart':
      // Kimi 2: any touch wakes at once (a click that never comes can never swallow it); an alert's own click goes there
      if (e.onChip) return no
      return { ...no, wake: true, shield: !!e.onRest }
    case 'keydown':
      return { wake: true, typeIntoAsk: !!e.key && e.key.length === 1 && !e.mod && !e.intoField, shield: false }
    case 'wheel':
    case 'input':
      return { ...no, wake: true }
    case 'scroll':
      // a scroll by itself may be the page moving itself (a log following new lines): it never wakes
      return no
  }
}

/** Kimi 2: what ends a press, so a press that never ends cleanly (a long-press menu, a lost pointerup) cannot hold. */
export const PRESS_ENDS = ['pointerup', 'pointercancel', 'blur', 'visibilitychange'] as const
/**
 * Kimi r2 1: whether a pointer event ends a press. A release outside the window is never seen as a pointerup, but the
 * next move over the page reports no buttons held (window pointerleave does not fire for element leaves: not relied on).
 */
export function pressEndedBy(e: { type: string; buttons: number }): boolean {
  if (e.type === 'pointerup' || e.type === 'pointercancel') return true
  return e.type === 'pointermove' && e.buttons === 0
}
/** Kimi r2 3: the click shield is drawn only for the sign-in and the wake that raised it. */
export const shieldShown = (shieldCtx: string | null, ctx: string, resting: boolean): boolean => !resting && shieldCtx !== null && shieldCtx === ctx
/** A press held this long without any other input is treated as over (nothing ended it that the page saw). */
export const PRESS_STALE_MS = 30_000
export const pressHeld = (pressedAt: number | null, now: number): boolean => pressedAt !== null && now - pressedAt <= PRESS_STALE_MS

/** Kimi 3: a scroll within this long of the person's own input is their momentum (counts as presence); later, it is the page's. */
export const MOMENTUM_MS = 2_500
export const scrollIsPresence = (now: number, lastRealInput: number): boolean => now - lastRealInput <= MOMENTUM_MS

/** Kimi 1: a decision alert counts only while that decision is still pending; settled elsewhere, it is gone everywhere. */
export function liveAlerts(alerts: RestAlert[], pendingDecisions: ReadonlySet<string>, admin = true): RestAlert[] {
  return alerts.filter((a) => (a.kind !== 'decision' || pendingDecisions.has(a.key.slice('decision:'.length))) && (admin || a.kind !== 'ask'))
}

/** The away line's ways in: exactly the kinds its words name (decisions only while some are still pending). */
export function awayChips(missedLive: RestAlert[], decisionsNow: number): RestChip[] {
  const decided = missedLive.some((a) => a.kind === 'decision')
  return restChips(restCounts({ decisions: decided ? decisionsNow : 0, health: 0 }, missedLive, true))
}

/**
 * Where a keystroke typed while resting goes: the Ask in this experience (Classic's capsule, Still's own question box
 * or its floating line), or the experience's own command line where that is its Ask (Construct). First match wins.
 */
export const TYPE_TARGETS = ['.still .st-ask-input', '.ask-root .ask-input', '.ask-root .ask-still-input', '[data-rest-type]'] as const

// ---- the glanceable alerts: counts, each one a way in ----

export interface RestCounts {
  /** Decisions waiting in the Inbox (pending approvals). */
  decisions: number
  /** Minds with health alerts not yet looked at. */
  health: number
  /** Received while resting. */
  asks: number
  goals: number
  answers: number
  power: number
}
export type RestChipId = keyof RestCounts
export interface RestChip {
  id: RestChipId
  n: number
  label: string
}


/** Counts while resting, from the store (what waits) and what arrived (what happened). Needs-you first. */
export function restCounts(waiting: { decisions: number; health: number }, away: RestAlert[], admin = false): RestCounts {
  const n = (k: RestAlertKind) => away.filter((a) => a.kind === k).length
  // Kimi 4: health alerts and people's asks are admin business (the live hive sends them to admins, and a person's own
  // ask to that person); the rest scopes them to admins itself rather than trusting every host to have filtered them
  return { decisions: waiting.decisions, health: admin ? waiting.health : 0, asks: admin ? n('ask') : 0, goals: n('goal'), answers: n('thread'), power: n('power') }
}

export function restChips(c: RestCounts): RestChip[] {
  const out: RestChip[] = []
  if (c.decisions) out.push({ id: 'decisions', n: c.decisions, label: plural(c.decisions, 'decision waiting', 'decisions waiting') })
  if (c.asks) out.push({ id: 'asks', n: c.asks, label: plural(c.asks, 'person asking', 'people asking') })
  if (c.health) out.push({ id: 'health', n: c.health, label: plural(c.health, 'mind needs you', 'minds need you') })
  if (c.goals) out.push({ id: 'goals', n: c.goals, label: plural(c.goals, 'task finished', 'tasks finished') })
  if (c.answers) out.push({ id: 'answers', n: c.answers, label: plural(c.answers, 'answer ready', 'answers ready') })
  if (c.power) out.push({ id: 'power', n: c.power, label: 'Minds were woken' })
  return out
}

/** Where tapping a chip goes (after waking). `task`: the one task, when exactly one finished (Tasks opens its card). */
export type RestDestination = { name: 'approvals' } | { name: 'health' } | { name: 'tasks'; task?: string } | { name: 'thread' } | { name: 'hive' }
export function chipDestination(id: RestChipId, away: RestAlert[]): RestDestination {
  switch (id) {
    case 'decisions':
    case 'asks':
      return { name: 'approvals' }
    case 'health':
      return { name: 'health' }
    case 'goals': {
      const goals = away.filter((a) => a.kind === 'goal')
      return goals.length === 1 ? { name: 'tasks', task: goals[0].key.slice('goal:'.length) } : { name: 'tasks' }
    }
    case 'answers':
      return { name: 'thread' }
    case 'power':
      return { name: 'hive' }
  }
}

/** The quiet sign that the hive is still working: "3 minds awake · 1 thinking". */
export function workingLine(awake: number, thinking: number): string {
  if (!awake) return 'All minds are resting'
  return `${plural(awake, 'mind', 'minds')} awake${thinking ? ` · ${thinking} thinking` : ''}`
}

/** The alert kinds each way in stands for (what `acted` removes from the actions). */
export const CHIP_KINDS: Record<RestChipId, RestAlertKind[]> = {
  decisions: ['decision'],
  asks: ['ask'],
  health: [],
  goals: ['goal'],
  answers: ['thread'],
  power: ['power'],
}

/** The way in from the "While you were away" line, per kind. */
export const CHIP_VERB: Record<RestChipId, string> = {
  decisions: 'See decisions',
  asks: 'See asks',
  health: 'See health',
  goals: 'See tasks',
  answers: 'Open the thread',
  power: 'See minds',
}

/** The hive's power wins: a page rests only when signed in and ready with no power screen up (Off, lighting, report). */
export const restAllowed = (ready: boolean, powerScreen: 'none' | 'off' | 'lighting' | 'report'): boolean => ready && powerScreen === 'none'

/** A rest's scene animates only with motion allowed and the page visible; otherwise it is one still frame. */
export const sceneLoops = (reduced: boolean, hidden: boolean): boolean => !reduced && !hidden
