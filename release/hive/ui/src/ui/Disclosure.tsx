import { AnimatePresence, m } from 'framer-motion'
import { useId, useState, type ReactNode } from 'react'
import { cx } from '../lib/cx'
import { Icon } from './Icon'

/**
 * A titled fold: a button that shows or hides what it holds, for what a page keeps out of its main view. Lives with the
 * shared UI parts, so a page importing it never pulls another feature's module into its bundle (a release build keeps
 * no chunk named after a candidate feature: scripts/candidate-markers.json).
 */
export function Disclosure({ title, children, defaultOpen = false, right }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div>
      <button className="flex min-h-9 w-full items-center gap-2 text-left" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <Icon name="chevron" size={14} className={cx('shrink-0 text-ink-3 transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1">{title}</span>
        {right}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <m.div id={id} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
            {children}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}
