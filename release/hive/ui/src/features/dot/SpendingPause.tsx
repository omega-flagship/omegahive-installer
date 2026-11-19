// Purpose: the notices on a mind's panel when the hive refuses its model calls for spending, or paces them.
import { m } from 'framer-motion'
import type { Agent, BudgetRefusal, BudgetSlowed } from '../../api/types'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { OWN_BUDGET_CODES } from './mindStatus'
import { shown } from '../../lib/displayName'
import { refusedWords, UNSEEN_REFUSAL } from '../usage/settle'

const WHY: Record<string, string> = {
  no_budget: 'It runs a paid model with no budget, so every model call is refused.',
  budget_exhausted: 'It has used its own budget; the next model call would pass the cap.',
  spend_limit: 'A spending limit (for the mind, its swarm, its key or the hive) has no room for the next call.',
  hive_budget_exhausted: 'The whole hive has reached its spending cap. Every paid mind is paused until it is raised.',
}

/** "Paused: spending limit": the hive is refusing this mind's model calls (budget.refused). */
export function SpendingPause({ agent, refusal, onFixBudget }: { agent: Agent; refusal: BudgetRefusal; onFixBudget: () => void }) {
  const dismiss = useHive((s) => s.dismissRefusal)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const keys = useHive((s) => s.keys)
  const named = (kind: 'agent' | 'swarm' | 'key', id: string) => shown((kind === 'agent' ? agents[id]?.name : kind === 'swarm' ? swarms[id]?.name : keys?.find((k) => k.id === id)?.label) ?? id)
  // the mind's own cap is what Raise its budget changes: offered when that cap refused it, or a code saying so
  const own = refusal.limit ? refusal.limit.scope === `agent:${agent.id}` && refusal.limit.period === 'total' : OWN_BUDGET_CODES.has(refusal.code)
  return (
    <m.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
      <div role="status" className="mt-2 flex items-start gap-2.5 rounded-xl border border-warn/40 bg-warn/[0.07] px-3 py-2">
        <Icon name="pause" size={16} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-semibold text-warn">Paused: spending limit reached</span>
            <code className="font-mono text-[10.5px] text-ink-4">{refusal.code}</code>
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
            {refusal.limit ? refusedWords(refusal.limit, named) : refusal.hidden ? UNSEEN_REFUSAL : WHY[refusal.code] ?? `The hive refused ${shown(agent.name)}'s model calls for spending.`}{' '}
            {refusal.count > 1 ? `${refusal.count} calls refused so far.` : 'Its model calls are refused until there is room.'}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
            <button onClick={() => navigate({ name: 'usage' })} className="inline-flex min-h-7 items-center gap-1 text-[12px] font-semibold text-ink underline-offset-2 hover:underline">
              <Icon name="chart" size={12} /> Open Usage and limits
            </button>
            {own && (
              <button onClick={onFixBudget} className="inline-flex min-h-7 items-center gap-1 text-[12px] font-semibold text-ink underline-offset-2 hover:underline">
                <Icon name="coin" size={12} /> {refusal.code === 'no_budget' ? 'Give it a budget' : 'Raise its budget'}
              </button>
            )}
          </div>
        </div>
        <button onClick={() => dismiss(agent.id)} aria-label="Hide this notice" title="Hide until the hive refuses it again" className="-mr-1 shrink-0 rounded-lg p-1.5 text-ink-4 hover:bg-tint/[0.07] hover:text-ink">
          <Icon name="x" size={14} />
        </button>
      </div>
    </m.div>
  )
}

/** "Slowed: spending faster than this month allows": the spend-rate guard is pacing this mind (budget.slowed) until a call
 *  is billed again. Says when its next call fits and that a higher monthly limit speeds it up. */
export function SpendingSlowed({ slowed }: { slowed: BudgetSlowed }) {
  const until = new Date(slowed.until)
  const left = Math.ceil((until.getTime() - Date.now()) / 60000)
  const when = left > 0
    ? `Its next model call fits again at ${until.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, in about ${left} minute${left === 1 ? '' : 's'}.`
    : 'Its next model call fits again now.'
  return (
    <m.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
      <div role="status" className="mt-2 flex items-start gap-2.5 rounded-xl border border-warn/40 bg-warn/[0.07] px-3 py-2">
        <Icon name="pause" size={16} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <span className="text-[13px] font-semibold text-warn">Slowed: spending faster than this month allows</span>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
            {when} A higher monthly limit on Usage and limits speeds it up.
          </p>
          <button onClick={() => navigate({ name: 'usage' })} className="mt-1.5 inline-flex min-h-7 items-center gap-1 text-[12px] font-semibold text-ink underline-offset-2 hover:underline">
            <Icon name="chart" size={12} /> Open Usage and limits
          </button>
        </div>
      </div>
    </m.div>
  )
}

/** A compact marker for the header row. */
export function PausedPill() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-[11px] font-medium text-warn" title="The hive is refusing this mind's model calls for spending">
      <Icon name="pause" size={10} /> paused: spending limit
    </span>
  )
}
