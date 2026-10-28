import { useIsPresent } from 'framer-motion'
import { Component, Suspense, useLayoutEffect, useState, type ReactNode } from 'react'
import { isChunkLoadError, onChunkRetryMounted, reportChunkError, reportChunkHealthy } from '../lib/chunkReload'

/**
 * A lazily loaded child of AnimatePresence (Surface M, live 0aa6330). Each lazy view gets its own Suspense boundary: a
 * shared one would re-suspend (and hide) every open view whenever another chunk loads, interrupting their exit
 * animations.
 *
 * A view that is already leaving never appears for the first time. React reveals a just-loaded view in a later,
 * throttled commit (up to ~300 ms), and a navigation in that window shares it: the view's motion element would mount
 * already exiting, framer-motion never starts an exit for it, and AnimatePresence then holds it for good (with
 * mode="wait" the next page never shows: the URL changes, the screen does not; without it the leaving view stays on
 * screen). A view that never showed is dropped instead, so its exit completes at once.
 *
 * `fallback` (default nothing) shows while the chunk loads, so a slow view still opens at once (the swarm sheet).
 *
 * Use it for every AnimatePresence child whose motion element is inside a lazy chunk (App's pages, sheets and dialogs;
 * the intro's welcome and help sheet).
 */
export function PresenceLazy({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const present = useIsPresent()
  const [shown, setShown] = useState(false)
  return (
    <ChunkBoundary>
      {/* fallback: what shows while the view's chunk loads (plain markup only, never a motion element: it must not take
          part in AnimatePresence's enter or exit; e.g. features/swarm/SwarmSheetSkeleton) */}
      <Suspense fallback={present ? fallback : null}>
        {present || shown ? (
          <>
            {/* Shown MUST stay inside this same Suspense boundary, beside the view: it then commits only when the view
                itself commits (a suspended first reveal does not mark the view shown). Moved outside, it would mark a view
                that never appeared as shown, and a view leaving before its reveal would hang AnimatePresence again. */}
            <Shown onShown={setShown} />
            {children}
          </>
        ) : null}
      </Suspense>
    </ChunkBoundary>
  )
}

/**
 * A lazy view whose chunk is gone (a tab left open across a deploy, or a failed load) takes only its own slot down, not
 * the shell: the page-level recovery (lib/chunkReload.ts) decides between reload, "save first" and Retry, and the shell
 * and the Ask stay. On Retry the slot renders the view again (lib/lazyRoute.ts starts a fresh import). Any other error is
 * rethrown untouched, to whatever caught it before.
 */
class ChunkBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null }
  private off: (() => void) | null = null
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  componentDidCatch(error: unknown) {
    if (!isChunkLoadError(error)) return
    reportChunkError(error)
    this.off ??= onChunkRetryMounted(() => {
      this.off?.()
      this.off = null
      this.setState({ error: null })
    })
  }
  componentWillUnmount() {
    this.off?.()
    this.off = null
  }
  render() {
    const { error } = this.state
    if (error == null) return this.props.children
    if (isChunkLoadError(error)) return null
    throw error
  }
}

/** Commits only with the view beside it (one Suspense boundary), so it marks the view as on screen. */
function Shown({ onShown }: { onShown: (v: boolean) => void }) {
  useLayoutEffect(() => {
    onShown(true)
    // the view's chunk resolved and rendered: this build's chunks load (releases the chunk-reload guard)
    reportChunkHealthy()
  }, [onShown])
  return null
}
