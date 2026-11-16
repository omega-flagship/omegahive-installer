// Purpose: the usage region every look's frame renders where it shows usage (classic's top bar after Spend, each other look's equivalent), and every view that covers a look's frame renders in its own header (a page, a mind's panel, Still's reading): the parts MeTTa places there (screens/frame.metta, today the battery), drawn once the screen engine has loaded, and nothing before then or when the region holds no part. One region draws at a time: while a covering view is open the look's frame yields to it, so a screen never shows two batteries.
import { Suspense, useEffect } from 'react'
import { create } from 'zustand'
import { lazyRoute } from '../lib/lazyRoute'

const FrameUsage = lazyRoute(() => import('./FrameUsage'))

/** How many open views cover the look's frame and draw their own usage region. */
const useCovering = create<{ open: number }>(() => ({ open: 0 }))

/**
 * The usage region. `covering` marks a view drawn over the look's frame (a page, a mind's panel, Still's reading): it
 * always draws, and the look's own frame region draws nothing while one is open. `className` dresses the region's box
 * the way the frame around it draws its own stats.
 */
export function UsageRegion({ className, covering = false }: { className?: string; covering?: boolean }) {
  const covered = useCovering((s) => s.open > 0)
  useEffect(() => {
    if (!covering) return
    useCovering.setState((s) => ({ open: s.open + 1 }))
    return () => useCovering.setState((s) => ({ open: s.open - 1 }))
  }, [covering])
  if (covered && !covering) return null
  return (
    <Suspense fallback={null}>
      <FrameUsage className={className} />
    </Suspense>
  )
}
