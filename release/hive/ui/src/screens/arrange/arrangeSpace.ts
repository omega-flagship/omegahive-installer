// Purpose: compose the stage's arrangement in MeTTa (screens/arrange/lib_arrange.metta) from one moment's state, and
// read the answer into plain values for the stage to draw.
/**
 * What a mind or a person shows on the hive's stage, and everything around it, is arranged by MeTTa. The page keeps a
 * plain state (the stage's size, the items it has, the statements said, the person's learned shares and the interest
 * each item has in each task); `compose` states it as atoms for one call of `arr-compose`, removes them before it
 * returns, and reads MeTTa's answer. The same state always arranges the same way, as `ScreensSpace.compose` and
 * xmonad's pure layouts do, so TypeScript builds atoms and reads answers and decides nothing about placement.
 *
 * Every key, task and kind is checked here, at the boundary: a symbol MeTTa would read as one of its own library words
 * (`empty`, `first`, `max` …) could run instead of being matched, so only the hive's own id shapes pass.
 */
import { E, S, ValueAtom, type Atom } from '@mettascript/hyperon'
import { isSym, show, type Val } from '../../lib/mindSpace/atoms'
import { AtomRunner, symName } from '../../lib/metta/runner'
import { plural } from '../../lib/plural'
import libArrange from './lib_arrange.metta?raw'
import board from '../../experiences/canvas/board.metta?raw'

/** The rules, then each look's own arrangement on them (the Canvas look's board). */
const ARRANGE_SOURCES: readonly (readonly [string, string])[] = [['lib_arrange', libArrange], ['board', board]]

export class ArrangeError extends Error {}

/** Where an item comes from. Its drawn kind is MeTTa's choice (KindOf), never the page's. A part is one of the open
 *  page's composed parts, its stored kind its block's role. */
export type Source = 'artifact' | 'mind' | 'task' | 'decision' | 'message' | 'part'
export interface ArrangeItem {
  key: string
  source: Source
  /** An artifact's stored kind (free text on the hive: note, plan, image, view …), or a part's role. */
  stored?: string
  /** The item's own shape, width by height in any unit (a picture's pixels), once the page knows it. */
  shape?: readonly [number, number]
}
export type Dir = 'row' | 'column'
export type Statement =
  | { say: 'show'; key: string; task: string | null }
  | { say: 'recall'; key: string }
  | { say: 'compare'; a: string; b: string; task: string | null }
  | { say: 'putAway'; key: string }
  | { say: 'clear' }
export interface LearnedShares {
  dir: Dir
  kinds: string[]
  shares: number[]
}
export interface ArrangeState {
  stage: { w: number; h: number }
  items: ArrangeItem[]
  /** An item belongs to a task: the mind that showed it, the task's holder, the task itself. */
  relates: { key: string; task: string }[]
  /** How many arrangements had each item in view with each task: interest[task][key]. */
  interest: Record<string, Record<string, number>>
  shares: LearnedShares[]
  /** What was said, oldest first. */
  log: Statement[]
  /** The newest statement's number; MeTTa echoes it in `seen`, so interest is credited once per statement. */
  episode: number
  /** A divider in the person's hand: the i-th divider of the group with that id (Divider.group), at that fraction. */
  dragging?: { group: string; index: number; at: number }
}

export type Mode = 'home' | 'focus' | 'side' | 'compare'
export interface Placed {
  key: string
  kind: string
  /** shown, or beside for an item drawn in a strip beside what is shown */
  role: 'shown' | 'beside'
  x: number
  y: number
  w: number
  h: number
}
export interface Divider {
  /** The group it splits, by its path from the outermost group: g, g0 for its first child, g0-1 for that one's second. */
  group: string
  index: number
  dir: Dir
  x: number
  y: number
  w: number
  h: number
  /** The least and most the divider may move to, as fractions of its group's length. */
  lo: number
  hi: number
  kinds: string[]
  shares: number[]
  /** A pointer at p along the divider's direction puts it at (p - offset) / room: the `at` a drag states. */
  offset: number
  room: number
}
export interface Arrangement {
  mode: Mode
  task: string | null
  placed: Placed[]
  dividers: Divider[]
  /** The shown items put away, newest first, that a press brings back. */
  tray: string[]
  /** The items to credit with interest in `task` for `episode`. */
  seen: { episode: number; keys: string[] }
  /** Keys the log names that the page has no item for. */
  unknown: string[]
}

// The hive's ids (ar_…, a_…, g_…, m_…) and conversation ids (ask:…): never a bare library word.
const KEY = /^[a-z]{1,8}_[A-Za-z0-9_-]{1,120}$/
const TASK = /^[a-z]{1,8}[_:][A-Za-z0-9_:.-]{1,120}$/
const STORED = /^[a-z][a-z0-9-]{0,39}$/
const KIND = /^[a-z]{1,16}$/
const SOURCES: readonly Source[] = ['artifact', 'mind', 'task', 'decision', 'message', 'part']

const n = (x: number, what: string): Atom => {
  if (!Number.isFinite(x)) throw new ArrangeError(`${what} is not a finite number`)
  return ValueAtom(x)
}
const key = (k: string): Atom => {
  if (!KEY.test(k)) throw new ArrangeError(`bad key ${JSON.stringify(k).slice(0, 40)}`)
  return S(k)
}
const task = (t: string | null): Atom => {
  if (t === null) return S('none')
  if (!TASK.test(t)) throw new ArrangeError(`bad task ${JSON.stringify(t).slice(0, 40)}`)
  return S(t)
}
const kind = (k: string): Atom => {
  if (!KIND.test(k)) throw new ArrangeError(`bad kind ${JSON.stringify(k).slice(0, 40)}`)
  return S(k)
}
// A group's id is its path in MeTTa, the child indices from the outermost group ((), (0), (0 1)), written g, g0, g0-1
const GROUP = /^g(?:\d+(?:-\d+)*)?$/
const groupPath = (id: string): Atom => {
  if (id.length > 120 || !GROUP.test(id)) throw new ArrangeError(`bad group ${JSON.stringify(id).slice(0, 40)}`)
  return E(...(id === 'g' ? [] : id.slice(1).split('-').map((i) => n(Number(i), 'group path'))))
}

function statementAtom(s: Statement): Atom {
  switch (s.say) {
    case 'show': return E(S('Show'), key(s.key), task(s.task))
    case 'recall': return E(S('Recall'), key(s.key))
    case 'compare': return E(S('Compare'), key(s.a), key(s.b), task(s.task))
    case 'putAway': return E(S('PutAway'), key(s.key))
    case 'clear': return E(S('Clear'))
  }
}

/**
 * The state as atoms. Interest is stated per task as one list, highest first: sorting costs MeTTaScript a binding per
 * step (about 0.3 ms each), and the order is the measured counts themselves; which items are drawn, how many fit and
 * where they go stay MeTTa's.
 * Time: O(i + r + s + l + Σ interest) atoms, with i items, r relations, s learned shares and l statements.
 */
function stateAtoms(st: ArrangeState): Atom[] {
  const atoms: Atom[] = [E(S('Stage'), n(st.stage.w, 'stage width'), n(st.stage.h, 'stage height')), E(S('Episode'), n(st.episode, 'episode'))]
  const keys = new Set<string>()
  for (const it of st.items) {
    if (!SOURCES.includes(it.source)) throw new ArrangeError(`bad source ${String(it.source)}`)
    // one item per key: two would give MeTTa two kinds for it to choose between
    if (keys.has(it.key)) throw new ArrangeError(`item ${it.key} stated twice`)
    keys.add(it.key)
    const kept = it.source === 'artifact' || it.source === 'part'
    const stored = kept && it.stored && STORED.test(it.stored) ? it.stored : kept ? 'other' : 'none'
    atoms.push(E(S('Item'), key(it.key), S(it.source), S(stored)))
    if (it.shape) {
      const [w, h] = it.shape
      if (!(w > 0 && h > 0)) throw new ArrangeError(`item ${it.key} has no shape: ${w} by ${h}`)
      atoms.push(E(S('ItemShape'), key(it.key), n(w, 'shape width'), n(h, 'shape height')))
    }
  }
  for (const r of st.relates) atoms.push(E(S('Relates'), key(r.key), task(r.task)))
  for (const [t, counts] of Object.entries(st.interest)) {
    const ranked = Object.entries(counts).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    atoms.push(E(S('Ranked'), task(t), E(...ranked.map(([k, c]) => E(key(k), n(c, 'interest'))))))
  }
  for (const l of st.shares) {
    if (l.kinds.length !== l.shares.length || l.kinds.length < 2) throw new ArrangeError('learned shares need one share per kind, two or more')
    atoms.push(E(S('Shares'), S(l.dir), E(...l.kinds.map(kind)), E(...l.shares.map((x) => n(x, 'share')))))
  }
  atoms.push(E(S('Log'), E(...[...st.log].reverse().map(statementAtom))))
  if (st.dragging) atoms.push(E(S('Dragging'), groupPath(st.dragging.group), n(st.dragging.index, 'divider'), n(st.dragging.at, 'divider position')))
  return atoms
}

const num = (v: Val, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ArrangeError(`${what}: ${show(v).slice(0, 60)}`)
  return v
}
const list = (v: Val, what: string): Val[] => {
  if (!Array.isArray(v)) throw new ArrangeError(`${what}: ${show(v).slice(0, 60)}`)
  return v
}
const word = (v: Val, what: string): string => {
  if (!isSym(v)) throw new ArrangeError(`${what}: ${show(v).slice(0, 60)}`)
  return v.sym
}

function readPlaced(v: Val): Placed {
  const p = list(v, 'placed')
  if (p.length !== 8 || !isSym(p[0], 'Placed')) throw new ArrangeError(`placed: ${show(v).slice(0, 80)}`)
  const role = word(p[3], 'role')
  if (role !== 'shown' && role !== 'beside') throw new ArrangeError(`placed role ${role}`)
  return { key: word(p[1], 'key'), kind: word(p[2], 'kind'), role, x: num(p[4], 'x'), y: num(p[5], 'y'), w: num(p[6], 'w'), h: num(p[7], 'h') }
}
function readDivider(v: Val): Divider {
  const d = list(v, 'divider')
  if (d.length !== 14 || !isSym(d[0], 'Divider')) throw new ArrangeError(`divider: ${show(v).slice(0, 80)}`)
  const dir = word(d[3], 'direction')
  if (dir !== 'row' && dir !== 'column') throw new ArrangeError(`divider direction ${dir}`)
  return {
    group: 'g' + list(d[1], 'group path').map((i) => num(i, 'group path')).join('-'), index: num(d[2], 'index'), dir, x: num(d[4], 'x'), y: num(d[5], 'y'), w: num(d[6], 'w'), h: num(d[7], 'h'),
    lo: num(d[8], 'lo'), hi: num(d[9], 'hi'), kinds: list(d[10], 'kinds').map((k) => word(k, 'kind')), shares: list(d[11], 'shares').map((x) => num(x, 'share')),
    offset: num(d[12], 'offset'), room: num(d[13], 'room'),
  }
}
const MODES: readonly Mode[] = ['home', 'focus', 'side', 'compare']

/** (Arranged mode task placed dividers tray (Seen n keys) unknown) into plain values. */
function readArrangement(v: Val): Arrangement {
  const a = list(v, 'arrangement')
  if (a.length !== 8 || !isSym(a[0], 'Arranged')) throw new ArrangeError(`unexpected ${show(v).slice(0, 120)}`)
  const mode = word(a[1], 'mode') as Mode
  if (!MODES.includes(mode)) throw new ArrangeError(`mode ${mode}`)
  const t = word(a[2], 'task')
  const seen = list(a[6], 'seen')
  if (seen.length !== 3 || !isSym(seen[0], 'Seen')) throw new ArrangeError(`seen: ${show(a[6]).slice(0, 60)}`)
  return {
    mode,
    task: t === 'none' ? null : t,
    placed: list(a[3], 'placed').map(readPlaced),
    dividers: list(a[4], 'dividers').map(readDivider),
    tray: list(a[5], 'tray').map((k) => word(k, 'tray key')),
    seen: { episode: num(seen[1], 'episode'), keys: list(seen[2], 'seen keys').map((k) => word(k, 'seen key')) },
    unknown: list(a[7], 'unknown').map((k) => word(k, 'unknown key')),
  }
}

export class ArrangeSpace {
  private readonly runner: AtomRunner

  private constructor() {
    this.runner = new AtomRunner(ARRANGE_SOURCES, ArrangeError)
  }

  /** A space holding the arrangement rules. */
  static open(): ArrangeSpace {
    return new ArrangeSpace()
  }

  /**
   * MeTTa arranges this state. Its atoms live in the space only for this call (synchronous, so no other call sees them)
   * and are removed before it returns, whatever happens.
   */
  compose(st: ArrangeState): Arrangement {
    return readArrangement(this.answer('arr-compose', stateAtoms(st)))
  }

  /**
   * MeTTa's answer to `head` with these atoms stated: they live in the space only for this call (synchronous, so no
   * other call sees them) and are removed before it returns, whatever happens.
   */
  answer(head: string, atoms: Atom[]): Val {
    const space = this.runner.m.space()
    for (const a of atoms) space.addAtom(a)
    let gone: number
    let out: Val
    try {
      out = this.runner.query(head)
    } finally {
      gone = space.removeAtoms(atoms)
    }
    // an atom left behind would change every later arrangement: refuse rather than draw from a dirty space
    if (gone !== atoms.length) throw new ArrangeError(`removed ${gone} of ${plural(atoms.length, 'atom')}`)
    return out
  }

  /** Guards over the vocabulary: each must be empty (the tests check them). */
  guards(): Record<'kindsWithoutSize' | 'kindsWithoutLeast' | 'leastAboveSize', string[]> {
    const names = (head: string) => {
      const v = this.runner.query(head)
      return (Array.isArray(v) ? v : []).map(symName)
    }
    return { kindsWithoutSize: names('arr-kinds-without-size'), kindsWithoutLeast: names('arr-kinds-without-least'), leastAboveSize: names('arr-least-above-size') }
  }
}

let shared: ArrangeSpace | null = null
/** The page's one arrangement space (the stage and the Canvas board), opened on first use. */
export function arrangeSpace(): ArrangeSpace {
  return (shared ??= ArrangeSpace.open())
}
