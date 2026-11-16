import { useEffect, useState, useSyncExternalStore } from 'react'
import { cx } from '../../lib/cx'
import { bindEpoch, currentEpoch, onIdentityChange, type EpochBinding } from '../../lib/identityEpoch'
import { useHive } from '../../store/store'
import { planLine, readPlanStatus, type PlanRow } from './planLine'

/**
 * What is left of each plan attached to this hive: one plain line per plan (planLine.ts), on Limits and on You & your
 * keys. The hive answers it to the hive owner only, so for anyone else (and on a hive or demo without plans) the list is
 * empty and nothing is drawn. Keyed by the identity epoch like the monthly-total panel: nothing read for one sign-in is
 * shown under the next.
 */
export function PlanUsage({ className }: { className?: string }) {
  const epoch = useSyncExternalStore(onIdentityChange, currentEpoch, currentEpoch)
  return <PlanUsageBody key={epoch} className={className} />
}

export function PlanUsageLines({ rows, className }: { rows: PlanRow[]; className?: string }) {
  if (!rows.length) return null
  return (
    <section aria-label="Your plans" data-plan-usage={rows.length} className={cx('rounded-2xl border border-line bg-tint/[0.03] px-4 py-3', className)}>
      <h2 className="eyebrow">Your plans</h2>
      <ul className="mt-1 space-y-0.5">
        {rows.map((row) => (
          <li key={row.provider} className="text-[12.5px] text-ink-3" data-plan={row.provider} data-reported={row.reported}>
            {planLine(row)}
          </li>
        ))}
      </ul>
    </section>
  )
}

function PlanUsageBody({ className }: { className?: string }) {
  const client = useHive((s) => s.client)
  const [rows, setRows] = useState<PlanRow[]>([])
  const read = client?.subscriptionStatus
  useEffect(() => {
    if (!read) return
    let live = true
    const b: EpochBinding = bindEpoch()   // shown only to the person it was asked for
    read.call(client).then(
      (v) => { if (live) b.commit(() => setRows(readPlanStatus(v))) },
      () => { if (live) b.commit(() => setRows([])) },   // unreadable: nothing is drawn, never a guessed figure
    )
    return () => { live = false }
  }, [client, read])
  return <PlanUsageLines rows={rows} className={className} />
}
