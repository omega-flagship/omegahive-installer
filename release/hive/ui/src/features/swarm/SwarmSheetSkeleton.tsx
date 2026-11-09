import { useLayoutEffect } from 'react'
import { hsl } from '../../lib/color'
import { shown } from '../../lib/displayName'
import { closeToHome } from '../../lib/router'
import { useHive } from '../../store/store'

/**
 * The swarm sheet while its view loads (demo-polish r1). The sheet's own code is a lazy chunk with ~two dozen
 * dependencies; on a cold or slow connection it took seconds, and until then only the bare map showed. This frame is in
 * the main bundle, so the sheet opens at once with the swarm's name and fills in when the view arrives. It is plain
 * markup (no motion element): it is a Suspense fallback inside an AnimatePresence child (ui/PresenceLazy.tsx) and must
 * never take part in the page's enter or exit.
 */
export function SwarmSheetSkeleton({ id }: { id: string }) {
  const swarm = useHive((s) => s.swarms[id])
  const name = swarm ? shown(swarm.name) : 'Swarm'
  // on screen: the view that replaces this frame skips its entrance (skeletonShownFor)
  useLayoutEffect(() => {
    tookOver = id
  }, [id])
  return (
    <section
      role="dialog"
      aria-label={`${name} swarm`}
      aria-busy="true"
      data-swarm-sheet="loading"
      className="xc-dress xc-page fixed inset-0 z-[25] flex flex-col overflow-hidden md:top-[var(--page-top,12px)] md:bottom-[var(--page-bottom,12px)] md:right-3 md:left-[var(--rail-x,84px)] md:rounded-[24px] md:border md:border-line"
      style={{
        background: 'linear-gradient(180deg, var(--look-page-a, color-mix(in oklab, var(--color-abyss) 90%, transparent)), var(--look-page-b, color-mix(in oklab, var(--color-void) 94%, transparent)))',
        backdropFilter: 'blur(24px) saturate(140%)',
        WebkitBackdropFilter: 'blur(24px) saturate(140%)',
      }}
    >
      <header className="relative flex shrink-0 items-center gap-2 px-3 pb-2 md:px-6 md:pt-4" style={{ paddingTop: 'calc(var(--sat) + 10px)' }}>
        <div className="min-w-0 flex-1 px-1">
          <div className="eyebrow flex items-center gap-1.5">
            {swarm && <span className="size-1.5 rounded-full" style={{ background: hsl(swarm.hue, 95, 68) }} />}
            Swarm
          </div>
          <h1 className="truncate font-display text-[22px] font-semibold tracking-tight md:text-[26px]">{name}</h1>
        </div>
        <button type="button" aria-label="Close" onClick={closeToHome} className="grid size-11 place-items-center rounded-xl text-ink-3 hover:text-ink">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>
      <div className="grid min-h-0 flex-1 gap-5 px-3 pb-6 md:grid-cols-[300px_1fr] md:px-6">
        <div className="hidden space-y-3 md:block" aria-hidden="true">
          <div className="h-4 w-3/4 animate-pulse rounded bg-tint/[0.06]" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-tint/[0.06]" />
          <div className="mt-6 h-24 animate-pulse rounded-2xl bg-tint/[0.04]" />
        </div>
        <div className="flex min-h-[320px] items-center justify-center rounded-[20px] border border-line">
          <div className="eyebrow animate-pulse">Opening the commons…</div>
        </div>
      </div>
    </section>
  )
}

let tookOver: string | null = null

/**
 * Whether this frame was on screen for swarm `id`: the view that replaces it then skips its entrance (fading the sheet
 * in again would blink). The view clears it once mounted (clearSkeletonShown).
 */
export const skeletonShownFor = (id: string): boolean => tookOver === id
export function clearSkeletonShown(): void {
  tookOver = null
}

/**
 * Load the swarm sheet's chunk ahead of a click (the Swarms page mounting, a card hovered or focused). A failed warm-up
 * is nobody's business: the chunk recovery (lib/chunkReload.ts) acts only on a view the person is opening.
 */
export function warmSwarmView(): void {
  void import('./SwarmView').catch(() => undefined)
}
