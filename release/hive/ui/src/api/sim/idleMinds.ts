/**
 * SIM ONLY: Health's idle minds (Platform idle-minds r2 shapes), for demo mode. Everything here is INVENTED: the
 * questions, answers, spend and the one personal mind ("Pip", the sim's Tomás Reyes's, seen only by an admin audit).
 * No real person, no network.
 *
 * What it plays:
 * - Coral: a costly idle mind (model calls with no input), noticed, not asked yet;
 * - Anvil: asked about a held task, and answered (the answer is shown as said, not as agreement);
 * - Vega: asked about an unanswered message, no answer yet;
 * - Nori: silent (awake, no input and no output), noticed;
 * - Pip: another person's personal mind, only with ?include=personal (audit, read-only), never remindable here:
 *   may_remind and may_sleep false, is_mine false;
 * - Mira: plays the viewer's OWN personal mind (is_mine true, may_remind and may_sleep true).
 * Who may act is the host's answer (Platform r2.4): may_remind / may_sleep / is_mine on every row and on every agent
 * view (simHostFlags). The UI reads only those flags.
 * Remind: 409 not_awake for a mind that is not awake, 403 personal_mind for another person's personal mind, and two
 * Reminds within 60 s are one question.
 */
import { ApiError } from '../client'
import type { IdleDetail, IdleKind, IdleMind, IdleOverview, IdleRecord, IdleStatus, Owed } from '../idleMinds'
import { REMIND_ONCE_MS } from '../idleMinds'

export interface SimIdleAgent {
  name: string
  swarm_id: string | null
  status: string
  owner?: string | null
  visibility?: string
  shared_with?: string[]
}

export interface SimIdleHost {
  agent(id: string): SimIdleAgent | undefined
  me(): { principal: string; admin: boolean }
  now(): number
}

const H = 3_600_000
const M = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const WINDOW = { notice_after_s: 3600, ask_quiet_s: 21600, counts_over_s: 86400 }
const PIP = 'a_pip_tomas'
const VIEWER = 'viewer'
/** The sim host's personal minds (INVENTED): whose each one is. 'viewer' is whoever is signed in. */
const PERSONAL: Record<string, string> = { [PIP]: 'user:p_tomas', a_mira04: VIEWER }
const personOf = (id: string, me: string): string | null => {
  const p = PERSONAL[id]
  return p === VIEWER ? me : p ?? null
}

/**
 * The sim host's answer to "may this viewer Remind / Sleep this mind" (Platform r2.4): a personal mind's person only;
 * any other mind, an admin or its owner. Not about awake: the UI checks that apart.
 */
export function simHostFlags(a: { id: string; owner?: string | null; visibility?: string; shared_with?: string[] }, me: { principal: string; admin: boolean }): { may_remind: boolean; may_sleep: boolean; is_mine: boolean } {
  const person = personOf(a.id, me.principal)
  const mine = person !== null && person === me.principal
  // r1.3 (Kimi #4): as the host, only a mind this viewer sees (app.py viewer(session).sees(row))
  const sees = me.admin || a.owner === me.principal || a.visibility !== 'private' || !!a.shared_with?.includes(me.principal)
  const may = person !== null ? mine : sees && (me.admin || (!!a.owner && a.owner === me.principal))
  return { may_remind: may, may_sleep: may, is_mine: mine }
}

interface Seed {
  id: string
  calls: number
  spend: number
  inputAgo: number
  kind: IdleKind | null
  owed: (now: number) => Owed[]
  history: (now: number) => IdleRecord[]
}

const rec = (over: Partial<IdleRecord> & Pick<IdleRecord, 'question_id' | 'kind' | 'question' | 'question_at' | 'status'>): IdleRecord => ({
  owed: [],
  observed_at: over.question_at,
  last_noticed_at: over.question_at,
  last_input_at: null,
  idle_calls_24h: 0,
  idle_spend_24h: 0,
  question_by: 'hive:health',
  reply: null,
  reply_at: null,
  closed_at: null,
  ...over,
})

const SEEDS: Seed[] = [
  { id: 'a_coral5', calls: 148, spend: 3.8612, inputAgo: 9 * H, kind: 'idle', owed: () => [], history: () => [] },
  {
    id: 'a_anvl09',
    calls: 6,
    spend: 0.1874,
    inputAgo: 3 * H,
    kind: 'owed',
    owed: (now) => [{ type: 'goal', goal_id: 'g_sim_runbook', title: 'Rewrite the on-call runbook', goal_status: 'claimed', since: iso(now - 4 * H) }],
    history: (now) => [
      rec({ question_id: 'hq_sim_anvil2', kind: 'owed', question: 'You hold the task "Rewrite the on-call runbook" (g_sim_runbook) since an invented time: finish, hand off or release it?', question_at: iso(now - 40 * M), status: 'replied', reply: 'Waiting on Bellows for the budget section; I will finish the rest today.', reply_at: iso(now - 31 * M), idle_calls_24h: 6, idle_spend_24h: 0.1874 }),
      rec({ question_id: 'hq_sim_anvil1', kind: 'idle', question: 'You’ve spent $0.42 over 3 hours with no input: sleep, or tell me what you’re waiting for?', question_at: iso(now - 30 * H), status: 'resolved', closed_at: iso(now - 29 * H), idle_calls_24h: 11, idle_spend_24h: 0.42 }),
    ],
  },
  {
    id: 'a_vega01',
    calls: 2,
    spend: 0.0391,
    inputAgo: 5 * H,
    kind: 'owed',
    owed: (now) => [{ type: 'message', message_id: 'm_sim_vega1', conversation_id: 'c_a_vega01~user:p_ada', from: 'user:p_ada', from_name: 'Ada Brightwater', since: iso(now - 5 * H) }],
    history: (now) => [rec({ question_id: 'hq_sim_vega1', kind: 'owed', question: 'Ada Brightwater wrote to you at an invented time and has no reply yet: answer, or say what you are waiting for?', question_at: iso(now - 70 * M), status: 'asked', idle_calls_24h: 2, idle_spend_24h: 0.0391 })],
  },
  { id: 'a_nori06', calls: 0, spend: 0, inputAgo: 7 * H, kind: 'silent', owed: () => [], history: () => [] },
  { id: 'a_mira04', calls: 0, spend: 0, inputAgo: 20 * M, kind: null, owed: () => [], history: () => [] },
]

export class SimIdleMinds {
  private history = new Map<string, IdleRecord[]>()
  private lastRemind = new Map<string, number>()

  constructor(private host: SimIdleHost) {
    const now = host.now()
    for (const s of SEEDS) this.history.set(s.id, s.history(now))
    this.history.set(PIP, [rec({ question_id: 'hq_sim_pip1', kind: 'silent', question: 'You’ve been awake 2 hours with no input and no output: sleep, or tell me what you’re waiting for?', question_at: iso(now - 50 * M), status: 'asked' })])
  }

  private pip(): SimIdleAgent {
    return { name: 'Pip', swarm_id: null, status: 'awake' }
  }

  private agentOf(id: string): SimIdleAgent | undefined {
    return id === PIP ? this.pip() : this.host.agent(id)
  }

  /** Readers: an admin or the owner; another person's personal mind only under audit. */
  private visible(id: string, a: SimIdleAgent, auditing: boolean): boolean {
    const me = this.host.me()
    const person = personOf(id, me.principal)
    if (person) return person === me.principal || (me.admin && auditing)
    return me.admin || a.owner === me.principal
  }

  private view(id: string): IdleMind | null {
    const a = this.agentOf(id)
    if (!a) return null
    const now = this.host.now()
    const seed = SEEDS.find((s) => s.id === id)
    const awake = a.status === 'awake'
    const hist = this.history.get(id) ?? []
    const latest = hist[0]
    const kind: IdleKind | null = awake ? (id === PIP ? 'silent' : seed?.kind ?? null) : null
    const open = latest && latest.status === 'asked'
    const status: IdleStatus = open ? 'asked' : kind ? 'noticed' : latest ? latest.status : 'quiet'
    const flags = simHostFlags({ id, owner: a.owner, visibility: a.visibility, shared_with: a.shared_with }, this.host.me())
    return {
      id,
      name: a.name,
      swarm_id: a.swarm_id,
      mind_status: a.status,
      personal: personOf(id, this.host.me().principal) !== null,
      idle_calls_24h: seed?.calls ?? 0,
      idle_spend_24h: seed?.spend ?? 0,
      last_input_at: iso(now - (seed?.inputAgo ?? 2 * H)),
      noticed: !!kind,
      kind,
      owed: awake && seed ? seed.owed(now) : [],
      question_id: latest?.question_id ?? null,
      question: latest?.question ?? null,
      question_at: latest?.question_at ?? null,
      question_by: latest?.question_by ?? null,
      reply: latest?.reply ?? null,
      reply_at: latest?.reply_at ?? null,
      status,
      actions: { remind: awake, sleep: awake },
      // the host's answer for this viewer; a row Health can act on only while awake
      may_remind: flags.may_remind && awake,
      // r2.4 (app.py): may_sleep is permission only; Sleep on a sleeping mind is a no-op, so it stays true
      may_sleep: flags.may_sleep,
      is_mine: flags.is_mine,
    }
  }

  list(opts: { includePersonal?: boolean } = {}): IdleOverview {
    const auditing = !!opts.includePersonal && this.host.me().admin
    const ids = [...SEEDS.map((s) => s.id), PIP]
    const rank: Record<string, number> = { asked: 0, noticed: 1 }
    const minds = ids
      .filter((id) => {
        const a = this.agentOf(id)
        if (!a || !this.visible(id, a, auditing)) return false
        return a.status === 'awake' || (this.history.get(id) ?? []).length > 0
      })
      .map((id) => this.view(id)!)
      .sort((x, y) => (rank[x.status] ?? 2) - (rank[y.status] ?? 2) || y.idle_spend_24h - x.idle_spend_24h)
    return { minds, generated_at: iso(this.host.now()), window: { ...WINDOW }, read_at: Date.now() }
  }

  detail(id: string, opts: { includePersonal?: boolean } = {}): IdleDetail {
    const a = this.agentOf(id)
    const auditing = !!opts.includePersonal && this.host.me().admin
    if (!a || !this.visible(id, a, auditing)) throw new ApiError(404, 'not_found', `No mind ${id}`)
    return { ...this.view(id)!, history: (this.history.get(id) ?? []).slice(0, 20).map((r) => ({ ...r })) }
  }

  remind(id: string): IdleDetail {
    const a = this.agentOf(id)
    const me = this.host.me()
    if (!a) throw new ApiError(404, 'not_found', `No mind ${id}`)
    const person = personOf(id, me.principal)
    if (person && person !== me.principal) {
      // an admin may audit it, but Remind is the person's own
      if (me.admin) throw new ApiError(403, 'personal_mind', 'a personal mind is reminded by its person only')
      throw new ApiError(404, 'not_found', `No mind ${id}`)
    }
    if (!this.visible(id, a, false)) throw new ApiError(404, 'not_found', `No mind ${id}`)
    if (a.status !== 'awake') throw new ApiError(409, 'not_awake', `${a.name} is not awake`)
    const now = this.host.now()
    const last = this.lastRemind.get(id)
    if (last === undefined || now - last >= REMIND_ONCE_MS) {
      this.lastRemind.set(id, now)
      const hist = this.history.get(id) ?? []
      if (hist[0]?.status === 'asked') hist[0] = { ...hist[0], status: 'superseded', closed_at: iso(now) }
      const seed = SEEDS.find((s) => s.id === id)
      const qid = `hq_sim_${id.slice(-4)}${hist.length + 1}`
      const owed = seed?.owed(now)[0]
      const text = owed?.type === 'goal'
        ? `You hold the task "${owed.title}" (${owed.goal_id}) since an invented time: finish, hand off or release it?`
        : owed?.type === 'message'
          ? `${owed.from_name} wrote to you at an invented time and has no reply yet: answer, or say what you are waiting for?`
          : seed && seed.calls > 0
            ? `You’ve spent $${seed.spend.toFixed(2)} over the last hours with no input: sleep, or tell me what you’re waiting for?`
            : 'You’ve been awake for hours with no input and no output: sleep, or tell me what you’re waiting for?'
      hist.unshift(rec({ question_id: qid, kind: seed?.kind ?? 'idle', owed: seed?.owed(now) ?? [], question: text, question_at: iso(now), question_by: me.principal, status: 'asked', idle_calls_24h: seed?.calls ?? 0, idle_spend_24h: seed?.spend ?? 0 }))
      this.history.set(id, hist.slice(0, 20))
    }
    return this.detail(id)
  }
}
