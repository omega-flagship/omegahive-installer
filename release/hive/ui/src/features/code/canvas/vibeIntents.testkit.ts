/**
 * Test kit (vitest only; never imported by the app). A HiveClient over the simulator's invented code service and its
 * mirror of the Ask's linkage intents (api/sim/intents.ts), with every route call logged as METHOD path, so a test can
 * read back exactly which routes the vibe request used. Invented data only; no hive.
 */
import { ApiError, type CodeContext, type HiveClient } from '../../../api/client'
import type { CodeTeamOffer } from '../../../api/askIntents'
import type { SimCodeService } from '../../../api/sim/codeService'
import { SIM_CODE_TEAM, SimIntents } from '../../../api/sim/intents'

export interface KitOptions {
  ctx: CodeContext
  /** hold each invented child's proposal until its gate is opened (in the order asked) */
  gated?: boolean
  /** null: the client has no Code team offer (as the live client today) */
  offer?: CodeTeamOffer | null
  /** false: the client has no intents routes at all; '404': the hive answers them 404 (an older host) */
  intents?: boolean | '404'
  /** every Ask turn is this one operation (as when the conductor already holds an intent on it) */
  fixedTurn?: string
  /** 'refused': the service refuses the workspace journal (a path-scoped grant: 403 event_scope) */
  journal?: 'refused'
  /** false: the hive's HIVE_MIND_SPAWN is off (submit admits; no child ever starts) */
  spawn?: boolean
  /** true: the client reads the team's children (GET /api/teams/{swarm}/children) */
  children?: boolean
  /** the request row's state and result as GET /api/requests shows it (absent: the request is not listed) */
  request?: { state: string; result: unknown }
  /** false: a host without the copy-apply consent gate (the controller puts a proposal in by itself) */
  consentGate?: boolean
  /** the invented controller's pause before it puts a proposal in (copy-apply on), ms */
  applyDelayMs?: number
  /** false: the application record has no consent evidence (today's host) */
  evidence?: boolean
  /** true: the client sends the person's consent (POST /api/requests/{rq}/proposals/{id}/accept|decline) */
  consent?: boolean
}

export function intentsKit(svc: SimCodeService, o: KitOptions) {
  const log: string[] = []
  /** the exact words each Ask turn carried */
  const words: string[] = []
  const gates: { p: Promise<void>; open: () => void }[] = []
  const turns = new Map<string, { turnId: string; createdAt: string }>()
  let n = 0
  const host = new SimIntents({
    principal: () => 'user:you',
    admin: () => true,
    turn: (op) => turns.get(op) ?? null,
    code: (task) => (task === o.ctx.task_id ? svc : undefined),
    later: (_ms, fn) => fn(),
    spawn: () => o.spawn !== false,
    consentGate: () => o.consentGate !== false,
    evidence: () => o.evidence !== false,
    applyDelayMs: o.applyDelayMs,
    consentPollMs: 5,
    mindGate: o.gated
      ? () => {
          let open!: () => void
          const p = new Promise<void>((r) => (open = r))
          gates.push({ p, open })
          return p
        }
      : undefined,
  })
  const strip = (q: Record<string, string>) => Object.fromEntries(Object.entries(q).filter(([k]) => !['task_id', 'grant_id', 'repository_id'].includes(k)))
  const notFound = () => Promise.reject(new ApiError(404, 'http_404', 'Not Found'))
  const client: Partial<HiveClient> = {
    codeProxy: <T,>(m: 'GET' | 'POST', path: string, q: Record<string, string>, body?: unknown) => {
      log.push(`${m} /api/code/proxy${path}`)
      if (o.journal === 'refused' && path === '/v1/events') return Promise.reject(new ApiError(403, 'event_scope', 'workspace journal requires unrestricted file scope', { source: 'omegacode', upstreamStatus: 403 }))
      return svc.proxy(m, path, strip(q), body ?? null) as Promise<T>
    },
    codeSuggestionScope: (_c, w, body) => (log.push(`POST /api/code/proxy/v1/workspaces/${w}/suggestion-scopes`), svc.proxy('POST', `/v1/workspaces/${w}/suggestion-scopes`, {}, body)),
    codeSuggestionHistory: (_c, w, page = {}) => (log.push(`GET /api/code/proxy/v1/workspaces/${w}/suggestions`), svc.proxy('GET', `/v1/workspaces/${w}/suggestions`, { limit: String(page.limit ?? 20), ...(page.cursor ? { cursor: page.cursor } : {}) }, null)),
    codeSuggestionRead: (_c, w, id) => (log.push(`GET /api/code/proxy/v1/workspaces/${w}/suggestions/${id}`), svc.proxy('GET', `/v1/workspaces/${w}/suggestions/${id}`, {}, null)),
    codeSuggestionDecide: (_c, w, body) => (log.push(`POST /api/code/proxy/v1/workspaces/${w}/suggestion-decisions`), svc.proxy('POST', `/v1/workspaces/${w}/suggestion-decisions`, {}, body)),
  }
  if (o.intents !== false) {
    const no = o.intents === '404'
    Object.assign(client, {
      askRecordIntent: async (op: string, body: unknown) => (log.push(`POST /api/ask/${op}/intents`), no ? notFound() : host.record(op, body as Record<string, unknown>).view),
      askSubmitIntent: async (id: string) => (log.push(`POST /api/ask/intents/${id}/submit`), no ? notFound() : host.submit(id)),
      askIntent: async (id: string) => (log.push(`GET /api/ask/intents/${id}`), no ? notFound() : host.get(id)),
      askIntents: async (q?: { state?: string; limit?: number }) => (log.push('GET /api/ask/intents'), no ? notFound() : host.list(q)),
    })
  }
  if (o.consent)
    client.proposalConsent = async (rq: string, id: string, decision: 'accept' | 'decline', digest: string) => (log.push(`POST /api/requests/${rq}/proposals/${id}/${decision}`), host.consent('user:you', rq, id, decision, { suggestion_digest: digest }))
  if (o.children) client.teamChildren = async (swarm: string) => (log.push(`GET /api/teams/${swarm}/children`), host.children(swarm))
  if (o.request) {
    const r = o.request
    client.listRequests = async () => {
      log.push('GET /api/requests')
      const ids = host.list({}).intents.map((v) => (v as { request_id: string | null }).request_id).filter(Boolean) as string[]
      return ids.map((id) => ({ id, kind: 'code', title: 't', from_swarm: '', from_goal: null, from_principal: 'user:you', to_swarm: SIM_CODE_TEAM.to_swarm, receiving_goal: null, state: r.state as never, depth: 0, created_at: '', cancelled_at: null, budget: { root: id, limit_usd: 0.5, allocated_usd: 0 }, result: r.result }))
    }
  }
  if (o.offer !== null) client.codeTeamOffer = async () => structuredClone(o.offer ?? SIM_CODE_TEAM)
  /** the Ask turn the words travel on (the universal Ask's POST /api/ask) */
  const turn = async (w: string) => {
    const op = o.fixedTurn ?? `ask-kit-${++n}`
    log.push('POST /api/ask')
    words.push(w)
    turns.set(op, { turnId: `turn_kit${n}`, createdAt: new Date().toISOString() })
    return op
  }
  return { client: client as HiveClient, turn, log, gates, host, words }
}

/** Wait until `ok()` (polling real time), or fail after `ms`. */
export async function until(ok: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}
