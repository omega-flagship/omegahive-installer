/**
 * INVENTED DATA. The simulator's mirror of the Ask's linkage intents (host release main 39c0731: hive/core/ask_intents.py
 * record / submit / get / list, and the r2.13 checks of minds.py `_instruction_body` and `instruct`), so the Code canvas's
 * vibe route runs end to end in the browser with no hive:
 *
 *   record   → one pending intent per Ask turn (same body: the same intent, 200; another: 409 intent_pending)
 *   submit   → linked, with an invented request, lease and receiving goal; the recorded 201 is answered byte for byte
 *   then     → the team's invented controller starts an invented suggest-only child, which files ONE retained proposal on
 *              the person's issued scope (the origin workspace); with copy-apply switched on, the controller then puts it
 *              into the person's copy (SimCodeService.applyAsController), exactly as far as Code's auto path allows
 *
 * Nothing here is live evidence; the team, its template and every id are invented.
 */
import { ApiError } from '../client'
import type { CodeTeamOffer, IntentRecordBody } from '../askIntents'
import type { SimCodeService } from './codeService'

const REQUEST_FIELDS = ['to_swarm', 'kind', 'title', 'instruction', 'origin', 'budget', 'lifetime', 'lease']
const ORIGIN_FIELDS = ['task_id', 'repository_id', 'workspace_id', 'scope_id', 'scope_digest', 'generation']
const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('')

/** INVENTED: the team that takes code requests in the simulator (Lyra's coordinator is its controller). */
export const SIM_CODE_TEAM: CodeTeamOffer = { to_swarm: 's_lyra', team_name: 'Lyra', template_ids: ['tpl_sim_coder'] }
/** INVENTED: the person ceiling (the host's HIVE_PERSON_REQUEST_CEILING_USD default). */
const CEILING_USD = 1

interface Row {
  id: string
  turn_id: string
  principal: string
  body: Record<string, unknown> & { operation_id: string }
  canon: string
  state: 'pending' | 'dispatching' | 'linked' | 'refused' | 'abandoned'
  request_id: string | null
  lease_id: string | null
  receiving_goal: string | null
  answer: string | null
  links_rev: number
  created_at: string
  updated_at: string
}

export interface SimIntentsDeps {
  principal(): string
  /** a named, enabled admin person (the record and submit routes' r2.13 check) */
  admin(): boolean
  /** the caller's own, undeleted Ask turn, or null */
  turn(op: string): { turnId: string; createdAt: string } | null
  /** the code service holding the origin task's workspace */
  code(taskId: string): SimCodeService | undefined
  later(ms: number, fn: () => void): void
  /** SIM fixture: the invented child waits for this before it files its proposal */
  mindGate?: () => Promise<void>
  /**
   * SIM: the hive's HIVE_MIND_SPAWN (default on). Off, as at ce8001d: submit still admits the request (minds.instruct
   * does not check it); only the controller's child spawn is refused (spawn_disabled), so no child starts and nothing
   * is proposed.
   */
  spawn?: () => boolean
  /** SIM: how long the controller takes before it puts a proposal into the copy itself (copy-apply on), ms */
  applyDelayMs?: number
  /**
   * SIM: the host's copy-apply consent gate (Platform 66312cd; default on). On, the controller's copy_apply needs the
   * request person's live accept for exactly that digest (else consent_required / consent_stale, and it waits). Off
   * plays a host without the gate (ce8001d): the controller puts the proposal in by itself.
   */
  consentGate?: () => boolean
  /** SIM: how often the invented controller looks for the person's consent, ms (default 400) */
  consentPollMs?: number
  /**
   * SIM: the application record carries its consent evidence (consent_id, applied_at), as Platform is adding. False
   * plays today's host, whose application record has neither (the page must then say it can't verify the OK).
   */
  evidence?: () => boolean
}

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
const bad = (m: string) => new ApiError(400, 'bad_request', m)

export class SimIntents {
  private rows = new Map<string, Row>()
  /** the invented team's children (minds.py child_view, only the fields the page reads) */
  private kids: { child_id: string; request_id: string; team_id: string; state: string }[] = []
  constructor(private d: SimIntentsDeps) {}
  /** copy-apply consents by `${request_id}:${suggestion_id}` (66312cd keeps every row; the sim keeps the newest) */
  private consents = new Map<string, { id: string | null; decision: 'accept' | 'decline'; digest: string; expires: number; spent: boolean }>()
  /**
   * POST /api/requests/{request_id}/proposals/{suggestion_id}/{accept|decline} {suggestion_digest} (66312cd minds.py
   * copy_apply_consent): the request's own person; a closed body; an accept lives ten minutes and is single use; any
   * decision voids the earlier ones.
   */
  consent(principal: string, requestId: string, suggestionId: string, decision: 'accept' | 'decline', data: unknown) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).join() !== 'suggestion_digest') throw bad('the body is exactly {suggestion_digest}')
    const digest = (data as { suggestion_digest: unknown }).suggestion_digest
    if (!/^suggestion_[0-9a-f]{32}$/.test(suggestionId)) throw bad('the proposal id is suggestion_<32 hex>')
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw bad("suggestion_digest is the proposal's bare 64-hex digest")
    const row = [...this.rows.values()].find((r) => r.request_id === requestId)
    if (!row) throw new ApiError(404, 'not_found', `no request ${requestId}`)
    if (row.principal !== principal) throw new ApiError(403, 'not_request_person', 'only the person who made this request accepts or declines its proposals')
    const at = new Date()
    const out: Record<string, unknown> = { request_id: requestId, suggestion_id: suggestionId, suggestion_digest: digest, decision, principal, created_at: at.toISOString() }
    if (decision === 'accept') {
      const expires = at.getTime() + 600_000
      const id = `cns_${hex(16)}`
      this.consents.set(`${requestId}:${suggestionId}`, { id, decision, digest, expires, spent: false })
      Object.assign(out, { consent_id: id, controller_id: 'a_vega01', expires_in: 600, expires_at: new Date(expires).toISOString() })
    } else this.consents.set(`${requestId}:${suggestionId}`, { id: null, decision, digest, expires: 0, spent: false })
    return out
  }
  /** GET /api/teams/{swarm_id}/children (minds.py team_children): one page, no cursor in the sim. */
  children(teamId: string) {
    if (teamId !== SIM_CODE_TEAM.to_swarm) throw new ApiError(404, 'not_found', 'no such swarm')
    return { children: this.kids.filter((k) => k.team_id === teamId).map((k) => ({ ...k })), snapshot_at: new Date().toISOString(), next_cursor: null }
  }

  private view(r: Row) {
    const lifetime = (r.body.lifetime ?? {}) as { until?: string }
    const origin = (r.body.origin ?? {}) as Record<string, unknown>
    return structuredClone({
      intent_id: r.id, turn_id: r.turn_id, kind: 'code.request', state: r.state, request_operation_id: r.body.operation_id,
      request_digest: `sim-${r.id}`, destination: { to_swarm: r.body.to_swarm, task_id: origin.task_id, workspace_id: origin.workspace_id, repository_id: origin.repository_id },
      title: r.body.title ?? null, instruction: r.body.instruction ?? null, instruction_digest: `sim-${r.id}`, budget: r.body.budget ?? null, until: lifetime.until ?? null,
      last_dispatch: null, last_refusal: null, dispatch_id: null, dispatch_started_at: null, request_id: r.request_id, lease_id: r.lease_id, receiving_goal: r.receiving_goal,
      deleted: false, links_rev: r.links_rev, created_at: r.created_at, updated_at: r.updated_at,
    })
  }
  private own(id: string): Row {
    const r = this.rows.get(id)
    if (!r || r.principal !== this.d.principal()) throw new ApiError(404, 'not_available', 'That isn’t available.')
    return r
  }

  /** minds.py _instruction_body, in miniature: only r2.13 names, its shape and limits. */
  private check(req: Record<string, unknown>) {
    const keys = Object.keys(req)
    if (keys.some((k) => !REQUEST_FIELDS.includes(k))) throw bad(`unknown fields: ${keys.filter((k) => !REQUEST_FIELDS.includes(k)).sort().join(', ')}`)
    if (REQUEST_FIELDS.some((k) => !(k in req))) throw bad('missing fields')
    if (req.kind !== 'code') throw bad("kind is 'code'")
    if (typeof req.to_swarm !== 'string' || !req.to_swarm || req.to_swarm.length > 80) throw bad("to_swarm is the team swarm's id")
    if (typeof req.title !== 'string' || ![...req.title].length || [...req.title].length > 200) throw bad('title is 1 to 200 characters')
    const n = typeof req.instruction === 'string' ? new TextEncoder().encode(req.instruction).length : 0
    if (n < 1 || n > 8192) throw bad('instruction is 1 to 8192 bytes of UTF-8 text')
    const o = req.origin as Record<string, unknown>
    if (!o || typeof o !== 'object' || Object.keys(o).sort().join() !== [...ORIGIN_FIELDS].sort().join()) throw bad(`origin is exactly ${ORIGIN_FIELDS.join(', ')}`)
    if (typeof o.scope_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(o.scope_digest)) throw bad('origin.scope_digest is sha256:<64 hex>')
    if (!Number.isInteger(o.generation) || (o.generation as number) < 1) throw bad('origin.generation is a positive integer')
    const b = req.budget as Record<string, unknown>
    if (!b || Object.keys(b).join() !== 'limit_usd' || typeof b.limit_usd !== 'number' || !(b.limit_usd > 0)) throw bad('budget is {limit_usd: a number more than 0}')
    const until = Date.parse(String((req.lifetime as { until?: unknown })?.until ?? ''))
    if (Number.isNaN(until) || until <= Date.now() || until > Date.now() + 24 * 3600_000) throw bad('lifetime.until is in the future and at most 24 hours ahead')
    const l = req.lease as { template_ids?: unknown; max_children?: unknown }
    if (!l || !Array.isArray(l.template_ids) || !l.template_ids.length || l.template_ids.length > 8 || new Set(l.template_ids).size !== l.template_ids.length) throw bad('lease.template_ids is 1 to 8 unique template ids')
    if (!Number.isInteger(l.max_children) || (l.max_children as number) < 1 || (l.max_children as number) > 4) throw bad('lease.max_children is an integer from 1 to 4')
  }

  /** POST /api/ask/{op}/intents. */
  record(op: string, data: IntentRecordBody | Record<string, unknown>): { status: 200 | 201; view: unknown } {
    if (!this.d.admin()) throw new ApiError(403, 'person_required', 'a named, signed-in admin person sends instructions')
    const t = this.d.turn(op)
    if (!t) throw new ApiError(404, 'not_available', 'That isn’t available.')
    if (Date.now() - Date.parse(t.createdAt) > 24 * 3600_000) throw bad('that Ask turn is more than 24 hours old; ask again')
    if (Object.keys(data ?? {}).sort().join() !== 'kind,request') throw bad('the body is exactly {kind, request}')
    if ((data as IntentRecordBody).kind !== 'code.request') throw bad("kind is 'code.request'")
    const req = (data as IntentRecordBody).request as unknown as Record<string, unknown>
    if (!req || typeof req !== 'object') throw bad('request is the r2.13 body without operation_id')
    if ('operation_id' in req) throw bad('operation_id is host-derived; leave it out of the request')
    this.check(req)
    const canon = canonical(req)
    const live = [...this.rows.values()].find((r) => r.turn_id === t.turnId && (r.state === 'pending' || r.state === 'dispatching'))
    if (live) {
      if (live.state === 'dispatching') throw new ApiError(409, 'intent_in_flight', 'That turn’s intent is being sent; wait for it to settle.')
      if (live.canon === canon) return { status: 200, view: this.view(live) }
      throw new ApiError(409, 'intent_pending', 'That turn already has an intent waiting to be sent.')
    }
    const at = new Date().toISOString()
    const id = `ai_${hex(12)}`
    const row: Row = { id, turn_id: t.turnId, principal: this.d.principal(), body: { ...req, operation_id: `ask.${id}` }, canon, state: 'pending', request_id: null, lease_id: null, receiving_goal: null, answer: null, links_rev: 1, created_at: at, updated_at: at }
    this.rows.set(id, row)
    return { status: 201, view: this.view(row) }
  }

  /** POST /api/ask/intents/{id}/submit: S1-S4 in miniature (no await between the claim and the link here). */
  submit(id: string): unknown {
    if (!this.d.admin()) throw new ApiError(403, 'person_required', 'a named, signed-in admin person sends instructions')
    const r = this.own(id)
    if (r.state === 'linked') return JSON.parse(r.answer!)
    if (r.state === 'abandoned') throw new ApiError(409, 'intent_closed', 'That intent was abandoned or its thread deleted; it can’t be sent.')
    const body = r.body as unknown as IntentRecordBody['request'] & { operation_id: string }
    const refuse = (status: number, code: string, message: string) => {
      r.state = 'refused'
      r.links_rev++
      throw new ApiError(status, code, message)
    }
    const svc = this.d.code(body.origin.task_id)
    if (!svc) refuse(403, 'origin_not_held', 'you did not open that task')
    if (body.to_swarm !== SIM_CODE_TEAM.to_swarm) refuse(403, 'not_offered', "that team does not offer 'code'")
    const unknown = body.lease.template_ids.filter((x) => !SIM_CODE_TEAM.template_ids.includes(x))
    if (unknown.length) refuse(422, 'template_unknown', 'templates not registered for that team')
    if (body.budget.limit_usd > CEILING_USD) refuse(402, 'spend_limit', `a person's instruction carries at most $${CEILING_USD.toFixed(2)}`)
    const rid = `rq_sim${hex(6)}`
    const answer = { request_id: rid, receiving_goal: `g_simrecv${hex(4)}`, lease_id: `ls_sim${hex(6)}`, state: 'accepted', budget: { root: rid, limit_usd: body.budget.limit_usd }, until: body.lifetime.until }
    Object.assign(r, { state: 'linked', request_id: answer.request_id, lease_id: answer.lease_id, receiving_goal: answer.receiving_goal, answer: JSON.stringify(answer), updated_at: new Date().toISOString() })
    r.links_rev++
    this.child(svc!, body, { request_id: rid, controller_id: 'a_vega01', execution_goal: answer.receiving_goal, issuer: r.principal, origin_scope: { scope_id: body.origin.scope_id, scope_digest: body.origin.scope_digest, generation: body.origin.generation } })
    return structuredClone(answer)
  }

  /** The invented team at work: a suggest-only child proposes on the origin scope; the controller may put it in. */
  private child(svc: SimCodeService, body: IntentRecordBody['request'], delegated: Record<string, unknown>) {
    this.d.later(300, () => {
      void (async () => {
        // the controller's spawn: refused when spawning is off (spawn_disabled goes to the controller, not the person)
        if (this.d.spawn && !this.d.spawn()) return
        this.kids.push({ child_id: `a_simchild${hex(4)}`, request_id: String(delegated.request_id), team_id: SIM_CODE_TEAM.to_swarm, state: 'running' })
        try {
          if (this.d.mindGate) await this.d.mindGate()
          const rec = (await svc.ask(body.origin.workspace_id, body.origin.scope_id, body.instruction, delegated)) as { id: string; digest: string }
          if (svc.copyApplyOn) {
            if (this.d.applyDelayMs) await new Promise((r) => setTimeout(r, this.d.applyDelayMs))
            const rid = String(delegated.request_id)
            let consentId: string | null = null
            if (!this.d.consentGate || this.d.consentGate()) {
              // 66312cd: issue_copy_apply needs a live, unspent accept for exactly this digest; the controller waits for it
              const until = Date.now() + 10 * 60_000
              for (;;) {
                const c = this.consents.get(`${rid}:${rec.id}`)
                if (c?.decision === 'decline' || Date.now() > until) return
                if (c && c.decision === 'accept' && !c.spent && c.expires > Date.now() && c.digest === rec.digest) {
                  c.spent = true
                  consentId = c.id
                  break
                }
                await new Promise((r) => setTimeout(r, this.d.consentPollMs ?? 400))
              }
            }
            try {
              await svc.applyAsController(rec.id, undefined, !this.d.evidence || this.d.evidence() ? { consent_id: consentId } : undefined)
            } catch {
              /* the auto path refused it (a shortening/removing change, or stale): the proposal keeps its person confirm */
            }
          }
        } catch {
          /* an invented child that could not propose files nothing; the page's wait ends without a proposal */
        }
      })()
    })
  }

  /** GET /api/ask/intents/{id}. */
  get(id: string) {
    return this.view(this.own(id))
  }
  /** GET /api/ask/intents?state=&limit=. */
  list(q: { state?: string; limit?: number } = {}) {
    const limit = q.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw bad('limit is 1 to 50')
    const mine = [...this.rows.values()].filter((r) => r.principal === this.d.principal() && (!q.state || r.state === q.state))
    return { intents: mine.sort((a, z) => z.created_at.localeCompare(a.created_at)).slice(0, limit).map((r) => this.view(r)) }
  }
}
