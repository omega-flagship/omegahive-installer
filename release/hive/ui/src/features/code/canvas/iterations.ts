/**
 * Iterations as a quiet history of checkpoints (Surface, Code canvas phase 2; gap inventory row 27), over OmegaCode's
 *   POST /v1/workspaces/{ws}/iterations          checkpoint + read: retain one observation of an attempt
 *   GET  /v1/workspaces/{ws}/iterations/{id}     read: one observation, with its currency
 *   GET  /v1/events?workspace_id=…               events: the journal, where each retained one is announced
 * (iterations.py retain/read; relay d5f608a code.py 70, 82–83). An observation is a RECORD: what was run, the
 * recorded evidence, the limits and what the person reports. It schedules nothing, runs nothing and is not a trusted
 * usage receipt; the service's outcome only recommends (stop / pause / continue) and grants no authority.
 */

export interface IterationForm {
  command: string[]
  evidence: string[]
  attempts: number
}
export interface IterationItem {
  id: string
  created_at: number
  author: string
}
export interface IterationView {
  id: string
  created_at: number
  author: string
  commands: string[][]
  verification_ids: string[]
  limits: { max_attempts: number; max_seconds: number; max_cost: number }
  reported: { attempts: number; elapsed_seconds: number | null; observed_cost: number | null; host_admitted: boolean; cancelled: boolean }
  outcome: { state: string; reason: string }
  generation: number
  currency: 'current' | 'historical'
}

/** The default bounds a person's record carries (the service requires finite limits; they bound nothing here). */
export const DEFAULT_LIMITS = { max_attempts: 5, max_seconds: 1800, max_cost: 1 }

/**
 * The closed request. Usage is reported as unknown and host admission as false: a person cannot observe those, and the
 * record says so rather than inventing numbers.
 */
export function iterationRequest(f: IterationForm, ws: { generation: number; tree_digest: string }, operationId: string) {
  return {
    operation_id: operationId,
    expected_generation: ws.generation,
    expected_tree_digest: ws.tree_digest,
    commands: [f.command],
    verification_ids: f.evidence,
    limits: { ...DEFAULT_LIMITS },
    observations: { attempts: f.attempts, elapsed_seconds: null, observed_cost: null, host_admitted: false, cancelled: false },
  }
}

const WORDS: Record<string, string> = {
  'paused:host_admission_unavailable': 'Paused: the hive has not admitted an automatic loop for this work, so this is a record, not a run.',
  'paused:usage_unknown': 'Paused: time or cost used is not known.',
  'paused:foreign_receipt': 'Paused: some evidence belongs to other work.',
  'stopped:cancelled': 'Stopped: cancelled.',
  'stopped:attempt_limit': 'Stopped: the attempt limit was reached.',
  'stopped:time_or_cost_limit': 'Stopped: the time or cost limit was reached.',
}
export function outcomeWords(o: { state: string; reason: string }): string {
  return WORDS[`${o.state}:${o.reason}`] ?? `${o.state}: ${o.reason.replace(/_/g, ' ')}`
}

const str = (v: unknown, max = 200): v is string => typeof v === 'string' && !!v && v.length <= max
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The retained iterations announced in the journal, newest first. */
export function parseIterationEvents(raw: unknown): IterationItem[] {
  const events = raw && typeof raw === 'object' ? (raw as { events?: unknown }).events : undefined
  if (!Array.isArray(events)) throw new Error('The journal answer was not understood.')
  const out: IterationItem[] = []
  for (const e of events) {
    if (!e || typeof e !== 'object' || (e as { kind?: unknown }).kind !== 'iteration.observation') continue
    const b = (e as { body?: Record<string, unknown> }).body
    if (!b || !str(b.id, 160) || !num(b.created_at) || !str(b.author)) throw new Error('An iteration in the journal was not understood.')
    out.push({ id: b.id, created_at: b.created_at, author: b.author })
  }
  return out.sort((a, z) => z.created_at - a.created_at)
}

/** One retained observation, strictly. */
export function parseIteration(raw: unknown): IterationView {
  const bad = (): never => {
    throw new Error('The iteration was not understood.')
  }
  const r = (raw ?? {}) as { record?: Record<string, unknown>; content?: Record<string, unknown>; currency?: unknown }
  const rec = r.record
  const c = r.content
  if (!rec || !c || !str(rec.id, 160) || !num(rec.created_at) || !str(rec.author)) return bad()
  if (c.schema !== 'omegacode-iteration-observation-v1' || !Array.isArray(c.commands) || !Array.isArray(c.verification_ids) || !num(c.generation)) return bad()
  const o = c.outcome as Record<string, unknown> | undefined
  if (!o || !str(o.state, 60) || !str(o.reason, 120)) return bad()
  if (r.currency !== 'current' && r.currency !== 'historical') return bad()
  const lim = (c.limits ?? {}) as IterationView['limits']
  const rep = (c.reported_observations ?? {}) as IterationView['reported']
  return {
    id: rec.id,
    created_at: rec.created_at,
    author: rec.author,
    commands: (c.commands as unknown[]).map((a) => (Array.isArray(a) && a.every((x) => typeof x === 'string') ? (a as string[]) : bad())),
    verification_ids: (c.verification_ids as unknown[]).map((v) => (str(v, 160) ? v : bad())),
    limits: lim,
    reported: rep,
    outcome: { state: o.state, reason: o.reason },
    generation: c.generation,
    currency: r.currency,
  }
}

type Call = <T>(method: 'GET' | 'POST', p: string, body?: unknown, query?: Record<string, string>) => Promise<T>

/** The journal page the service returns at most (store.events default limit). */
export const JOURNAL_PAGE = 200
/** At most this many pages are read for one list (200 000 events); beyond it the list says it is partial. */
export const JOURNAL_PAGES = 1000

/**
 * Every retained iteration for a workspace: the whole journal is paged by its sequence cursor (`after` = the last seq
 * read) until a short page; records are deduplicated by id; newest first.
 */
export async function readAllIterations(call: Call, workspace: string): Promise<{ items: IterationItem[]; partial: boolean }> {
  const seen = new Map<string, IterationItem>()
  let after = 0
  for (let page = 0; page < JOURNAL_PAGES; page++) {
    const raw = await call<unknown>('GET', '/v1/events', undefined, { workspace_id: workspace, after: String(after) })
    const events = raw && typeof raw === 'object' ? (raw as { events?: unknown }).events : undefined
    if (!Array.isArray(events)) throw new Error('The journal answer was not understood.')
    for (const it of parseIterationEvents(raw)) if (!seen.has(it.id)) seen.set(it.id, it)
    const seqs = events.map((e) => (e && typeof e === 'object' ? (e as { seq?: unknown }).seq : undefined)).filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
    const last = seqs.length ? Math.max(...seqs) : after
    if (events.length < JOURNAL_PAGE || last <= after) return { items: [...seen.values()].sort((a, z) => z.created_at - a.created_at), partial: false }
    after = last
  }
  return { items: [...seen.values()].sort((a, z) => z.created_at - a.created_at), partial: true }
}

/**
 * The drawer's iteration list and the one opened, for one context at a time (the workbench's call and workspace).
 * A changed context clears both at once; late answers for an earlier context or an earlier request are dropped.
 */
export class IterationsReader {
  state: { ctx: string; items: IterationItem[] | null; partial: boolean; open: IterationView | null; error: string | null } = { ctx: '', items: null, partial: false, open: null, error: null }
  private seq = 0
  private openSeq = 0
  private subs = new Set<() => void>()
  subscribe = (fn: () => void) => {
    this.subs.add(fn)
    return () => {
      this.subs.delete(fn)
    }
  }
  getState = () => this.state
  private set(p: Partial<IterationsReader['state']>) {
    this.state = { ...this.state, ...p }
    this.subs.forEach((f) => f())
  }
  /** Switch to a context: everything from another one is cleared synchronously. */
  setContext(ctx: string) {
    if (ctx === this.state.ctx) return
    this.seq++
    this.openSeq++
    this.set({ ctx, items: null, partial: false, open: null, error: null })
  }
  async load(ctx: string, call: Call, workspace: string) {
    if (ctx !== this.state.ctx) return
    const mine = ++this.seq
    try {
      const r = await readAllIterations(call, workspace)
      if (mine === this.seq && ctx === this.state.ctx) this.set({ items: r.items, partial: r.partial, error: null })
    } catch (e) {
      if (mine === this.seq && ctx === this.state.ctx) this.set({ items: [], error: e instanceof Error ? e.message : String(e) })
    }
  }
  async open(ctx: string, call: Call, workspace: string, id: string) {
    if (ctx !== this.state.ctx) return
    const mine = ++this.openSeq
    try {
      const v = parseIteration(await call<unknown>('GET', `/v1/workspaces/${workspace}/iterations/${id}`))
      if (mine === this.openSeq && ctx === this.state.ctx && v.id === id) this.set({ open: v })
    } catch (e) {
      if (mine === this.openSeq && ctx === this.state.ctx) this.set({ error: e instanceof Error ? e.message : String(e) })
    }
  }
  show(ctx: string, v: IterationView | null) {
    if (ctx === this.state.ctx) {
      this.openSeq++
      this.set({ open: v })
    }
  }
}
