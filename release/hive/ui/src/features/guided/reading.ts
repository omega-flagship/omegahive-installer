/**
 * Where a READING step's caption goes (stand-in r5 P2; Root r6 acceptance): the target it points at and the caption are
 * both readable, and they never overlap. `placeReading` is pure (boxes in, a placement out; tested without a browser).
 *
 * It owns the target's visibility (Root 170349Z, option a). Two boxes matter:
 *  - the screen the caption may use: the viewport short of the Ask's band (ui/overlays ASK_RESERVE);
 *  - the VIEW: where the target can actually be seen, its scroller's visible box (a sheet's or panel's scroll area,
 *    so not under the panel's own header or a live-log band below it) and above the Ask's band.
 * Every placement it returns, once its `shift` is scrolled, leaves the target whole inside the view (or, too tall,
 * starting at the top of the room left for it, read on by scrolling) and off the caption:
 *  1. Beside: the ordinary hint placement (tour/place placeHint) next to the target (scrolled whole into the view
 *     first, if it was not), the viewers' region counted as covered and offered as the panel to sit outside of. Taken
 *     only on a real fit (covers >= 0) that does not overlap the target; placeHint's fallback (covers -1) never is.
 *  2. Docked: the caption at the top or bottom of the screen, the target scrolled into the part of the view the caption
 *     leaves (the least scroll wins). Neither fits: docked at the top, the target from its top edge under it, the rest
 *     read by scrolling (a scrolling reading arrangement, not a claim that it all fits).
 * The live reveal (store liveEnv.reveal: wholeShift into visibleBand) scrolls the target into its view first; the
 * caption is then placed from the target's measured box after that scroll.
 */
import { useSyncExternalStore } from 'react'
import { placeHint, type Box } from '../../tour/place'
import { askReservePx } from '../../ui/overlays'
import type { GuideRun } from './store'

const M = 8

/** A vertical band of the screen, in viewport px. */
export interface Band {
  top: number
  bottom: number
}

export interface ReadingPlacement {
  left: number
  top: number
  width: number
  /** beside: next to the target; docked-top / docked-bottom: at that edge of the screen */
  mode: 'beside' | 'docked-top' | 'docked-bottom'
  /** how far the target must scroll (positive: its content moves up); 0 when it is already where it reads */
  shift: number
  /** the target is taller than the room it has: only its top part shows, the rest by scrolling */
  scrolls: boolean
}

export const overlaps = (a: Box, b: Box): boolean => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height

/**
 * How far to scroll so a target shows whole inside `band` (positive moves the content up), in whole steps of `step`
 * (a device pixel, 1 / devicePixelRatio, the finest a scroller moves): 0 when it already does; else the least
 * step-aligned move that fits BOTH edges, rechecked after rounding (r6.5 Design 220243Z: a 99.8px target in a 100px
 * band at fractional offsets may have no aligned fit); null when none exists, and the caller makes room or reads by
 * scrolling, never claiming whole. A target taller than the band starts at its top: floor, so the top stays visible.
 */
export function wholeShift(t: Band, band: Band, step = 1): number | null {
  if (t.top >= band.top && t.bottom <= band.bottom) return 0
  if (t.bottom - t.top > band.bottom - band.top) return Math.floor((t.top - band.top) / step) * step
  const s = t.top < band.top ? Math.floor((t.top - band.top) / step) * step : Math.ceil((t.bottom - band.bottom) / step) * step
  return t.top - s >= band.top && t.bottom - s <= band.bottom ? s : null
}

export function placeReading(anchor: Box, size: { width: number; height: number }, viewport: { width: number; height: number }, controls: Box[], region: Box | null, view: Band = { top: 0, bottom: viewport.height }, step = 1): ReadingPlacement {
  const w = Math.min(size.width, viewport.width - 2 * M)
  const h = size.height
  const v = { top: Math.max(0, view.top), bottom: Math.min(viewport.height, view.bottom) }
  const span = { top: anchor.top, bottom: anchor.top + anchor.height }
  // 1. beside the target, once it is whole in the view
  const s0 = anchor.height <= v.bottom - v.top ? wholeShift(span, v, step) : null
  if (s0 !== null) {
    const a = { ...anchor, top: anchor.top - s0 }
    const r = region ? { ...region, top: region.top - s0 } : null
    const p = placeHint(a, { width: w, height: h }, viewport, r ? [...controls, r] : controls, r)
    if (p.covers >= 0 && !overlaps(p, a)) return { left: p.left, top: p.top, width: p.width, mode: 'beside', shift: s0, scrolls: false }
  }
  // 2. docked at an edge of the screen, the target in the part of the view the caption leaves; along that edge, over
  //    the target first, else at either side, the first place that covers none of the kept-clear boxes (a toast, Ω)
  const centred = Math.max(M, Math.min(viewport.width - w - M, anchor.left + anchor.width / 2 - w / 2))
  const lefts = [centred, M, viewport.width - w - M]
  const docks = [
    { mode: 'docked-top' as const, top: M, band: { top: Math.max(v.top, M + h + M), bottom: v.bottom } },
    { mode: 'docked-bottom' as const, top: viewport.height - M - h, band: { top: v.top, bottom: Math.min(v.bottom, viewport.height - M - h - M) } },
  ]
  const leftFor = (top: number) => lefts.find((l) => !controls.some((c) => overlaps({ left: l, top, width: w, height: h }, c)))
  let best: (ReadingPlacement & { clear: boolean }) | null = null
  for (const d of docks) {
    if (d.band.bottom - d.band.top < anchor.height) continue
    const shift = wholeShift(span, d.band, step)
    if (shift === null) continue
    const l = leftFor(d.top)
    const cand = { left: l ?? centred, top: d.top, width: w, mode: d.mode, shift, scrolls: false, clear: l !== undefined }
    // clear of the kept-clear boxes first, then the least scroll
    if (!best || (cand.clear && !best.clear) || (cand.clear === best.clear && Math.abs(shift) < Math.abs(best.shift))) best = cand
  }
  if (best) {
    const { clear: _clear, ...placed } = best
    return placed
  }
  // neither fits: docked at the top, the target from its top edge just under it, read on by scrolling
  return { left: leftFor(M) ?? centred, top: M, width: w, mode: 'docked-top', shift: Math.floor((anchor.top - docks[0].band.top) / step) * step, scrolls: true }
}

/**
 * Room to read, per reading step (Root 184433Z): the target and its frame can change size after the step first found
 * it (a viewer resolving from "loading", a panel settling). Each settled measurement of the same step is observed;
 * the first time the target stops fitting its view, the room is made ONCE for that step (the sheet opened, or the
 * yielding bands reflowed) and kept; another step, run or person starts afresh. Pure: the caller does the making.
 */
export class ReadingRoom {
  private step = ''
  private made = false
  /** `key`: run id, step token and identity epoch; `fits`: the target fits its view now. True: make the room now. */
  observe(key: string, fits: boolean): boolean {
    if (key !== this.step) {
      this.step = key
      this.made = false
    }
    if (fits || this.made) return false
    this.made = true
    return true
  }
  /** the step ended (finish, stop, close, modal, a change of person): nothing is kept */
  release(): void {
    this.step = ''
    this.made = false
  }
}

// ---------------------------------------------------------------- the live page (DOM)

/** The nearest ancestor that scrolls vertically (the sheet or panel holding the target), else the page. */
export function scrollerOf(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p
  }
  return document.scrollingElement
}

/**
 * Where `el` can be seen: the intersection of every ancestor box that clips it (each scrollport and overflow-hidden
 * frame, so not under a sheet's or panel's fixed header nor its live-log band, which sit outside those boxes) and the
 * window above the Ask's band. Empty (bottom <= top) when nothing of it can show.
 */
export function visibleBand(el: Element): Band {
  let top = 0
  let bottom = window.innerHeight - askReservePx()
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    if (getComputedStyle(p).overflowY === 'visible') continue
    const r = p.getBoundingClientRect()
    top = Math.max(top, r.top)
    bottom = Math.min(bottom, r.bottom)
  }
  // and above the Ask as it actually is now, where it is under the target (its capsule can stand taller than its
  // reserved room for a moment, with a status line over it): the measured box, not only the reserve
  const t = el.getBoundingClientRect()
  for (const a of document.querySelectorAll?.('#ask .ask-capsule, #ask .ask-dock, #ask .ask-still-line') ?? []) {
    const r = a.getBoundingClientRect()
    if (r.width < 1 || r.height < 1 || r.right <= t.left || r.left >= t.right || r.top <= top) continue
    bottom = Math.min(bottom, r.top)
  }
  return { top, bottom }
}

/**
 * Whether a reading step is on screen now: a demo at a `read` step, shown (ready, or paused by the person), its target
 * found, and no modal over it. Closed, stopped, finished, fenced (a change of person) or moved on: false at once.
 */
export function readingNow(run: GuideRun | null, underModal: boolean, targetShown: boolean): boolean {
  return run?.kind === 'demo' && !underModal && targetShown && (run.m.status === 'ready' || run.m.status === 'paused') && !!run.script.steps[run.m.step]?.read
}

/** Say on the page that a reading step shows (html[data-guide-reading]); the returned function takes it back, and ends
 *  any reflow the step made (endReflow). */
export function holdAsks(root: HTMLElement): () => void {
  root.dataset.guideReading = ''
  return () => {
    delete root.dataset.guideReading
    endReflow(root)
  }
}

/** A reading step's reflow (html[data-guide-reflow]: the panel bands marked data-reading-yields step aside). */
export function startReflow(root: HTMLElement): void {
  root.dataset.guideReflow = ''
}
export function endReflow(root: HTMLElement): void {
  delete root.dataset.guideReflow
}

/** Whether a reading step shows now (html[data-guide-reading], as holdAsks sets it). */
export const guideReading = (): boolean => typeof document !== 'undefined' && document.documentElement?.dataset.guideReading !== undefined

/**
 * Whether a guided demo's caption or answer is on screen (html[data-guide-demo], set by GuideLayer): its own controls
 * are then never under what belongs to the view beneath (a first-visit hint), at any step, reading or not.
 */
export const guideShowing = (): boolean => typeof document !== 'undefined' && document.documentElement?.dataset.guideDemo !== undefined

/** Say on the page that a guided demo shows; the returned function takes it back. */
export function markDemo(root: HTMLElement): () => void {
  root.dataset.guideDemo = ''
  return () => {
    delete root.dataset.guideDemo
    endReflow(root)
  }
}

/**
 * guideShowing, re-rendering when it changes: a first-visit hint (tour/ViewInfo) waits while a guided demo shows,
 * without being forgotten or marked seen, and comes back when it ends.
 */
export function useGuideShowing(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mo = new MutationObserver(cb)
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-guide-demo'] })
      return () => mo.disconnect()
    },
    guideShowing,
    () => false,
  )
}

/** A reading target as measured: the clipped box (the highlight), the element, its whole box and its view band. */
export interface TargetMeasure {
  box: { left: number; top: number; right: number; bottom: number } | null
  el: Element | null
  full: { left: number; top: number; right: number; bottom: number } | null
  band: Band | null
}
/** the same edge in device pixels (the finest step the screen draws): r6.5/r6.6's rule, so a 0.5px change at 2x counts */
const near = (a: Record<string, number> | null, b: Record<string, number> | null, dpr: number): boolean => (!a || !b ? a === b : Object.keys(b).every((k) => Math.round(a[k] * dpr) === Math.round(b[k] * dpr)))
/**
 * Whether two measurements are the same for layout: the element, the clipped box, the whole box AND the band, each
 * edge compared in device pixels (stand-in r6 P3: at DPR 2 a 0.5 CSS px growth is a whole device pixel and can turn a
 * whole fit into clipping).
 */
export function sameMeasure(a: TargetMeasure, b: TargetMeasure, dpr: number = (typeof window !== 'undefined' && window.devicePixelRatio) || 1): boolean {
  // noise may be filtered only within the same fit class (Root 231754Z): a change of whole/clipped, or of the shift
  // that would bring it whole, is always a new measurement, however small
  if (fitClass(a, dpr) !== fitClass(b, dpr)) return false
  return a.el === b.el && near(a.box, b.box, dpr) && near(a.full, b.full, dpr) && near(a.band as Record<string, number> | null, b.band as Record<string, number> | null, dpr)
}

/** A measurement's fit class: whole or clipped in its band (exact), and the device-pixel shift that would make it whole. */
function fitClass(m: TargetMeasure, dpr: number): string {
  if (!m.full || !m.band) return 'none'
  const t = { top: m.full.top, bottom: m.full.bottom }
  return `${t.top >= m.band.top && t.bottom <= m.band.bottom ? 'whole' : 'clipped'}:${wholeShift(t, m.band, 1 / dpr)}`
}
