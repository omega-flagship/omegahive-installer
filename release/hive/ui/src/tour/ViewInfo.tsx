import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../lib/cx'
import { useEscape } from '../lib/hooks'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/primitives'
import { useCovered } from '../ui/overlays'
import { useGuideShowing } from '../features/guided/reading'
import { useIntro } from './introStore'
import { hintHeight, placeHint, type Box } from './place'
import { mapLabelBoxes } from '../scene/mapLabels'
import { readAskRoom } from '../features/ask/askRoom'
import { KEYS, readKey, writeKey } from './storage'
import { VIEW_HELP, type ViewKey } from './views'

/** Hints already shown in this page, for when storage cannot remember them. */
const shownThisPage = new Set<string>()

function hintPending(key: string): boolean {
  return !shownThisPage.has(key) && !readKey(KEYS.hint(key))
}

function markHint(key: string): void {
  shownThisPage.add(key)
  writeKey(KEYS.hint(key), '1')
}

type Place = { top?: number; bottom?: number; right: number; width: number }

function placeFor(el: HTMLElement | null, width: number): Place | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  const vw = window.innerWidth
  const w = Math.min(width, vw - 24)
  // right-align to the button, kept inside the viewport
  const right = Math.max(12, Math.min(vw - r.right, vw - w - 12))
  const below = window.innerHeight - r.bottom
  return below > 220 || below > r.top ? { top: r.bottom + 8, right, width: w } : { bottom: window.innerHeight - r.top + 8, right, width: w }
}

const CONTROLS = 'button, a[href], input, select, textarea, [role="tab"], [role="radio"], [role="slider"], [role="switch"], [role="button"], [data-tour="hud-stats"], h1, h2, [role="heading"]'

/** Controls, titles (and the hive's stats) the person can see, as boxes the hint stays off: it never covers Wake, Stop, the budget or a page's title. */
function visibleControls(self: HTMLElement): Box[] {
  const out: Box[] = []
  for (const el of document.querySelectorAll<HTMLElement>(CONTROLS)) {
    if (el === self || el.closest('[data-viewinfo-layer]')) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) continue
    // only what is on top at its centre: controls hidden under a page or panel do not count
    const hit = document.elementFromPoint(Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2)))
    if (hit && !el.contains(hit) && !hit.closest('[data-viewinfo-layer]')) continue
    out.push({ left: r.left, top: r.top, width: r.width, height: r.height })
  }
  // the star map's swarm labels are titles too, drawn on the canvas: kept clear where the map is on top
  for (const b of mapLabelBoxes()) {
    if (b.top + b.height < 0 || b.top > window.innerHeight || b.left + b.width < 0 || b.left > window.innerWidth) continue
    const hit = document.elementFromPoint(Math.min(window.innerWidth - 1, Math.max(0, b.left + b.width / 2)), Math.min(window.innerHeight - 1, Math.max(0, b.top + b.height / 2)))
    if (hit && hit.tagName !== 'CANVAS') continue
    out.push(b)
  }
  return out
}

/** The Ask's band at the bottom (--ask-room plus the safe area), which the hint stays above. */
function askRoom(): number {
  const css = getComputedStyle(document.documentElement)
  return readAskRoom() + (parseFloat(css.getPropertyValue('--sab')) || 0)
}

/** Below this width the first-visit hint is never a floating card: it would cover the page's content (Design,
 *  2026-10-12). The compact trigger keeps its dot, and the help opens on tap. */
export const HINT_MIN_WIDTH = 640

function hintPlaceFor(el: HTMLElement | null, text: string): { left: number; top: number; width: number } | null {
  if (!el || window.innerWidth < HINT_MIN_WIDTH) return null
  const r = el.getBoundingClientRect()
  const width = Math.min(300, window.innerWidth - 24)
  const panel = el.closest<HTMLElement>('[role="dialog"]')?.getBoundingClientRect()
  const p = placeHint(
    { left: r.left, top: r.top, width: r.width, height: r.height },
    { width, height: hintHeight(text, width) },
    { width: window.innerWidth, height: window.innerHeight },
    visibleControls(el),
    panel && panel.width < window.innerWidth - 40 ? { left: panel.left, top: panel.top, width: panel.width, height: panel.height } : null,
    askRoom(),
  )
  // no spot covers nothing (a busy phone header): the hint is not shown over a title or a control
  return p.covers === 0 ? { left: p.left, top: p.top, width: p.width } : null
}

/**
 * The small "What's this?" button every main view carries: a short card on what the view is for, with
 * "Show me" to play just its tour chapter. The first time a person opens the view on their own, a gentle
 * one-line hint appears beside it (remembered per view, when storage allows).
 */
export function ViewInfo({ view, className, size = 'md' }: { view: ViewKey; className?: string; size?: 'sm' | 'md' }) {
  const help = VIEW_HELP[view]
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  const [place, setPlace] = useState<Place | null>(null)
  const [hintAt, setHintAt] = useState<{ left: number; top: number; width: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLDivElement>(null)
  // the welcome, the tour, or a guided demo on screen (its caption and controls, any step; guided/reading): the hint waits
  const demo = useGuideShowing()
  const busy = useIntro((s) => s.welcome || !!s.tour) || demo
  // a sheet or menu this button is not inside is open: the hint belongs to the view beneath, so it waits (ui/overlays)
  const covered = useCovered(btn)
  const startTour = useIntro((s) => s.startTour)

  // the first-visit hint: once per view, never over the welcome or during the tour
  useEffect(() => {
    if (busy || covered || !hintPending(help.hintKey)) return
    const show = setTimeout(() => {
      if (!hintPending(help.hintKey)) return
      markHint(help.hintKey)
      setHint(true)
    }, 1100)
    return () => clearTimeout(show)
  }, [busy, covered, help.hintKey])
  // the welcome, the tour or a reading step hides both, without forgetting
  const cardOpen = open && !busy
  const hintShown = hint && !busy && !covered
  // its time on screen counts only while it shows: hidden by a reading step (or a sheet), it is not used up meanwhile
  useEffect(() => {
    if (!hintShown) return
    const t = setTimeout(() => setHint(false), 9000)
    return () => clearTimeout(t)
  }, [hintShown])

  useLayoutEffect(() => {
    if (!cardOpen) return
    const update = () => setPlace(placeFor(btn.current, 340))
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [cardOpen])
  // the first-visit hint sits where it covers no controls: below, above, beside the panel, or beside the button
  useLayoutEffect(() => {
    if (!hintShown || cardOpen) return
    const update = () => setHintAt(hintPlaceFor(btn.current, `${help.hint} What's this?`))
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [hintShown, cardOpen, help.hint])

  useEscape(() => setOpen(false), cardOpen)
  useEffect(() => {
    if (!cardOpen) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!card.current?.contains(t) && !btn.current?.contains(t)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [cardOpen])

  const toggle = () => {
    setHint(false)
    setOpen((o) => !o)
  }

  return (
    <>
      <button
        ref={btn}
        onClick={toggle}
        aria-label={`What's this? About ${help.title.toLowerCase()}`}
        aria-expanded={cardOpen}
        title="What's this?"
        data-tour={`info-${view}`}
        className={cx(
          'relative inline-flex shrink-0 items-center justify-center rounded-xl text-ink-3 transition-colors hover:bg-white/[0.07] hover:text-ink',
          size === 'sm' ? 'size-9' : 'size-11',
          cardOpen && 'bg-white/[0.08] text-ink',
          className,
        )}
      >
        <Icon name="question" size={size === 'sm' ? 17 : 19} />
        {hintShown && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-accent-2 shadow-[0_0_8px_#6ee7ff]" aria-hidden="true" />}
      </button>
      {createPortal(
        <AnimatePresence>
          {cardOpen && place && (
            <m.div
              ref={card}
              key="card"
              data-viewinfo-layer=""
              role="dialog"
              aria-label={`What's this: ${help.title}`}
              initial={{ opacity: 0, y: place.top !== undefined ? -6 : 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
              transition={{ type: 'spring', stiffness: 560, damping: 38 }}
              className="glass-strong fixed z-[75] rounded-[20px] !bg-[#0b0b22]/[0.97] p-4"
              style={{ top: place.top, bottom: place.bottom, right: place.right, width: place.width, transformOrigin: place.top !== undefined ? 'top right' : 'bottom right' }}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="eyebrow">What's this?</div>
                  <h2 className="mt-1 font-display text-[17px] font-semibold tracking-tight text-ink">{help.title}</h2>
                </div>
                <button onClick={() => setOpen(false)} className="-mt-1 -mr-1.5 flex size-9 items-center justify-center rounded-lg text-ink-3 hover:bg-white/[0.06] hover:text-ink" aria-label="Close">
                  <Icon name="x" size={16} />
                </button>
              </div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">{help.body}</p>
              <div className="mt-3.5 flex items-center gap-2">
                <Button
                  variant="primary"
                  icon="play"
                  className="min-h-10 px-3.5 text-[13px]"
                  onClick={() => {
                    setOpen(false)
                    startTour({ chapter: help.chapter, only: true })
                  }}
                >
                  Show me
                </Button>
                <button
                  onClick={() => {
                    setOpen(false)
                    startTour({})
                  }}
                  className="min-h-10 rounded-xl px-3 text-[13px] font-medium text-ink-3 transition-colors hover:bg-white/[0.06] hover:text-ink"
                >
                  Full tour
                </button>
              </div>
            </m.div>
          )}
          {hintShown && !cardOpen && hintAt && (
            <m.div
              key="hint"
              role="status"
              data-viewinfo-layer=""
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
              transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              className="glass-strong fixed z-[74] flex items-center gap-1 rounded-2xl !bg-[#0b0b22]/[0.97] py-1 pr-1 pl-3"
              style={{ top: hintAt.top, left: hintAt.left, width: hintAt.width }}
            >
              <button onClick={toggle} className="min-h-9 min-w-0 flex-1 text-left text-[12.5px] leading-snug text-ink-2 hover:text-ink">
                {help.hint} <span className="font-semibold whitespace-nowrap text-accent-2">What's this?</span>
              </button>
              <button onClick={() => setHint(false)} className="flex size-9 shrink-0 items-center justify-center rounded-xl text-ink-4 hover:bg-white/[0.06] hover:text-ink" aria-label="Dismiss hint">
                <Icon name="x" size={14} />
              </button>
            </m.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}
