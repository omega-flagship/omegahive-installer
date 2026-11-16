// Purpose: the Canvas look's board as MeTTa arranges it (board.metta): the look states its swarms, minds, tasks and
// decisions in its own order, and reads MeTTa's answer into the Layout it draws. Where each thing sits and which tasks
// an island shows are MeTTa's; this file only orders the hive's data and reads numbers back.
import { E, S, ValueAtom, type Atom } from '@mettascript/hyperon'
import type { Agent, Approval, Goal, Swarm } from '../sdk'
import { isSym, show, type Val } from '../../lib/mindSpace/atoms'
import { ArrangeError, arrangeSpace } from '../../screens/arrange/arrangeSpace'
import { FREE, type IslandBox, type Item, type ItemKind, type Layout, type Rect } from './layout'

// A failed task stays on its island after the work still going, as Tasks keeps it in Failed: the hive gave up on it and a
// person may Reopen it, so it is not finished (a tester saw a task vanish from the Canvas when it failed).
const ISLAND_ORDER: Record<string, number> = { stalled: 0, waiting: 1, submitted: 2, claimed: 3, open: 4, failed: 5 }
const statusRank = (a: Agent) => (a.status === 'awake' ? 0 : a.status === 'starting' ? 1 : a.status === 'error' ? 2 : a.status === 'asleep' ? 3 : 4)

/** An island as the look states it: its minds, its active tasks and its done ones, each in the look's order. */
export interface Isle {
  id: string
  swarm: Swarm | null
  name: string
  hue: number | null
  members: string[]
  active: string[]
  done: string[]
  /** Every task the swarm has, cancelled ones too, so MeTTa counts the ones an island leaves off. */
  total: number
}
export interface BoardInput {
  isles: Isle[]
  decisions: string[]
  aspect: number
  /** The mind whose chat card is open. */
  open: string | null
}

/**
 * The board's data in the look's order: islands with the most minds first (then by name) and the unassigned minds last;
 * in each, the coordinator first, then by how awake each mind is, then by name; tasks stuck first, through waiting, in
 * review, in progress and open, to failed (then by priority and newest), and done ones newest first. Sorting is the
 * data's order, as a screen's adapter orders its rows; which of them show and where they sit is MeTTa's.
 * Time: O(a log a + g log g) for a minds and g tasks.
 */
export function boardInput(agents: Agent[], swarms: Swarm[], goals: Goal[], decisions: Approval[], aspect: number, open: string | null = null): BoardInput {
  const ids = new Set(swarms.map((s) => s.id))
  const bySwarm = new Map<string, Agent[]>()
  for (const a of agents) {
    const sid = a.swarm_id && ids.has(a.swarm_id) ? a.swarm_id : FREE
    bySwarm.set(sid, [...(bySwarm.get(sid) ?? []), a])
  }
  const goalsBySwarm = new Map<string, Goal[]>()
  for (const g of goals) goalsBySwarm.set(g.swarm_id, [...(goalsBySwarm.get(g.swarm_id) ?? []), g])
  const groups: { id: string; swarm: Swarm | null; name: string; hue: number | null }[] = swarms
    .map((s) => ({ id: s.id, swarm: s, name: s.name, hue: s.hue }))
    .sort((a, b) => (bySwarm.get(b.id)?.length ?? 0) - (bySwarm.get(a.id)?.length ?? 0) || a.name.localeCompare(b.name))
  if (bySwarm.has(FREE)) groups.push({ id: FREE, swarm: null, name: 'Unassigned', hue: null })
  const isles = groups.map((g): Isle => {
    const coord = g.swarm?.coordinator_id
    const members = [...(bySwarm.get(g.id) ?? [])].sort((a, b) => Number(b.id === coord) - Number(a.id === coord) || statusRank(a) - statusRank(b) || a.name.localeCompare(b.name))
    const all = g.swarm ? goalsBySwarm.get(g.id) ?? [] : []
    const active = all.filter((t) => t.status in ISLAND_ORDER)
      .sort((a, b) => ISLAND_ORDER[a.status] - ISLAND_ORDER[b.status] || b.priority - a.priority || b.updated_at.localeCompare(a.updated_at))
    const done = all.filter((t) => t.status === 'done').sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    return { id: g.id, swarm: g.swarm, name: g.name, hue: g.hue, members: members.map((m) => m.id), active: active.map((t) => t.id), done: done.map((t) => t.id), total: all.length }
  })
  return { isles, decisions: decisions.map((d) => d.id), aspect, open }
}

// The board draws every id the store holds, so ids go to MeTTa as strings: a string is data however it is spelled, where a
// symbol spelling a library word (empty, first, max) would run.
const str = (id: string): Atom => ValueAtom(id)
const list = (ids: string[]) => E(...ids.map(str))

function boardAtoms(b: BoardInput): Atom[] {
  if (!Number.isFinite(b.aspect)) throw new ArrangeError('the canvas aspect is not a number')
  const atoms = [
    E(S('BoardAspect'), ValueAtom(b.aspect)),
    E(S('BoardIslands'), E(...b.isles.map((i) => E(S('Isle'), str(i.id), S(i.swarm ? 'yes' : 'no'), list(i.members), list(i.active), list(i.done), ValueAtom(i.total))))),
    E(S('BoardDecisions'), list(b.decisions)),
  ]
  if (b.open) atoms.push(E(S('BoardOpen'), str(b.open)))
  return atoms
}

const num = (v: Val): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ArrangeError(`canvas: ${show(v).slice(0, 60)}`)
  return v
}
const name = (v: Val): string => {
  if (!isSym(v)) throw new ArrangeError(`canvas: ${show(v).slice(0, 60)}`)
  return v.sym
}
/** An id as the look stated it (a string), or the lane's own name (the symbol decisions). */
const idOf = (v: Val): string => (typeof v === 'string' ? v : name(v))
const rect = (v: Val): Rect => {
  if (!Array.isArray(v) || v.length !== 5 || !isSym(v[0], 'Rect')) throw new ArrangeError(`canvas rect: ${show(v).slice(0, 60)}`)
  return { x: num(v[1]), y: num(v[2]), w: num(v[3]), h: num(v[4]) }
}
const KINDS: readonly ItemKind[] = ['mind', 'goal', 'decision', 'island', 'lane', 'add', 'chat']
const IN_ISLAND: readonly ItemKind[] = ['mind', 'goal', 'add', 'chat']

/** The board MeTTa arranged for this data, as the look draws it. */
export function composeBoard(b: BoardInput): Layout {
  const v = arrangeSpace().answer('board-compose', boardAtoms(b))
  // (CanvasArranged mode (IslandBox …) items lane bounds empty focus)
  if (!Array.isArray(v) || v.length !== 8 || !isSym(v[0], 'CanvasArranged')) throw new ArrangeError(`canvas: ${show(v).slice(0, 120)}`)
  const mode = name(v[1])
  if (mode !== 'row' && mode !== 'column') throw new ArrangeError(`canvas lane mode ${mode}`)
  const byId = new Map(b.isles.map((i) => [i.id, i]))
  const islands = (Array.isArray(v[2]) ? v[2] : []).map((x): IslandBox => {
    if (!Array.isArray(x) || x.length !== 9 || !isSym(x[0], 'IslandBox')) throw new ArrangeError(`island: ${show(x).slice(0, 80)}`)
    const isle = byId.get(idOf(x[1]))
    if (!isle) throw new ArrangeError(`an island the look did not state: ${show(x[1])}`)
    return { id: isle.id, swarm: isle.swarm, name: isle.name, hue: isle.hue, members: isle.members, x: num(x[2]), y: num(x[3]), w: num(x[4]), h: num(x[5]),
      cols: num(x[6]), goals: (Array.isArray(x[7]) ? x[7] : []).map(idOf), doneHidden: num(x[8]) }
  })
  const items = new Map<string, Item>()
  for (const x of Array.isArray(v[3]) ? v[3] : []) {
    if (!Array.isArray(x) || x.length !== 8 || !isSym(x[0], 'BoardItem')) throw new ArrangeError(`item: ${show(x).slice(0, 80)}`)
    const kind = name(x[1]) as ItemKind
    if (!KINDS.includes(kind)) throw new ArrangeError(`item kind ${kind}`)
    const id = idOf(x[2])
    const key = `${kind}:${id}`
    items.set(key, { key, kind, id, ...(IN_ISLAND.includes(kind) ? { island: idOf(x[3]) } : {}), x: num(x[4]), y: num(x[5]), w: num(x[6]), h: num(x[7]) })
  }
  return { laneMode: mode, islands, items, lane: rect(v[4]), decisions: b.decisions, bounds: rect(v[5]), empty: isSym(v[6], 'none') ? null : rect(v[6]), laneFocus: rect(v[7]) }
}
