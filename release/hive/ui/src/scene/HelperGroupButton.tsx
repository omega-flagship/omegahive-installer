import { useEffect, useRef } from 'react'
import type { HiveEngine } from './engine'
import { helperGroupWords, type HelperGroup } from './helperGroups'

/**
 * The keyboard way to a folded helper group: a button riding its orb (the engine moves it each frame). Unseen until
 * focused (the orb itself is drawn on the canvas); focused, it shows its words and a focus ring. Enter or Space opens the
 * group and closes it again.
 */
export function HelperGroupButton({ engine, group, team, reduced, onToggle }: { engine: Pick<HiveEngine, 'track'> | null; group: HelperGroup; team: string; reduced: boolean; onToggle: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!engine || !el) return
    engine.track(el, group.id)
    return () => engine.track(el, null)
  }, [engine, group.id])
  return (
    <div ref={ref} className="pointer-events-none absolute top-0 left-0 z-10" style={{ transform: 'translate3d(-9999px, -9999px, 0)' }}>
      <HelperGroupOrbButton group={group} team={team} reduced={reduced} onToggle={onToggle} />
    </div>
  )
}

/** The button itself (no hooks): its words, its state, and the press that opens or closes the group. */
export function HelperGroupOrbButton({ group, team, reduced, onToggle }: { group: HelperGroup; team: string; reduced: boolean; onToggle: () => void }) {
  const words = helperGroupWords(group, team)
  return (
    <button
      type="button"
      data-helper-group={group.id}
      aria-label={words.aria}
      aria-expanded={group.expanded}
      onClick={onToggle}
      className={`glass pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium text-ink opacity-0 outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-white/70 ${reduced ? '' : 'transition-opacity duration-150'}`}
      style={{ minWidth: 32, minHeight: 32 }}
    >
      {words.label}
    </button>
  )
}
