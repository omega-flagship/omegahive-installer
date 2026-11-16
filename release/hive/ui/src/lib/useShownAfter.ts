import { useEffect, useState } from 'react'

/**
 * Whether something that started at `since` (Date.now(), or null when nothing has) has gone on for `ms`: true once the
 * timer for that start has fired. A new start, or none, is false at once, worked out while rendering (never by setState
 * in an effect). One already past `ms` turns true on the next tick.
 */
export function useShownAfter(since: number | null, ms: number): boolean {
  const [shownFor, setShownFor] = useState<number | null>(null)
  useEffect(() => {
    if (since === null) return
    const timer = setTimeout(() => setShownFor(since), Math.max(0, since + ms - Date.now()))
    return () => clearTimeout(timer)
  }, [since, ms])
  return since !== null && shownFor === since
}
