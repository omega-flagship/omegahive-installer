import type { CollabRequest, Goal, GoalStatus, RequestState } from '../types'

/**
 * SIM ONLY. Cross-swarm requests as the host keeps them (hive/core/collab.py at ad9e82c): a stored row, and a view whose
 * state is read from the receiving goal through REQUEST_STATE, `accepted` without a receiving goal, `cancelled` once
 * cancelled_at is set; `result` is the receiving goal's retained result or null. So a submitted goal reads `in-review`,
 * the requester's accept makes it `completed`, and a return puts it back to `working`. Every row is INVENTED.
 */
export const REQUEST_STATE: Partial<Record<GoalStatus, RequestState>> = {
  open: 'queued',
  claimed: 'working',
  waiting: 'needs-approval',
  submitted: 'in-review',
  done: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** What the host stores for a request (the view adds state, result and budget). */
export interface SimRequestRow {
  id: string
  kind: string
  title: string
  from_swarm: string
  from_goal: string | null
  from_principal: string
  to_swarm: string
  receiving_goal: string | null
  depth: number
  created_at: string
  cancelled_at: string | null
  budget_root: string
  limit_usd: number
  allocated_usd: number
  /** Request ids above this one (collab.py `ancestry`), so cancelling a request cancels what it asked for in turn. */
  ancestry: string[]
}

/** collab.py request_view, over the sim's goals. */
export function requestView(row: SimRequestRow, goal: Goal | undefined): CollabRequest {
  // as the host: a status outside REQUEST_STATE (stalled) reads `accepted`
  const state: RequestState = row.cancelled_at ? 'cancelled' : (goal && REQUEST_STATE[goal.status]) || 'accepted'
  const retained = goal && (goal.status === 'submitted' || goal.status === 'done' || goal.status === 'failed') && goal.result != null
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    from_swarm: row.from_swarm,
    from_goal: row.from_goal,
    from_principal: row.from_principal,
    to_swarm: row.to_swarm,
    receiving_goal: row.receiving_goal,
    state,
    depth: row.depth,
    created_at: row.created_at,
    cancelled_at: row.cancelled_at,
    budget: { root: row.budget_root, limit_usd: row.limit_usd, allocated_usd: row.allocated_usd },
    ancestry: [...row.ancestry],
    // the host returns the receiving goal's result data; the sim keeps an invented marker, never shown by the UI
    result: retained ? { summary: 'Invented retained result (sim).' } : null,
  }
}

/** The host's page: newest first, at most `limit` (GET /api/requests: ORDER BY created_at DESC LIMIT 200). */
export function requestPage(rows: Iterable<SimRequestRow>, goal: (id: string) => Goal | undefined, limit = 200): CollabRequest[] {
  return [...rows]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map((r) => requestView(r, r.receiving_goal ? goal(r.receiving_goal) : undefined))
}

/** collab.py cancel_request: the request and every request below it; each open receiving goal is cancelled. */
export function cancelRequests(rows: Map<string, SimRequestRow>, id: string, at: string): string[] {
  const cancelled: string[] = []
  for (const r of rows.values()) {
    if (r.id !== id && !r.ancestry.includes(id)) continue
    if (r.cancelled_at) continue
    r.cancelled_at = at
    cancelled.push(r.id)
  }
  return cancelled
}
