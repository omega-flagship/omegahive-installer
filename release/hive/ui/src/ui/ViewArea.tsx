// Purpose: a page window's content area, which measures its own width and gives it to the views inside (ViewWidth), so
// they lay out for the room they get rather than for the screen.
import { useRef, type ReactNode } from 'react'
import { useElementWidth, ViewWidth } from '../lib/hooks'

/** Its width is null until measured (lib/hooks useElementWidth), which leaves the views on the screen's answer. */
export function ViewArea({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  return (
    <div ref={ref} className={className}>
      <ViewWidth.Provider value={width}>{children}</ViewWidth.Provider>
    </div>
  )
}
