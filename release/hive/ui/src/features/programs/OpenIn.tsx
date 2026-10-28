import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { useEscape } from '../../lib/hooks'
import { cx } from '../../lib/cx'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { iconOr } from '../../ui/iconPaths'
import { shown } from '../../lib/displayName'

/** "Open in…": the enabled programs, for a swarm view or a mind's panel. Small: it ships in their chunks. */
export function OpenIn({ onPick, className, iconOnly }: { onPick: (programId: string) => void; className?: string; iconOnly?: boolean }) {
  const programs = useHive((s) => s.programs)
  const load = useHive((s) => s.loadPrograms)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEscape(() => setOpen(false), open)
  useEffect(() => {
    if (!open) return
    if (!programs) void load().catch(() => undefined)
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [open, programs, load])
  const list = (programs ?? []).filter((p) => p.enabled)
  return (
    <div ref={ref} className={cx('relative', className)}>
      <button
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open in a program"
        title="Open in a program"
        className={cx(
          'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors',
          iconOnly ? 'size-11 text-ink-2 hover:bg-white/[0.07] hover:text-ink' : 'border border-line bg-white/[0.06] px-4 text-ink hover:border-line-2 hover:bg-white/[0.1]',
          open && 'bg-white/[0.09] text-ink',
        )}
      >
        <Icon name="apps" size={iconOnly ? 20 : 18} />
        {!iconOnly && 'Open in…'}
      </button>
      <AnimatePresence>
        {open && (
          <m.div
            role="menu"
            aria-label="Programs"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
            transition={{ type: 'spring', stiffness: 520, damping: 36 }}
            className="glass-strong absolute top-full right-0 z-40 mt-2 w-[300px] max-w-[calc(100vw-24px)] rounded-2xl p-1.5"
          >
            <div className="eyebrow px-2.5 pt-1.5 pb-1">Open in a program</div>
            {!programs ? (
              <div className="px-2.5 py-3 text-[12.5px] text-ink-3">Loading…</div>
            ) : !list.length ? (
              <div className="px-2.5 py-3 text-[12.5px] text-ink-3">No programs are enabled on this hive.</div>
            ) : (
              list.map((p) => (
                <button
                  key={p.id}
                  role="menuitem"
                  onClick={() => (setOpen(false), onPick(p.id))}
                  className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-white/[0.07]"
                >
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-white/[0.04] text-accent">
                    <Icon name={iconOr(p.icon, 'spark')} size={17} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-medium text-ink">{shown(p.name)}</span>
                    <span className="line-clamp-2 text-[11.5px] leading-snug text-ink-3">{shown(p.description)}</span>
                  </span>
                </button>
              ))
            )}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}
