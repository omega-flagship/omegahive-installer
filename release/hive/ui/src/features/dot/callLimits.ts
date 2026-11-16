// Purpose: what a mind's next paid call is admitted against, read while its panel is open, and the cap its panel shows.
import { useEffect, useState } from 'react'
import type { Agent, CallLimit, CallLimits, SeenLimit } from '../../api/types'
import { startVisiblePoll } from '../../lib/poll'
import { useHive } from '../../store/store'

/** How often a mind's limits are read again while its panel is open and the page is visible (a modest interval). */
export const LIMITS_POLL_MS = 60_000

/**
 * What a mind's next paid call is admitted against (GET /api/agents/{id}/limits, least room first), read when its panel
 * opens, again when its spend or its refusal changes, and every LIMITS_POLL_MS while the page is visible: a call whose
 * cost never comes back keeps its worst case held until it settles by itself, with no event to say either.
 * Null while unread, or on a hive without the read.
 */
export function useCallLimits(agentId: string, spent: number, refusedAt: string | undefined): CallLimits | null {
  const client = useHive((s) => s.client)
  const [read, setRead] = useState<{ id: string; limits: CallLimits } | null>(null)
  useEffect(() => {
    const agentLimits = client?.agentLimits
    if (!agentLimits) return
    let live = true
    const stop = startVisiblePoll(() => {
      agentLimits.call(client, agentId).then((limits) => { if (live) setRead({ id: agentId, limits }) }, () => undefined)
    }, LIMITS_POLL_MS)
    return () => {
      live = false
      stop()
    }
  }, [client, agentId, spent, refusedAt])
  return read && read.id === agentId ? read.limits : null
}

/** The limit that stops the mind next (the least room), when it is not the mind's own cap, a limit this viewer may not
 *  see included: null when its own cap binds, or nothing limits it, so the panel shows that cap as before. */
export function bindingElsewhere(agentId: string, limits: CallLimits | null): CallLimit | null {
  const first = limits?.limits[0]
  return first && first.label !== `agent:${agentId}:total` ? first : null
}

/** The cap admission holds the mind to and what is used of it: its own limit row when the hive names one (a session's
 *  total can hold it below the stored budget), counting the worst cases held for calls not yet settled; else the stored
 *  budget and the spend. A cap of 0 means the mind has none of its own. */
export function budgetMeter(agent: Pick<Agent, 'id' | 'budget_usd' | 'spent_usd'>, limits: CallLimits | null): { cap: number; used: number } {
  const own = limits?.limits.find((l): l is SeenLimit => !l.hidden && l.label === `agent:${agent.id}:total`)
  return own ? { cap: own.limit_usd, used: own.spent_usd + own.held_usd } : { cap: agent.budget_usd, used: agent.spent_usd }
}
