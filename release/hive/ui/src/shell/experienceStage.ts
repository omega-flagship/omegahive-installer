import { useEffect, useLayoutEffect } from 'react'
import { cleanInsets, experienceNoticeTop, noticeOverlap, noticePillWidth, noticeRowTop, OMEGA_GLYPH, TOUCH_MIN, type Box, type Insets } from '../lib/frameFit'
import { useHive } from '../store/store'
import { setAppStage, useAppStage, type AppStage } from './appStage'

/** Marks chrome a whole experience asks the host to keep clear of its notices: bars, docks, pagers, command lines. */
export const KEEP_CLEAR = 'data-xc-keep-clear'

/**
 * Marks a row an experience's own layout reserves for the host's notice (followups-r9 item 2; Construct's phone deck):
 * while it is visible the pill sits in it, and the host keeps `--xc-notice-h` on the root at the pill's actual height so
 * the row (and the content laid out after it) makes exactly that much room. No row: the pill is placed as below.
 */
export const NOTICE_ROW = 'data-xc-notice-row'
export const NOTICE_HEIGHT_VAR = '--xc-notice-h'

const box = (r: DOMRect): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })

function readDeviceInsets(probe: HTMLElement): Insets {
  const cs = getComputedStyle(probe)
  return cleanInsets({ top: parseFloat(cs.paddingTop), right: parseFloat(cs.paddingRight), bottom: parseFloat(cs.paddingBottom), left: parseFloat(cs.paddingLeft) })
}

const visibleBox = (el: Element): Box | null => {
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) return null
  if (el.closest('[inert],[aria-hidden="true"]')) return null
  const cs = getComputedStyle(el)
  return cs.visibility === 'hidden' || Number(cs.opacity) === 0 ? null : box(r)
}

/** Whether an experience's reserved notice row is open: a notice is showing and it is placed on the experience stage. */
export function reservesNoticeRow(notices: number, stage: AppStage | null): boolean {
  return notices > 0 && stage?.mode === 'experience'
}

/** For an experience's layout: open its reserved notice row (`NOTICE_ROW`) now. */
export function useNoticeRow(): boolean {
  const notices = useHive((s) => s.toasts.length)
  return reservesNoticeRow(notices, useAppStage())
}

/** The boxes to keep clear right now: every visible `data-xc-keep-clear` element, and Ω's hit area. */
function keepClearBoxes(): Box[] {
  return [...document.querySelectorAll(`[${KEEP_CLEAR}], [data-omega-button]`)].map(visibleBox).filter((b): b is Box => !!b)
}

/** The experience's reserved notice row, when one is visible. */
function noticeRowBox(): Box | null {
  const el = document.querySelector(`[${NOTICE_ROW}]`)
  return el ? visibleBox(el) : null
}

/** The pill's actual height on screen (it sits in the host's toast lane), or null while none is shown. */
function shownPillHeight(): number | null {
  const el = document.querySelector('[data-toast-place] [data-toast-pill]')
  const h = el?.getBoundingClientRect().height ?? 0
  return h >= 1 ? Math.ceil(h) : null
}

/** The experience's other visible controls (its scene, its page): avoided when there is a choice, never chased. */
function controlBoxes(): Box[] {
  const out: Box[] = []
  for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role=tab]')) {
    if (el.closest(`[${KEEP_CLEAR}], [data-omega-button], [data-toast-place], .toast-stack`)) continue
    const b = visibleBox(el)
    if (b) out.push(b)
  }
  return out
}

/**
 * Request Q: while a whole experience is in front (`active`), host notices are the one-line pill, top centre by
 * preference, placed clear of the chrome the experience keeps clear (lib/frameFit `experienceNoticeTop`): never over its
 * bottom band, its top bars or Ω, and where it can, over none of its other controls. The place is measured on mount, on
 * resize and orientation change, and when a notice arrives; while one shows it is re-checked every 250 ms and moves
 * only if kept-clear chrome now meets it (a pager that appears, a dock that springs in), never to chase scene content.
 * Nothing is measured while no notice shows (measured before paint, so a notice never flashes in the wrong place).
 * Inactive (a classic page or sheet over the experience): notices go back to where they always are. Notices stay
 * under every dialog and inert behind it, as on the app stage; the approval queue still waits for open dialogs.
 */
export function useExperienceNotices(active: boolean): void {
  const showing = useHive((s) => s.toasts.length > 0)
  useLayoutEffect(() => {
    if (!active || typeof window === 'undefined') return
    const probe = document.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)'
    document.body.appendChild(probe)
    const coarse = window.matchMedia('(pointer: coarse)')
    let raf = 0
    let top: number | null = null
    let settled = false
    const measure = () => {
      raf = 0
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      const pill = { width: noticePillWidth(viewport), height: coarse.matches ? TOUCH_MIN : OMEGA_GLYPH }
      const root = document.documentElement.style
      if (showing) root.setProperty(NOTICE_HEIGHT_VAR, `${shownPillHeight() ?? pill.height}px`)
      else root.removeProperty(NOTICE_HEIGHT_VAR)
      // the experience reserved a row for the notice: the pill sits in it, wherever that row now is
      const inRow = noticeRowTop(viewport, readDeviceInsets(probe), showing ? noticeRowBox() : null, pill)
      if (inRow !== null) {
        top = inRow
        settled = showing
        setAppStage({ mode: 'experience', top })
        return
      }
      const clear = keepClearBoxes()
      // a notice that is showing stays put while the chrome around it stays clear (scene content moving is not chased)
      if (settled && top !== null && noticeOverlap(viewport, top, pill, clear) === 0 && top + pill.height <= viewport.height) return
      top = experienceNoticeTop(viewport, readDeviceInsets(probe), clear, pill, undefined, showing ? controlBoxes() : [])
      settled = showing
      setAppStage({ mode: 'experience', top })
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    const resized = () => {
      settled = false
      schedule()
    }
    measure()
    const poll = showing ? setInterval(schedule, 250) : null
    window.addEventListener('resize', resized)
    window.addEventListener('orientationchange', resized)
    window.visualViewport?.addEventListener('resize', resized)
    coarse.addEventListener('change', resized)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (poll) clearInterval(poll)
      window.removeEventListener('resize', resized)
      window.removeEventListener('orientationchange', resized)
      window.visualViewport?.removeEventListener('resize', resized)
      coarse.removeEventListener('change', resized)
      document.documentElement.style.removeProperty(NOTICE_HEIGHT_VAR)
      probe.remove()
    }
  }, [active, showing])
  // back to the usual place when the experience goes behind a page, or goes
  useEffect(() => {
    if (active) return () => setAppStage(null)
  }, [active])
}
