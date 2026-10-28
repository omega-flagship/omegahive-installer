import { useState } from 'react'
import { shown } from '../../lib/displayName'
import { useHive } from '../../store/store'
import { askConfirm } from '../../ui/confirm'

/** Move a mind to another swarm, keeping its id, history and budget (the host's PATCH swarm_id). This control only
 *  offers what the viewer may see and disables itself while the mind runs; the host enforces all of it: destination
 *  visibility, not archived, and the mind stopped. */
export function SwarmMove({ agentId }: { agentId: string }) {
  const agent = useHive((s) => s.agents[agentId])
  const swarms = useHive((s) => s.swarms)
  const patch = useHive((s) => s.patchAgent)
  const toast = useHive((s) => s.toast)
  const [busy, setBusy] = useState(false)
  if (!agent) return null
  const running = agent.status === 'awake' || agent.status === 'starting'
  const options = Object.values(swarms).filter((s) => !s.archived_at).sort((a, b) => a.name.localeCompare(b.name))
  return (
    <section aria-labelledby="swarm-move-h">
      <h3 id="swarm-move-h" className="eyebrow mb-2">Swarm</h3>
      <select
        aria-labelledby="swarm-move-h"
        className="w-full rounded-xl border border-line bg-white/[0.04] px-3 py-2 text-[13px] text-ink disabled:opacity-60"
        value={agent.swarm_id ?? ''}
        disabled={busy || running}
        onChange={async (e) => {
          const to = e.target.value
          if (!to || to === agent.swarm_id) return
          const ok = await askConfirm(`Move ${shown(agent.name)} to ${shown(swarms[to]?.name ?? to)}? It keeps its history and budget, and works there from now on.`, 'Move')
          if (!ok) return
          setBusy(true)
          const moved = await patch(agent.id, { swarm_id: to })
          setBusy(false)
          if (moved) toast({ tone: 'success', icon: 'user', title: `${shown(agent.name)} moved to ${shown(swarms[to]?.name ?? to)}`, body: 'Same mind, same history and budget.' })
        }}
      >
        {!agent.swarm_id && <option value="">No swarm</option>}
        {options.map((s) => <option key={s.id} value={s.id} className="bg-[#0b0b22]">{shown(s.name)}</option>)}
      </select>
      {running && <p className="mt-2 text-meta text-ink-4">Stop {shown(agent.name)} before moving it.</p>}
    </section>
  )
}
