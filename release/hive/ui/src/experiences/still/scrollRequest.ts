import { useEffect, useEffectEvent, useState, type RefObject } from 'react'

export type ScrollTo = 'needs' | 'now' | 'learned' | 'everything'
interface Pending { to: ScrollTo; words: string | null }

/**
 * Still's "scroll to a part after this commit" request. A submitted request clears its suggestions, so the scroll waits
 * for the paper to settle (one quiet window of 100 ms on its actual layout changes, at most 1.5 s) and for the words
 * that were sent to clear from the field; then it lands, if it still may. A pointer, wheel or key press, the page being
 * hidden, or new typing (different words from the ones sent) takes over. Moved here from the page so it can be mounted;
 * new typing is now noticed while rendering, and a request that may not run is dropped from a timer, never by
 * setState in an effect.
 *
 * `may` says whether it may run now (signed in as before, shown, on the hive page, not in a held phase); `land` does
 * the scroll (and any focus) and is only called when `may` says yes; `again` re-checks when the page's route or phase
 * changes.
 */
export function useScrollRequest({ askWords, watch, may, land, again }: {
  askWords: string
  watch: RefObject<HTMLElement | null>
  may: () => boolean
  land: (to: ScrollTo) => void
  again: string
}): (to: ScrollTo, words: string | null) => void {
  const [pending, setPending] = useState<Pending | null>(null)
  // new typing takes over: different words from the ones the request was sent with
  if (pending && pending.words !== null && askWords.trim() && askWords !== pending.words) setPending(null)
  const mayNow = useEffectEvent(may)
  const landNow = useEffectEvent(land)
  useEffect(() => {
    if (!pending) return
    if (!mayNow()) {
      const drop = window.setTimeout(() => setPending(null), 0)
      return () => window.clearTimeout(drop)
    }
    // the words that were sent are still in the field: wait for them to clear
    if (pending.words !== null && askWords.trim()) return
    let closed = false, quiet = 0, limit = 0
    let observer: ResizeObserver | null = null
    const dispose = () => {
      window.clearTimeout(quiet); window.clearTimeout(limit); observer?.disconnect()
      for (const kind of ['pointerdown', 'wheel', 'keydown']) window.removeEventListener(kind, cancel, true)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    const cancel = () => { if (!closed) { closed = true; dispose(); setPending(null) } }
    const onVisibility = () => { if (document.hidden) cancel() }
    const finish = () => {
      if (closed) return
      closed = true; dispose()
      if (mayNow()) landNow(pending.to)
      setPending(null)
    }
    // One navigation-owned quiet window, driven by actual layout changes; no idle polling or frame loop.
    const settle = () => { if (!closed) { window.clearTimeout(quiet); quiet = window.setTimeout(finish, 100) } }
    if (typeof ResizeObserver !== 'undefined' && watch.current) { observer = new ResizeObserver(settle); observer.observe(watch.current); settle() }
    limit = window.setTimeout(finish, 1500)
    for (const kind of ['pointerdown', 'wheel', 'keydown']) window.addEventListener(kind, cancel, true)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { closed = true; dispose() }
  }, [pending, askWords, watch, again])
  return (to, words) => setPending({ to, words })
}
