// Purpose: the Canvas look's board as data: its rectangles, items, islands and layout as MeTTa arranges them
// (board.metta, read by board.ts), the unassigned minds' island, the pending decisions in order, and two drawing helpers.
import type { Approval, Swarm } from '../sdk'

/** The unassigned minds' island. */
export const FREE = '__free'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type ItemKind = 'mind' | 'goal' | 'decision' | 'island' | 'lane' | 'add' | 'chat'

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
  /** What the camera frames when the person goes to Decisions: the lane's head and its first decisions. */
  laneFocus: Rect
}

export const pendingDecisions = (approvals: Record<string, Approval>): Approval[] => {
  const rank = { high: 0, medium: 1, low: 2 } as const
  return Object.values(approvals)
    .filter((a) => a.status === 'pending')
    .sort((a, b) => rank[a.risk] - rank[b.risk] || b.created_at.localeCompare(a.created_at))
}

export const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

export function hashAngle(id: string, span = 2.4): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return ((((h % 1000) + 1000) % 1000) / 1000 - 0.5) * span
}
