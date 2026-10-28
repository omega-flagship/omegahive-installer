import type { Agent, Approval, Goal, Swarm } from '../sdk'

/** World units (px at 100%). */
export const CARD_W = 268
export const CARD_H = 184
export const GAP = 20
export const PAD = 36
export const HEAD = 136
export const ST_W = 204
export const ST_H = 156
export const ST_GAP = 18
export const LANE_W = 316
export const DEC_H = 236
export const DEC_GAP = 22
export const LANE_HEAD = 132
export const CHAT_W = 404
export const CHAT_H = 548
export const ISLAND_GAP = 150
export const FREE = '__free'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type ItemKind = 'mind' | 'goal' | 'decision' | 'island' | 'lane' | 'add'

export interface Item extends Rect {
  key: string
  kind: ItemKind
  id: string
  island?: string
}

export interface IslandBox extends Rect {
  id: string
  swarm: Swarm | null
  name: string
  hue: number | null
  members: string[]
  goals: string[]
  doneHidden: number
  cols: number
}

export interface Layout {
  /** column: Decisions to the right (landscape). row: a strip across the top (portrait). */
  laneMode: 'column' | 'row'
  islands: IslandBox[]
  items: Map<string, Item>
  lane: Rect
  decisions: string[]
  bounds: Rect
  empty: Rect | null
}

const ACTIVE_ORDER: Record<string, number> = { stalled: 0, waiting: 1, submitted: 2, claimed: 3, open: 4 }

export function goalOrder(goals: Goal[]): { shown: Goal[]; hidden: number } {
  const active = goals.filter((g) => g.status in ACTIVE_ORDER)
  active.sort((a, b) => ACTIVE_ORDER[a.status] - ACTIVE_ORDER[b.status] || b.priority - a.priority || b.updated_at.localeCompare(a.updated_at))
  const done = goals.filter((g) => g.status === 'done').sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  const shown = [...active.slice(0, 8), ...done.slice(0, Math.max(0, 3 - Math.min(active.length, 3)))]
  return { shown, hidden: goals.length - shown.length }
}

const statusRank = (a: Agent) => (a.status === 'awake' ? 0 : a.status === 'starting' ? 1 : a.status === 'error' ? 2 : a.status === 'asleep' ? 3 : 4)

export const pendingDecisions = (approvals: Record<string, Approval>): Approval[] => {
  const rank = { high: 0, medium: 1, low: 2 } as const
  return Object.values(approvals)
    .filter((a) => a.status === 'pending')
    .sort((a, b) => rank[a.risk] - rank[b.risk] || b.created_at.localeCompare(a.created_at))
}

/** Deterministic board layout: shelf-packed swarm islands, then the Decisions lane to the right. */
export function computeLayout(agents: Agent[], swarms: Swarm[], goals: Goal[], decisions: Approval[], aspect = 1.6): Layout {
  const portrait = aspect < 0.85
  const items = new Map<string, Item>()
  const bySwarm = new Map<string, Agent[]>()
  const swarmIds = new Set(swarms.map((s) => s.id))
  for (const a of agents) {
    const sid = a.swarm_id && swarmIds.has(a.swarm_id) ? a.swarm_id : FREE
    if (!bySwarm.has(sid)) bySwarm.set(sid, [])
    bySwarm.get(sid)!.push(a)
  }
  const goalsBySwarm = new Map<string, Goal[]>()
  for (const g of goals) {
    if (!goalsBySwarm.has(g.swarm_id)) goalsBySwarm.set(g.swarm_id, [])
    goalsBySwarm.get(g.swarm_id)!.push(g)
  }

  const groups: { id: string; swarm: Swarm | null; name: string; hue: number | null }[] = swarms
    .map((s) => ({ id: s.id, swarm: s, name: s.name, hue: s.hue }))
    .sort((a, b) => (bySwarm.get(b.id)?.length ?? 0) - (bySwarm.get(a.id)?.length ?? 0) || a.name.localeCompare(b.name))
  if (bySwarm.has(FREE)) groups.push({ id: FREE, swarm: null, name: 'Unassigned', hue: null })

  const boxes: IslandBox[] = groups.map((g) => {
    const coord = g.swarm?.coordinator_id
    const members = (bySwarm.get(g.id) ?? []).sort((a, b) => Number(b.id === coord) - Number(a.id === coord) || statusRank(a) - statusRank(b) || a.name.localeCompare(b.name))
    const n = Math.max(1, members.length)
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3
    const rows = Math.ceil(n / cols)
    const cardsH = rows * CARD_H + (rows - 1) * GAP
    const { shown, hidden } = g.swarm ? goalOrder(goalsBySwarm.get(g.id) ?? []) : { shown: [], hidden: 0 }
    const slots = g.swarm ? shown.length + 1 : 0
    const perCol = Math.max(2, Math.floor((cardsH + ST_GAP) / (ST_H + ST_GAP)))
    const gcols = slots === 0 ? 0 : slots <= perCol ? 1 : 2
    const goalRows = gcols ? Math.ceil(slots / gcols) : 0
    const goalsH = goalRows ? goalRows * ST_H + (goalRows - 1) * ST_GAP : 0
    const cardsW = cols * CARD_W + (cols - 1) * GAP
    const goalsW = gcols ? 44 + gcols * ST_W + (gcols - 1) * ST_GAP : 0
    const w = Math.max(PAD * 2 + cardsW + goalsW, 520)
    const h = HEAD + Math.max(cardsH, goalsH) + PAD
    return { id: g.id, swarm: g.swarm, name: g.name, hue: g.hue, members: members.map((m) => m.id), goals: shown.map((x) => x.id), doneHidden: hidden, cols, x: 0, y: 0, w, h }
  })

  // shelf packing
  const area = boxes.reduce((s, b) => s + b.w * b.h, 0)
  const widest = boxes.reduce((m, b) => Math.max(m, b.w), 0)
  const target = Math.max(widest, Math.sqrt(area * Math.max(0.3, aspect)) * (portrait ? 1.05 : 1.2))
  let cx = 0
  let cy = 0
  let rowH = 0
  let right = 0
  for (const b of boxes) {
    if (cx > 0 && cx + b.w > target) {
      cx = 0
      cy += rowH + ISLAND_GAP
      rowH = 0
    }
    b.x = cx
    b.y = cy
    cx += b.w + ISLAND_GAP
    rowH = Math.max(rowH, b.h)
    right = Math.max(right, b.x + b.w)
  }
  const contentH = boxes.length ? cy + rowH : 0

  let empty: Rect | null = null
  if (!boxes.length) {
    empty = { x: 0, y: 0, w: 640, h: 380 }
    right = 640
  }

  for (const b of boxes) {
    items.set(`island:${b.id}`, { key: `island:${b.id}`, kind: 'island', id: b.id, x: b.x, y: b.y, w: b.w, h: b.h })
    b.members.forEach((id, i) => {
      const c = i % b.cols
      const r = Math.floor(i / b.cols)
      items.set(`mind:${id}`, { key: `mind:${id}`, kind: 'mind', id, island: b.id, x: b.x + PAD + c * (CARD_W + GAP), y: b.y + HEAD + r * (CARD_H + GAP), w: CARD_W, h: CARD_H })
    })
    if (b.swarm) {
      const n = Math.max(1, b.members.length)
      const rows = Math.ceil(n / b.cols)
      const cardsH = rows * CARD_H + (rows - 1) * GAP
      const perCol = Math.max(2, Math.floor((cardsH + ST_GAP) / (ST_H + ST_GAP)))
      const slots = b.goals.length + 1
      const gcols = slots <= perCol ? 1 : 2
      const gx = b.x + PAD + b.cols * CARD_W + (b.cols - 1) * GAP + 44
      const per = Math.ceil(slots / gcols)
      const place = (i: number) => ({ x: gx + Math.floor(i / per) * (ST_W + ST_GAP), y: b.y + HEAD + (i % per) * (ST_H + ST_GAP) })
      b.goals.forEach((id, i) => items.set(`goal:${id}`, { key: `goal:${id}`, kind: 'goal', id, island: b.id, ...place(i), w: ST_W, h: ST_H }))
      items.set(`add:${b.id}`, { key: `add:${b.id}`, kind: 'add', id: b.id, island: b.id, ...place(b.goals.length), w: ST_W, h: ST_H })
    }
  }

  if (portrait) {
    // Decisions first: a strip across the top, islands below it
    const n = Math.max(1, decisions.length)
    const laneW = Math.max(right, 40 + n * (LANE_W - 40) + (n - 1) * DEC_GAP)
    const laneH = LANE_HEAD + DEC_H + 36
    const shift = laneH + ISLAND_GAP
    for (const it of items.values()) it.y += shift
    for (const b of boxes) b.y += shift
    if (empty) empty.y += shift
    const lane = { x: 0, y: 0, w: laneW, h: laneH }
    items.set('lane:decisions', { key: 'lane:decisions', kind: 'lane', id: 'decisions', ...lane })
    decisions.forEach((d, i) =>
      items.set(`decision:${d.id}`, { key: `decision:${d.id}`, kind: 'decision', id: d.id, x: 20 + i * (LANE_W - 40 + DEC_GAP), y: LANE_HEAD, w: LANE_W - 40, h: DEC_H }),
    )
    const bounds = { x: 0, y: 0, w: Math.max(laneW, right), h: shift + Math.max(contentH, empty ? empty.h : 0) }
    return { laneMode: 'row', islands: boxes, items, lane, decisions: decisions.map((d) => d.id), bounds, empty }
  }
  const laneX = right + ISLAND_GAP + 20
  const laneH = Math.max(contentH, empty ? empty.h : 0, LANE_HEAD + Math.max(1, decisions.length) * (DEC_H + DEC_GAP) + 24, 520)
  const lane = { x: laneX, y: 0, w: LANE_W, h: laneH }
  items.set('lane:decisions', { key: 'lane:decisions', kind: 'lane', id: 'decisions', ...lane })
  decisions.forEach((d, i) =>
    items.set(`decision:${d.id}`, { key: `decision:${d.id}`, kind: 'decision', id: d.id, x: laneX + 20, y: LANE_HEAD + i * (DEC_H + DEC_GAP), w: LANE_W - 40, h: DEC_H }),
  )
  const bounds = { x: 0, y: 0, w: laneX + LANE_W, h: laneH }
  return { laneMode: 'column', islands: boxes, items, lane, decisions: decisions.map((d) => d.id), bounds, empty }
}

export const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

export function hashAngle(id: string, span = 2.4): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return ((((h % 1000) + 1000) % 1000) / 1000 - 0.5) * span
}
