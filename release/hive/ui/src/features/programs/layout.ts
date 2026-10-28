import type { Polarity, ProgramDescription, ProgramRole, WorkGraph, WorkItem, WorkLink } from '../../api/types'
import type { TrailStep } from '../../store/programSession'

/**
 * Host-owned layouts of one work graph. Pure and deterministic: the same graph, step and size always
 * give the same boxes, so items keep their places between renders and only move when the person's
 * step (or the content) changes. Items are keyed by id; an item shown twice in compare (overlapping
 * groups) gets a second key `id~group` marked as a duplicate of the same item.
 */

export type Tier = 'focus' | 'near' | 'far' | 'context'
export type Side = 'left' | 'right' | 'top' | 'bottom'

export interface NodeBox {
  key: string
  id: string
  x: number
  y: number
  w: number
  h: number
  tier: Tier
  /** 1 = full presence; earlier context recedes. */
  opacity: number
  /** Compare: a second appearance of the same item (overlapping groups). */
  dupOf?: string
  /** The group this instance stands in (compare). */
  group?: string
  /** Gap items in compare are drawn as empty, dashed slots. */
  slot?: boolean
  /** Where a newly revealed item grows from (map). */
  from?: { x: number; y: number }
}

export interface Lane {
  key: string
  x: number
  y: number
  w: number
  label: string
  tone: 'support' | 'oppose' | 'qualify' | 'neutral' | 'gap' | 'group' | 'context' | 'conflict'
  count?: number
  align?: 'left' | 'center' | 'right'
}

export interface EdgeBox {
  key: string
  from: string
  to: string
  rel: string
  pol: Polarity
  weight: number
  /** Edges that touch the focus carry their relation label. */
  label?: string
}

export interface SceneLayout {
  nodes: NodeBox[]
  edges: EdgeBox[]
  lanes: Lane[]
  /** Pairs of node keys that are the same item (compare). */
  same: [string, string][]
  width: number
  height: number
  focusKey: string | null
}

export interface LayoutInput {
  graph: WorkGraph
  describe: ProgramDescription | null
  step: TrailStep
  trail: TrailStep[]
  /** Container size. */
  width: number
  height: number
}

// ---------------------------------------------------------------- graph index

export interface GraphIndex {
  items: Map<string, WorkItem>
  order: Map<string, number>
  adj: Map<string, { other: string; link: WorkLink; pol: Polarity; out: boolean; idx: number }[]>
  polarity: (rel: string) => Polarity
  role: (kind: string) => ProgramRole
  relLabel: (rel: string) => string
  kindLabel: (kind: string) => string
}

export function indexGraph(graph: WorkGraph, describe: ProgramDescription | null): GraphIndex {
  const pols = new Map((describe?.relations ?? []).map((r) => [r.id, r.polarity]))
  const roles = new Map((describe?.kinds ?? []).map((k) => [k.id, k.role]))
  const relLabels = new Map((describe?.relations ?? []).map((r) => [r.id, r.label || r.id]))
  const kindLabels = new Map((describe?.kinds ?? []).map((k) => [k.id, k.label || k.id]))
  const items = new Map(graph.items.map((i) => [i.id, i]))
  const order = new Map(graph.items.map((i, n) => [i.id, n]))
  const adj: GraphIndex['adj'] = new Map(graph.items.map((i) => [i.id, []]))
  graph.links.forEach((l, idx) => {
    const pol = pols.get(l.rel) ?? 'neutral'
    if (!items.has(l.from) || !items.has(l.to) || l.from === l.to) return
    adj.get(l.from)!.push({ other: l.to, link: l, pol, out: true, idx })
    adj.get(l.to)!.push({ other: l.from, link: l, pol, out: false, idx })
  })
  for (const list of adj.values()) list.sort((a, b) => (b.link.weight ?? 0.5) - (a.link.weight ?? 0.5) || a.idx - b.idx)
  return {
    items,
    order,
    adj,
    polarity: (rel) => pols.get(rel) ?? 'neutral',
    role: (kind) => roles.get(kind) ?? 'other',
    relLabel: (rel) => relLabels.get(rel) ?? rel,
    kindLabel: (kind) => kindLabels.get(kind) ?? kind,
  }
}

export function hash(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h ^= h >>> 13
  h = Math.imul(h, 0x5bd1e995)
  return (h ^ (h >>> 15)) >>> 0
}

// ---------------------------------------------------------------- sizes

export interface Sizes {
  narrow: boolean
  pad: number
  gap: number
  box: Record<Tier, { w: number; h: number }>
}

export function sizes(width: number): Sizes {
  const narrow = width < 760
  if (narrow) {
    const pad = 12
    const gap = 10
    const col = Math.max(132, Math.floor((width - pad * 2 - gap) / 2))
    return { narrow, pad, gap, box: { focus: { w: Math.min(col * 2 + gap, 420), h: 116 }, near: { w: col, h: 98 }, far: { w: col, h: 98 }, context: { w: col, h: 60 } } }
  }
  return { narrow, pad: 28, gap: 16, box: { focus: { w: 272, h: 128 }, near: { w: 212, h: 100 }, far: { w: 196, h: 96 }, context: { w: 168, h: 60 } } }
}

const ROLE_ORDER: ProgramRole[] = ['question', 'claim', 'hypothesis', 'explanation', 'assessment', 'evidence', 'source', 'other', 'gap']

function edgesFor(gi: GraphIndex, graph: WorkGraph, keyOf: (id: string) => string | undefined, focus: string | null): EdgeBox[] {
  const out: EdgeBox[] = []
  for (const l of graph.links) {
    const a = keyOf(l.from)
    const b = keyOf(l.to)
    if (!a || !b || a === b) continue
    out.push({ key: l.id, from: a, to: b, rel: l.rel, pol: gi.polarity(l.rel), weight: l.weight ?? 0.5, label: focus && (l.from === focus || l.to === focus) ? gi.relLabel(l.rel) : undefined })
  }
  return out
}

function overlaps(a: NodeBox, b: NodeBox, gap: number) {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
}

/** Normalise boxes to start at the padding and report the extent (lanes move with them). */
function finish(nodes: NodeBox[], lanes: Lane[], s: Sizes, width: number, height: number, centre = true): { width: number; height: number } {
  if (!nodes.length) return { width, height }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.w)
    maxY = Math.max(maxY, n.y + n.h)
  }
  for (const l of lanes) {
    const lx = l.align === 'center' ? l.x - l.w / 2 : l.align === 'right' ? l.x - l.w : l.x
    minX = Math.min(minX, lx)
    minY = Math.min(minY, l.y)
    maxX = Math.max(maxX, lx + l.w)
  }
  const w = maxX - minX + s.pad * 2
  const h = maxY - minY + s.pad * 2 + (s.narrow ? 0 : 36)
  const W = Math.max(width, w)
  const H = Math.max(height, h)
  const dx = s.pad - minX + (centre ? Math.max(0, (W - w) / 2) : 0)
  const dy = s.pad - minY + (centre ? Math.max(0, (H - h) / 2) : 0)
  for (const n of nodes) {
    n.x = Math.round(n.x + dx)
    n.y = Math.round(n.y + dy)
    if (n.from) n.from = { x: n.from.x + dx, y: n.from.y + dy }
  }
  for (const l of lanes) {
    l.x = Math.round(l.x + dx)
    l.y = Math.round(l.y + dy)
  }
  return { width: Math.round(W), height: Math.round(H) }
}

// ================================================================ unfold

interface Placed {
  depth: number
  side: Side
  weight: number
}

/** Rings from the focus: depth by BFS; side by the polarity of the link that reaches the item. */
export function classifyUnfold(gi: GraphIndex, focus: string): Map<string, Placed> {
  const out = new Map<string, Placed>()
  if (!gi.items.has(focus)) return out
  const sideOf = (pol: Polarity): Side => (pol === 'support' ? 'left' : pol === 'oppose' ? 'right' : pol === 'qualify' ? 'top' : 'bottom')
  const queue = [focus]
  const seen = new Set([focus])
  const meta = new Map<string, Placed>([[focus, { depth: 0, side: 'bottom', weight: 1 }]])
  while (queue.length) {
    const cur = queue.shift()!
    const cm = meta.get(cur)!
    for (const e of gi.adj.get(cur) ?? []) {
      if (seen.has(e.other)) continue
      seen.add(e.other)
      const depth = cm.depth + 1
      let side: Side
      if (depth === 1) side = sideOf(e.pol)
      else if ((e.pol === 'support' || e.pol === 'oppose') && (cm.side === 'top' || cm.side === 'bottom')) side = sideOf(e.pol)
      else side = cm.side
      const p = { depth, side, weight: e.link.weight ?? 0.5 }
      meta.set(e.other, p)
      out.set(e.other, p)
      queue.push(e.other)
    }
  }
  return out
}

const SIDE_LABEL: Record<Side, { label: string; tone: Lane['tone'] }> = {
  left: { label: 'Supporting', tone: 'support' },
  right: { label: 'Opposing', tone: 'oppose' },
  top: { label: 'Qualifying', tone: 'qualify' },
  bottom: { label: 'Related', tone: 'neutral' },
}

export function layoutUnfold(input: LayoutInput, gi: GraphIndex): SceneLayout {
  const { graph, width, height } = input
  const s = sizes(width)
  const focus = input.step.focus && gi.items.has(input.step.focus) ? input.step.focus : (graph.focus && gi.items.has(graph.focus) ? graph.focus : graph.items[0]?.id ?? null)
  if (!focus) return { nodes: [], edges: [], lanes: [], same: [], width, height, focusKey: null }
  const placed = classifyUnfold(gi, focus)
  const buckets = new Map<string, string[]>()
  const unlinked: string[] = []
  for (const it of graph.items) {
    if (it.id === focus) continue
    const p = placed.get(it.id)
    if (!p) {
      unlinked.push(it.id)
      continue
    }
    const k = `${p.side}:${p.depth}`
    buckets.set(k, [...(buckets.get(k) ?? []), it.id])
  }
  const sortBucket = (ids: string[]) =>
    ids.sort((a, b) => (placed.get(b)!.weight - placed.get(a)!.weight) || (gi.items.get(b)!.weight ?? 0) - (gi.items.get(a)!.weight ?? 0) || gi.order.get(a)! - gi.order.get(b)!)
  for (const v of buckets.values()) sortBucket(v)
  const tierOf = (d: number): Tier => (d <= 1 ? 'near' : 'far')
  const nodes: NodeBox[] = []
  const lanes: Lane[] = []
  const F = s.box.focus
  const maxDepth = Math.max(0, ...[...placed.values()].map((p) => p.depth))

  if (s.narrow) {
    // one column of bands: qualifying above, the focus, supporting | opposing side by side, related, the outer ring
    const W = width - s.pad * 2
    const col = s.box.near.w
    let y = 0
    const grid = (ids: string[], tier: Tier, label: string, tone: Lane['tone'], opacity = 1) => {
      if (!ids.length) return
      lanes.push({ key: `lane-${label}`, x: 0, y, w: W, label, tone, count: ids.length })
      y += 26
      ids.forEach((id, i) => {
        const b = s.box[tier]
        nodes.push({ key: id, id, x: (i % 2) * (col + s.gap), y: y + Math.floor(i / 2) * (b.h + s.gap), w: b.w, h: b.h, tier, opacity })
      })
      y += Math.ceil(ids.length / 2) * (s.box[tier].h + s.gap) + 8
    }
    const sideIds = (side: Side) => {
      const out: { id: string; d: number }[] = []
      for (let d = 1; d <= maxDepth; d++) for (const id of buckets.get(`${side}:${d}`) ?? []) out.push({ id, d })
      return out
    }
    const top = sideIds('top').reverse()
    if (top.length) {
      lanes.push({ key: 'lane-top', x: 0, y, w: W, label: SIDE_LABEL.top.label, tone: 'qualify', count: top.length })
      y += 26
      top.forEach((t, i) => {
        const b = s.box[tierOf(t.d)]
        nodes.push({ key: t.id, id: t.id, x: (i % 2) * (col + s.gap), y: y + Math.floor(i / 2) * (s.box.near.h + s.gap), w: b.w, h: b.h, tier: tierOf(t.d), opacity: 1 })
      })
      y += Math.ceil(top.length / 2) * (s.box.near.h + s.gap) + 8
    }
    nodes.push({ key: focus, id: focus, x: (W - F.w) / 2, y, w: F.w, h: F.h, tier: 'focus', opacity: 1 })
    y += F.h + s.gap + 10
    const left = sideIds('left')
    const right = sideIds('right')
    if (left.length || right.length) {
      if (left.length) lanes.push({ key: 'lane-left', x: 0, y, w: col, label: SIDE_LABEL.left.label, tone: 'support', count: left.length })
      if (right.length) lanes.push({ key: 'lane-right', x: col + s.gap, y, w: col, label: SIDE_LABEL.right.label, tone: 'oppose', count: right.length })
      y += 26
      let ly = y
      let ry = y
      for (const t of left) {
        const b = s.box[tierOf(t.d)]
        nodes.push({ key: t.id, id: t.id, x: 0, y: ly, w: b.w, h: b.h, tier: tierOf(t.d), opacity: 1 })
        ly += b.h + s.gap
      }
      for (const t of right) {
        const b = s.box[tierOf(t.d)]
        nodes.push({ key: t.id, id: t.id, x: col + s.gap, y: ry, w: b.w, h: b.h, tier: tierOf(t.d), opacity: 1 })
        ry += b.h + s.gap
      }
      y = Math.max(ly, ry) + 8
    }
    const bottom = sideIds('bottom')
    if (bottom.length) {
      lanes.push({ key: 'lane-bottom', x: 0, y, w: W, label: SIDE_LABEL.bottom.label, tone: 'neutral', count: bottom.length })
      y += 26
      bottom.forEach((t, i) => {
        const tier = tierOf(t.d)
        nodes.push({ key: t.id, id: t.id, x: (i % 2) * (col + s.gap), y: y + Math.floor(i / 2) * (s.box.near.h + s.gap), w: s.box[tier].w, h: s.box[tier].h, tier, opacity: 1 })
      })
      y += Math.ceil(bottom.length / 2) * (s.box.near.h + s.gap) + 8
    }
    grid(unlinked, 'context', 'Outer ring · not linked to this focus', 'context', 0.55)
    const ext = finish(nodes, lanes, s, width, height, false)
    return { nodes, edges: edgesFor(gi, graph, (id) => id, focus), lanes, same: [], ...ext, focusKey: focus }
  }

  // wide: elliptical rings. Columns on the sides, rows above and below, then a light de-overlap.
  nodes.push({ key: focus, id: focus, x: -F.w / 2, y: -F.h / 2, w: F.w, h: F.h, tier: 'focus', opacity: 1 })
  // rings are compressed to the depths a side actually has, and to the columns the width allows;
  // beyond that a ring stacks into the outermost column (depth still reads from size and order)
  const sideCols = Math.max(1, Math.floor((width / 2 - s.pad - F.w / 2 - 48 + 40) / (s.box.near.w + 40)))
  const perCol = Math.max(3, Math.floor((height - 80) / (s.box.near.h + s.gap)))
  const perRow = Math.max(2, Math.min(4, Math.floor((width - s.pad * 2 + s.gap) / (s.box.near.w + s.gap)) - 1))
  const rank = new Map<string, number>()
  for (const side of ['left', 'right', 'top', 'bottom'] as Side[]) {
    let r = 0
    for (let d = 1; d <= maxDepth; d++) if (buckets.get(`${side}:${d}`)?.length) rank.set(`${side}:${d}`, r++)
  }
  const sideX = (col: number) => F.w / 2 + 48 + Math.min(col, sideCols - 1) * (s.box.near.w + 40)
  const rowY = (row: number) => F.h / 2 + 52 + row * (s.box.near.h + 44)
  const extraSlots: Record<Side, number> = { left: 0, right: 0, top: 0, bottom: 0 }
  const laneAt: Partial<Record<Side, { x: number; y: number }>> = {}
  const stackY: Record<'left' | 'right', number[]> = { left: [], right: [] }
  for (let d = 1; d <= maxDepth; d++) {
    for (const side of ['left', 'right', 'top', 'bottom'] as Side[]) {
      const ids = buckets.get(`${side}:${d}`) ?? []
      if (!ids.length) continue
      const tier = tierOf(d)
      const b = s.box[tier]
      const r0 = rank.get(`${side}:${d}`) ?? 0
      const cap = side === 'left' || side === 'right' ? perCol : perRow
      const chunks: string[][] = []
      for (let i = 0; i < ids.length; i += cap) chunks.push(ids.slice(i, i + cap))
      chunks.forEach((chunk, ci) => {
        const slot = r0 + extraSlots[side] + ci
        if (side === 'left' || side === 'right') {
          const col = Math.min(slot, sideCols - 1)
          const cx = sideX(col) + s.box.near.w / 2
          // a column shared by several rings stacks them, nearest ring first
          const before = stackY[side][col] ?? 0
          const total = chunk.length * b.h + (chunk.length - 1) * s.gap
          chunk.forEach((id, i) => {
            const cy = before ? before + s.gap + i * (b.h + s.gap) + b.h / 2 : -total / 2 + i * (b.h + s.gap) + b.h / 2
            const bend = Math.min(60, Math.abs(cy) * 0.16) // a ring, not a wall
            const x = side === 'left' ? -(cx - bend) - b.w / 2 : cx - bend - b.w / 2
            nodes.push({ key: id, id, x, y: cy - b.h / 2, w: b.w, h: b.h, tier, opacity: 1 })
          })
          stackY[side][col] = before ? before + s.gap + total : total / 2
          const lx = side === 'left' ? -cx - b.w / 2 : cx - b.w / 2
          if (!laneAt[side] || Math.abs(lx) < Math.abs(laneAt[side]!.x)) laneAt[side] = { x: lx, y: -total / 2 - 30 }
        } else {
          const cy = rowY(slot) + b.h / 2
          const total = chunk.length * b.w + (chunk.length - 1) * s.gap
          chunk.forEach((id, i) => {
            const cx = -total / 2 + i * (b.w + s.gap) + b.w / 2
            const bend = Math.abs(cx) * 0.12
            const y = side === 'top' ? -(cy - bend) - b.h / 2 : cy - bend - b.h / 2
            nodes.push({ key: id, id, x: cx - b.w / 2, y, w: b.w, h: b.h, tier, opacity: 1 })
          })
          if (!laneAt[side]) laneAt[side] = { x: 0, y: side === 'top' ? -cy - b.h / 2 - 28 : cy + b.h / 2 + 8 }
        }
      })
      extraSlots[side] += chunks.length - 1
    }
  }
  // the outer ring: items not linked to the focus
  if (unlinked.length) {
    let rx = 0
    let ry = 0
    for (const n of nodes) {
      rx = Math.max(rx, Math.abs(n.x), Math.abs(n.x + n.w))
      ry = Math.max(ry, Math.abs(n.y), Math.abs(n.y + n.h))
    }
    rx += 90
    ry += 60
    const b = s.box.context
    unlinked.forEach((id, i) => {
      const a = -Math.PI / 2 + (i / unlinked.length) * Math.PI * 2 + 0.35
      nodes.push({ key: id, id, x: Math.cos(a) * rx - b.w / 2, y: Math.sin(a) * ry - b.h / 2, w: b.w, h: b.h, tier: 'context', opacity: 0.55 })
    })
  }
  // de-overlap: push the later (outer) box away from the centre
  for (let pass = 0; pass < 40; pass++) {
    let moved = false
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]
        const b = nodes[j]
        if (!overlaps(a, b, 10)) continue
        moved = true
        const bx = b.x + b.w / 2
        const by = b.y + b.h / 2
        const len = Math.hypot(bx, by) || 1
        b.x += (bx / len) * 14
        b.y += (by / len) * 14
      }
    }
    if (!moved) break
  }
  for (const side of ['left', 'right', 'top', 'bottom'] as Side[]) {
    const at = laneAt[side]
    if (!at) continue
    const count = [...placed.values()].filter((p) => p.side === side).length
    const meta = SIDE_LABEL[side]
    if (side === 'left' || side === 'right') {
      // above the nearest column's top item
      const col = nodes.filter((n) => n.id !== focus && placed.get(n.id)?.side === side && placed.get(n.id)!.depth === 1)
      const topY = col.length ? Math.min(...col.map((n) => n.y)) - 30 : at.y
      const x = col.length ? (side === 'left' ? Math.min(...col.map((n) => n.x)) : Math.min(...col.map((n) => n.x))) : at.x
      lanes.push({ key: `lane-${side}`, x, y: topY, w: s.box.near.w, label: meta.label, tone: meta.tone, count })
    } else {
      const row = nodes.filter((n) => placed.get(n.id)?.side === side)
      const y = side === 'top' ? Math.min(...row.map((n) => n.y)) - 30 : Math.max(...row.map((n) => n.y + n.h)) + 10
      lanes.push({ key: `lane-${side}`, x: 0, y, w: 240, label: meta.label, tone: meta.tone, count, align: 'center' })
    }
  }
  if (unlinked.length) {
    const outer = nodes.filter((n) => n.tier === 'context')
    lanes.push({ key: 'lane-outer', x: 0, y: Math.max(...outer.map((n) => n.y + n.h)) + 10, w: 300, label: 'Outer ring · not linked to this focus', tone: 'context', count: unlinked.length, align: 'center' })
  }
  const ext = finish(nodes, lanes, s, width, height)
  return { nodes, edges: edgesFor(gi, graph, (id) => id, focus), lanes, same: [], ...ext, focusKey: focus }
}

// ================================================================ map

const forceCache = new Map<string, Map<string, { x: number; y: number }>>()

/** A light force layout seeded by id hashes: deterministic, and stable while the structure is. */
export function forceLayout(graph: WorkGraph, spacing = 250): Map<string, { x: number; y: number }> {
  const key = `${spacing}|${graph.items.map((i) => i.id).join('\u0001')}|${graph.links.map((l) => `${l.from}>${l.to}`).join('\u0001')}`
  const hit = forceCache.get(key)
  if (hit) return hit
  const ids = graph.items.map((i) => i.id)
  const n = ids.length
  const idx = new Map(ids.map((id, i) => [id, i]))
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const spread = spacing * Math.sqrt(n) * 0.6
  ids.forEach((id, i) => {
    const a = (hash(id) / 4294967296) * Math.PI * 2
    const r = spread * (0.2 + 0.8 * Math.sqrt(hash(id, 0x9e3779b9) / 4294967296))
    xs[i] = Math.cos(a) * r
    ys[i] = Math.sin(a) * r
  })
  const edges: [number, number][] = []
  for (const l of graph.links) {
    const a = idx.get(l.from)
    const b = idx.get(l.to)
    if (a !== undefined && b !== undefined && a !== b) edges.push([a, b])
  }
  const k = spacing
  const iters = n <= 60 ? 280 : n <= 160 ? 140 : 70
  const dx = new Float64Array(n)
  const dy = new Float64Array(n)
  for (let it = 0; it < iters; it++) {
    const temp = spacing * 0.9 * (1 - it / iters) + 2
    dx.fill(0)
    dy.fill(0)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = xs[i] - xs[j]
        let ey = ys[i] - ys[j]
        let d2 = ex * ex + ey * ey
        if (d2 < 0.01) {
          ex = 0.1 * ((i % 3) - 1 || 1)
          ey = 0.1
          d2 = 0.02
        }
        const d = Math.sqrt(d2)
        // repulsion, stronger sideways so wide cards do not sit on top of each other
        const f = (k * k) / d
        dx[i] += (ex / d) * f * 1.25
        dy[i] += (ey / d) * f * 0.8
        dx[j] -= (ex / d) * f * 1.25
        dy[j] -= (ey / d) * f * 0.8
      }
    }
    for (const [a, b] of edges) {
      const ex = xs[a] - xs[b]
      const ey = ys[a] - ys[b]
      const d = Math.sqrt(ex * ex + ey * ey) || 0.01
      const f = (d * d) / k
      dx[a] -= (ex / d) * f
      dy[a] -= (ey / d) * f
      dx[b] += (ex / d) * f
      dy[b] += (ey / d) * f
    }
    for (let i = 0; i < n; i++) {
      // gentle gravity keeps islands near
      dx[i] -= xs[i] * 0.03
      dy[i] -= ys[i] * 0.05
      const d = Math.hypot(dx[i], dy[i]) || 1
      const m = Math.min(d, temp)
      xs[i] += (dx[i] / d) * m
      ys[i] += (dy[i] / d) * m
    }
  }
  // remove card overlaps
  const W = spacing * 0.86
  const H = spacing * 0.4
  for (let pass = 0; pass < 30; pass++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ox = W - Math.abs(xs[i] - xs[j])
        const oy = H - Math.abs(ys[i] - ys[j])
        if (ox <= 0 || oy <= 0) continue
        moved = true
        if (ox / W < oy / H) {
          const s = (xs[i] < xs[j] ? -1 : 1) * (ox / 2 + 1)
          xs[i] += s
          xs[j] -= s
        } else {
          const s = (ys[i] < ys[j] ? -1 : 1) * (oy / 2 + 1)
          ys[i] += s
          ys[j] -= s
        }
      }
    }
    if (!moved) break
  }
  const out = new Map(ids.map((id, i) => [id, { x: Math.round(xs[i]), y: Math.round(ys[i]) }]))
  if (forceCache.size > 12) forceCache.delete(forceCache.keys().next().value!)
  forceCache.set(key, out)
  return out
}

/** The map grows outward from the followed item: earlier map foci stay as receding context. */
export function layoutMap(input: LayoutInput, gi: GraphIndex): SceneLayout {
  const { graph, width, height, trail } = input
  const s = sizes(width)
  const focus = input.step.focus && gi.items.has(input.step.focus) ? input.step.focus : (graph.focus && gi.items.has(graph.focus) ? graph.focus : graph.items[0]?.id ?? null)
  if (!focus) return { nodes: [], edges: [], lanes: [], same: [], width, height, focusKey: null }
  const pos = forceLayout(graph, s.narrow ? 185 : 250)
  const tier = new Map<string, Tier>([[focus, 'focus']])
  const parent = new Map<string, string>()
  const reveal = (id: string, t: Tier, from: string) => {
    if (tier.has(id)) return
    tier.set(id, t)
    parent.set(id, from)
  }
  const n1 = (gi.adj.get(focus) ?? []).map((e) => e.other)
  for (const id of n1) reveal(id, 'near', focus)
  if (s.narrow ? n1.length < 3 : graph.items.length <= 48 || n1.length < 6) {
    for (const a of n1) for (const e of gi.adj.get(a) ?? []) reveal(e.other, 'far', a)
  }
  // earlier map steps: their foci and neighbours recede but stay clickable
  for (const st of trail) {
    if (st.stage !== 'map' || !st.focus || !gi.items.has(st.focus) || st.focus === focus) continue
    if (!tier.has(st.focus)) tier.set(st.focus, 'context')
    for (const e of gi.adj.get(st.focus) ?? []) reveal(e.other, 'context', st.focus)
  }
  const nodes: NodeBox[] = []
  const box = { focus: { w: 240, h: 124 }, near: { w: 204, h: 100 }, far: { w: 188, h: 96 }, context: { w: 160, h: 60 } }
  if (s.narrow) {
    box.focus = { w: 196, h: 120 }
    box.near = { w: 156, h: 100 }
    box.far = { w: 148, h: 96 }
    box.context = { w: 136, h: 60 }
  }
  for (const it of graph.items) {
    const t = tier.get(it.id)
    if (!t) continue
    const p = pos.get(it.id)!
    const b = box[t]
    const from = parent.get(it.id) ? pos.get(parent.get(it.id)!) : undefined
    nodes.push({ key: it.id, id: it.id, x: p.x - b.w / 2, y: p.y - b.h / 2, w: b.w, h: b.h, tier: t, opacity: t === 'context' ? 0.5 : t === 'far' ? 0.85 : 1, from: from ? { x: from.x - b.w / 2, y: from.y - b.h / 2 } : undefined })
  }
  // fit what is visible: positions come from one stable global layout, scaled about the focus so the
  // explored region fits the stage (never below 70%; beyond that the stage scrolls), then cards are nudged apart
  const fpos = pos.get(focus)!
  let spanX = 0
  let spanY = 0
  let maxW = 0
  let maxH = 0
  for (const n of nodes) {
    spanX = Math.max(spanX, Math.abs(n.x + n.w / 2 - fpos.x))
    spanY = Math.max(spanY, Math.abs(n.y + n.h / 2 - fpos.y))
    maxW = Math.max(maxW, n.w)
    maxH = Math.max(maxH, n.h)
  }
  const sc = Math.max(s.narrow ? 0.5 : 0.7, Math.min(1, (width / 2 - s.pad - maxW / 2) / (spanX || 1), (height / 2 - s.pad - maxH / 2 - (s.narrow ? 0 : 20)) / (spanY || 1)))
  const scale = (x: number, y: number, w: number, h: number) => ({ x: fpos.x + (x + w / 2 - fpos.x) * sc - w / 2, y: fpos.y + (y + h / 2 - fpos.y) * sc - h / 2 })
  for (const n of nodes) {
    const p = scale(n.x, n.y, n.w, n.h)
    if (n.from) n.from = scale(n.from.x, n.from.y, n.w, n.h)
    n.x = p.x
    n.y = p.y
  }
  // place greedily, nearest to the focus first: a card that would overlap takes the nearest free spot
  const TIER_RANK: Record<Tier, number> = { focus: 0, near: 1, far: 2, context: 3 }
  const order = [...nodes].sort((p, q) => TIER_RANK[p.tier] - TIER_RANK[q.tier] || Math.hypot(p.x - fpos.x, p.y - fpos.y) - Math.hypot(q.x - fpos.x, q.y - fpos.y) || (p.key < q.key ? -1 : 1))
  const placed: NodeBox[] = []
  for (const n of order) {
    const x0 = n.x
    const y0 = n.y
    search: for (let r = 0; r <= 2400; r += 18) {
      const steps = r === 0 ? 1 : Math.max(8, Math.round((2 * Math.PI * r) / 40))
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2
        n.x = x0 + Math.cos(a) * r
        n.y = y0 + Math.sin(a) * r * 0.75
        if (!placed.some((p) => overlaps(p, n, 18))) break search
      }
    }
    placed.push(n)
  }
  const ext = finish(nodes, [], s, width, height)
  const visible = new Set(nodes.map((n) => n.id))
  return { nodes, edges: edgesFor(gi, graph, (id) => (visible.has(id) ? id : undefined), focus), lanes: [], same: [], ...ext, focusKey: focus }
}

// ================================================================ compare

interface CGroup {
  id: string
  label: string
  items: string[]
  generated?: boolean
  gap?: boolean
}

/** Host groups for a chosen set: each item with what supports or qualifies it, what opposes it, and nearby gaps. */
export function groupsForChosen(gi: GraphIndex, chosen: string[]): CGroup[] {
  const anchors = chosen.filter((id) => gi.items.has(id))
  const set = new Set(anchors)
  const out: CGroup[] = []
  const against: CGroup[] = []
  for (const a of anchors) {
    const sup: string[] = []
    const opp: string[] = []
    for (const e of gi.adj.get(a) ?? []) {
      if (set.has(e.other) || gi.role(gi.items.get(e.other)!.kind) === 'gap') continue
      if (e.pol === 'support' || e.pol === 'qualify') sup.push(e.other)
      else if (e.pol === 'oppose') opp.push(e.other)
    }
    out.push({ id: `sel:${a}`, label: gi.items.get(a)!.label, items: [a, ...new Set(sup)], generated: true })
    if (opp.length) against.push({ id: `against:${a}`, label: `Against “${gi.items.get(a)!.label}”`, items: [...new Set(opp)], generated: true })
  }
  // an "against" group already shown whole in another chosen item's group adds nothing
  for (const g of against) {
    const elsewhere = new Set(out.filter((o) => o.id !== `sel:${g.id.slice(8)}`).flatMap((o) => o.items))
    if (!g.items.every((id) => elsewhere.has(id))) out.push(g)
  }
  const gaps: string[] = []
  const near = new Set(anchors)
  for (const a of anchors) for (const e of gi.adj.get(a) ?? []) near.add(e.other)
  for (const id of [...near]) for (const e of gi.adj.get(id) ?? []) if (gi.role(gi.items.get(e.other)!.kind) === 'gap') gaps.push(e.other)
  for (const id of near) if (gi.role(gi.items.get(id)!.kind) === 'gap') gaps.push(id)
  if (gaps.length) out.push({ id: 'gaps', label: 'Missing research', items: [...new Set(gaps)], generated: true, gap: true })
  return out
}

export function layoutCompare(input: LayoutInput, gi: GraphIndex): SceneLayout {
  const { graph, width, height, step } = input
  const s = sizes(width)
  const chosen = (step.compare ?? []).filter((id) => gi.items.has(id))
  let groups: CGroup[] = chosen.length >= 2 ? groupsForChosen(gi, chosen) : graph.groups.map((g) => ({ id: g.id, label: g.label || g.id, items: g.items.filter((id) => gi.items.has(id)) }))
  if (!groups.length && step.focus && gi.items.has(step.focus)) groups = groupsForChosen(gi, [step.focus])
  groups = groups.filter((g) => g.items.length)
  for (const g of groups) g.gap = g.gap || g.items.every((id) => gi.role(gi.items.get(id)!.kind) === 'gap')
  const sides: { L: CGroup[]; R: CGroup[]; G: CGroup[] } = { L: [], R: [], G: [] }
  const between = (a: CGroup, b: CGroup) => {
    const A = new Set(a.items)
    const B = new Set(b.items)
    let conflict = 0
    let agree = 0
    for (const id of A) if (B.has(id)) agree += 2
    for (const l of graph.links) {
      const ab = (A.has(l.from) && B.has(l.to)) || (B.has(l.from) && A.has(l.to))
      if (!ab || l.from === l.to) continue
      const p = gi.polarity(l.rel)
      if (p === 'oppose') conflict++
      else if (p === 'support') agree++
    }
    return { conflict, agree }
  }
  for (const g of groups) {
    if (g.gap) {
      sides.G.push(g)
      continue
    }
    if (!sides.L.length) {
      sides.L.push(g)
      continue
    }
    const score = (side: CGroup[]) => side.reduce((n, o) => {
      const r = between(g, o)
      return n + r.agree - 3 * r.conflict
    }, 0)
    const sl = score(sides.L)
    const sr = sides.R.length ? score(sides.R) : 0
    if (!sides.R.length) sides[sl > 0 ? 'L' : 'R'].push(g)
    else sides[sl >= sr ? 'L' : 'R'].push(g)
  }
  const conflictAcross = sides.L.some((a) => sides.R.some((b) => between(a, b).conflict > 0))
  const roleRank = (id: string) => ROLE_ORDER.indexOf(gi.role(gi.items.get(id)!.kind))
  const sortItems = (ids: string[]) => [...ids].sort((a, b) => roleRank(a) - roleRank(b) || (gi.items.get(b)!.weight ?? 0) - (gi.items.get(a)!.weight ?? 0) || gi.order.get(a)! - gi.order.get(b)!)

  const nodes: NodeBox[] = []
  const lanes: Lane[] = []
  const same: [string, string][] = []
  const firstKey = new Map<string, string>()
  const place = (id: string, group: CGroup, x: number, y: number, tier: Tier) => {
    const b = s.box[tier]
    const prior = firstKey.get(id)
    const key = prior ? `${id}~${group.id}` : id
    if (!prior) firstKey.set(id, key)
    else same.push([prior, key])
    const slot = gi.role(gi.items.get(id)!.kind) === 'gap'
    nodes.push({ key, id, x, y, w: b.w, h: b.h, tier, opacity: 1, dupOf: prior ? id : undefined, group: group.id, slot })
    return b.h
  }
  const colW = s.box.near.w
  const block = (g: CGroup, x: number, y0: number, w = colW): number => {
    lanes.push({ key: `lane-${g.id}`, x, y: y0, w, label: g.label, tone: g.gap ? 'gap' : 'group', count: g.items.length })
    let y = y0 + 30
    for (const id of sortItems(g.items)) y += place(id, g, x, y, 'near') + s.gap
    return y + 14
  }

  if (s.narrow) {
    const W = width - s.pad * 2
    const halfX = colW + s.gap
    let ly = 0
    let ry = 0
    if (sides.R.length && conflictAcross) {
      lanes.push({ key: 'lane-conflict', x: W / 2, y: 0, w: 120, label: 'In conflict', tone: 'conflict', align: 'center' })
      ly = ry = 30
    }
    for (const g of sides.L) ly = block(g, 0, ly)
    for (const g of sides.R) ry = block(g, halfX, ry)
    let y = Math.max(ly, ry)
    for (const g of sides.G) {
      lanes.push({ key: `lane-${g.id}`, x: 0, y, w: W, label: g.label, tone: 'gap', count: g.items.length })
      y += 30
      sortItems(g.items).forEach((id, i) => place(id, g, (i % 2) * halfX, y + Math.floor(i / 2) * (s.box.near.h + s.gap), 'near'))
      y += Math.ceil(g.items.length / 2) * (s.box.near.h + s.gap) + 14
    }
    const ext = finish(nodes, lanes, s, width, height, false)
    return { nodes, edges: edgesFor(gi, graph, (id) => firstKey.get(id), null), lanes, same, ...ext, focusKey: null }
  }

  // wide: left side | gaps (centre) | right side; a side's groups are sub-columns when they fit
  const gapW = sides.G.length ? colW + 40 : 72
  const sideW = Math.max(colW, (width - s.pad * 2 - gapW) / 2)
  const fit = Math.max(1, Math.floor((sideW + s.gap) / (colW + s.gap)))
  const layoutSide = (list: CGroup[], x0: number, dir: 1 | -1) => {
    // columns grow outward from the centre
    let bottom = 0
    const heights: number[] = []
    list.forEach((g, i) => {
      if (list.length <= fit) {
        const x = dir === 1 ? x0 + i * (colW + s.gap * 1.5) : x0 - colW - i * (colW + s.gap * 1.5)
        bottom = Math.max(bottom, block(g, x, 0))
      } else {
        const col = i % fit
        heights[col] ??= 0
        const x = dir === 1 ? x0 + col * (colW + s.gap * 1.5) : x0 - colW - col * (colW + s.gap * 1.5)
        heights[col] = block(g, x, heights[col])
        bottom = Math.max(bottom, heights[col])
      }
    })
    return bottom
  }
  const lx = -gapW / 2
  const rx = gapW / 2
  layoutSide(sides.L, lx, -1)
  layoutSide(sides.R, rx, 1)
  let gy = 0
  for (const g of sides.G) gy = block(g, -colW / 2, gy)
  if (sides.R.length && conflictAcross) lanes.push({ key: 'lane-conflict', x: 0, y: -40, w: 120, label: 'In conflict', tone: 'conflict', align: 'center' })
  const ext = finish(nodes, lanes, s, width, height)
  return { nodes, edges: edgesFor(gi, graph, (id) => firstKey.get(id), null), lanes, same, ...ext, focusKey: null }
}

export function layoutStage(input: LayoutInput, gi: GraphIndex): SceneLayout {
  if (input.step.stage === 'map') return layoutMap(input, gi)
  if (input.step.stage === 'compare') return layoutCompare(input, gi)
  return layoutUnfold(input, gi)
}
