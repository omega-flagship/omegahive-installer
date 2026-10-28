/**
 * Where the Ask sits (UNIVERSAL_ASK_DESIGN §1.1): bottom centre, clear of Ω (its 36 px glyph + 12 px margin + 12 px gap)
 * and the safe areas, above a dock or the phone's tab bar; the thread rises above it on desktop (or is pinned as a
 * side column), is a bottom sheet on a phone and a right-half side sheet in landscape. Pure, and tested.
 */
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

export function placeAsk(p: PlacementIn): Placement {
  const mode = askMode(p.width, p.height)
  const margin = mode === 'desktop' ? 24 : 10
  let minLeft = Math.max(margin, p.omegaRight !== null ? p.omegaRight + OMEGA_CLEAR : 0, p.railX ?? 0)
  let bottom = mode === 'desktop' ? 18 : 10
  if (mode === 'desktop' && p.layout === 'dock' && !p.page) bottom = 12 + 60 + 8 + 6
  if (mode === 'phone' && p.tabBar) bottom = 74
  if (mode === 'landscape') {
    // a compact capsule right of Ω, in the left half (the thread takes the right half)
    const width = Math.max(220, Math.min(420, p.width / 2 - minLeft - margin))
    return { mode, bottom: 8, left: minLeft, width }
  }
  // on the clock's row (the bottom 48 px plus a gap), the Ask's right edge stops short of the OS clock
  let maxRight = p.clockLeft != null && bottom < CLOCK_ROW ? Math.min(p.width - margin, p.clockLeft - OMEGA_CLEAR) : p.width - margin
  // a phone where that leaves too little: above Ω and the clock's row, the full width (Ω and the clock sit on that row only)
  if (mode === 'phone' && bottom < CLOCK_ROW && maxRight - minLeft < ASK_PHONE_MIN) {
    bottom = CLOCK_ROW
    maxRight = p.width - margin
    minLeft = Math.max(margin, p.railX ?? 0)
  }
  const avail = maxRight - minLeft
  const width = Math.min(ASK_MAX, avail)
  // centred in the content area: right of the classic rail when it shows (as pages are), else the whole width
  const contentLeft = p.railX ?? 0
  const centred = contentLeft + (p.width - contentLeft - width) / 2
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
  const open = placeAsk({ ...p, clockLeft: null, omegaRight: null })
  if (open.width <= lifted.width) return lifted
  const wide = liftClear({ ...open, bottom: lifted.bottom }, boxes, vp, sab)
  return wide.bottom === lifted.bottom ? wide : lifted
}
