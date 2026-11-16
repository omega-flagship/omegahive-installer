import type {
  ItemRevision,
  Polarity,
  ProgramAction,
  ProgramDescription,
  ProgramRole,
  Uncertainty,
  WorkGraph,
  WorkItem,
  WorkLink,
  WorkSource,
} from '../../api/types'

/**
 * The case file's reading of a WorkGraph. Pure: no React, no store, so every rule here is proved in node.
 *
 * Rules carried from the contract (hive/PROGRAMS.md) and OmegaTruth's own limitations:
 *  - polarity comes from describe().relations, never from guessing at relation names when describe gives them;
 *  - uncertainty is labelled by its method and never fused; missing means unassessed, which is not zero;
 *  - sources sharing an `origin` are not independent; on the balance they count once per origin group;
 *  - retracted and superseded items stay in the record (errata) but add no weight;
 *  - counts describe coverage, not quality or truth; an empty side is a search gap, not evidence.
 */

// ------------------------------------------------------------------ roles and polarity

const DEFAULT_POLARITY: Record<string, Polarity> = {
  supports: 'support',
  support: 'support',
  contradicts: 'oppose',
  opposes: 'oppose',
  oppose: 'oppose',
  qualifies: 'qualify',
  qualify: 'qualify',
}

export function polarityOf(rel: string, describe: ProgramDescription | null): Polarity {
  const r = describe?.relations.find((x) => x.id === rel)
  if (r) return r.polarity
  return DEFAULT_POLARITY[rel] ?? 'neutral'
}

export function roleOf(kind: string, describe: ProgramDescription | null): ProgramRole {
  const k = describe?.kinds.find((x) => x.id === kind)
  if (k) return k.role
  const known: ProgramRole[] = ['question', 'claim', 'evidence', 'hypothesis', 'assessment', 'explanation', 'gap', 'source']
  return (known as string[]).includes(kind) ? (kind as ProgramRole) : 'other'
}

export function kindLabel(kind: string, describe: ProgramDescription | null): string {
  return describe?.kinds.find((x) => x.id === kind)?.label ?? kind
}

// ------------------------------------------------------------------ uncertainty: labelled, never fused

export interface ULabel {
  /** False only when no uncertainty was given. Unassessed is not zero. */
  assessed: boolean
  method: 'nal' | 'pln' | 'qualitative' | 'other' | 'unassessed'
  /** The method's own name, as shown: NAL, PLN, Qualitative, or the program's method name. */
  methodName: string
  /** Each component with its own name. Two numbers stay two numbers. */
  parts: { key: string; name: string; value: string; n?: number }[]
  /** One line for screen readers and tooltips. */
  text: string
}

const fx = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n.toFixed(2) : String(v)
}
const nOf = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function labelU(u: Uncertainty | null | undefined): ULabel {
  if (!u || typeof u !== 'object' || !('method' in u))
    return { assessed: false, method: 'unassessed', methodName: 'Unassessed', parts: [], text: 'Unassessed: no uncertainty given (not zero)' }
  if (u.method === 'nal' && 'f' in u) {
    const parts = [
      { key: 'f', name: 'frequency', value: fx(u.f), n: nOf(u.f) },
      { key: 'c', name: 'confidence', value: fx(u.c), n: nOf(u.c) },
    ]
    return { assessed: true, method: 'nal', methodName: 'NAL', parts, text: `NAL truth value: frequency ${parts[0].value}, confidence ${parts[1].value}` }
  }
  if (u.method === 'pln' && 'strength' in u) {
    const parts = [
      { key: 's', name: 'strength', value: fx(u.strength), n: nOf(u.strength) },
      { key: 'c', name: 'confidence', value: fx(u.confidence), n: nOf(u.confidence) },
    ]
    return { assessed: true, method: 'pln', methodName: 'PLN', parts, text: `PLN truth value: strength ${parts[0].value}, confidence ${parts[1].value}` }
  }
  if (u.method === 'qualitative') {
    const status = String((u as { status?: unknown }).status ?? 'unstated')
    return { assessed: true, method: 'qualitative', methodName: 'Qualitative', parts: [{ key: 'status', name: 'status', value: status }], text: `Qualitative: ${status}` }
  }
  const label = (u as { label?: unknown }).label
  const shown = typeof label === 'string' && label ? label : 'unlabelled'
  return { assessed: true, method: 'other', methodName: String(u.method), parts: [{ key: 'label', name: 'label', value: shown }], text: `${shown} (method “${u.method}”, shown as given)` }
}

// ------------------------------------------------------------------ the balance

export type Side = 'for' | 'against' | 'qualify'

export interface Piece {
  item: WorkItem
  link: WorkLink
  side: Side
  /** link.weight, else item.weight, else 1; never negative. */
  weight: number
  /** Retracted and superseded pieces stay visible but add nothing. */
  counted: boolean
  /** Index of its origin group within its pan (pieces sharing a source origin share a group). */
  group: number
  /** The origins its sources declare. */
  origins: string[]
  exhibits: string[]
}

export interface Pan {
  pieces: Piece[]
  /** Counted pieces. */
  count: number
  /** Independent origin groups among counted pieces. */
  independent: number
  /** Sum over origin groups of the heaviest counted piece in each: shared origins count once. */
  weight: number
  /** Counted pieces with no uncertainty given. */
  unassessed: number
  /** Origins shared by two or more counted pieces on this side. */
  shared: string[]
}

export interface Balance {
  target: WorkItem
  pro: Pan
  con: Pan
  qualify: Piece[]
  /** -1 (all against) … +1 (all for). 0 when both sides are empty. */
  tilt: number
  /** Which side has nothing at all: a search gap, not evidence. */
  empty: 'both' | 'for' | 'against' | null
}

const NOT_COUNTED = new Set(['retracted', 'superseded'])

function pieceWeight(link: WorkLink, item: WorkItem) {
  const w = typeof link.weight === 'number' ? link.weight : typeof item.weight === 'number' ? item.weight : 1
  return Number.isFinite(w) ? Math.max(0, w) : 1
}

/** Union-find over shared origins: two pieces are dependent when any of their sources share an origin. */
function groupByOrigin(pieces: Piece[]) {
  const parent = pieces.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const firstWith = new Map<string, number>()
  pieces.forEach((p, i) => {
    for (const o of p.origins) {
      const j = firstWith.get(o)
      if (j === undefined) firstWith.set(o, i)
      else parent[find(i)] = find(j)
    }
  })
  const ids = new Map<number, number>()
  pieces.forEach((p, i) => {
    const r = find(i)
    if (!ids.has(r)) ids.set(r, ids.size)
    p.group = ids.get(r)!
  })
}

function pan(pieces: Piece[]): Pan {
  const counted = pieces.filter((p) => p.counted)
  groupByOrigin(counted)
  const heaviest = new Map<number, number>()
  for (const p of counted) heaviest.set(p.group, Math.max(heaviest.get(p.group) ?? 0, p.weight))
  const originUse = new Map<string, number>()
  for (const p of counted) for (const o of new Set(p.origins)) originUse.set(o, (originUse.get(o) ?? 0) + 1)
  for (const p of pieces) if (!p.counted) p.group = -1
  return {
    pieces,
    count: counted.length,
    independent: heaviest.size,
    weight: [...heaviest.values()].reduce((a, b) => a + b, 0),
    unassessed: counted.filter((p) => !p.item.uncertainty).length,
    shared: [...originUse.entries()].filter(([, n]) => n >= 2).map(([o]) => o),
  }
}

export function balanceFor(graph: WorkGraph, describe: ProgramDescription | null, targetId: string, exhibitsOf?: (item: WorkItem) => string[]): Balance | null {
  const items = new Map(graph.items.map((i) => [i.id, i]))
  const target = items.get(targetId)
  if (!target) return null
  const sides: Record<Side, Piece[]> = { for: [], against: [], qualify: [] }
  for (const link of graph.links) {
    if (link.to !== targetId) continue
    const pol = polarityOf(link.rel, describe)
    const side: Side | null = pol === 'support' ? 'for' : pol === 'oppose' ? 'against' : pol === 'qualify' ? 'qualify' : null
    const item = items.get(link.from)
    if (!side || !item) continue
    sides[side].push({
      item,
      link,
      side,
      weight: pieceWeight(link, item),
      counted: !NOT_COUNTED.has(String(item.status ?? 'current')),
      group: 0,
      origins: [...new Set((item.sources ?? []).map((s) => s.origin).filter((o): o is string => !!o))],
      exhibits: exhibitsOf ? exhibitsOf(item) : [],
    })
  }
  const pro = pan(sides.for)
  const con = pan(sides.against)
  const total = pro.weight + con.weight
  const tilt = total > 0 ? (pro.weight - con.weight) / total : 0
  const empty = !pro.count && !con.count ? 'both' : !pro.count ? 'for' : !con.count ? 'against' : null
  return { target, pro, con, qualify: sides.qualify, tilt, empty }
}

// ------------------------------------------------------------------ exhibits and custody

export type Custody = 'cited' | 'retrieved' | 'inspected' | 'unavailable'
export const CUSTODY_CHAIN: Custody[] = ['cited', 'retrieved', 'inspected']
export const CUSTODY_WORDS: Record<Custody, { label: string; why: string }> = {
  cited: { label: 'Cited', why: 'Referenced only: not retrieved, not read.' },
  retrieved: { label: 'Retrieved', why: 'Fetched and kept, not yet read at the locator.' },
  inspected: { label: 'Inspected', why: 'The located content was read.' },
  unavailable: { label: 'Unavailable', why: 'Could not be retrieved: the chain is broken here.' },
}

export function custodyOf(status: unknown): Custody {
  const s = String(status ?? 'cited')
  return s === 'retrieved' || s === 'inspected' || s === 'unavailable' ? s : 'cited'
}

/** Each link of the chain: reached, current, or broken (unavailable). */
export function custodySteps(status: unknown): { step: Custody; state: 'done' | 'current' | 'todo' | 'broken' }[] {
  const c = custodyOf(status)
  if (c === 'unavailable')
    return [
      { step: 'cited', state: 'done' },
      { step: 'unavailable', state: 'broken' },
    ]
  const at = CUSTODY_CHAIN.indexOf(c)
  return CUSTODY_CHAIN.map((step, i) => ({ step, state: i < at ? 'done' : i === at ? 'current' : 'todo' }))
}

export interface Exhibit {
  /** A, B, … Z, AA … in order of first citation. */
  mark: string
  key: string
  source: WorkSource
  custody: Custody
  citedBy: { id: string; side: Side | null }[]
  /** Other exhibits that share this one's origin. Non-empty means: not independent. */
  sameOrigin: string[]
}

const sourceKey = (s: WorkSource) => `${s.id}\u0000${s.origin ?? ''}\u0000${s.url ?? s.local_ref ?? ''}`

export function markFor(i: number): string {
  let s = ''
  let n = i
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

export function collectExhibits(graph: WorkGraph, describe: ProgramDescription | null): Exhibit[] {
  const sideOf = new Map<string, Side>()
  for (const l of graph.links) {
    const p = polarityOf(l.rel, describe)
    if (p === 'support' || p === 'oppose' || p === 'qualify') sideOf.set(l.from, p === 'support' ? 'for' : p === 'oppose' ? 'against' : 'qualify')
  }
  const byKey = new Map<string, Exhibit>()
  const add = (s: WorkSource, citer: string) => {
    const k = sourceKey(s)
    let ex = byKey.get(k)
    if (!ex) byKey.set(k, (ex = { mark: markFor(byKey.size), key: k, source: s, custody: custodyOf(s.status), citedBy: [], sameOrigin: [] }))
    if (!ex.citedBy.some((c) => c.id === citer)) ex.citedBy.push({ id: citer, side: sideOf.get(citer) ?? null })
  }
  for (const it of graph.items) {
    for (const s of it.sources ?? []) add(s, it.id)
    if (roleOf(it.kind, describe) === 'source' && !(it.sources ?? []).length) {
      const m = it.meta ?? {}
      add({ id: it.id, label: it.label, status: typeof m.status === 'string' ? m.status : undefined, origin: typeof m.origin === 'string' ? m.origin : undefined }, it.id)
    }
  }
  const list = [...byKey.values()]
  const byOrigin = new Map<string, Exhibit[]>()
  for (const e of list) if (e.source.origin) byOrigin.set(e.source.origin, [...(byOrigin.get(e.source.origin) ?? []), e])
  for (const group of byOrigin.values()) {
    const distinct = new Set(group.map((e) => e.source.id))
    if (distinct.size < 2) continue
    for (const e of group) e.sameOrigin = group.filter((o) => o !== e).map((o) => o.mark)
  }
  return list
}

export function exhibitsOfItem(exhibits: Exhibit[], item: WorkItem): string[] {
  return exhibits.filter((e) => e.citedBy.some((c) => c.id === item.id)).map((e) => e.mark)
}

// ------------------------------------------------------------------ errata

export type ErratumKind = 'corrected' | 'retracted' | 'superseded'

export interface Erratum {
  item: WorkItem
  kind: ErratumKind
  /** The wording before (the latest prior revision's label), when the program kept it. */
  was: string | null
  now: string
  note: string | null
  at: string | null
  revision: string | null
  history: ItemRevision[]
}

export function collectErrata(graph: WorkGraph): { errata: Erratum[]; affected: WorkItem[] } {
  const errata: Erratum[] = []
  for (const it of graph.items) {
    const st = String(it.status ?? 'current')
    if (st !== 'corrected' && st !== 'retracted' && st !== 'superseded') continue
    const history = it.revisions ?? []
    const last = history[history.length - 1]
    errata.push({ item: it, kind: st, was: last?.label ?? null, now: it.label, note: last?.note ?? null, at: last?.at ?? it.at ?? null, revision: last?.revision ?? null, history })
  }
  errata.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
  const affected = graph.items.filter((i) => (i.flags ?? []).includes('affected-by-correction'))
  return { errata, affected }
}

// ------------------------------------------------------------------ proposals: transport and review, never merged

export interface ProposalParts {
  goalId: string | null
  transport: string
  review: string
}

export const TRANSPORT_WORDS: Record<string, { label: string; why: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }> = {
  validated: { label: 'validated', why: 'The hive checked the binding and digest. This is delivery, not acceptance.', tone: 'ok' },
  stale: { label: 'stale', why: 'The case changed after the request was bound. Reconcile before relying on it.', tone: 'warn' },
  refused: { label: 'refused', why: 'The hive refused the result.', tone: 'bad' },
  expired: { label: 'expired', why: 'The deadline passed before a result arrived.', tone: 'muted' },
  cancelled: { label: 'cancelled', why: 'The request was cancelled.', tone: 'muted' },
}
export const REVIEW_WORDS: Record<string, { label: string; why: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }> = {
  pending: { label: 'pending', why: 'Not yet reviewed by the case. Not a finding.', tone: 'warn' },
  accepted: { label: 'accepted', why: 'The case reviewed and admitted it.', tone: 'ok' },
  rejected: { label: 'rejected', why: 'The case reviewed and declined it.', tone: 'bad' },
  superseded: { label: 'superseded', why: 'Replaced by a later proposal.', tone: 'muted' },
}

export function proposalOf(item: WorkItem): ProposalParts | null {
  const raw = (item as { proposal?: unknown }).proposal ?? item.meta?.proposal
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (p.transport === undefined && p.review === undefined) return null
  return {
    goalId: typeof p.goal_id === 'string' ? p.goal_id : null,
    transport: typeof p.transport === 'string' ? p.transport : 'unknown',
    review: typeof p.review === 'string' ? p.review : 'unknown',
  }
}

// ------------------------------------------------------------------ actions: where they belong, and which need a full-context confirm

export function actionsFor(describe: ProgramDescription | null, kind: string): ProgramAction[] {
  return (describe?.actions ?? []).filter((a) => !a.applies_to || a.applies_to.includes(kind))
}

/** Per role, the verbs a case file puts on the item itself; the rest sit behind "More". */
const PRIMARY: Partial<Record<ProgramRole, string[]>> = {
  question: ['ask-scientist', 'add-claim', 'add-hypothesis', 'add-gap'],
  claim: ['challenge', 'add-support', 'add-counterevidence', 'verify-claim'],
  hypothesis: ['challenge', 'add-support', 'add-counterevidence', 'compare'],
  evidence: ['inspect-source', 'correct'],
  source: ['inspect-source', 'review-source'],
  assessment: ['challenge', 'ask-challenger'],
  gap: ['investigate-gap'],
}

export function placeActions(describe: ProgramDescription | null, item: WorkItem): { primary: ProgramAction[]; more: ProgramAction[] } {
  const all = actionsFor(describe, item.kind)
  const order = PRIMARY[roleOf(item.kind, describe)] ?? []
  const primary = order.map((id) => all.find((a) => a.id === id)).filter((a): a is ProgramAction => !!a)
  return { primary, more: all.filter((a) => !primary.includes(a)) }
}

export type GateKind = 'spend' | 'dispatch' | 'egress' | 'durable'

export interface Gate {
  kind: GateKind
  /** Who or what acts. */
  who: string
  /** What it costs, or plainly that the program does not say. */
  cost: string
  /** The time budget, or plainly that none is stated. */
  deadline: string
  /** What leaves the case, if anything. */
  disclosure: string | null
}

const TRUTH_DEADLINE = 'Set by the app: 5 minutes by default, never more than 30. Past it the task fails and its shares are revoked.'
const NO_COST = 'Not reported by the program. An agent may spend provider credit.'
const SNAPSHOT = 'A scoped snapshot of the connected records is shown to the agent (revision-bound).'

const KNOWN_GATES: Record<string, Gate> = {
  'ask-scientist': { kind: 'dispatch', who: "The swarm's configured Scientist (an agent)", cost: NO_COST, deadline: TRUTH_DEADLINE, disclosure: SNAPSHOT },
  'verify-claim': { kind: 'dispatch', who: "The swarm's configured Scientist, for factual verification", cost: NO_COST, deadline: TRUTH_DEADLINE, disclosure: SNAPSHOT },
  'ask-challenger': { kind: 'dispatch', who: "The swarm's configured Challenger (an agent)", cost: NO_COST, deadline: TRUTH_DEADLINE, disclosure: SNAPSHOT },
  challenge: { kind: 'dispatch', who: 'A task posted to the swarm; an agent may take it', cost: NO_COST, deadline: TRUTH_DEADLINE, disclosure: SNAPSHOT },
  'investigate-gap': { kind: 'dispatch', who: 'A research task posted to the swarm; an agent may take it', cost: NO_COST, deadline: TRUTH_DEADLINE, disclosure: SNAPSHOT },
  'dispatch-bias-trial': { kind: 'spend', who: 'A preregistered bias trial, run by an agent', cost: 'About $1 per trial (Surface estimate; the program does not report it).', deadline: TRUTH_DEADLINE, disclosure: 'The frozen trial case is shown to the agent.' },
  'retrieve-source': { kind: 'egress', who: 'The hive, fetching the stored public HTTPS address', cost: 'No charge stated. The request leaves this machine.', deadline: 'Bounded by the program.', disclosure: 'The source address is requested from outside the hive.' },
  correct: { kind: 'durable', who: 'You, recording a permanent correction', cost: 'None.', deadline: 'Immediate.', disclosure: null },
}

/**
 * Whether an action needs the full-context confirm, and what it will say. Known ids first; for programs that
 * declare their own, a conservative reading of the id (anything that asks, dispatches, pays or trades).
 */
export function gateOf(actionId: string): Gate | null {
  const known = KNOWN_GATES[actionId]
  if (known) return known
  if (/(^|-)(spend|pay|buy|purchase|bid|trade|execute|order|fund)(-|$)/.test(actionId))
    return { kind: 'spend', who: 'Declared by the program', cost: 'Not reported by the program; this action may spend money.', deadline: 'Not stated.', disclosure: null }
  if (/^(ask|dispatch|delegate|hire|request|run)-/.test(actionId))
    return { kind: 'dispatch', who: 'An agent, as declared by the program', cost: NO_COST, deadline: 'Not stated by the program.', disclosure: 'The program decides what the agent is shown.' }
  return null
}

export const GATE_WORDS: Record<GateKind, string> = {
  spend: 'Spends money',
  dispatch: 'Dispatches an agent',
  egress: 'Reaches outside the hive',
  durable: 'Permanent change',
}

// ------------------------------------------------------------------ the whole case

export interface CaseModel {
  revision: string
  title: string
  question: WorkItem | null
  claims: WorkItem[]
  hypotheses: WorkItem[]
  explanations: WorkItem[]
  assessments: WorkItem[]
  gaps: WorkItem[]
  evidence: WorkItem[]
  /** Claims first, then hypotheses: everything that can sit on the balance. */
  weighable: WorkItem[]
  balances: Map<string, Balance>
  /** The claim to put on the balance first: the focus if weighable, else the claim with the most evidence. */
  primary: string | null
  exhibits: Exhibit[]
  errata: Erratum[]
  affected: WorkItem[]
  notes: string[]
}

export function buildCase(graph: WorkGraph, describe: ProgramDescription | null): CaseModel {
  const by = (role: ProgramRole) => graph.items.filter((i) => roleOf(i.kind, describe) === role)
  const questions = by('question')
  const question = questions.find((q) => q.id === graph.focus) ?? questions[0] ?? null
  const claims = by('claim')
  const hypotheses = by('hypothesis')
  const exhibits = collectExhibits(graph, describe)
  const marks = (it: WorkItem) => exhibitsOfItem(exhibits, it)
  const weighable = [...claims, ...hypotheses]
  const balances = new Map<string, Balance>()
  for (const w of weighable) {
    const b = balanceFor(graph, describe, w.id, marks)
    if (b) balances.set(w.id, b)
  }
  const evidenceCount = (id: string) => {
    const b = balances.get(id)
    return b ? b.pro.pieces.length + b.con.pieces.length + b.qualify.length : 0
  }
  const live = (i: WorkItem) => !NOT_COUNTED.has(String(i.status ?? 'current'))
  const focusW = weighable.find((w) => w.id === graph.focus)
  const best = [...claims].filter(live).sort((a, b) => evidenceCount(b.id) - evidenceCount(a.id))[0] ?? weighable[0]
  const { errata, affected } = collectErrata(graph)
  return {
    revision: graph.revision,
    title: graph.title ?? question?.label ?? 'Case file',
    question,
    claims,
    hypotheses,
    explanations: by('explanation'),
    assessments: by('assessment'),
    gaps: by('gap'),
    evidence: by('evidence'),
    weighable,
    balances,
    primary: (focusW ?? best)?.id ?? null,
    exhibits,
    errata,
    affected,
    notes: graph.notes ?? [],
  }
}

/** Tilt in degrees for a beam, capped so a lopsided case still reads as a balance. */
export const tiltDeg = (tilt: number, max = 14) => -Math.max(-1, Math.min(1, tilt)) * max

export const COVERAGE_CAVEAT = 'Counts and weights describe coverage, not quality or truth. Sources sharing an origin count once. An empty side is a search gap, not evidence.'

/** "no pieces", "1 piece", "3 pieces". */
export const plural = (k: number, one: string, many: string) => `${k === 0 ? 'no' : k} ${k === 1 ? one : many}`

/** The balance in one plain sentence, for the brief. */
export function leanSentence(b: Balance): string {
  const side = (p: Pan) => `${plural(p.count, 'piece', 'pieces')} from ${plural(p.independent, 'independent origin', 'independent origins')}`
  if (b.empty === 'both') return 'Nothing has yet been placed on either side. The balance is empty, which says nothing about the claim.'
  const lean = Math.abs(b.tilt) < 0.08 ? 'stands level' : b.tilt > 0 ? 'leans for the claim' : 'leans against it'
  const gap = b.empty === 'against' ? ' Nothing against has been recorded; that is a gap in the search, not support.' : b.empty === 'for' ? ' Nothing for has been recorded; that is a gap in the search, not refutation.' : ''
  return `On the present record the balance ${lean}: ${side(b.pro)} for, ${side(b.con)} against.${gap}`
}
