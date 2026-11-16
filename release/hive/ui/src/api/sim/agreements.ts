import { ApiError } from '../client'
import type { ConnectionAction, ConnectionAgreement, CreateRequestConnection, Swarm } from '../types'

/** Disposable request-only agreements. No model, memory sharing or process effects. */
export class SimAgreements {
  private rows = new Map<string, ConnectionAgreement>()
  private seq = 0
  constructor(private swarms: Map<string, Swarm>, private clock = () => new Date().toISOString()) {}
  list(swarmId: string) { return structuredClone([...this.rows.values()].filter((c) => c.from_swarm === swarmId || c.to_swarm === swarmId)) }
  create(body: CreateRequestConnection) {
    const from = this.swarms.get(body.from_swarm), to = this.swarms.get(body.to_swarm)
    if (!from || !to || from.id === to.id || !from.member_ids.includes(body.from_coordinator) || !to.member_ids.includes(body.to_coordinator)) throw new ApiError(400, 'bad_coordinator', 'Two different swarms and their member coordinators are required')
    if (!body.purpose.trim() || !body.scopes.length || body.scopes.some((s) => s.kind !== 'requests' || !['from->to','to->from'].includes(s.direction) || !s.kinds.length || s.kinds.some((k) => !k.trim()))) throw new ApiError(400, 'bad_scopes', 'Name a purpose and request kinds')
    this.days(body.days)
    if (!Number.isFinite(body.budget_usd) || body.budget_usd < 0 || body.budget_usd > 100000 || !['drain','cancel'].includes(body.on_end)) throw new ApiError(400, 'bad_request', 'Invalid budget or expiry policy')
    const at = this.clock(), end = this.until(body.days)
    const c: ConnectionAgreement = { ...structuredClone(body), id: `cn_sim_${++this.seq}`, starts_at: at, ends_at: end, until_revoked: false, review_at: null, status: 'active', allocated_usd: 0, created_by: 'simulated operator', created_at: at, history: [{ at, by: 'simulated operator', event: 'created' }], summary: `${from.name} → ${to.name}: ${body.purpose}`, note: 'Ending a connection stops access from then on; it cannot erase what was already read.' }
    this.rows.set(c.id, c); return structuredClone(c)
  }
  action(id: string, action: ConnectionAction, days?: number, reason?: string) {
    const c = this.rows.get(id)
    if (!c) throw new ApiError(404, 'not_found', 'No connection')
    if (action === 'renew') {
      if (c.status === 'revoked') throw new ApiError(409, 'revoked', 'A revoked connection cannot be renewed')
      this.days(days!); c.ends_at = this.until(days!); c.status = 'active'
    } else if (action === 'pause') {
      if (c.status !== 'active') throw new ApiError(409, 'not_active', 'Connection is not active')
      c.status = 'paused'
    } else if (action === 'resume') {
      if (c.status !== 'paused' || (c.ends_at && c.ends_at <= this.clock())) throw new ApiError(409, 'ended', 'Connection cannot be resumed')
      c.status = 'active'
    } else if (action === 'revoke') {
      if (c.status === 'revoked' || c.status === 'ended') throw new ApiError(409, 'closed', 'Connection is already closed')
      c.status = 'revoked'
    } else throw new ApiError(400, 'bad_action', 'Unknown connection action')
    // connections.py revoke records {event: "revoked", reason} ("revoked" when no reason was given)
    c.history.push(action === 'revoke' ? { at: this.clock(), by: 'simulated operator', event: 'revoked', reason: (reason ?? '').trim() || 'revoked' } : { at: this.clock(), by: 'simulated operator', event: action })
    return structuredClone(c)
  }
  private until(days: number) { return new Date(Date.parse(this.clock()) + days * 86400000).toISOString() }
  private days(days: number) { if (!Number.isFinite(days) || days <= 0 || days > 365) throw new ApiError(400, 'bad_request', 'Duration must be positive and at most 365 days') }
}
