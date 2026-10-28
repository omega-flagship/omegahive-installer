import { useState } from 'react'
import { need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { ResourceView } from '../../ui/ResourceView'
import { shown } from '../../lib/displayName'
import { Icon } from '../../ui/Icon'

/**
 * Find help for work (S1): who might take a piece of work, from configured roles or advertised services and recorded
 * claims (GET /api/match). Moved here unchanged from the old Boards page; acceptance is still required before assignment.
 * A task-scoped match (the hive's phase 2) will move it onto each task.
 */
export function FindHelp() {
  const client = useHive((s) => s.client)
  const [open, setOpen] = useState(false)
  const [service, setService] = useState('plan')
  const [matchKind, setMatchKind] = useState<'mind' | 'swarm'>('swarm')
  const [role, setRole] = useState('Planner')
  const matchNeed = matchKind === 'mind' ? role : service
  if (!client?.matchServices) return null
  return (
    <section className="mt-6 rounded-[20px] border border-line bg-white/[0.02]" aria-labelledby="find-help-h" id="find-help">
      <h2 id="find-help-h">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-h-12 w-full items-center gap-2 px-4 text-left text-[13.5px] font-semibold text-ink-2">
          <Icon name="search" size={14} />
          Find help for work
          <span className="ml-auto text-[12px] font-normal text-ink-4">minds or swarms that might take it</span>
          <Icon name="chevronDown" size={14} className={open ? 'rotate-180' : undefined} />
        </button>
      </h2>
      {open && <Matches kind={matchKind} need={matchNeed} setKind={setMatchKind} role={role} setRole={setRole} service={service} setService={setService} />}
    </section>
  )
}

function Matches({ kind, need: matchNeed, setKind, role, setRole, service, setService }: { kind: 'mind' | 'swarm'; need: string; setKind: (k: 'mind' | 'swarm') => void; role: string; setRole: (r: string) => void; service: string; setService: (s: string) => void }) {
  const client = useHive((s) => s.client)
  const matches = useResource(() => need(client, 'matchServices', 'Service matching')(matchNeed, kind), { key: `${kind}:${matchNeed}` })
  const field = 'min-h-10 rounded-xl border border-line bg-white/[0.04] px-3 text-[13px] text-ink'
  return (
    <div className="space-y-3 px-4 pb-4">
      <p className="text-[12.5px] text-ink-3">Recommendations use configured roles or advertised services and recorded claims. Acceptance is required before assignment.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-ink-3">
          Find
          <select value={kind} onChange={(e) => setKind(e.target.value as 'mind' | 'swarm')} className={field}>
            <option value="swarm">Swarm service</option>
            <option value="mind">Mind by configured role</option>
          </select>
        </label>
        {kind === 'mind' ? (
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            Role
            <input value={role} onChange={(e) => setRole(e.target.value)} className={field} />
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            Service
            <select value={service} onChange={(e) => setService(e.target.value)} className={field}>
              <option value="plan">Planning</option>
              <option value="review">Critical review</option>
              <option value="code-review">Code review</option>
            </select>
          </label>
        )}
      </div>
      <ResourceView res={matches}>
        {(data) => (
          <div className="grid gap-2 md:grid-cols-2">
            {!data.candidates.length && <p className="text-[12.5px] text-ink-3">No configured candidates match this request.</p>}
            {data.candidates.map((c) => (
              <article key={c.entity_id} className="space-y-1 rounded-2xl border border-line bg-white/[0.03] p-3 text-[12.5px] text-ink-2">
                <strong className="text-[13.5px] text-ink">{shown(c.name)}</strong>
                <p>
                  {c.active_claims} recorded held tasks · Eligibility: {c.eligibility}
                </p>
                <p>
                  Capacity: {c.capacity} · Cost: {c.cost}
                </p>
                <p className="text-ink-3">{c.reasons.join('; ')}</p>
                <p className="text-ink-3">{c.uncertainties.join('; ')}</p>
                <small className="block text-ink-4">
                  Configured {kind === 'mind' ? 'role' : 'service'}: {matchNeed} · Verified capabilities: {c.verified_capabilities.join(', ') || 'none established'}
                </small>
              </article>
            ))}
          </div>
        )}
      </ResourceView>
    </div>
  )
}
