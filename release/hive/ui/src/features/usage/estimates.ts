// Purpose: what the Usage page names minds, swarms and keys with, and an estimate as the person saw it when they opened its money decision.
import type { EstimatedCall } from '../../api/moneyWork'
import { shown } from '../../lib/displayName'
import { useHive } from '../../store/store'

/**
 * An estimate as the person saw it when they opened its decision: a copy, so the dialog's binding can tell a change
 * that arrives while it is open (DecisionDialog's bound). A money decision is only ever taken in a full inspection
 * (Review R2/R3): one estimate, or all of them at once (cost_reservations.correct), for 30 days after it settled.
 */
export const seenEstimate = (e: EstimatedCall): EstimatedCall => ({ ...e, scopes: [...e.scopes], metadata: { ...e.metadata }, observation: e.observation && { ...e.observation } })

/** A mind's, a swarm's or a key's name as the hive's store has it, else its id. */
export function useNamer() {
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const keys = useHive((s) => s.keys)
  return (kind: 'agent' | 'swarm' | 'key', id: string) => {
    if (kind === 'agent') return agents[id] ? shown(agents[id].name) : id
    if (kind === 'swarm') return swarms[id] ? shown(swarms[id].name) : id
    const k = keys?.find((x) => x.id === id)
    return k ? `${k.label} ${k.hint}` : id
  }
}
