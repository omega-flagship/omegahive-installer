/**
 * On You (#/me): the way to your personal mind. Shown once the hive says you have one; on a hive without personal
 * minds it is not shown at all (nothing broken, nothing to set up).
 */
import { useEffect } from 'react'
import { presenceOf, PRESENCE_WORDS } from '../../api/personalMind'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { MindFigure } from './MindFigure'
import { useMind } from './store'

export function PersonalMindLink() {
  const state = useMind((s) => s.state)
  const mind = useMind((s) => s.mind)
  const load = useMind((s) => s.load)
  const client = useHive((s) => s.client)
  useEffect(() => {
    void load()
  }, [load, client])
  if (state !== 'ready' || !mind) return null
  const presence = presenceOf(mind.status, false)
  return (
    <button
      type="button"
      onClick={() => navigate({ name: 'me', view: 'mind' })}
      className="flex w-full items-center gap-4 rounded-2xl border border-line bg-white/[0.03] p-4 text-left transition-colors hover:bg-white/[0.06]"
      data-mind-link=""
    >
      <span className="shrink-0" aria-hidden>
        <MindFigure name={mind.name} presence={presence} remembers={3} acting={false} versioned={!!mind.version} width={34} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="eyebrow block">Your personal mind</span>
        <span className="mt-0.5 block font-display text-[17px] font-semibold text-ink">{mind.name}</span>
        <span className="block text-[12.5px] text-ink-3">{PRESENCE_WORDS[presence]} · what it remembers, its version and its hands</span>
      </span>
      <span className="shrink-0 text-[13px] text-accent">Open ›</span>
    </button>
  )
}
