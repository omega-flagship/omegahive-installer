import { useId, useMemo, useState } from 'react'
import type { Swarm } from '../../api/types'
import { money, localWhen } from '../../lib/format'
import { cx } from '../../lib/cx'
import { REQUEST_STATE_LABEL, REQUEST_STATE_MEANING, REQUEST_STATE_TONE, REQUEST_STATES, REQUEST_TONE_CLASS } from '../../lib/requestState'
import { navigate } from '../../lib/router'
import { useMe } from '../../lib/useAdmin'
import { need, useResource } from '../../lib/useResource'
import { shown } from '../../lib/displayName'
import { useHive } from '../../store/store'
import { ResourceView } from '../../ui/ResourceView'
import { SimChip } from '../../ui/SimChip'
import { Skeleton } from '../../ui/primitives'
import { bindCodingInbox, filterRows, inboxIdentity, receivingGoalRoute, REQUEST_PAGE_LIMIT, type CodingInboxRead, type CodingInboxView, type CodingRequestRow, type InboxFilter } from './codingSwarmInbox'

/**
 * A swarm's request inbox, beside SwarmTeam (Surface request P; adopted from Code's CodingSwarmInboxPanel proof of
 * concept). Read-only: requests in and out of this swarm, who asked from which swarm and goal, the receiving goal, the
 * host's state, the budget root with its limit and allocation, the cancellation time and whether a retained result was
 * returned. It never reads a result's contents, never synthesises worker status, never sums budget roots and never
 * reports provider spending. Opening a receiving goal goes through the router; it never asks anything to run.
 *
 * Child minds' status and stop/retire come with the control plane (GET /api/teams/{swarm}/children and its control
 * route, on the person's session): not built here.
 */

export interface InboxNames {
  swarm?: (id: string) => string | undefined
  principal?: (principal: string) => string | undefined
}

/** The presentational panel: binds one tagged read to this team and identity, or withholds it entirely. */
export function CodingSwarmInboxPanel({ read, team_id, context, onOpenGoal, names }: { read: CodingInboxRead; team_id: string; context: string; onOpenGoal?: (row: CodingRequestRow) => void; names?: InboxNames }) {
  const view = useMemo((): CodingInboxView | null => {
    try {
      return bindCodingInbox(read, team_id, context)
    } catch {
      return null
    }
  }, [read, team_id, context])
  const [filter, setFilter] = useState<InboxFilter>({ direction: 'all', state: 'all' })
  const ids = useId()
  if (!view) return <p role="alert" className="xc-ink-2 rounded-xl border border-bad/40 p-3 text-small">Requests unavailable for this swarm and current reader.</p>
  const shownRows = filterRows(view.rows, filter)
  const incoming = view.rows.filter((r) => r.direction === 'incoming').length
  return (
    <section aria-label="Coding swarm requests" className="space-y-3 break-words">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="xc-heading text-lead font-semibold">Requests</h2>
        <span className="xc-ink-3 text-meta">{incoming} in · {view.rows.length - incoming} out</span>
      </div>
      <p className="xc-ink-2 text-small">Requests connect other swarms to this swarm’s work. The hive controls assignment, source access and execution; this list only reads.</p>
      <p className="xc-ink-3 text-meta" data-page-limit>
        The newest {REQUEST_PAGE_LIMIT} requests you may see: {view.returned_count} returned, {view.rows.length} involve this swarm.
      </p>
      {view.possibly_capped && (
        <p role="status" className="rounded-xl border border-warn/50 bg-warn/10 p-2.5 text-small text-warn">
          This page reached the hive’s limit of {REQUEST_PAGE_LIMIT}. Older requests may be missing, so a short or empty list here does not mean there are none.
        </p>
      )}
      {view.rows.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show requests">
          <label className="flex min-w-0 items-center gap-1.5 text-meta">
            <span className="xc-ink-3">Direction</span>
            <select id={`${ids}-dir`} value={filter.direction} onChange={(e) => setFilter({ ...filter, direction: e.target.value as InboxFilter['direction'] })} className="xc-input min-h-11 px-2 text-small">
              <option value="all">All</option>
              <option value="incoming">Incoming</option>
              <option value="outgoing">Outgoing</option>
            </select>
          </label>
          <label className="flex min-w-0 items-center gap-1.5 text-meta">
            <span className="xc-ink-3">State</span>
            <select id={`${ids}-state`} value={filter.state} onChange={(e) => setFilter({ ...filter, state: e.target.value as InboxFilter['state'] })} className="xc-input min-h-11 px-2 text-small">
              <option value="all">All</option>
              {REQUEST_STATES.map((s) => <option key={s} value={s}>{REQUEST_STATE_LABEL[s]}</option>)}
            </select>
          </label>
        </div>
      )}
      {!view.rows.length ? (
        <p className="xc-ink-3 text-small">No requests involving this swarm in this returned page.</p>
      ) : !shownRows.length ? (
        <p className="xc-ink-3 text-small">No requests match these filters. <button type="button" className="xc-button xc-subtle min-h-11 px-2 text-small" onClick={() => setFilter({ direction: 'all', state: 'all' })}>Show all</button></p>
      ) : (
        <ul className="space-y-2.5">
          {shownRows.map((row) => <RequestRow key={row.id} row={row} names={names} onOpenGoal={onOpenGoal} />)}
        </ul>
      )}
      <p className="xc-ink-3 text-meta">Allocation is not provider spending. Nested requests can share a budget root; these rows are never added into a new budget.</p>
      <p className="xc-ink-3 rounded-xl border border-dashed border-line p-2.5 text-meta" aria-disabled="true" data-children-note>
        Children (coming with the control plane): the status of child minds, and stopping or retiring them, will appear here once the hive offers them. Nothing is shown until then.
      </p>
    </section>
  )
}

function RequestRow({ row, names, onOpenGoal }: { row: CodingRequestRow; names?: InboxNames; onOpenGoal?: (row: CodingRequestRow) => void }) {
  const swarmName = (id: string) => {
    const n = names?.swarm?.(id)
    return n ? `${n} · ${id}` : id
  }
  const who = names?.principal?.(row.from_principal)
  const fields: [string, string, boolean?][] = [
    ['Request', row.id, true],
    ['From swarm', swarmName(row.from_swarm)],
    ['To swarm', swarmName(row.to_swarm)],
    ['Requested by', who ? `${who} · ${row.from_principal}` : row.from_principal],
    ['Origin task', row.from_goal ?? 'Not returned', !!row.from_goal],
    ['Receiving task', row.receiving_goal ?? 'Not returned', !!row.receiving_goal],
    ['Budget root', row.budget.root, true],
    ['Request limit', money(row.budget.limit_usd)],
    ['Allocated to requests', money(row.budget.allocated_usd)],
    ['Nested request depth', String(row.depth)],
  ]
  return (
    <li data-request={row.id} data-state={row.state} className="xc-divider rounded-2xl border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="xc-heading min-w-0 flex-1 text-body font-semibold">
          {row.title}
          {row.title_truncated && <span className="xc-ink-3 font-normal">… (title truncated)</span>}
        </h3>
        <span title={REQUEST_STATE_MEANING[row.state]} className={cx('shrink-0 rounded-lg border px-2 py-0.5 text-meta font-medium', REQUEST_TONE_CLASS[REQUEST_STATE_TONE[row.state]])}>
          {REQUEST_STATE_LABEL[row.state]}
        </span>
      </div>
      <p className="xc-ink-2 mt-1 text-small">
        {row.direction === 'incoming' ? 'Incoming' : 'Outgoing'} · {row.kind} · {REQUEST_STATE_MEANING[row.state]}
      </p>
      <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-small sm:grid-cols-2">
        {fields.map(([label, value, mono]) => (
          <div key={label} className="min-w-0">
            <dt className="xc-ink-3 text-meta">{label}</dt>
            <dd className={cx('break-all', mono && 'font-mono text-meta')}>
              {value}
              {(label === 'Request limit' || label === 'Allocated to requests') && <> <SimChip /></>}
            </dd>
          </div>
        ))}
        <div className="min-w-0">
          <dt className="xc-ink-3 text-meta">Created</dt>
          <dd><time dateTime={row.created_at} title={row.created_at}>{localWhen(row.created_at)}</time></dd>
        </div>
        {row.cancelled_at && (
          <div className="min-w-0">
            <dt className="xc-ink-3 text-meta">Cancelled</dt>
            <dd><time dateTime={row.cancelled_at} title={row.cancelled_at}>{localWhen(row.cancelled_at)}</time></dd>
          </div>
        )}
      </dl>
      <p className="xc-ink-2 mt-2 text-small">{row.result_returned ? 'Retained result returned by the hive.' : 'No retained result returned by the hive.'}</p>
      {row.receiving_goal && onOpenGoal && (
        <button type="button" className="xc-button mt-2 min-h-11 px-3 text-small" onClick={() => onOpenGoal(row)}>
          Open receiving task
        </button>
      )}
    </li>
  )
}

/** The owner binding: the existing listRequests() through useResource, under (client, principal, team). */
export function SwarmRequestInbox({ swarm }: { swarm: Swarm }) {
  const { me, loaded } = useMe()
  // the principal is part of the identity: wait for it rather than read once without it and again with it
  if (!loaded) return <Skeleton className="h-40" />
  return <BoundInbox key={`${me?.principal ?? ''}\u0000${swarm.id}`} swarm={swarm} principal={me?.principal} />
}

function BoundInbox({ swarm, principal }: { swarm: Swarm; principal: string | undefined }) {
  const client = useHive((s) => s.client)
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const ctx = inboxIdentity(client, principal, swarm.id)
  const team = swarm.id
  const res = useResource<CodingInboxRead>(async () => ({ ctx, team_id: team, requests: await need(client, 'listRequests', 'Requests')() }), { context: [principal, team], poll: 15000, isEmpty: () => false })
  const names: InboxNames = {
    swarm: (id) => (swarms[id] ? shown(swarms[id].name) : undefined),
    principal: (p) => (p.startsWith('agent:') && agents[p.slice(6)] ? shown(agents[p.slice(6)].name) : undefined),
  }
  return (
    <ResourceView res={res} errorTitle="Could not load requests" unsupported={{ title: 'Requests are not available here', body: 'This hive does not list cross-swarm requests.' }}>
      {(read) => <CodingSwarmInboxPanel key={ctx} read={read} team_id={team} context={ctx} names={names} onOpenGoal={(row) => navigate(receivingGoalRoute(row))} />}
    </ResourceView>
  )
}
