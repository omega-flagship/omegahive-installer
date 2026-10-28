import { plural } from '../../lib/plural'
import { useMemo } from 'react'
import { shown } from '../../lib/displayName'
import { ago, money } from '../../lib/format'
import { useNow } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Orb } from '../../ui/primitives'
import { SimChip } from '../../ui/SimChip'
import { atCap, capSentence, recentRefusals, restOf, sleepRule, spendPicture } from './sleepSpend'

/**
 * Health (demo D3): who is awake and who is asleep under the hive's sleep rule, any mind at its spend cap with its
 * calls refused, the refusals the hive announced, and the spend picture. Read from what the page already holds (the
 * minds, `budget.refused` and the recent billed calls); nothing here writes. Dollar figures carry the sim chip in demo.
 */
export function SleepAndSpend() {
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const refusals = useHive((s) => s.refusals)
  const usage = useHive((s) => s.usage)
  const now = useNow(30_000)
  const minds = useMemo(() => Object.values(agents).filter((a) => a.kind !== 'module').sort((x, y) => x.name.localeCompare(y.name)), [agents])
  const awake = minds.filter((a) => restOf(a.status) === 'awake')
  const asleep = minds.filter((a) => restOf(a.status) === 'asleep')
  const capped = minds.filter((a) => atCap(a))
  const refused = useMemo(() => recentRefusals(refusals, agents), [refusals, agents])
  const spend = useMemo(() => spendPicture(minds, usage, now), [minds, usage, now])
  if (!minds.length) return null
  const where = (id: string | null) => (id && swarms[id] ? ` · ${shown(swarms[id].name)}` : '')

  return (
    <section aria-labelledby="ss-h" className="space-y-4 rounded-2xl border border-line bg-white/[0.03] p-4" data-tour="health-sleep-spend">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="ss-h" className="eyebrow">Sleep and spend</h2>
        <span className="text-[12.5px] text-ink-3">
          {awake.length} awake · {asleep.length} asleep{capped.length ? ` · ${capped.length} at its spend cap` : ''}
        </span>
      </div>

      {capped.map((a) => (
        <div key={a.id} role="status" data-cap-mind={a.id} data-tour="health-cap" className="flex items-start gap-2.5 rounded-xl border border-warn/40 bg-warn/[0.07] px-3 py-2.5">
          <Icon name="pause" size={16} className="mt-0.5 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-warn">
              {shown(a.name)} is at its spend cap <SimChip />
            </p>
            <p className="mt-0.5 text-[12.5px] leading-snug text-ink-2">{capSentence({ ...a, name: shown(a.name) }, refusals[a.id])}</p>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
              <button onClick={() => navigate({ name: 'dot', id: a.id, tab: 'model' })} className="inline-flex min-h-7 items-center gap-1 text-[12px] font-semibold text-ink underline-offset-2 hover:underline">
                <Icon name="coin" size={12} /> Raise its budget
              </button>
              <button onClick={() => navigate({ name: 'usage' })} className="inline-flex min-h-7 items-center gap-1 text-[12px] font-semibold text-ink underline-offset-2 hover:underline">
                <Icon name="chart" size={12} /> Usage and limits
              </button>
            </div>
          </div>
        </div>
      ))}

      <div className="grid gap-3 md:grid-cols-2">
        {([['Awake', awake], ['Asleep', asleep]] as const).map(([label, list]) => (
          <div key={label} className="min-w-0">
            <h3 className="mb-1.5 text-[12px] font-medium text-ink-3">{label} · {list.length}</h3>
            {list.length === 0 ? (
              <p className="text-[12.5px] text-ink-4">None.</p>
            ) : (
              <ul className="space-y-1.5" aria-label={`${label} minds`}>
                {list.map((a) => (
                  <li key={a.id} className="flex items-start gap-2">
                    <Orb hue={a.hue} status={a.status} size={18} className="mt-0.5" />
                    <div className="min-w-0 text-[12.5px] leading-snug">
                      <button className="font-medium text-ink hover:underline" onClick={() => navigate({ name: 'dot', id: a.id })}>{shown(a.name)}</button>
                      <span className="text-ink-4">{where(a.swarm_id)}</span>
                      <div className="text-ink-3">{atCap(a) ? 'At its spend cap: the hive refuses its model calls' : sleepRule(a)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      <div>
        <h3 className="mb-1.5 text-[12px] font-medium text-ink-3">Recent refusals · {refused.length}</h3>
        {refused.length === 0 ? (
          <p className="text-[12.5px] text-ink-4">The hive has not refused any model call for spending since this page opened.</p>
        ) : (
          <ul className="space-y-1.5" aria-label="Recent refusals">
            {refused.map(({ agent, refusal, why }) => (
              <li key={agent.id} className="rounded-xl border border-line bg-black/20 px-3 py-2 text-[12.5px] leading-snug">
                <span className="font-medium text-ink">{shown(agent.name)}</span>
                <span className="text-ink-4"> · {refusal.count} refused · last {ago(refusal.at, now)}</span>
                <div className="text-ink-3">{why}</div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-ink-3">Spend <SimChip /></h3>
        <p className="text-[12.5px] leading-snug text-ink-2">
          {money(spend.total)} spent by these minds in all. {spend.dayCalls ? `${money(spend.day)} across ${plural(spend.dayCalls, 'model call')} in the last 24 hours that this page has seen.` : 'No billed model calls seen in the last 24 hours.'}
        </p>
        {spend.top.length > 0 && (
          <ul className="mt-2 space-y-1" aria-label="Biggest spenders">
            {spend.top.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-[12px]">
                <span className="w-24 shrink-0 truncate text-ink-2">{shown(t.name)}</span>
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                  <span className="block h-full rounded-full" style={{ width: `${t.budget > 0 ? Math.min(100, (t.spent / t.budget) * 100) : 100}%`, background: t.budget > 0 && t.spent >= t.budget ? 'var(--color-warn)' : 'var(--color-accent)' }} />
                </span>
                <span className="shrink-0 text-ink-3 tabular-nums">{money(t.spent)}{t.budget > 0 ? ` of ${money(t.budget)}` : ' · no cap'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
