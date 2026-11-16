/** Purpose: place the Ask on the screen, pure and tested.
 * Where the Ask sits (UNIVERSAL_ASK_DESIGN §1.1): bottom centre, clear of Ω (its 36 px glyph + 12 px margin + 12 px gap)
 * and the safe areas, above a dock or the phone's tab bar; the thread rises above it on desktop (or is pinned as a
 * side column), is a bottom sheet on a phone and a right-half side sheet in landscape. At the person's other two sizes
 * (features/ask/askSize.ts) it is the collapsed mark at the start of its row (placeMark) or the left half (placeHalf).
 * Pure, and tested.
 */
import { cornerTop } from '../../shell/clockModel'

export type AskMode = 'desktop' | 'phone' | 'landscape'

export interface PlacementIn {
  width: number
  height: number
  /** the classic navigation layout */
  layout: 'rail' | 'topbar' | 'dock'
  /** a classic page covers the phone's tab bar */
  page: boolean
  /** classic shows the phone tab bar: on the hive, and above its pages (Classic nav redesign: More stays one tap away) */
  tabBar: boolean
  /** Ω's right edge, when Ω is on screen (experiences, app frames) */
  omegaRight: number | null
  /** The classic rail's clear left edge for content (`--rail-x`), when the rail is on screen: the Ask never covers it */
  railX?: number | null
  /** The OS clock's left edge, when it shows (shell/OsClock): on the clock's row the Ask ends before it, as it starts after Ω */
  clockLeft?: number | null
  /**
   * The hive's own home (no page open): the Ask sits on the page's centre axis with the mark, the title and the apps
   * (Jon, 3 Nov: "some of them should be centered"), still never over the rail. A page centres it in its content area.
   */
  pageAxis?: boolean
  /** px the page's centre axis moves left for a thread pinned beside it (PINNED_AXIS_SHIFT), so the Ask and the Ω share it */
  axisShift?: number
}

/** A desktop thread pinned beside the home takes the right; what's left is centred this far left of the page's centre */
export const PINNED_AXIS_SHIFT = 202

/**
 * Where the Ask's thread sits beside the view, if it does: the left half at the person's half size (`half`: an Ask at
 * that size is on screen, in any look), a side sheet in landscape, a pinned column on desktop. The one source for both
 * the root's `data-ask-side` (which the scene frames by) and the Ask's own axis shift.
 */
export function askSideOf(o: { floating: boolean; threadOpen: boolean; pinned: boolean; mode: AskMode; half?: boolean }): 'desktop' | 'landscape' | 'half' | null {
  if (o.half) return 'half'
  if (!o.floating || !o.threadOpen) return null
  if (o.mode === 'landscape') return 'landscape'
  return o.mode === 'desktop' && o.pinned ? 'desktop' : null
}

export interface Placement {
  mode: AskMode
  /** px above the bottom safe area */
  bottom: number
  left: number
  width: number
}

export const OMEGA_CLEAR = 12
/** The OS clock's row: its box is 12 + 36 px above the bottom safe area (shell/clockModel CLOCK_MARGIN + CLOCK_HEIGHT), plus a gap */
export const CLOCK_ROW = 12 + 36 + 8
export const ASK_MAX = 640
/**
 * The narrowest the Ask is fitted between Ω and the OS clock on a phone (audit P1 #1: the text box was 59–113 px on app
 * pages, mind sheets, Still and Professional). Narrower, it rises above their row and takes the full width there, as
 * wide as above the classic tab bar.
 */
export const ASK_PHONE_MIN = 300

export function askMode(width: number, height: number): AskMode {
  if (height < 500 && width > height) return 'landscape'
  return width < 768 ? 'phone' : 'desktop'
}

/** The margin the Ask keeps from the screen's sides: 24 px on a desktop, 10 px on a phone. */
const marginOf = (mode: AskMode): number => (mode === 'desktop' ? 24 : 10)

/** Where the Ask's row starts: past the margin, Ω (when it is on screen) and the classic rail. Pure, and tested. */
export function rowStart(p: PlacementIn): number {
  return Math.max(marginOf(askMode(p.width, p.height)), p.omegaRight !== null ? p.omegaRight + OMEGA_CLEAR : 0, p.railX ?? 0)
}

/**
 * The Ask's row height above the bottom safe area before anything lifts it: above a classic dock, above a phone's tab
 * bar, else at the foot. Pure, and tested.
 */
export function rowBottom(p: PlacementIn): number {
  const mode = askMode(p.width, p.height)
  if (mode === 'landscape') return 8
  if (mode === 'desktop') return p.layout === 'dock' && !p.page ? 12 + 60 + 8 + 6 : 18
  return p.tabBar ? 74 : 10
}

export function placeAsk(p: PlacementIn): Placement {
  const mode = askMode(p.width, p.height)
  const margin = marginOf(mode)
  let minLeft = rowStart(p)
  let bottom = rowBottom(p)
  if (mode === 'landscape') {
    // a compact capsule right of Ω, in the left half (the thread takes the right half)
    const width = Math.max(220, Math.min(420, p.width / 2 - minLeft - margin))
    return { mode, bottom, left: minLeft, width }
  }
  // beside the host's corner (the clock's row, and the feedback entry where it stands on the clock: shell/clockModel
  // cornerTop), the Ask's right edge stops short of it
  const row = cornerTop(p.width)
  let maxRight = p.clockLeft != null && bottom < row ? Math.min(p.width - margin, p.clockLeft - OMEGA_CLEAR) : p.width - margin
  // a phone where that leaves too little: above Ω and the corner, the full width (Ω and the corner sit on that row only)
  if (mode === 'phone' && bottom < row && maxRight - minLeft < ASK_PHONE_MIN) {
    bottom = row
    maxRight = p.width - margin
    minLeft = Math.max(margin, p.railX ?? 0)
  }
  const avail = maxRight - minLeft
  const width = Math.min(ASK_MAX, avail)
  // on the home, on the page's centre axis; on a page, centred in its content area (right of the rail, as pages are)
  const contentLeft = p.pageAxis ? 0 : (p.railX ?? 0)
  const centred = contentLeft + (p.width - contentLeft - width) / 2 - (p.pageAxis ? p.axisShift ?? 0 : 0)
  return { mode, bottom, left: Math.max(minLeft, Math.min(centred, maxRight - width)), width }
}

/**
 * Whether the Ask is under a modal layer (AskHost dims it then): an open aria-modal dialog that is not the Ask's own, or
 * modal containment (ui/useModalContainment) has made the Ask inert, as a nav menu does over the rail or a sheet. The
 * second keeps the dimming true to what can be used: a layer without aria-modal still leaves the Ask unusable.
 */
export const askUnderModal = (doc: Pick<Document, 'querySelector'>, ask: Pick<Element, 'closest'> | null): boolean =>
  !!doc.querySelector('[aria-modal="true"]:not([data-ask-own])') || !!ask?.closest('[inert]')

/** A screen box (CSS px from the viewport's top-left). */
export interface ClearBox {
  left: number
  top: number
  right: number
  bottom: number
}

/** The Ask's capsule height at rest (ask.css `.ask-capsule` min-height) plus a little air. */
export const ASK_HEIGHT = 56
/** How high the Ask may be lifted: never above this share of the screen (a tall chrome column is not a floor). */
export const LIFT_MAX_SHARE = 0.55

/**
 * Inside an experience, the Ask never covers the chrome the experience asked the host to keep clear
 * (`data-xc-keep-clear`: navigators, pills, docks, pagers, chip rows; shell/experienceStage). Given where `placeAsk`
 * put it and the kept-clear boxes on screen now, it is lifted just above any box it would meet in the lower part of the
 * screen, repeatedly, until it meets none. Boxes in the upper part (top bars, beacons) are left to the notices. Ω is
 * handled by `placeAsk` (left clearance), not here. `sab` is the bottom safe area (the Ask's `bottom` is above it).
 * Pure, and tested.
 */
export function liftClear(p: Placement, boxes: ClearBox[], viewport: { width: number; height: number }, sab = 0, height = ASK_HEIGHT, gap = 8): Placement {
  const H = viewport.height
  const floor = H * (1 - LIFT_MAX_SHARE)
  const low = boxes.filter((b) => b.right - b.left >= 1 && b.bottom - b.top >= 1 && b.top >= floor - 1 && b.top < H && b.bottom > 0)
  let bottom = p.bottom
  for (let i = 0; i < 8; i++) {
    const top = H - sab - bottom - height
    const base = H - sab - bottom
    const hit = low.filter((b) => b.left < p.left + p.width && b.right > p.left && b.top < base && b.bottom > top)
    if (!hit.length) break
    const next = Math.ceil(H - sab - Math.min(...hit.map((b) => b.top)) + gap)
    if (next <= bottom || H - sab - next - height < floor) break
    bottom = next
  }
  return bottom === p.bottom ? p : { ...p, bottom }
}

/**
 * Inside an experience: `placeAsk`, then lifted clear of the kept-clear chrome (`liftClear`). Once lifted above the
 * bottom row that Ω and the OS clock share, neither is beside it any more, so it takes the full width of the content
 * row there (on a phone the clock row would otherwise leave the field a few characters wide), and is lifted again in
 * case the wider field meets other chrome. If the wider field cannot be placed as low, the narrow lifted one stays.
 * Pure, and tested.
 */
export function placeInExperience(p: PlacementIn, boxes: ClearBox[], sab = 0): Placement {
  const base = placeAsk(p)
  if (!boxes.length) return base
  const vp = { width: p.width, height: p.height }
  const lifted = liftClear(base, boxes, vp, sab)
  if (lifted.mode === 'landscape' || lifted.bottom < CLOCK_ROW || (p.clockLeft == null && p.omegaRight == null)) return lifted
  // above Ω's row Ω is no longer beside it; the feedback entry standing on the clock still is, up to the corner's top,
  // so there the field ends before the corner
  const open = placeAsk({ ...p, clockLeft: lifted.bottom < cornerTop(p.width) ? p.clockLeft : null, omegaRight: null })
  if (open.width <= lifted.width) return lifted
  const wide = liftClear({ ...open, bottom: lifted.bottom }, boxes, vp, sab)
  return wide.bottom === lifted.bottom ? wide : lifted
}

/** The collapsed Ask's mark: one round control the height of Ω's touch target (ask.css .ask-collapsed). */
export const MARK_SIZE = 44

/**
 * Where the collapsed Ask's mark sits: at the start of the Ask's row, right of Ω or the rail (Haley, Lisbon 13 Nov: "that
 * little Omega icon in the bottom left corner"), on the row's own height, lifted clear of an experience's kept-clear
 * chrome as the field is. Pure, and tested.
 */
export function placeMark(p: PlacementIn, boxes: ClearBox[], sab = 0): Placement {
  const mode = askMode(p.width, p.height)
  return liftClear({ mode, bottom: rowBottom(p), left: rowStart(p), width: MARK_SIZE }, boxes, { width: p.width, height: p.height }, sab, MARK_SIZE)
}

/**
 * The Ask at half size on a desktop or a landscape phone: the left half of the screen right of where its row starts,
 * the field on the row's height (lifted clear of kept-clear chrome as it always is) and the thread in the column above
 * it; the stage arranges in the rest (screens/arrange stageWindow). Pure, and tested.
 */
export function placeHalf(p: PlacementIn, boxes: ClearBox[], sab = 0): Placement {
  const mode = askMode(p.width, p.height)
  const left = rowStart(p)
  const width = Math.round((p.width - left) / 2) - marginOf(mode)
  return liftClear({ mode, bottom: rowBottom(p), left, width }, boxes, { width: p.width, height: p.height }, sab)
}
