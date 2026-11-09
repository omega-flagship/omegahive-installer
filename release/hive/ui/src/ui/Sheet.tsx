import { m, useDragControls, type PanInfo } from 'framer-motion'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useEscape, useIsDesktop, useReducedMotion } from '../lib/hooks'
import { useScene } from '../scene/sceneStore'
import { cx } from '../lib/cx'
import { ASK_RESERVE, useOverlay } from './overlays'

export type Snap = 'peek' | 'full'

/**
 * A responsive panel: a glass side panel on desktop, a draggable bottom sheet on phones.
 * It reports the space it covers so the scene camera can centre in what is left.
 */
export function Sheet({
  label,
  onClose,
  children,
  width = 440,
  initialSnap = 'full',
  peekHeight = '52dvh',
  header,
  className,
  onEscape,
}: {
  label: string
  onClose: () => void
  children: ReactNode
  width?: number
  initialSnap?: Snap
  peekHeight?: string
  header?: ReactNode
  className?: string
  /** What Esc does when it should differ from closing (e.g. back one step inside the panel). */
  onEscape?: () => void
}) {
  const desktop = useIsDesktop()
  const reduced = useReducedMotion()
  const id = useId()
  const setInset = useScene((s) => s.setInset)
  const ref = useRef<HTMLDivElement>(null)
  const [snap, setSnap] = useState<Snap>(initialSnap)
  const drag = useDragControls()
  // first-visit hints of the view beneath wait while this sheet is open (ui/overlays)
  useOverlay(ref)

  useEscape(onEscape ?? onClose)

  const reportRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const report = () => {
      const r = el.getBoundingClientRect()
      if (desktop) setInset(id, { right: window.innerWidth - r.left + 8 })
      else setInset(id, { bottom: Math.min(window.innerHeight * 0.6, window.innerHeight - r.top) })
    }
    reportRef.current = report
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
      setInset(id, null)
    }
  }, [desktop, id, setInset, snap])

  useEffect(() => {
    // move focus into the panel for keyboard and screen-reader users
    const el = ref.current
    if (!el) return
    const t = setTimeout(() => {
      if (el.contains(document.activeElement)) return
      const target = el.querySelector<HTMLElement>('[data-autofocus]') ?? el
      target.focus({ preventScroll: true })
    }, 60)
    return () => clearTimeout(t)
  }, [])

  const spring = reduced ? { duration: 0.15 } : { type: 'spring' as const, stiffness: 380, damping: 38, mass: 0.9 }

  if (desktop) {
    return (
      <m.aside
        ref={ref}
        role="dialog"
        aria-modal="false"
        aria-label={label}
        tabIndex={-1}
        onAnimationComplete={() => reportRef.current()}
        initial={{ opacity: 0, x: 48, scale: 0.985 }}
        animate={{ opacity: 1, x: 0, scale: 1 }}
        exit={{ opacity: 0, x: 48, scale: 0.985, transition: { duration: 0.18 } }}
        transition={spring}
        className={cx('xc-dress xc-frame glass-strong fixed top-3 right-3 bottom-3 z-30 flex flex-col overflow-hidden rounded-[22px] outline-none', className)}
        // ends above the host's OS clock in the bottom-right corner (shell/osClock.css) and above the universal Ask's room
        // (ui/overlays ASK_RESERVE), which stay visible and reachable: the Ask spans the bottom centre, so a side panel's
        // bottom row (a sticky footer, a composer) would otherwise sit under it
        style={{ width, bottom: `max(12px, var(--os-clock-lift, 0px), ${ASK_RESERVE}, var(--ask-pop-room, 0px))` }}
      >
        {header}
        {children}
      </m.aside>
    )
  }

  // Drag springs back to the origin by itself (dragConstraints); we only decide the new snap.
  const onDragEnd = (_: unknown, info: PanInfo) => {
    const dy = info.offset.y
    const v = info.velocity.y
    if (snap === 'peek' && (dy > 120 || v > 700)) return onClose()
    if (snap === 'full' && (dy > 260 || v > 1200)) return onClose()
    if (snap === 'full' && (dy > 90 || v > 400)) setSnap('peek')
    else if (snap === 'peek' && (dy < -50 || v < -350)) setSnap('full')
  }

  return (
    <>
      <m.div
        className="xc-dress xc-backdrop fixed inset-0 z-20 bg-shade/30"
        initial={{ opacity: 0 }}
        animate={{ opacity: snap === 'full' ? 1 : 0 }}
        exit={{ opacity: 0 }}
        style={{ pointerEvents: snap === 'full' ? 'auto' : 'none' }}
        onClick={() => setSnap('peek')}
        aria-hidden="true"
      />
      <m.div
        ref={ref}
        role="dialog"
        aria-modal="false"
        aria-label={label}
        tabIndex={-1}
        drag="y"
        dragControls={drag}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.06, bottom: 0.8 }}
        onDragEnd={onDragEnd}
        onAnimationComplete={() => reportRef.current()}
        onTransitionEnd={() => reportRef.current()}
        initial={{ y: '100%' }}
        animate={{ y: '0%' }}
        exit={{ y: '100%', transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } }}
        transition={spring}
        style={{
          height: snap === 'full' ? 'calc(100dvh - 48px - var(--sat))' : peekHeight,
          transition: reduced ? undefined : 'height 420ms cubic-bezier(0.22, 1.1, 0.36, 1)',
        }}
        className={cx('xc-dress xc-frame xc-flush-b glass-strong sheet-solid fixed inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-[26px] outline-none', className)}
      >
        <div
          className="flex shrink-0 cursor-grab touch-none justify-center pt-2.5 pb-1 active:cursor-grabbing"
          onPointerDown={(e) => drag.start(e)}
          onDoubleClick={() => setSnap(snap === 'full' ? 'peek' : 'full')}
        >
          <button
            className="flex h-6 w-16 items-center justify-center"
            data-tour="sheet-snap"
            aria-expanded={snap === 'full'}
            aria-label={snap === 'full' ? 'Collapse panel' : 'Expand panel'}
            onClick={() => setSnap(snap === 'full' ? 'peek' : 'full')}
          >
            <span className="h-1.5 w-10 rounded-full bg-tint/25" />
          </button>
        </div>
        <div className="shrink-0 touch-none" onPointerDown={(e) => drag.start(e)}>
          {header}
        </div>
        {children}
        {/* the content ends above the universal Ask, which stays on screen over the sheet (ui/overlays ASK_RESERVE) */}
        {/* ...and above the OS clock, which sits over the sheet's bottom-right corner (shell/osClock.css), and inside an
            experience above Ω's corner (--xc-omega-floor, index.css): a floor, never in place of the Ask's room */}
        {/* ...and above what the Ask opened under its field ("Did you mean…"), while it is open (features/ask/popDismiss) */}
        <div className="xc-omega-spacer shrink-0" style={{ height: `max(${ASK_RESERVE}, var(--os-clock-lift, 0px), var(--xc-omega-floor, 0px), var(--ask-pop-room, 0px))` }} />
      </m.div>
    </>
  )
}
