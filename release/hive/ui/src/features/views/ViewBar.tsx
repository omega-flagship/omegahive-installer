/**
 * Purpose: the bar above every view, whatever drew it (ViewFrame's LiveView or MettaFrame): its title, the page's own
 * controls, and Full screen or Close.
 */
import type { ReactNode } from 'react'
import { Button } from '../../ui/primitives'
import { Icon } from '../../ui/Icon'
import { cx } from '../../lib/cx'
import type { DisplayMode } from './viewBridge'

/** The bar above a view: its title, the page's own controls, and Full screen or Close. */
export function ViewBar({ title, full, onMode, extra }: { title: string; full: boolean; onMode: (m: DisplayMode) => void; extra?: ReactNode }) {
  return (
    <div className={cx('flex items-center gap-2', full ? 'h-12 border-b border-line px-3' : 'mb-1.5')}>
      <Icon name="apps" size={15} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink-2">{title}</span>
      {extra}
      <Button variant="ghost" className="min-h-9 px-2.5 text-[12px]" icon={full ? 'x' : 'unfold'} onClick={() => onMode(full ? 'inline' : 'fullscreen')}>
        {full ? 'Close' : 'Full screen'}
      </Button>
    </div>
  )
}
