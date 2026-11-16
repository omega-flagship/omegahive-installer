/**
 * The canvas's geometry, pure and tested: how the artboard fits the stage clear of the hive's reserved areas (the Ω
 * corner, the Ask's bottom band, the top bar of quiet controls), pan and zoom (wheel, pinch), where the ring of
 * controls sits beside a selection, alignment guides while moving, and resizing from an edge or a corner.
 *
 * Screen coordinates are the stage's own CSS px (0,0 at its top-left). `View` maps artboard units to them:
 * screen = art * scale + (tx, ty).
 */

export interface View {
  scale: number
  tx: number
  ty: number
}
export interface Size {
  width: number
  height: number
}
export interface Point {
  x: number
  y: number
}
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
/** Bands of the stage the work should not sit under by default (px). */
export interface Reserve {
  top: number
  right: number
  bottom: number
  left: number
}

export const MIN_SCALE = 0.05
export const MAX_SCALE = 8

/** The view that fits the whole artboard in the stage, clear of the reserved bands, centred, never above 100 %. */
export function fit(art: Size, stage: Size, reserve: Reserve, pad = 24): View {
  const w = Math.max(40, stage.width - reserve.left - reserve.right - pad * 2)
  const h = Math.max(40, stage.height - reserve.top - reserve.bottom - pad * 2)
  const scale = clampScale(Math.min(w / art.width, h / art.height, 1))
  const tx = reserve.left + pad + (w - art.width * scale) / 2
  const ty = reserve.top + pad + (h - art.height * scale) / 2
  return { scale, tx: Math.round(tx), ty: Math.round(ty) }
}

export const clampScale = (s: number): number => Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number.isFinite(s) ? s : 1))

/** Zoom by `factor` about a screen point (the pointer, or the pinch centre): that point stays put. */
export function zoomAt(v: View, factor: number, at: Point): View {
  const scale = clampScale(v.scale * factor)
  const k = scale / v.scale
  return { scale, tx: at.x - (at.x - v.tx) * k, ty: at.y - (at.y - v.ty) * k }
}

export const pan = (v: View, dx: number, dy: number): View => ({ ...v, tx: v.tx + dx, ty: v.ty + dy })

/** Keep at least `keep` px of the artboard on the stage, whatever the pan. */
export function keepVisible(v: View, art: Size, stage: Size, keep = 80): View {
  const w = art.width * v.scale
  const h = art.height * v.scale
  const kx = Math.min(keep, w)
  const ky = Math.min(keep, h)
  return { ...v, tx: Math.max(kx - w, Math.min(stage.width - kx, v.tx)), ty: Math.max(ky - h, Math.min(stage.height - ky, v.ty)) }
}

export const toArt = (v: View, p: Point): Point => ({ x: (p.x - v.tx) / v.scale, y: (p.y - v.ty) / v.scale })
export const toScreen = (v: View, p: Point): Point => ({ x: p.x * v.scale + v.tx, y: p.y * v.scale + v.ty })
export const rectToScreen = (v: View, r: Rect): Rect => ({ x: r.x * v.scale + v.tx, y: r.y * v.scale + v.ty, width: r.width * v.scale, height: r.height * v.scale })

/** The wheel: with ⌘/Ctrl (and a trackpad pinch, which browsers send as ctrl+wheel) it zooms, otherwise it pans. */
export function wheel(v: View, e: { deltaX: number; deltaY: number; ctrlKey: boolean; metaKey: boolean; deltaMode?: number }, at: Point): View {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
  if (e.ctrlKey || e.metaKey) return zoomAt(v, Math.exp(-e.deltaY * unit * 0.0022), at)
  return pan(v, -e.deltaX * unit, -e.deltaY * unit)
}

/** Two pointers moved: the scale follows their distance, the view follows their centre. */
export function pinch(v: View, before: [Point, Point], after: [Point, Point]): View {
  const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) || 1
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const m0 = mid(...before)
  const m1 = mid(...after)
  const z = zoomAt(v, d(...after) / d(...before), m0)
  return pan(z, m1.x - m0.x, m1.y - m0.y)
}

// ------------------------------------------------------------------ the ring of controls

export type Side = 'above' | 'below' | 'right' | 'left' | 'inside'

/** What the ring should keep off, in the stage's screen px. */
export interface RingAvoid {
  /** the other elements' boxes: the design content the ring should cover least */
  others?: Rect[]
  /** the artboard: covering it (even its background) costs a little, so free space outside it wins when it is near */
  board?: Rect | null
  /** never cover these (Ω's corner, the drawer pill): any overlap rules a place out unless nothing else fits */
  avoid?: Rect[]
}

/** The area two boxes share (px²). */
export const overlapArea = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

const gapBetween = (a: Rect, b: Rect): number => {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width))
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height))
  return Math.hypot(dx, dy)
}

/** Weights of the ring's placement cost: covered content dominates; the board and distance only break near-ties. */
export const RING_COST = { selection: 3, content: 1, board: 0.1, avoid: 1e6, perPx: 4 } as const
const ORDER: Side[] = ['above', 'below', 'right', 'left']

/**
 * Where the ring (a `ring`-sized box, including any open sub-row such as the colours) sits beside a selection's screen
 * box: the place, inside the stage's free area (clear of the reserved top line and the Ask's band), that covers the least
 * of the design. Candidates: above and below the selection (centred, or aligned to either edge), beside it (top-aligned
 * or centred), and just outside the artboard above or below it. Cost = covered selection ×3 + covered other elements
 * + covered artboard ×0.1 + 4 per px of distance from the selection, with anything over `avoid` ruled out; ties keep
 * the order above, below, right, left. When nothing fits, the ring sits inside the selection's top edge.
 */
export function placeRing(box: Rect, ring: Size, stage: Size, reserve: Reserve, opts: RingAvoid = {}, gap = 10): { x: number; y: number; side: Side } {
  const minX = reserve.left + 8
  const maxX = stage.width - reserve.right - 8 - ring.width
  const minY = reserve.top + 8
  const maxY = stage.height - reserve.bottom - 8 - ring.height
  const cx = (v: number) => Math.round(Math.max(minX, Math.min(maxX, v)))
  const cy = (v: number) => Math.round(Math.max(minY, Math.min(maxY, v)))
  const xs = [box.x + box.width / 2 - ring.width / 2, box.x, box.x + box.width - ring.width].map(cx)
  const ys = [box.y, box.y + box.height / 2 - ring.height / 2].map(cy)
  const cands: { side: Side; x: number; y: number }[] = []
  for (const x of xs) cands.push({ side: 'above', x, y: Math.round(box.y - gap - ring.height) }, { side: 'below', x, y: Math.round(box.y + box.height + gap) })
  for (const y of ys) cands.push({ side: 'right', x: Math.round(box.x + box.width + gap), y }, { side: 'left', x: Math.round(box.x - gap - ring.width), y })
  const b = opts.board
  if (b) cands.push({ side: 'above', x: xs[0], y: Math.round(b.y - gap - ring.height) }, { side: 'below', x: xs[0], y: Math.round(b.y + b.height + gap) })
  let best: { side: Side; x: number; y: number; cost: number } | null = null
  for (const c of cands) {
    if (c.x < minX - 0.5 || c.x > maxX + 0.5 || c.y < minY - 0.5 || c.y > maxY + 0.5) continue   // only places that fit as they are
    const r = { x: c.x, y: c.y, width: ring.width, height: ring.height }
    let cost = RING_COST.selection * overlapArea(r, box) + RING_COST.perPx * gapBetween(r, box) + ORDER.indexOf(c.side) * 1e-3
    for (const o of opts.others ?? []) cost += RING_COST.content * overlapArea(r, o)
    if (b) cost += RING_COST.board * overlapArea(r, b)
    for (const a of opts.avoid ?? []) cost += RING_COST.avoid * overlapArea(r, a)
    if (!best || cost < best.cost) best = { ...c, cost }
  }
  if (best) return { x: best.x, y: best.y, side: best.side }
  return { x: xs[0], y: cy(box.y + gap), side: 'inside' }
}

// ------------------------------------------------------------------ alignment guides while moving

export interface Guide {
  axis: 'x' | 'y'
  /** artboard units */
  at: number
}

const lines = (r: Rect) => ({ x: [r.x, r.x + r.width / 2, r.x + r.width], y: [r.y, r.y + r.height / 2, r.y + r.height] })

/**
 * Snap a moving box to the artboard's edges and centre and to the other elements' edges and centres, within
 * `threshold` artboard units. Returns the snapped position and the guides to draw.
 */
export function snap(moving: Rect, others: Rect[], art: Size, threshold: number): { x: number; y: number; guides: Guide[] } {
  const targets = { x: [0, art.width / 2, art.width], y: [0, art.height / 2, art.height] }
  for (const o of others) {
    const l = lines(o)
    targets.x.push(...l.x)
    targets.y.push(...l.y)
  }
  const own = lines(moving)
  const best = (axis: 'x' | 'y') => {
    let found: { d: number; at: number } | null = null
    for (const t of targets[axis]) for (const m of own[axis]) {
      const d = t - m
      if (Math.abs(d) <= threshold && (!found || Math.abs(d) < Math.abs(found.d))) found = { d, at: t }
    }
    return found
  }
  const bx = best('x')
  const by = best('y')
  const guides: Guide[] = []
  if (bx) guides.push({ axis: 'x', at: bx.at })
  if (by) guides.push({ axis: 'y', at: by.at })
  return { x: moving.x + (bx?.d ?? 0), y: moving.y + (by?.d ?? 0), guides }
}

// ------------------------------------------------------------------ resizing from an edge or a corner

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** The box after dragging `handle` by (dx, dy) artboard units; never smaller than `min` either way. */
export function resizeBox(r: Rect, handle: Handle, dx: number, dy: number, min = 8): Rect {
  let { x, y, width, height } = r
  if (handle.includes('e')) width = Math.max(min, r.width + dx)
  if (handle.includes('s')) height = Math.max(min, r.height + dy)
  if (handle.includes('w')) {
    width = Math.max(min, r.width - dx)
    x = r.x + r.width - width
  }
  if (handle.includes('n')) {
    height = Math.max(min, r.height - dy)
    y = r.y + r.height - height
  }
  return { x, y, width, height }
}

/** A handle's position on a screen box. */
export function handlePoint(r: Rect, h: Handle): Point {
  const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.width : r.x + r.width / 2
  const y = h.includes('n') ? r.y : h.includes('s') ? r.y + r.height : r.y + r.height / 2
  return { x, y }
}
