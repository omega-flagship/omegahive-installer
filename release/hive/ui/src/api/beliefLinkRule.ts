// Purpose: the hive's rule for when a change to a mind's belief link widens it (PUT /api/agents/{id}/belief-link in
// hive/API.md), so the page offers each reader only the changes their rights allow and the simulator refuses the rest
// as the hive does.
import type { BeliefLink, BeliefLinkDomains } from './types'

/** What a setting links: the owner's choice, or the mind's default for null; [] links none. */
export function effective(domains: BeliefLinkDomains, def: BeliefLink['default']): BeliefLink['linked'] {
  if (domains === null) return def
  if (domains === 'all') return 'all'
  return domains.length ? domains : 'none'
}

/**
 * Whether setting `domains` lets the swarm see a belief the link in place now does not: "all" over anything less, a
 * subject not linked now, or null where the mind's default links more than now. Only the owner may make such a change;
 * an admin may make any other.
 */
export function widens(link: Pick<BeliefLink, 'linked' | 'default'>, domains: BeliefLinkDomains): boolean {
  const next = effective(domains, link.default)
  const now = link.linked
  if (next === 'none' || now === 'all') return false
  if (next === 'all' || now === 'none') return true
  return next.some((d) => !now.includes(d))
}
