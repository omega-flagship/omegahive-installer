import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  cleanInsets, frameInsets, framedPadding, frameReserved, noticeLane, NOTICE_GAP, NO_RESERVED, sameInsets, sameReserved, ZERO_INSETS,
  type Box, type Insets, type Reserved,
} from '../../lib/frameFit'
import { setAppStage } from '../../shell/appStage'
import { laneClockRoom } from '../../shell/clockModel'

export interface StageFit {
  /** Framed: the host's own padding around the frame (device insets, and the bottom lane for Ω and notices). */
  padding: Insets
  /** Sent to the frame in `context`: measured in the frame's own box. */
  insets: Insets
  reserved: Reserved
}
const INITIAL: StageFit = { padding: ZERO_INSETS, insets: ZERO_INSETS, reserved: NO_RESERVED }
const box = (r: DOMRect): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })

/** The device's safe-area insets, read from the host page (inside the frame they are always 0). */
function readDeviceInsets(probe: HTMLElement): Insets {
  const cs = getComputedStyle(probe)
  return cleanInsets({ top: parseFloat(cs.paddingTop), right: parseFloat(cs.paddingRight), bottom: parseFloat(cs.paddingBottom), left: parseFloat(cs.paddingLeft) })
}

/**
 * Measures the stage for an app frame (PROGRAMS.md §9c Fit) on mount, resize, orientation change, visual-viewport
 * change and whenever the frame or Ω changes size; tells the toast host where the app stage keeps its notices.
 * Values change only when a whole CSS pixel changes, so the frame is re-sent `context` only on a real change.
 */
export function useStageFit(frame: RefObject<HTMLIFrameElement | null>, layout: 'framed' | 'full', ready: boolean): StageFit {
  const [fit, setFit] = useState<StageFit>(INITIAL)
  const measureNow = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    if (!ready || typeof window === 'undefined') return
    const probe = document.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)'
    document.body.appendChild(probe)
    let raf = 0
    let watchedOmega: Element | null = null
    let watchedClock: Element | null = null
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => schedule()) : null
    const measure = () => {
      raf = 0
      const el = frame.current
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      const device = readDeviceInsets(probe)
      // Ω of THIS app stage (the section the frame is in), never another experience's
      const omegaEl = el?.closest('section')?.querySelector('[data-omega-button]') ?? null
      if (omegaEl !== watchedOmega) {
        if (watchedOmega) ro?.unobserve(watchedOmega)
        if (omegaEl) ro?.observe(omegaEl)
        watchedOmega = omegaEl
      }
      const omega = omegaEl ? box(omegaEl.getBoundingClientRect()) : null
      // the host's OS clock (always mounted, hidden while it steps aside): watched, so the lane follows it when it hides,
      // returns or changes width (12/24-hour, a new minute) without the viewport changing
      const clockEl = document.querySelector('.os-clock')
      if (clockEl !== watchedClock) {
        if (watchedClock) ro?.unobserve(watchedClock)
        if (clockEl) ro?.observe(clockEl, { box: 'border-box' })
        watchedClock = clockEl
      }
      const padding = layout === 'framed' ? framedPadding(viewport, device, omega) : ZERO_INSETS
      const f = el ? box(el.getBoundingClientRect()) : null
      const insets = f ? frameInsets(f, viewport, device) : ZERO_INSETS
      const reserved = f ? frameReserved(f, omega) : NO_RESERVED
      setFit((prev) => (sameInsets(prev.padding, padding) && sameInsets(prev.insets, insets) && sameReserved(prev.reserved, reserved) ? prev : { padding, insets, reserved }))
      // the OS clock (shell/OsClock) holds the lane's right end, mirroring Ω at its left
      const clockRoom = layout === 'framed' ? laneClockRoom(viewport.width, clockEl?.getBoundingClientRect(), NOTICE_GAP) : 0
      setAppStage(layout === 'framed' ? { mode: 'framed', lane: noticeLane(device, omega, undefined, clockRoom) } : { mode: 'full', top: device.top + 8 })
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    measureNow.current = schedule
    measure()
    if (frame.current) ro?.observe(frame.current)
    window.addEventListener('resize', schedule)
    window.addEventListener('orientationchange', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      measureNow.current = null
      ro?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('orientationchange', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
      probe.remove()
    }
  }, [frame, layout, ready])
  // the padding just applied moves the frame (a move alone does not resize it): measure once more
  const p = fit.padding
  useLayoutEffect(() => {
    measureNow.current?.()
  }, [p.top, p.right, p.bottom, p.left])
  // the notices go back to their usual place when the app stage goes
  useEffect(() => () => setAppStage(null), [])
  return fit
}
