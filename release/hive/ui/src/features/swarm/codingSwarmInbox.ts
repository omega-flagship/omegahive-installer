import type { CollabRequest, RequestState } from '../../api/types'
import { readContext } from '../../lib/readContext'
import { isRequestState } from '../../lib/requestState'
import type { Route } from '../../lib/router'

/**
 * A swarm's request inbox: a read-only projection of the hive's request page beside SwarmTeam. No scheduling, no
 * authority. Adopted from Code's proof of concept (coordination/omegacode/poc/codingSwarmInbox.ts, sha256 2cce5a76…)
 * onto the owner's CollabRequest type.
 *
 * The person's GET /api/requests answers the newest 200 requests this reader may see (host next15, 3fc8ad4: the
 * visibility filter is applied before the limit; earlier hosts limited first, so a short page could hide older ones). The read is tagged with the identity it was made under (readContext:
 * client, principal, team); a read for another team or identity is refused before any row or navigation is offered.
 * Keeping only the rows that involve this team is presentation, never authority.
 */

/** The host's page size for GET /api/requests. */
export const REQUEST_PAGE_LIMIT = 200

/** One read of GET /api/requests, tagged with the identity and team it was read for. */
export interface CodingInboxRead {
  ctx: string
  team_id: string
  requests: unknown
}

export type RequestDirection = 'incoming' | 'outgoing'

export interface CodingRequestRow {
  id: string
  kind: string
  title: string
  title_truncated: boolean
  direction: RequestDirection
  from_swarm: string
  to_swarm: string
  from_principal: string
  from_goal: string | null
  receiving_goal: string | null
  state: RequestState
  depth: number
  created_at: string
  cancelled_at: string | null
  budget: CollabRequest['budget']
  /** Whether the host returned a retained result. Its contents are never read here. */
  result_returned: boolean
}

export interface CodingInboxView {
  team_id: string
  rows: CodingRequestRow[]
  /** How many requests the host returned in this page (all teams, after its visibility filter). */
  returned_count: number
  /** The page reached the host's limit: older requests may exist and are not listed. */
  possibly_capped: boolean
}

export class CodingInboxMismatch extends Error {
  constructor() {
    super('Coding swarm requests do not match the current swarm and reader')
    this.name = 'CodingInboxMismatch'
  }
}

const TITLE_MAX = 2048
const MAX_DEPTH = 4
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const ref = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(v)
const money = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
function refuse(): never {
  throw new CodingInboxMismatch()
}

/**
 * Bind one read to the current team and identity, validate every row strictly, and keep the rows involving this team.
 * Throws CodingInboxMismatch on any mismatch or malformed row: the whole page is withheld, not partly shown.
 */
export function bindCodingInbox(raw: CodingInboxRead, team_id: string, current_ctx: string): CodingInboxView {
  if (!raw || !ref(team_id) || raw.team_id !== team_id || typeof current_ctx !== 'string' || !current_ctx || raw.ctx !== current_ctx) refuse()
  if (!Array.isArray(raw.requests) || raw.requests.length > REQUEST_PAGE_LIMIT) refuse()
  const rows: CodingRequestRow[] = []
  const seen = new Set<string>()
  for (const item of structuredClone(raw.requests) as unknown[]) {
    if (!object(item)) refuse()
    if (!['id', 'kind', 'from_swarm', 'to_swarm', 'from_principal'].every((k) => ref(item[k]))) refuse()
    if (typeof item.title !== 'string' || !isRequestState(item.state)) refuse()
    if (!Number.isSafeInteger(item.depth) || (item.depth as number) < 0 || (item.depth as number) > MAX_DEPTH) refuse()
    if (typeof item.created_at !== 'string' || !item.created_at) refuse()
    if (!(item.cancelled_at === null || typeof item.cancelled_at === 'string')) refuse()
    if (!('result' in item)) refuse()
    for (const key of ['from_goal', 'receiving_goal']) if (item[key] !== null && !ref(item[key])) refuse()
    const budget = item.budget
    if (!object(budget) || !ref(budget.root) || !money(budget.limit_usd) || !money(budget.allocated_usd)) refuse()
    if (seen.has(item.id as string) || item.from_swarm === item.to_swarm) refuse()
    seen.add(item.id as string)
    // the host returns a visibility-filtered page across the hive: keep this team's rows (presentation only)
    if (item.from_swarm !== team_id && item.to_swarm !== team_id) continue
    const titlePoints = Array.from(item.title)
    rows.push({
      id: item.id as string,
      kind: item.kind as string,
      title: titlePoints.slice(0, TITLE_MAX).join(''),
      title_truncated: titlePoints.length > TITLE_MAX,
      direction: item.to_swarm === team_id ? 'incoming' : 'outgoing',
      from_swarm: item.from_swarm as string,
      to_swarm: item.to_swarm as string,
      from_principal: item.from_principal as string,
      from_goal: item.from_goal as string | null,
      receiving_goal: item.receiving_goal as string | null,
      state: item.state,
      depth: item.depth as number,
      created_at: item.created_at,
      cancelled_at: item.cancelled_at as string | null,
      budget: { root: budget.root, limit_usd: budget.limit_usd as number, allocated_usd: budget.allocated_usd as number },
      result_returned: item.result !== null && item.result !== undefined,
    })
  }
  // Never sum: nested requests can name the same budget root, so these rows are not added into a new budget.
  return { team_id, rows, returned_count: raw.requests.length, possibly_capped: raw.requests.length === REQUEST_PAGE_LIMIT }
}

/** Presentation-only filters over a bound view. They narrow what is shown; they never widen what was read. */
export interface InboxFilter {
  direction: RequestDirection | 'all'
  state: RequestState | 'all'
}
export function filterRows(rows: CodingRequestRow[], f: InboxFilter): CodingRequestRow[] {
  return rows.filter((r) => (f.direction === 'all' || r.direction === f.direction) && (f.state === 'all' || r.state === f.state))
}

/** The identity a read is made under: the readContext of (client, principal, team), as useResource computes it. */
export function inboxIdentity(client: object | null | undefined, principal: string | undefined, team_id: string): string {
  return readContext(client, [principal, team_id])
}

/** Where "Open receiving task" goes: that task (the request's receiving goal) on its team's Tasks. Navigation only; nothing runs. */
export function receivingGoalRoute(row: Pick<CodingRequestRow, 'to_swarm' | 'receiving_goal'>): Route {
  return row.receiving_goal ? { name: 'tasks', swarm: row.to_swarm, task: row.receiving_goal } : { name: 'tasks', swarm: row.to_swarm }
}
