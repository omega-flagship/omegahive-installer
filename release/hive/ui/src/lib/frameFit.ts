/**
 * Frame fit (PROGRAMS.md §9a/§9c "Fit"): how an app's own interface sits on the host's stage, on any screen.
 *
 * Inside a sandboxed iframe `env(safe-area-inset-*)` is 0, and the frame cannot see the host's Ω corner. The host
 * therefore measures both and tells the frame, in its own box's coordinates:
 *
 * - `insets`: how far the device's safe-area bands (notch, home indicator, rounded corners) reach into the frame.
 * - `reserved.bottomLeft`: the rectangle at the frame's bottom-left corner that Ω (plus a margin) covers.
 *
 * Framed: the host pads the frame clear of both (a bottom lane holds Ω and host notices), so both read 0.
 * Full-bleed: the frame fills the stage and must honour both itself.
 *
 * Every function here is pure, so the geometry is tested without a browser.
 */

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}
export interface Reserved {
  bottomLeft: { width: number; height: number }
}
/** A box in viewport CSS px (as getBoundingClientRect gives it). */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}
export interface Viewport {
  width: number
  height: number
}

/** Space kept around Ω on every side (its glyph's own offset from the screen edge is the same 12 px). */
export const OMEGA_MARGIN = 12
/** Ω's visible glyph: a 36 px disc, 12 px from the left and bottom edges (plus the safe areas), on every screen. */
export const OMEGA_GLYPH = 36
/** The smallest touch target on a coarse pointer (WCAG 2.5.5 / Apple HIG 44 pt). */
export const TOUCH_MIN = 44

/**
 * Ω's hit area (request Q): the glyph itself on a fine pointer; on a coarse pointer a 44 px square with the same glyph
 * centred in it, so the glyph does not move and the target grows outwards into the corner (4 px each side).
 * `offset` is the hit area's distance from the left and bottom edges (before safe areas).
 */
export function omegaHit(coarse: boolean): { size: number; offset: number; glyph: number } {
  const size = coarse ? TOUCH_MIN : OMEGA_GLYPH
  return { size, offset: OMEGA_MARGIN - (size - OMEGA_GLYPH) / 2, glyph: OMEGA_GLYPH }
}
/** No value larger than this is ever sent (a measurement gone wrong must not blank the frame). */
const MAX_PX = 4096

export const ZERO_INSETS: Insets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 }) as Insets
export const NO_RESERVED: Reserved = Object.freeze({ bottomLeft: Object.freeze({ width: 0, height: 0 }) }) as Reserved

/** A length as whole CSS px: finite, at least 0, at most 4096, rounded up (a fraction of a pixel still covers). */
export function px(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.ceil(v - 1e-6), MAX_PX) : 0
}

/** Insets as data: exactly top/right/bottom/left, each px(). */
export function cleanInsets(i: Partial<Record<keyof Insets, unknown>> | null | undefined): Insets {
  if (!i) return { ...ZERO_INSETS }
  return { top: px(i.top), right: px(i.right), bottom: px(i.bottom), left: px(i.left) }
}

/** Reserved as data: exactly `{bottomLeft: {width, height}}`, each px(); a zero side zeroes both (no area). */
export function cleanReserved(r: { bottomLeft?: { width?: unknown; height?: unknown } | null } | null | undefined): Reserved {
  const width = px(r?.bottomLeft?.width)
  const height = px(r?.bottomLeft?.height)
  return width && height ? { bottomLeft: { width, height } } : { bottomLeft: { width: 0, height: 0 } }
}

const span = (b: Box) => ({ w: Math.max(0, b.right - b.left), h: Math.max(0, b.bottom - b.top) })

/** How far each of the device's safe-area bands reaches into `frame` (0 where the frame already clears it). */
export function frameInsets(frame: Box, viewport: Viewport, device: Insets): Insets {
  const { w, h } = span(frame)
  if (!w || !h) return { ...ZERO_INSETS }
  const d = cleanInsets(device)
  const clamp = (v: number, max: number) => px(Math.min(Math.max(v, 0), max))
  return {
    top: clamp(d.top - frame.top, h),
    right: clamp(frame.right - (viewport.width - d.right), w),
    bottom: clamp(frame.bottom - (viewport.height - d.bottom), h),
    left: clamp(d.left - frame.left, w),
  }
}

/** Ω's box grown by the margin: the area nothing of the frame's should sit under. */
export function omegaArea(omega: Box, margin = OMEGA_MARGIN): Box {
  return { left: omega.left - margin, top: omega.top - margin, right: omega.right + margin, bottom: omega.bottom + margin }
}

/** The rectangle at the frame's bottom-left corner that Ω (with its margin) covers; zero when they do not meet. */
export function frameReserved(frame: Box, omega: Box | null, margin = OMEGA_MARGIN): Reserved {
  const { w, h } = span(frame)
  if (!omega || !w || !h || !span(omega).w || !span(omega).h) return cleanReserved(null)
  const o = omegaArea(omega, margin)
  if (o.right <= frame.left || o.left >= frame.right || o.bottom <= frame.top || o.top >= frame.bottom) return cleanReserved(null)
  return cleanReserved({ bottomLeft: { width: Math.min(o.right - frame.left, w), height: Math.min(frame.bottom - o.top, h) } })
}

/**
 * Framed: the host's own padding around the frame. The device insets on every side, and at the bottom a lane as tall
 * as Ω's area (Ω on its left, host notices on its right), so neither Ω nor a notice ever covers the frame.
 */
export function framedPadding(viewport: Viewport, device: Insets, omega: Box | null, margin = OMEGA_MARGIN): Insets {
  const d = cleanInsets(device)
  const lane = omega && span(omega).h ? viewport.height - omegaArea(omega, margin).top : 0
  return { top: d.top, right: d.right, bottom: Math.max(d.bottom, px(lane)), left: d.left }
}

/**
 * The host's notice lane in framed mode: right of Ω's area, as tall as it, above the bottom inset. Null: no Ω.
 * `clockRoom`: how far from the right edge the host's OS clock (shell/clockModel.ts) reaches, gap included; the lane ends
 * there, so a notice never covers the clock at the lane's right end.
 */
export function noticeLane(device: Insets, omega: Box | null, margin = OMEGA_MARGIN, clockRoom = 0): { left: number; top: number; right: number; bottom: number } | null {
  if (!omega || !span(omega).h) return null
  const d = cleanInsets(device)
  const o = omegaArea(omega, margin)
  return { left: px(o.right), top: px(o.top), right: Math.max(d.right, margin, px(clockRoom)), bottom: d.bottom }
}

/** Gap kept between a host notice and anything it must keep clear of. */
export const NOTICE_GAP = 8
/** The one-line notice pill grows no wider than this (and never past 12 px from either side). */
export const NOTICE_MAX_WIDTH = 512

/** The widest the top-centre notice pill can be at this viewport (it is centred in the lane, 12 px in from each side). */
export function noticePillWidth(viewport: Viewport): number {
  return Math.max(0, Math.min(viewport.width - 2 * OMEGA_MARGIN, NOTICE_MAX_WIDTH))
}

const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))

/** How much of `boxes` the pill at `top` (top centre, with `gap` around it) covers, in square px. */
export function noticeOverlap(viewport: Viewport, top: number, pill: { width: number; height: number }, boxes: Box[], gap = NOTICE_GAP): number {
  const left = (viewport.width - pill.width) / 2
  const r: Box = { left: left - gap, top: top - gap, right: left + pill.width + gap, bottom: top + pill.height + gap }
  return boxes.reduce((s, b) => s + overlap(r, b), 0)
}

/**
 * Experience stage (request Q): where the host's one-line notice goes while a whole experience is in front. Top centre
 * by preference, never over the chrome the experience asked the host to keep clear (`keepClear`: `data-xc-keep-clear`
 * bars, docks, pagers, command lines, and Ω), always between the top and bottom insets. The places tried are the top
 * (inset + gap) and just below and just above each box. Of those, the one covering the least kept-clear area wins;
 * among equals, the one covering the least of the experience's other controls (`avoid`: things in its scene or page
 * that happen to be there when the notice arrives); among equals, the higher. The result is a whole CSS px.
 */
export function experienceNoticeTop(viewport: Viewport, device: Insets, keepClear: Box[], pill: { width: number; height: number }, gap = NOTICE_GAP, avoid: Box[] = []): number {
  const d = cleanInsets(device)
  const floor = d.top + gap
  const ceiling = viewport.height - d.bottom - gap - pill.height
  const real = (bs: Box[]) => bs.filter((b) => span(b).w > 0 && span(b).h > 0)
  const hard = real(keepClear)
  const soft = real(avoid)
  const places = [floor, ...[...hard, ...soft].flatMap((b) => [b.bottom + gap, b.top - gap - pill.height])]
  const tops = [...new Set(places.map((t) => Math.ceil(t - 1e-6)))].filter((t) => t >= floor && t <= ceiling).sort((a, b) => a - b)
  if (!tops.length) return px(floor)
  let best = tops[0]
  let bestCost: [number, number] = [Infinity, Infinity]
  for (const t of tops) {
    const c: [number, number] = [noticeOverlap(viewport, t, pill, hard, gap), noticeOverlap(viewport, t, pill, soft, gap)]
    if (c[0] < bestCost[0] || (c[0] === bestCost[0] && c[1] < bestCost[1])) {
      best = t
      bestCost = c
      if (c[0] === 0 && c[1] === 0) break
    }
  }
  return px(best)
}

/**
 * Experience stage with a reserved notice row (followups-r9 item 2): an experience whose layout keeps a row of its own
 * for the host's notice (`data-xc-notice-row`, sized to the notice's measured height) gets the pill in that row, so
 * its content (a console, a log) sits beside the notice instead of under it. The row's top, kept between the device
 * insets; null with no row, and the pill goes where `experienceNoticeTop` puts it.
 */
export function noticeRowTop(viewport: Viewport, device: Insets, row: Box | null, pill: { height: number }): number | null {
  if (!row || !(row.bottom - row.top > 0) || !(row.right - row.left > 0)) return null
  const d = cleanInsets(device)
  return px(Math.max(d.top, Math.min(Math.ceil(row.top - 1e-6), viewport.height - d.bottom - pill.height)))
}

export const sameInsets = (a: Insets, b: Insets) => a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left
export const sameReserved = (a: Reserved, b: Reserved) => a.bottomLeft.width === b.bottomLeft.width && a.bottomLeft.height === b.bottomLeft.height
