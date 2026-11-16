import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ViewFrame } from './ViewFrame'

/**
 * The views a mind's message names, drawn under it. A mind saves a view as an artifact and sends its id with a short
 * digest (hive/templates/omega/prompt.txt), so an artifact id in its words marks where the view belongs. Each named
 * artifact is drawn under the last of the mind's messages that names it, and only once that message comes near the
 * screen, so a long conversation does not open every view in it. An id that is not a view draws nothing
 * (ViewFrame, place chat). Each spot carries its artifact id (data-view-slot), so the chip that names it in the
 * conversation's words (features/views/Words) can bring it into sight.
 */

export function MessageViews({ ids }: { ids: readonly string[] }) {
  return (
    <div className="mt-2 space-y-3">
      {ids.map((id) => <WhenNear key={id} id={id}><ViewFrame artifactId={id} place="chat" /></WhenNear>)}
    </div>
  )
}

/** Its children, once this spot comes within a screen of the visible part of the page. */
function WhenNear({ id, children }: { id: string; children: ReactNode }) {
  const spot = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = spot.current
    if (!el || near) return
    const seen = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setNear(true) }, { rootMargin: '100% 0px' })
    seen.observe(el)
    return () => seen.disconnect()
  }, [near])
  return <div ref={spot} data-view-slot={id}>{near ? children : null}</div>
}
