import { ApiError, type HiveClient } from '../../api/client'
import type { CollabRequest, ConnectionAction, ConnectionAgreement, CreateRequestConnection } from '../../api/types'
import { money } from '../../lib/format'
import { isTerminalRequest, requestStateLabel } from '../../lib/requestState'
import { need } from '../../lib/useResource'
import { askConfirm } from '../../ui/confirm'

export type ConnectionNames = { swarm?: (id: string) => string; mind?: (id: string) => string }
const identity = (id: string, name?: (id: string) => string) => name ? `${name(id)} (${id})` : id
const invalid = (message: string): never => { throw new ApiError(400, 'bad_request', message) }
const duration = (days: number | undefined) => { if (!Number.isFinite(days) || days! <= 0 || days! > 365) invalid('Duration must be positive and at most 365 days') }

/** Plain UI actions for the page-Omega registry. Callers mount ConfirmHost; host authorization remains authoritative. */
export async function reviewCreateConnection(client: HiveClient | null, input: CreateRequestConnection, names: ConnectionNames = {}): Promise<ConnectionAgreement | null> {
  const create = need(client, 'createConnection', 'Connection creation')
  // Snapshot before waiting: a draft edited during review must never widen the submitted intent.
  const body = structuredClone(input)
  if (!body.from_swarm || !body.to_swarm || body.from_swarm === body.to_swarm || !body.from_coordinator || !body.to_coordinator || !body.purpose.trim()) invalid('Name two different swarms, their coordinators and a purpose')
  duration(body.days)
  if (!Number.isFinite(body.budget_usd) || body.budget_usd < 0 || body.budget_usd > 100000 || !['drain', 'cancel'].includes(body.on_end)) invalid('Invalid allocation budget or end policy')
  if (!body.scopes.length || body.scopes.some((s) => s.kind !== 'requests' || !['from->to', 'to->from'].includes(s.direction) || !s.kinds.length || s.kinds.some((k) => !k.trim()))) invalid('This action only creates named request permissions')
  const scopes = body.scopes.map((s) => `${s.direction === 'from->to' ? `${identity(body.from_swarm, names.swarm)} → ${identity(body.to_swarm, names.swarm)}` : `${identity(body.to_swarm, names.swarm)} → ${identity(body.from_swarm, names.swarm)}`}: ${s.kinds.join(', ')}`).join('; ')
  const message = `Connect for “${body.purpose}”? Coordinators: ${identity(body.from_coordinator, names.mind)} ↔ ${identity(body.to_coordinator, names.mind)}. Allow requests: ${scopes}. Duration: ${body.days} days from now. Request allocation: ${money(body.budget_usd)}. At expiry: ${body.on_end === 'cancel' ? 'cancel running requests' : 'let running requests finish'}.${body.deliverable ? ` Deliverable: ${body.deliverable}.` : ''}${body.success ? ` Success: ${body.success}.` : ''}`
  if (!await askConfirm(message, 'Create connection')) return null
  return create(body)
}

export async function reviewConnectionAction(client: HiveClient | null, input: ConnectionAgreement, action: ConnectionAction, days?: number, names: ConnectionNames = {}, reason?: string): Promise<ConnectionAgreement | null> {
  const change = need(client, 'connectionAction', 'Connection controls')
  const c = structuredClone(input)
  if (!['pause', 'resume', 'renew', 'revoke'].includes(action)) invalid('Unknown connection action')
  if (!c.id || (action === 'pause' && c.status !== 'active') || (action === 'resume' && c.status !== 'paused') || (action === 'revoke' && !['active', 'paused'].includes(c.status)) || c.status === 'revoked') invalid('The connection cannot take this action in its displayed state; refresh it')
  if (action === 'renew') duration(days)
  const scopes = c.scopes.map((s) => s.kind === 'requests'
    ? `${s.direction === 'from->to' ? `${identity(c.from_swarm, names.swarm)} → ${identity(c.to_swarm, names.swarm)}` : `${identity(c.to_swarm, names.swarm)} → ${identity(c.from_swarm, names.swarm)}`}: ${s.kinds.join(', ')} requests`
    : `${identity(s.mind, names.mind)} / ${s.space}${s.pattern ? ` (${s.pattern})` : ''}: read by ${identity(s.side === 'from' ? c.to_coordinator : c.from_coordinator, names.mind)}`).join('; ')
  const effects = action === 'revoke' ? 'Stops new access and cancels associated requests. Already read information is retained.' : action === 'pause' ? `Stops new access. Running requests ${c.on_end === 'cancel' ? 'are cancelled' : 'may finish'}.` : action === 'renew' ? `Reactivates these scopes for ${days} days from now.${c.status === 'active' ? ` The host first reapplies access; associated requests ${c.on_end === 'cancel' ? 'are cancelled under this agreement’s end policy' : 'may finish'}.` : ''}` : `Reactivates these scopes until ${c.ends_at ?? c.review_at ?? 'the host end date'}.`
  const label = action[0].toUpperCase() + action.slice(1)
  if (!await askConfirm(`${label} “${c.purpose}” (${c.id})? Coordinators: ${identity(c.from_coordinator, names.mind)} ↔ ${identity(c.to_coordinator, names.mind)}. Scopes: ${scopes}. Request allocation: ${money(c.allocated_usd)} of ${money(c.budget_usd)}. ${effects}`, label, { danger: action === 'revoke' })) return null
  // the host records a revoke's reason in the connection's history (app.py:2615); every revoke sends one, even empty
  return action === 'revoke' ? change(c.id, action, undefined, (reason ?? '').trim()) : change(c.id, action, action === 'renew' ? days : undefined)
}

export async function reviewCancelRequest(client: HiveClient | null, input: CollabRequest): Promise<Awaited<ReturnType<NonNullable<HiveClient['cancelRequest']>>> | null> {
  const cancel = need(client, 'cancelRequest', 'Request cancellation')
  const r = structuredClone(input)
  // in review is not terminal: submitted work can still be cancelled (collab.py cancel_request)
  if (!r.id || isTerminalRequest(r)) invalid('This request is already terminal; refresh it')
  if (!await askConfirm(`Cancel request “${r.title}” (${r.id})? ${r.from_swarm} → ${r.to_swarm}; kind ${r.kind}; ${requestStateLabel(r.state).toLowerCase()}.${typeof r.connection_id === 'string' ? ` Connection: ${r.connection_id}.` : ''}`, 'Cancel request', { danger: true })) return null
  return cancel(r.id)
}
