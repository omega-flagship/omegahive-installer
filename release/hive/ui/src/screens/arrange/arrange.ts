// Purpose: the stage's state in this page: what was said and the items it names, kept for this tab, and what the
// person taught it (the shares they dragged splits to, how often each item was in view with each task), kept for them
// in this browser; the stage asks MeTTa to arrange it.
import { useSyncExternalStore } from 'react'
import { onIdentityChange } from '../../lib/identityEpoch'
import type { Goal, StageSaid } from '../../api/types'
import { goalHolder } from '../../experiences/canvas/data'
import type { ScreenBox } from '../../scene/sceneStore'
import type { ArrangeItem, ArrangeState, LearnedShares, Statement } from './arrangeSpace'

/** Where the stage arranges what is shown: CSS px from the viewport's top left. */
export interface StageWindow { x: number; y: number; w: number; h: number }

/**
 * The stage's window: the viewport below the stage's own bar (`top` px) and above the docked Ask's room (`bottom` px),
 * less what the Ask's open thread covers, since the Ask is drawn over the stage. A thread over that window leaves up to
 * four strips, each running the window's whole width or height along one of its edges: above the thread, below it, to
 * its left and to its right. The largest is kept, the first in that order on a tie, so a thread rising over the dock
 * leaves the window above it and one pinned to a side leaves the rest beside it. A thread outside the window, none, or
 * one leaving no strip at all (a full-height sheet) leaves the whole window. Time: O(1).
 */
export function stageWindow(viewport: { w: number; h: number }, top: number, bottom: number, thread: ScreenBox | null): StageWindow {
  const whole: StageWindow = { x: 0, y: top, w: viewport.w, h: Math.max(0, viewport.h - top - bottom) }
  if (!thread) return whole
  const right = whole.x + whole.w
  const low = whole.y + whole.h
  // the part of the thread over the window
  const l = Math.max(whole.x, thread.left)
  const r = Math.min(right, thread.right)
  const t = Math.max(whole.y, thread.top)
  const b = Math.min(low, thread.bottom)
  if (l >= r || t >= b) return whole
  const strips: StageWindow[] = [
    { x: whole.x, y: whole.y, w: whole.w, h: t - whole.y },
    { x: whole.x, y: b, w: whole.w, h: low - b },
    { x: whole.x, y: whole.y, w: l - whole.x, h: whole.h },
    { x: r, y: whole.y, w: right - r, h: whole.h },
  ]
  const best = strips.reduce((a, s) => (s.w * s.h > a.w * a.h ? s : a))
  return best.w * best.h > 0 ? best : whole
}

/** What the stage holds now. */
export interface StageState {
  /** What was said, oldest first. */
  log: Statement[]
  /** Every item a statement named or brought along, by key. */
  items: Record<string, ArrangeItem>
  /** The items each statement said belong to its task (the mind that showed it, for one). */
  relates: { key: string; task: string }[]
  /** The newest statement's number. */
  episode: number
  /** The statement whose arrangement is being credited with interest, and the items credited for it so far. */
  credited: number
  creditedKeys: string[]
  dragging: { group: string; index: number; at: number } | null
  /** The own shape of each item this page has drawn and knows it for (a picture's pixels), kept for this tab. */
  shapes: Record<string, readonly [number, number]>
  /** The newest mind statement heard (its host sequence number), so a resync replays only what this page missed;
   *  -1 until the page knows where its hearing starts. */
  heard: number
  /** What the signed-in person taught the stage. */
  memory: Memory
}
export interface Memory {
  shares: LearnedShares[]
  /** interest[task][key]: how many statements' arrangements had the item in view with the task. */
  interest: Record<string, Record<string, number>>
}

// The tray lists what was shown since the stage last emptied; a person keeps no more chips than this in mind, and an
// older statement than these can no longer change what is drawn.
const LOG_KEPT = 64
const PREFIX = 'omegahive.arrange.v1:'
const EMPTY_MEMORY: Memory = { shares: [], interest: {} }
const fresh = (memory: Memory): StageState => ({ log: [], items: {}, relates: [], episode: 0, credited: 0, creditedKeys: [], dragging: null, shapes: {}, heard: -1, memory })

let principal: string | null = null
let state: StageState = fresh(EMPTY_MEMORY)
const subs = new Set<() => void>()
const set = (next: StageState) => {
  state = next
  subs.forEach((f) => f())
}

function clean(v: unknown): Memory {
  if (typeof v !== 'object' || v === null) return EMPTY_MEMORY
  const m = v as Partial<Memory>
  const shares = Array.isArray(m.shares) ? m.shares.filter((s): s is LearnedShares =>
    !!s && (s.dir === 'row' || s.dir === 'column') && Array.isArray(s.kinds) && Array.isArray(s.shares) && s.kinds.length === s.shares.length &&
    s.kinds.length >= 2 && s.kinds.every((k) => typeof k === 'string') && s.shares.every((x) => typeof x === 'number' && Number.isFinite(x))) : []
  const interest: Memory['interest'] = {}
  if (m.interest && typeof m.interest === 'object') {
    for (const [t, counts] of Object.entries(m.interest)) {
      if (!counts || typeof counts !== 'object') continue
      const kept = Object.entries(counts).filter(([, n]) => typeof n === 'number' && Number.isInteger(n) && n > 0)
      if (kept.length) interest[t] = Object.fromEntries(kept)
    }
  }
  return { shares, interest }
}

function readMemory(who: string): Memory {
  try {
    return clean(JSON.parse(window.localStorage.getItem(PREFIX + who) ?? 'null'))
  } catch {
    return EMPTY_MEMORY
  }
}

/**
 * Keep what the person taught. A browser's storage is shared with the hive's other per-person stores, so when it is full
 * the tasks credited longest ago are let go, half at a time, until what is left fits.
 */
function writeMemory(who: string, m: Memory): void {
  let tasks = Object.keys(m.interest)
  for (;;) {
    try {
      window.localStorage.setItem(PREFIX + who, JSON.stringify({ shares: m.shares, interest: Object.fromEntries(tasks.map((t) => [t, m.interest[t]])) }))
      return
    } catch {
      if (tasks.length === 0) return // storage unavailable: remembered for this page only
      tasks = tasks.slice(Math.ceil(tasks.length / 2))
    }
  }
}

/** Whose stage this is: the signed-in person (the hive's principal), or this browser on a hive that names nobody. */
export function bindPerson(who: string | null): void {
  if (who === principal) return
  principal = who
  set(fresh(who ? readMemory(who) : EMPTY_MEMORY))
}
// a person's stage never outlives their sign-in: a change of person empties it before anyone else sees the change
onIdentityChange(() => {
  principal = null
  set(fresh(EMPTY_MEMORY))
})

/**
 * Something said to the stage, by a mind or the person: the statement, the items it names (so the stage knows what
 * each is without waiting to look it up) and the items that belong to its task.
 */
export function say(statement: Statement, items: ArrangeItem[] = [], relates: { key: string; task: string }[] = []): void {
  const known = { ...state.items }
  for (const it of items) known[it.key] = it
  const log = [...state.log, statement].slice(-LOG_KEPT)
  set({ ...state, log, items: known, relates: [...state.relates.filter((r) => !relates.some((x) => x.key === r.key && x.task === r.task)), ...relates], episode: state.episode + 1, dragging: null })
}

/** A divider in the person's hand, or let go (null). */
export function drag(d: StageState['dragging']): void {
  set({ ...state, dragging: d })
}

/** An item's own shape, as its drawer learned it (a picture's natural pixels); a picture that has none is not stated. */
export function shaped(key: string, w: number, h: number): void {
  if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h))) return
  const was = state.shapes[key]
  if (was && was[0] === w && was[1] === h) return
  set({ ...state, shapes: { ...state.shapes, [key]: [w, h] } })
}

/**
 * A mind's statement, as the hive sent it to this person: said to the stage once, the mind that said it brought along
 * as an item belonging to its task.
 */
export function heard(s: StageSaid): void {
  if (s.seq <= state.heard) return
  const [a, b] = s.items.map((i) => i.key)
  const statement: Statement = s.say === 'compare' ? { say: 'compare', a, b, task: s.task } : s.say === 'show' ? { say: 'show', key: a, task: s.task } : { say: 'recall', key: a }
  const items: ArrangeItem[] = [...s.items.map((i): ArrangeItem => (i.source === 'artifact' ? { key: i.key, source: 'artifact', stored: i.stored } : { key: i.key, source: i.source })),
    { key: s.agent_id, source: 'mind' }]
  say(statement, items, s.task ? [{ key: s.agent_id, task: s.task }] : [])
  set({ ...state, heard: s.seq })
}

/** Where this page's hearing starts: statements up to `seq` were said before it opened, and are not replayed. */
export function heardUpTo(seq: number): void {
  if (seq > state.heard) set({ ...state, heard: seq })
}
export const heardNow = (): number => state.heard

/** The shares the person left a split at, for the same kinds from now on: the newest drag of those kinds wins. */
export function learn(l: LearnedShares): void {
  const same = (x: LearnedShares) => x.dir === l.dir && x.kinds.join(' ') === l.kinds.join(' ')
  const memory = { ...state.memory, shares: [...state.memory.shares.filter((x) => !same(x)), l] }
  if (principal) writeMemory(principal, memory)
  set({ ...state, memory, dragging: null })
}

/**
 * One more time in view with the task for each item MeTTa named, once per item per statement, however late in that
 * statement it comes into view (a page draws its parts a moment after the stage first arranges).
 */
export function credit(episode: number, task: string | null, keys: string[]): void {
  if (episode < state.credited) return
  const before = episode === state.credited ? state.creditedKeys : []
  const newly = task ? keys.filter((k) => !before.includes(k)) : []
  if (!task || newly.length === 0) {
    if (episode !== state.credited) set({ ...state, credited: episode, creditedKeys: [] })
    return
  }
  const counts = { ...(state.memory.interest[task] ?? {}) }
  for (const k of newly) counts[k] = (counts[k] ?? 0) + 1
  // the task credited now moves to the end, so it is the last let go when storage is full
  const rest = Object.fromEntries(Object.entries(state.memory.interest).filter(([t]) => t !== task))
  const memory = { ...state.memory, interest: { ...rest, [task]: counts } }
  if (principal) writeMemory(principal, memory)
  set({ ...state, memory, credited: episode, creditedKeys: [...before, ...newly] })
}

const subscribe = (f: () => void) => {
  subs.add(f)
  return () => {
    subs.delete(f)
  }
}
/** The stage's state now. */
export const useStage = (): StageState => useSyncExternalStore(subscribe, () => state, () => state)

/**
 * The stage's state as MeTTa reads it. A statement's task that is one of the hive's tasks brings that task and the mind
 * holding it along, each belonging to the task; whether either is drawn stays MeTTa's choice.
 * Time: O(l + r + i) for l statements, r relations and i items.
 */
export function stageState(st: StageState, stage: { w: number; h: number }, goals: Record<string, Goal>, parts: { key: string; block: string }[] = []): ArrangeState {
  const items = new Map<string, ArrangeItem>(Object.entries(st.items))
  // the open page's composed parts are items too: MeTTa credits them with the task when the person is back on the page,
  // and brings those with interest beside what is shown
  for (const p of parts) if (!items.has(p.key)) items.set(p.key, { key: p.key, source: 'part', stored: p.block })
  const relates = new Map(st.relates.map((r) => [`${r.key} ${r.task}`, r]))
  const belongs = (key: string, source: ArrangeItem['source'], task: string) => {
    if (!items.has(key)) items.set(key, { key, source })
    relates.set(`${key} ${task}`, { key, task })
  }
  for (const s of st.log) {
    const task = s.say === 'show' || s.say === 'compare' ? s.task : null
    if (!task) continue
    // everything once in view with the task is an item again, whatever look it was drawn in, and MeTTa decides
    // whether it comes back beside what is shown (a mind, a task or a creation, by its id)
    for (const key of Object.keys(st.memory.interest[task] ?? {})) {
      const source = key.startsWith('ar_') ? 'artifact' : key.startsWith('a_') ? 'mind' : key.startsWith('g_') ? 'task' : null
      if (source && !items.has(key)) items.set(key, { key, source })
    }
    const g = goals[task]
    if (!g) continue
    belongs(g.id, 'task', task)
    const holder = goalHolder(g)
    if (holder) belongs(holder, 'mind', task)
  }
  const shapedItems = [...items.values()].map((it) => (st.shapes[it.key] ? { ...it, shape: st.shapes[it.key] } : it))
  return { stage, items: shapedItems, relates: [...relates.values()], interest: st.memory.interest, shares: st.memory.shares, log: st.log, episode: st.episode, dragging: st.dragging ?? undefined }
}
