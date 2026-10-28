import { useEffect, useRef } from 'react'

/**
 * Run `fn` now and every `ms` while the page is visible. Polling stops while the tab is hidden and
 * resumes (with an immediate run) when it is shown again. Returns a function that stops it for good.
 */
export function startVisiblePoll(fn: () => void, ms: number, doc: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  const run = () => {
    if (timer !== undefined) return
    fn()
    timer = setInterval(fn, ms)
  }
  const halt = () => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }
  const onVisibility = () => (doc.hidden ? halt() : run())
  doc.addEventListener('visibilitychange', onVisibility)
  if (!doc.hidden) run()
  return () => {
    halt()
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}

/**
 * Hook form of startVisiblePoll: the latest `fn` is always called; the poll restarts when `deps` change.
 * Use it in place of a bare setInterval for any page that refreshes from the server.
 */
export function useVisiblePoll(fn: () => void, ms: number, deps: readonly unknown[] = []): void {
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  })
  useEffect(
    () => startVisiblePoll(() => ref.current(), ms),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ms, ...deps],
  )
}
