import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useHive } from '../store/store'
import { navigate } from '../lib/router'
import { openGallery } from '../shell/uiVariant'
import { setFpsMeter, useFpsMeterOn } from '../shell/fpsMeterState'
import { HiveDirectory } from './HiveDirectory'
import { powerMenuItems } from '../features/power/menu'
import { OmegaGlyph } from '../brand/OmegaGlyph'
import { LiveOmega } from '../brand/LiveOmega'

export interface OmegaItem {
  label: string
  run: () => void
  /** Shown as selected (e.g. the swarm an app works in). */
  checked?: boolean
}
export interface OmegaSection {
  title?: string
  items: OmegaItem[]
}

/**
 * The one thing that never changes: Ω, bottom-left, in every experience and every app. Its menu carries the context's
 * own section (an app: leave, its views, its swarm) and then the same ways around the hive everywhere: everything in
 * the hive, Change experience, search, the frame-rate meter. Arrow keys, Home/End, Escape, focus restored to Ω.
 */
export function OmegaMenu({ heading, context, mark, sections = [], footer = [] }: { heading: string; context: string; /** what this Ω's mark wears, when not the experience (an app's own material) */ mark?: string; sections?: OmegaSection[]; footer?: OmegaItem[] }) {
  const [open, setOpen] = useState(false)
  const [directory, setDirectory] = useState(false)
  const fps = useFpsMeterOn()
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = (restore = true) => {
    setOpen(false)
    if (restore) button.current?.focus()
  }
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>('[role^=menuitem]')?.focus()
  }, [open])
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^=menuitem]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      close(false)
    }
  }
  const item = (it: OmegaItem, i: number) => (
    <button
      key={`${it.label}-${i}`}
      role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={it.checked}
      className="xc-item mx-1 flex min-h-9 items-center gap-2 px-2.5 py-2 text-left"
      onClick={() => {
        close(false)
        it.run()
      }}
    >
      {it.checked !== undefined && <span aria-hidden="true" className="xc-mark w-3 shrink-0">{it.checked ? '●' : ''}</span>}
      <span className="min-w-0 [overflow-wrap:anywhere]">{it.label}</span>
    </button>
  )
  const common: OmegaItem[] = [
    // creating is never more than two clicks away, in every experience and every app (Jon, 2026-10-05)
    { label: 'Start a swarm…', run: () => navigate({ name: 'launch' }) },
    { label: 'New mind…', run: () => navigate({ name: 'new' }) },
    { label: 'Everything in the hive…', run: () => setDirectory(true) },
    { label: 'Change experience…', run: () => openGallery(true) },
    { label: 'Search and commands', run: () => useHive.getState().setPalette(true) },
    { label: fps ? 'Hide frame rate' : 'Show frame rate', run: () => setFpsMeter(!fps) },
  ]
  return (
    // Ω's glyph is 12 px from the left and bottom edges everywhere; on a coarse pointer its hit area is a 44 px square
    // around the same glyph, so the box sits 8 px in (lib/frameFit omegaHit: request Q)
    <div className="fixed bottom-3 left-3 z-[80] flex flex-col items-start gap-1.5 pointer-coarse:bottom-2 pointer-coarse:left-2" style={{ marginBottom: 'var(--sab, 0px)', marginLeft: 'env(safe-area-inset-left, 0px)' }} data-tour="experience-escape">
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={heading}
          onKeyDown={onMenuKey}
          className="xc-menu thin-scroll flex max-h-[min(70dvh,calc(100dvh-72px))] w-max max-w-[min(320px,calc(100vw-24px))] min-w-[220px] flex-col overflow-y-auto py-1 text-[13px]"
        >
          <div className="xc-ink-3 px-3 pt-1.5 pb-1 text-[11px] [overflow-wrap:anywhere]" aria-hidden="true">
            {heading}
          </div>
          {sections.map((s, si) => (
            <div key={si} role="group" aria-label={s.title} className="xc-divider flex flex-col border-b pb-1">
              {s.title && <div className="xc-ink-3 px-3 pt-1.5 pb-0.5 text-[10.5px] font-semibold tracking-[0.1em] uppercase" aria-hidden="true">{s.title}</div>}
              {s.items.map(item)}
            </div>
          ))}
          <div className="pt-1" />
          {[...common, ...powerMenuItems()].map(item)}
          {footer.length > 0 && <div className="xc-divider my-1 border-t" />}
          {footer.map(item)}
        </div>
      )}
      {directory && <HiveDirectory experience={context} onClose={() => setDirectory(false)} restoreTo={() => button.current} />}
      <button
        ref={button}
        data-omega-button=""
        aria-label="Change experience and other ways out"
        title={heading}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="xc-omega-hit grid size-9 place-items-center pointer-coarse:size-11"
      >
        <span data-omega-glyph="" aria-hidden="true" className="xc-omega grid size-9 place-items-center rounded-full">
          <LiveOmega look={mark ?? context} size="corner" className="size-[30px]" fallback={<span className="grid size-full place-items-center"><OmegaGlyph className="h-[19px] w-[21px]" /></span>} />
        </span>
      </button>
    </div>
  )
}
