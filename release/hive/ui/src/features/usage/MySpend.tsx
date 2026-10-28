import { useResource, need } from '../../lib/useResource'
import { navigate } from '../../lib/router'
import { shown } from '../../lib/displayName'
import { useHive } from '../../store/store'
import { Button, Meter } from '../../ui/primitives'

/** The signed-in person's own spend this month: what the hive paid for them (against their allowance), what their own
 *  keys paid, and where it went. The owner (2026-10-04): personalised costs, $50/month per member, then own keys. */
export function MySpend() {
  const client = useHive((s) => s.client)
  const res = useResource(() => need(client, 'usageMe', 'Your spend')(), { poll: 30000 })
  if (res.status !== 'ready' || !res.data) return null
  const me = res.data
  const allowance = me.allowance_usd
  const low = allowance != null && me.remaining_usd != null && me.remaining_usd < allowance * 0.2
  return (
    <section className="mb-4 rounded-2xl border border-line bg-white/[0.02] p-4" aria-label="Your spend this month">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-display text-[15px] font-semibold">Your spend this month</h2>
        <span className="text-[13px] text-ink-2">
          ${me.hive_paid_usd.toFixed(2)}{allowance != null ? ` of your $${allowance.toFixed(0)} allowance` : ' (no allowance cap)'}
          {me.own_keys_usd > 0 && ` · $${me.own_keys_usd.toFixed(2)} on your own keys`}
        </span>
      </div>
      {allowance != null && (
        <div className="mt-2.5">
          <Meter value={me.hive_paid_usd} max={allowance} label={`$${me.hive_paid_usd.toFixed(2)} of $${allowance.toFixed(0)} allowance used`} />
        </div>
      )}
      {me.by_mind.length > 0 && (
        <p className="mt-2 text-[12.5px] text-ink-3">
          Mostly: {me.by_mind.slice(0, 4).map((m) => `${shown(m.name)} $${m.cost_usd.toFixed(2)}`).join(' · ')}
        </p>
      )}
      {allowance != null && me.own_keys === 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-accent/[0.08] px-3 py-2 text-[12.5px] text-ink-2">
          <span className="min-w-0 flex-1">{low ? 'Your allowance is running low. ' : ''}Add your own AI key to work without an allowance limit; it is used only for your minds and sessions.</span>
          <Button variant="subtle" className="min-h-8 px-3 text-[12px]" onClick={() => navigate({ name: 'me' })}>Add a key</Button>
          {low && <Button variant="ghost" className="min-h-8 px-3 text-[12px]" onClick={() => navigate({ name: 'approvals' })}>Ask for more</Button>}
        </div>
      )}
    </section>
  )
}
