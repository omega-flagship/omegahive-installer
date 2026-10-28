import { ApiError } from '../client'
import type {
  ActionResult,
  Agent,
  Belief,
  BeliefDetail,
  Goal,
  Program,
  ProgramDescription,
  ProgramDetail,
  ProgramStage,
  Swarm,
  Uncertainty,
  WorkGraph,
  WorkItem,
  WorkLink,
  WorkSource,
} from '../types'
import { omegaDesign } from './omegadesign' // Surface: the Design living canvas's data (sim only)
import { omegaTools } from './omegaTools' // Surface: guided demos' stand-in for the tools catalogue (invented, sim only)
import { omegaToolsWithInventedReasoning } from './reasoningFixture' // Surface: invented reasoning-module reads (sim only, opt-in)

/**
 * Hive programs in the simulator: hive/core/programs.py (discovery, capability-limited context, graph and
 * result validation) with faithful TypeScript ports of the two built-in programs:
 * - hive/plugins/contract_fixture/program.py ("contract-fixture"), the public synthetic question;
 * - hive/plugins/commons_explorer/program.py ("commons-explorer"), over the sim's own NAL commons.
 */

const CONTRACT = '0.1'
const STAGES: ProgramStage[] = ['unfold', 'map', 'compare', 'detail']
const ROLES = new Set(['question', 'claim', 'evidence', 'hypothesis', 'assessment', 'explanation', 'gap', 'source', 'other'])
const POLARITIES = new Set(['support', 'oppose', 'qualify', 'neutral'])
const ITEM_STATUSES = new Set(['current', 'corrected', 'superseded', 'retracted'])
const SOURCE_STATUSES = new Set(['retrieved', 'inspected', 'cited', 'unavailable'])
const RESULT_STATUSES = new Set(['done', 'started', 'needs_input', 'stale', 'refused', 'error'])
const MAX_ITEMS = 400
const MAX_LINKS = 1200
const READ_ID = /^[\w.-]{1,64}$/
/** G1: a read result is at most 4 MB serialised (413 read_too_large). */
const MAX_READ = 4 * 1024 * 1024
/** G2: a file with an action is at most 20 MB, and at most the action's declared max_bytes. */
const MAX_FILE = 20 * 1024 * 1024

type Json = Record<string, unknown>

/** What a program may touch, limited to its declared capabilities and one swarm (ProgramContext). */
export interface ProgramCtx {
  swarm_id: string
  swarm: Swarm
  beliefs(): Belief[]
  belief(statement: string): BeliefDetail | null
  agents(): Pick<Agent, 'id' | 'name' | 'kind' | 'hue'>[]
  create_goal(title: string, detail?: string): Promise<Goal>
  /** Candidate (G2): the person's file for this one action ({name, mime, size, sha256, bytes}); never stored. */
  file?: SimFile | null
}
export interface SimFile {
  name: string
  mime: string
  size: number
  sha256: string
  bytes: Uint8Array
}

export interface HostServices {
  swarm(id: string): Swarm
  beliefs(swarmId: string): Belief[]
  belief(swarmId: string, statement: string): BeliefDetail | null
  agents(): Agent[]
  createGoal(swarmId: string, title: string, detail: string, createdBy: string): Promise<Goal>
  emit(program: Program): void
}

export interface SimProgram {
  manifest: { id: string; name: string; version: string; description: string; icon: string; capabilities: string[] }
  describe(): ProgramDescription
  view(ctx: ProgramCtx, focus: string | null, stage: ProgramStage): WorkGraph | Json
  act(ctx: ProgramCtx, action: string, items: string[], params: Json): Promise<Json> | Json
  /** Candidate (G1): a declared read; JSON out, never persisted. */
  read?(ctx: ProgramCtx, query: string, params: Json): Json | unknown[] | string | number | boolean | null
}

const clone = <T,>(v: T): T => structuredClone(v)

// ================================================================== contract fixture

const FIXTURE_SOURCES: Record<string, WorkSource> = {
  's-inspection': { id: 's-inspection', label: 'Council inspection report 2024', kind: 'document', url: 'https://example.org/riverside/inspection-2024.pdf', date: '2024-03-12', locator: 'p. 4, table 2', status: 'inspected', origin: 'riverside-council' },
  's-press': { id: 's-press', label: 'Council press release', kind: 'document', url: 'https://example.org/riverside/press-2024-04.html', date: '2024-04-02', locator: 'paragraph 3', status: 'retrieved', origin: 'riverside-council' },
  's-blog': { id: 's-blog', label: 'Structural engineering blog post', kind: 'document', url: 'https://example.org/engineering/riverside-after-the-flood', date: '2025-11-20', locator: "section 'Load rating'", status: 'retrieved', origin: 'independent-engineer' },
}

interface FixtureState {
  n: number
  items: WorkItem[]
  links: WorkLink[]
  groups: { id: string; label: string; items: string[] }[]
}

function fixtureSeed(): FixtureState {
  const S = FIXTURE_SOURCES
  return {
    n: 1,
    items: [
      { id: 'q1', kind: 'question', label: 'Is the Riverside footbridge rated for 5-tonne loads?' },
      { id: 'c1', kind: 'claim', label: 'The footbridge is rated for 5 t', uncertainty: { method: 'nal', f: 0.8, c: 0.55 } },
      { id: 'e1', kind: 'evidence', label: 'Inspection report lists a 5 t rating', sources: [clone(S['s-inspection'])], uncertainty: { method: 'nal', f: 0.9, c: 0.8 } },
      { id: 'e2', kind: 'evidence', label: 'Press release repeats the 5 t rating', sources: [clone(S['s-press'])], uncertainty: { method: 'nal', f: 0.9, c: 0.5 }, meta: { note: 'same origin as e1; not independent' } },
      { id: 'e3', kind: 'evidence', label: 'Engineer reports the rating was cut to 3 t after the 2025 flood', sources: [clone(S['s-blog'])], uncertainty: { method: 'qualitative', status: 'unverified' } },
      { id: 'h1', kind: 'hypothesis', label: 'The rating was reduced after the flood' },
      { id: 'a1', kind: 'assessment', label: 'Contested: both supporting reports share one origin', uncertainty: { method: 'qualitative', status: 'contested' } },
      { id: 'g1', kind: 'gap', label: 'No inspection after the 2025 flood has been found' },
    ],
    links: [
      { id: 'l1', from: 'c1', to: 'q1', rel: 'answers' },
      { id: 'l2', from: 'h1', to: 'q1', rel: 'answers' },
      { id: 'l3', from: 'e1', to: 'c1', rel: 'supports', weight: 0.8 },
      { id: 'l4', from: 'e2', to: 'c1', rel: 'supports', weight: 0.3 },
      { id: 'l5', from: 'e3', to: 'c1', rel: 'contradicts', weight: 0.6 },
      { id: 'l6', from: 'e3', to: 'h1', rel: 'supports', weight: 0.6 },
      { id: 'l7', from: 'c1', to: 'e1', rel: 'depends_on' },
      { id: 'l8', from: 'a1', to: 'c1', rel: 'qualifies' },
      { id: 'l9', from: 'g1', to: 'a1', rel: 'qualifies' },
    ],
    groups: [
      { id: 'agreement', label: 'Supports a 5 t rating', items: ['c1', 'e1', 'e2'] },
      { id: 'conflict', label: 'Points to a lower rating', items: ['e3', 'h1'] },
      { id: 'common-origin', label: 'Same origin: Riverside council', items: ['e1', 'e2'] },
      { id: 'gap', label: 'Missing research', items: ['g1'] },
    ],
  }
}

export function contractFixture(): SimProgram {
  const STATE = new Map<string, FixtureState>() // swarm id -> the fixture's records
  const state = (ctx: ProgramCtx) => {
    let s = STATE.get(ctx.swarm_id ?? 'local')
    if (!s) STATE.set(ctx.swarm_id ?? 'local', (s = fixtureSeed()))
    return s
  }
  const graph = (s: FixtureState, focus: string | null = null, stage: ProgramStage = 'unfold'): Json => ({
    revision: `r${s.n}`,
    focus: focus || 'q1',
    title: 'Riverside footbridge load rating (synthetic fixture)',
    suggested_stage: stage,
    items: clone(s.items),
    links: clone(s.links),
    groups: clone(s.groups),
    notes: ['Synthetic test data. Sources are example.org placeholders.'],
  })
  return {
    manifest: {
      id: 'contract-fixture',
      name: 'Contract fixture',
      version: '0.1.0',
      description: 'A synthetic question with support and counterevidence, for testing programs and hosts against contract 0.1.',
      icon: 'flask',
      capabilities: ['goals:write'],
    },
    describe: () => ({
      contract: CONTRACT,
      kinds: [
        { id: 'question', label: 'Question', role: 'question' },
        { id: 'claim', label: 'Claim', role: 'claim' },
        { id: 'evidence', label: 'Evidence', role: 'evidence' },
        { id: 'hypothesis', label: 'Hypothesis', role: 'hypothesis' },
        { id: 'assessment', label: 'Assessment', role: 'assessment' },
        { id: 'gap', label: 'Gap', role: 'gap' },
      ],
      relations: [
        { id: 'answers', label: 'answers', polarity: 'neutral' },
        { id: 'supports', label: 'supports', polarity: 'support' },
        { id: 'contradicts', label: 'contradicts', polarity: 'oppose' },
        { id: 'qualifies', label: 'qualifies', polarity: 'qualify' },
        { id: 'depends_on', label: 'depends on', polarity: 'neutral' },
      ],
      actions: [
        { id: 'inspect-source', label: 'Open source', applies_to: ['evidence'] },
        { id: 'compare', label: 'Compare', applies_to: ['claim', 'hypothesis'], stage: 'compare' },
        // §9d: posting a challenge goal is consequential, so the app opts in to the host confirm
        { id: 'challenge', label: 'Challenge', applies_to: ['claim', 'assessment'], confirm: true },
        { id: 'investigate-gap', label: 'Investigate', applies_to: ['gap'] },
        { id: 'correct', label: 'Correct', applies_to: ['evidence'], params: { text: 'the corrected wording', note: 'why it changed' } },
      ],
    }),
    view: (ctx, focus, stage) => graph(state(ctx), focus, stage),
    async act(ctx, action, items, params) {
      const s = state(ctx)
      const base = params.base_revision
      if (base && base !== `r${s.n}`) return { status: 'stale', message: `the view changed (now r${s.n}); reload and try again`, graph: graph(s) }
      const byId = new Map(s.items.map((i) => [i.id, i]))
      const targets = items.map((i) => byId.get(i)).filter((x): x is WorkItem => !!x)
      if (!targets.length) return { status: 'refused', message: 'choose at least one item from this view' }
      if (action === 'inspect-source') {
        const sources = targets.flatMap((t) => t.sources ?? [])
        return { status: 'done', detail: { sources: clone(sources) }, message: 'references only: opening a URL or local file is up to the person' }
      }
      if (action === 'compare') return { status: 'done', graph: graph(s, targets[0].id, 'compare') }
      if (action === 'challenge' || action === 'investigate-gap') {
        const title = (action === 'challenge' ? 'Find counterevidence for: ' : 'Research: ') + targets[0].label
        const goal = await ctx.create_goal(title, `Opened from the contract fixture on ${targets[0].id}`)
        return { status: 'started', task: { id: goal.id, kind: 'goal', status: goal.status }, message: `posted task ${goal.id} to the swarm` }
      }
      if (action === 'correct') {
        const text = String(params.text ?? '').trim()
        if (!text) return { status: 'needs_input', message: 'say what the corrected evidence states', needs: { text: 'the corrected wording', note: 'why it changed' } }
        const item = targets[0]
        ;(item.revisions ??= []).push({ revision: `r${s.n}`, label: item.label, note: String(params.note ?? ''), at: new Date().toISOString() })
        item.label = text
        item.status = 'corrected'
        const affected = [
          ...s.links.filter((l) => l.to === item.id && l.rel === 'depends_on').map((l) => l.from),
          ...s.links.filter((l) => l.from === item.id && l.rel === 'supports').map((l) => l.to),
        ]
        for (const other of s.items) {
          if (!affected.includes(other.id)) continue
          other.flags ??= []
          if (!other.flags.includes('affected-by-correction')) other.flags.push('affected-by-correction')
        }
        s.n += 1
        return { status: 'done', graph: graph(s, item.id, 'detail'), message: `corrected ${item.id}; ${new Set(affected).size} conclusions flagged for review` }
      }
      return { status: 'refused', message: `unknown action ${action}` }
    },
  }
}

// ================================================================== commons explorer

const OVERVIEW = 'overview'
const MAX_BELIEFS = 120

/** hive/spaces/sexpr.py, enough for terms(): nested lists of atoms; numbers are not terms. */
type Node = string | number | Node[]
export function parseSexpr(text: string): Node {
  const tokens: (string | { s: string })[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) i++
    else if (ch === '(' || ch === ')') {
      tokens.push(ch)
      i++
    }
    else if (ch === '"') {
      let j = i + 1
      let buf = ''
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          buf += text[j + 1]
          j += 2
        } else buf += text[j++]
      }
      if (j >= text.length) throw new Error('unterminated string')
      tokens.push({ s: buf })
      i = j + 1
    } else {
      let j = i
      while (j < text.length && !/\s/.test(text[j]) && !'()"'.includes(text[j])) j++
      tokens.push(text.slice(i, j))
      i = j
    }
  }
  if (!tokens.length) throw new Error('empty expression')
  let pos = 0
  const read = (): Node => {
    const t = tokens[pos++]
    if (t === undefined) throw new Error('unbalanced')
    if (t === '(') {
      const out: Node[] = []
      while (tokens[pos] !== ')') {
        if (pos >= tokens.length) throw new Error('unbalanced')
        out.push(read())
      }
      pos++
      return out
    }
    if (t === ')') throw new Error('unexpected )')
    if (typeof t !== 'string') return t.s
    return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t) ? Number(t) : t
  }
  const node = read()
  if (pos !== tokens.length) throw new Error('trailing tokens')
  return node
}

export function terms(statement: string): string[] {
  let parsed: Node
  try {
    parsed = parseSexpr(statement)
  } catch {
    return []
  }
  const out: string[] = []
  const walk = (node: Node) => {
    if (Array.isArray(node)) for (const child of node.length && typeof node[0] === 'string' ? node.slice(1) : node) walk(child)
    else if (typeof node === 'string') out.push(node)
  }
  walk(parsed)
  return out
}

const subject = (statement: string) => terms(statement)[0] ?? null
const r6 = (x: number) => Math.round(Number(x) * 1e6) / 1e6
const nal = (tv: { f: number; c: number }): Uncertainty => ({ method: 'nal', f: r6(tv.f), c: r6(tv.c) })
/** Python's "{:g}". */
const g = (x: number) => String(Number(Number(x).toPrecision(6)))
const bid = (statement: string) => `b:${statement}`

function revisionOf(beliefs: Belief[]): string {
  // a hash of the commons, like the plugin's sha1 (the exact digest differs; it is opaque)
  const text = JSON.stringify(beliefs.map((b) => [b.statement, { c: b.tv.c, f: b.tv.f }, b.stamp]))
  let h1 = 0x811c9dc5
  let h2 = 0x1234567
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = Math.imul(h2 ^ c, 2246822519)
  }
  return `c-${((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 10)}`
}

function beliefItem(b: Belief, kind = 'belief', names: Record<string, string> = {}): WorkItem {
  const sources: WorkSource[] = (b.sources ?? []).map((a) => ({ id: `dot:${a}`, label: names[a] ?? a, kind: 'dot', status: 'cited', origin: `dot:${a}` }))
  return {
    id: bid(b.statement),
    kind,
    label: b.statement,
    uncertainty: nal(b.tv),
    sources,
    at: b.updated_at,
    weight: b.tv.c,
    meta: { stamp: b.stamp, independent_sources: (b.sources ?? []).length },
  }
}

function gapsFor(b: Belief): [string, string][] {
  const out: [string, string][] = []
  if ((b.sources ?? []).length <= 1) out.push(['single', `Only one independent source for ${b.statement}`])
  if (b.tv.c >= 0.5 && Math.abs(b.tv.f - 0.5) < 0.15) out.push(['ambiguous', `Evidence is split on ${b.statement}`])
  else if (b.tv.c < 0.4) out.push(['weak', `Low confidence in ${b.statement}`])
  return out
}

const gapItem = (b: Belief, key: string, label: string): WorkItem => ({ id: `gap:${key}:${b.statement}`, kind: 'gap', label, meta: { statement: b.statement, reason: key } })

export function commonsExplorer(): SimProgram {
  const names = (ctx: ProgramCtx) => Object.fromEntries(ctx.agents().map((a) => [a.id, a.name]))

  const overview = (ctx: ProgramCtx, beliefs: Belief[], nm: Record<string, string>, rev: string): Json => {
    const question: WorkItem = { id: OVERVIEW, kind: 'question', label: `What does ${ctx.swarm.name} believe?`, text: `${beliefs.length} shared beliefs in this swarm's commons.` }
    const items: WorkItem[] = [question]
    const links: Json[] = []
    const gaps: string[] = []
    for (const b of beliefs) {
      const item = beliefItem(b, 'belief', nm)
      items.push(item)
      links.push({ from: item.id, to: OVERVIEW, rel: 'answers', weight: b.tv.c })
      for (const [key, label] of gapsFor(b)) {
        const gi = gapItem(b, key, label)
        items.push(gi)
        gaps.push(gi.id)
        links.push({ from: gi.id, to: item.id, rel: 'qualifies' })
      }
    }
    const well = beliefs.filter((b) => (b.sources ?? []).length >= 2 && b.tv.c >= 0.6).map((b) => bid(b.statement))
    const groups = [
      { id: 'agreement', label: 'Well supported (two or more independent minds)', items: well },
      { id: 'gap', label: 'Missing research', items: gaps },
    ]
    const notes = beliefs.length ? [] : ["This swarm's commons is empty. Minds add beliefs with hive-publish."]
    return { revision: rev, focus: OVERVIEW, title: question.label, suggested_stage: 'unfold', items, links, groups: groups.filter((x) => x.items.length), notes }
  }

  const rivalsOf = (beliefs: Belief[], b: Belief) => {
    const subj = subject(b.statement)
    return beliefs.filter((o) => o.statement !== b.statement && subj && subject(o.statement) === subj)
  }

  const belief = (ctx: ProgramCtx, beliefs: Belief[], b: Belief, nm: Record<string, string>, rev: string, stage: ProgramStage): Json => {
    const focus = bid(b.statement)
    const detail = ctx.belief(b.statement) ?? { assertions: [] }
    const items: WorkItem[] = [beliefItem(b, 'belief', nm)]
    const links: (Omit<WorkLink, 'id'> & { id?: string })[] = []
    detail.assertions.forEach((a, n) => {
      const origin = 'stamp:' + [...a.stamp].sort().join(',')
      const who = nm[a.agent_id] ?? a.agent_id
      const item: WorkItem = {
        id: `r:${b.statement}:${n}`,
        kind: 'report',
        label: `${who} reported f=${g(a.tv.f)} c=${g(a.tv.c)}`,
        text: `Outcome in the commons: ${a.outcome}.`,
        uncertainty: nal(a.tv),
        at: a.created_at,
        sources: [{ id: `dot:${a.agent_id}`, label: who, kind: 'dot', status: 'cited', date: a.created_at.slice(0, 10), origin, locator: 'evidence ' + a.stamp.join(', ') }],
        status: a.outcome === 'kept' || a.outcome === 'denied' ? 'superseded' : 'current',
        weight: a.tv.c,
        meta: { outcome: a.outcome, stamp: a.stamp },
      }
      items.push(item)
      links.push({ from: item.id, to: focus, rel: a.tv.f >= 0.5 ? 'supports' : 'contradicts', weight: a.tv.c })
    })
    for (const o of rivalsOf(beliefs, b)) {
      const r = beliefItem(o, 'rival', nm)
      items.push(r)
      links.push({ from: r.id, to: focus, rel: 'rivals', weight: o.tv.c })
    }
    const gaps: string[] = []
    for (const [key, label] of gapsFor(b)) {
      const gi = gapItem(b, key, label)
      items.push(gi)
      gaps.push(gi.id)
      links.push({ from: gi.id, to: focus, rel: 'qualifies' })
    }
    const support = links.filter((l) => l.rel === 'supports').map((l) => l.from)
    const oppose = links.filter((l) => l.rel === 'contradicts' || l.rel === 'rivals').map((l) => l.from)
    const groups = [
      { id: 'agreement', label: 'Supports it', items: [focus, ...support] },
      { id: 'conflict', label: 'Against it or says otherwise', items: oppose },
      { id: 'gap', label: 'Missing research', items: gaps },
    ]
    return {
      revision: rev,
      focus,
      title: b.statement,
      suggested_stage: stage,
      items,
      links,
      groups: groups.filter((x) => x.items.length),
      notes: ['Reports from minds that share evidence carry the same origin; they are not independent.'],
    }
  }

  const map = (beliefs: Belief[], b: Belief, nm: Record<string, string>, rev: string): Json => {
    const focus = bid(b.statement)
    const seen = new Set([focus])
    let frontier = [b]
    const items: WorkItem[] = [beliefItem(b, 'belief', nm)]
    const links: WorkLink[] = []
    const index = new Map<string, Belief[]>()
    for (const o of beliefs) for (const t of new Set(terms(o.statement))) index.set(t, [...(index.get(t) ?? []), o])
    for (let depth = 0; depth < 2; depth++) {
      const next: Belief[] = []
      for (const cur of frontier) {
        const cid = bid(cur.statement)
        for (const t of new Set(terms(cur.statement))) {
          for (const o of index.get(t) ?? []) {
            const oid = bid(o.statement)
            if (oid === cid || items.length >= 80) continue
            if (!seen.has(oid)) {
              seen.add(oid)
              items.push(beliefItem(o, 'belief', nm))
              next.push(o)
            }
            const link = { id: `${cid}|shares-term|${oid}`, from: cid, to: oid, rel: 'shares-term', weight: 0.5 }
            if (!links.some((x) => x.id === link.id) && !links.some((x) => x.id === `${oid}|shares-term|${cid}`)) links.push(link)
          }
        }
      }
      frontier = next
    }
    return { revision: rev, focus, title: `Around ${b.statement}`, suggested_stage: 'map', items, links, groups: [], notes: ['Linked by shared terms, two steps out.'] }
  }

  return {
    manifest: {
      id: 'commons-explorer',
      name: 'Commons Explorer',
      version: '0.1.0',
      description: "What does this swarm believe, and why? Each shared belief unfolds into the reports behind it, its rivals and the research it is missing.",
      icon: 'orbit',
      capabilities: ['commons:read', 'goals:write'],
    },
    describe: () => ({
      contract: CONTRACT,
      kinds: [
        { id: 'question', label: 'Question', role: 'question' },
        { id: 'belief', label: 'Shared belief', role: 'claim' },
        { id: 'report', label: 'Report', role: 'evidence' },
        { id: 'rival', label: 'Rival belief', role: 'hypothesis' },
        { id: 'gap', label: 'Missing research', role: 'gap' },
      ],
      relations: [
        { id: 'answers', label: 'answers', polarity: 'neutral' },
        { id: 'supports', label: 'supports', polarity: 'support' },
        { id: 'contradicts', label: 'contradicts', polarity: 'oppose' },
        { id: 'rivals', label: 'says otherwise about the same subject', polarity: 'oppose' },
        { id: 'shares-term', label: 'shares a term with', polarity: 'neutral' },
        { id: 'qualifies', label: 'qualifies', polarity: 'qualify' },
      ],
      actions: [
        { id: 'inspect-source', label: 'Open source', applies_to: ['report'] },
        { id: 'compare', label: 'Compare', applies_to: ['belief', 'rival'], stage: 'compare' },
        { id: 'challenge', label: 'Look for counterevidence', applies_to: ['belief', 'rival'] },
        { id: 'investigate-gap', label: 'Research this', applies_to: ['gap'] },
      ],
    }),
    view(ctx, focus, stage) {
      const beliefs = ctx.beliefs().slice(0, MAX_BELIEFS)
      const nm = names(ctx)
      const rev = revisionOf(beliefs)
      const b = focus ? beliefs.find((x) => bid(x.statement) === focus) : undefined
      if (b) return stage === 'map' ? map(beliefs, b, nm, rev) : belief(ctx, beliefs, b, nm, rev, stage)
      return overview(ctx, beliefs, nm, rev)
    },
    async act(ctx, action, items, params) {
      const beliefs = ctx.beliefs().slice(0, MAX_BELIEFS)
      const nm = names(ctx)
      const rev = revisionOf(beliefs)
      if (params.base_revision && params.base_revision !== rev) return { status: 'stale', message: 'the commons changed; here is the current view', graph: overview(ctx, beliefs, nm, rev) }
      const byId = new Map(beliefs.map((b) => [bid(b.statement), b]))
      if (action === 'inspect-source') {
        const first = items[0] ?? ''
        const statement = first.startsWith('r:') ? first.slice(2, first.lastIndexOf(':')) : null
        const detail = statement ? ctx.belief(statement) : null
        if (!detail) return { status: 'refused', message: 'choose a report' }
        const a = detail.assertions[Number(first.slice(first.lastIndexOf(':') + 1))]
        if (!a) return { status: 'refused', message: 'choose a report' }
        return {
          status: 'done',
          detail: {
            sources: [
              {
                id: `dot:${a.agent_id}`,
                label: nm[a.agent_id] ?? a.agent_id,
                kind: 'dot',
                status: 'inspected',
                date: a.created_at,
                locator: 'evidence ' + a.stamp.join(', '),
                origin: 'stamp:' + [...a.stamp].sort().join(','),
                record: { statement: a.statement, tv: a.tv, outcome: a.outcome },
              },
            ],
          },
        }
      }
      const chosen = items.map((i) => byId.get(i)).filter((x): x is Belief => !!x)
      if (action === 'compare') {
        if (chosen.length < 2) return { status: 'needs_input', message: 'choose two or more beliefs to compare', needs: { items: 'two or more beliefs' } }
        const cmpItems: WorkItem[] = []
        const links: Json[] = []
        const groups: Json[] = []
        for (const b of chosen) {
          const gr = belief(ctx, beliefs, b, nm, rev, 'compare') as { items: WorkItem[]; links: WorkLink[]; groups: { id: string; label: string; items: string[] }[] }
          const have = new Set(cmpItems.map((i) => i.id))
          cmpItems.push(...gr.items.filter((i) => !have.has(i.id)))
          const haveLinks = new Set(links.map((x) => `${x.from}\u0000${x.rel}\u0000${x.to}`))
          links.push(...(gr.links as unknown as Json[]).filter((x) => !haveLinks.has(`${x.from}\u0000${x.rel}\u0000${x.to}`)))
          for (const grp of gr.groups) groups.push({ id: `${grp.id}:${b.statement}`, label: `${grp.label}: ${b.statement}`, items: grp.items })
        }
        return {
          status: 'done',
          graph: {
            revision: rev,
            focus: bid(chosen[0].statement),
            title: 'Comparing ' + chosen.map((b) => b.statement).join(' vs '),
            suggested_stage: 'compare',
            items: cmpItems,
            links,
            groups,
            notes: ['Disagreement is kept side by side.'],
          },
        }
      }
      if (action === 'challenge' || action === 'investigate-gap') {
        let title: string
        if (action === 'investigate-gap') {
          const first = items[0] ?? ''
          const parts = first.split(':')
          const statement = first.startsWith('gap:') && parts.length >= 3 ? parts.slice(2).join(':') : null
          if (!statement) return { status: 'refused', message: 'choose a gap' }
          title = `Research: ${statement} needs more independent evidence`
        } else {
          if (!chosen.length) return { status: 'refused', message: 'choose a belief' }
          title = `Find counterevidence for ${chosen[0].statement}`
        }
        const goal = await ctx.create_goal(title, 'Opened from Commons Explorer')
        return { status: 'started', task: { id: goal.id, kind: 'goal', status: goal.status }, message: `posted task ${goal.id} to the swarm` }
      }
      return { status: 'refused', message: `unknown action ${action}` }
    },
  }
}

// ================================================================== invented read/file fixture (sim only)

/**
 * An INVENTED app for the frame-ops candidates (G1 read, G2 act with a file): a small ledger of made-up entries. It is
 * not installed by default (the sim's catalogue stays the two built-ins); `SimPrograms.installInvented('ledger-fixture')`
 * adds it. It declares one read ("entries") and one action that accepts a file ("attach"). Nothing it receives is kept.
 */
export function ledgerFixture(): SimProgram {
  const ENTRIES = Array.from({ length: 24 }, (_, i) => ({ id: `n${i + 1}`, at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, label: `Invented entry ${i + 1}`, value: ((i * 37) % 100) / 10 }))
  const item = (id: string, label: string): WorkItem => ({ id, kind: 'claim', label })
  return {
    manifest: { id: 'ledger-fixture', name: 'Ledger fixture', version: '0.0.1', description: 'Invented entries for testing app reads and files (sim only).', icon: 'flask', capabilities: ['goals:write'] },
    describe: () => ({
      contract: CONTRACT,
      kinds: [{ id: 'claim', label: 'Entry', role: 'claim' }],
      relations: [],
      actions: [
        // a file action is always person_activity (the hive refuses accepts_file without it), so host-confirmed (§9d)
        { id: 'attach', label: 'Attach a file', person_activity: true, accepts_file: { mimes: ['application/pdf', 'text/plain', 'image/*'], max_bytes: 5 * 1024 * 1024 } },
        { id: 'note', label: 'Note', confirm: true },
      ],
      reads: [{ id: 'entries', label: 'Entries' }],
    }),
    view: () => ({ revision: 'r1', focus: 'n1', title: 'Ledger (invented)', items: ENTRIES.slice(0, 5).map((e) => item(e.id, e.label)), links: [], groups: [], notes: ['Invented data.'] }),
    async act(ctx, action) {
      if (action === 'attach') {
        const f = ctx.file
        if (!f) return { status: 'needs_input', message: 'choose a file to attach' }
        // the program sees the bytes for this call only; it answers with what it received and keeps nothing
        return { status: 'done', message: `received ${f.name}`, detail: { received: { name: f.name, mime: f.mime, size: f.size, sha256: f.sha256 } } }
      }
      if (action === 'note') {
        const goal = await ctx.create_goal('Review an invented ledger entry', 'Opened from the ledger fixture (invented)')
        return { status: 'started', task: { id: goal.id, kind: 'goal', status: goal.status }, message: `posted task ${goal.id}` }
      }
      return { status: 'refused', message: `unknown action ${action}` }
    },
    read(_ctx, query, params) {
      if (query !== 'entries') return null
      const limit = typeof params.limit === 'number' && Number.isSafeInteger(params.limit) ? Math.max(1, Math.min(600, params.limit)) : 50
      // `pad` exists only to exercise the 4 MB cap: invented filler, never real content
      const pad = typeof params.pad === 'number' && params.pad > 0 ? 'x'.repeat(Math.min(params.pad, 5_000_000)) : undefined
      return { entries: ENTRIES.slice(0, limit), total: ENTRIES.length, ...(pad ? { pad } : {}) }
    },
  }
}

/**
 * INVENTED: where each app is set up in the simulated hive, best first (the operator's HIVE_APP_HOMES on a live hive).
 * Every listed swarm has an awake coordinator, so the demo's first request is answered. An app not listed here is set
 * up in Lyra.
 */
export const SIM_APP_HOMES: Record<string, string[]> = {
  'commons-explorer': ['s_lyra', 's_kelp'],
  omegadesign: ['s_lyra'],
  'omega-tools': ['s_lyra'],
  'contract-fixture': ['s_kelp'],
}
const SIM_DEFAULT_HOMES = ['s_lyra']

const INVENTED: Record<string, () => SimProgram> = { 'ledger-fixture': ledgerFixture, 'omega-tools-reasoning-fixture': omegaToolsWithInventedReasoning }

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function fromBase64(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) return null
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

// ================================================================== validation (hive/core/programs.py)

function unit(v: unknown) {
  const n = Number(v)
  return v !== null && v !== '' && Number.isFinite(n) && n >= 0 && n <= 1
}

export function checkUncertainty(u: unknown): string | null {
  if (!u || typeof u !== 'object' || !String((u as Json).method ?? '').trim()) return 'uncertainty needs a method (e.g. nal, pln, qualitative)'
  const x = u as Json
  if (x.method === 'nal' && !(unit(x.f) && unit(x.c))) return 'nal uncertainty needs f and c in [0, 1]'
  if (x.method === 'pln' && !(unit(x.strength) && unit(x.confidence))) return 'pln uncertainty needs strength and confidence in [0, 1]'
  if (x.method === 'qualitative' && !String(x.status ?? '').trim()) return 'qualitative uncertainty needs a status'
  return null
}

export function validateGraph(programId: string, desc: ProgramDescription, raw: unknown, stage: ProgramStage): WorkGraph {
  const bad = (m: string): never => {
    throw new ApiError(400, 'bad_graph', `${programId}: ${m}`)
  }
  if (!raw || typeof raw !== 'object') bad('view() must return a dict')
  const graph = clone(raw as Json)
  if (!String(graph.revision ?? '').trim()) bad('a work graph needs a revision (any string that changes when the content changes)')
  const items = (graph.items as WorkItem[]) ?? []
  const links = (graph.links as WorkLink[]) ?? []
  const groups = (graph.groups as { id: string; label?: string; items: string[] }[]) ?? []
  if (items.length > MAX_ITEMS || links.length > MAX_LINKS) bad(`a view holds at most ${MAX_ITEMS} items and ${MAX_LINKS} links (got ${items.length} and ${links.length}); narrow the view instead of cutting it`)
  const kinds = new Set(desc.kinds.map((k) => k.id))
  const rels = new Set(desc.relations.map((r) => r.id))
  const ids = new Set<string>()
  for (const item of items) {
    if (!item.id || ids.has(item.id)) bad(`item ids must be present and unique (${item.id})`)
    ids.add(item.id)
    if (!kinds.has(item.kind)) bad(`item ${item.id} has unknown kind ${item.kind}`)
    if (item.uncertainty != null) {
      const p = checkUncertainty(item.uncertainty)
      if (p) bad(`item ${item.id}: ${p}`)
    }
    item.status ??= 'current'
    if (!ITEM_STATUSES.has(item.status)) bad(`item ${item.id} has status ${item.status}`)
    item.sources ??= []
    for (const s of item.sources) {
      if (!s.id || !s.label) bad(`item ${item.id} has a source without id or label`)
      if (!SOURCE_STATUSES.has(String(s.status ?? 'cited'))) bad(`source ${s.id} has status ${s.status}`)
    }
    item.label ??= item.id
    item.flags ??= []
  }
  const linkIds = new Set<string>()
  for (const l of links) {
    if (!ids.has(l.from) || !ids.has(l.to)) bad(`link ${l.from} -> ${l.to} points outside the graph`)
    if (!rels.has(l.rel)) bad(`link uses unknown relation ${l.rel}`)
    l.id ??= `${l.from}|${l.rel}|${l.to}`
    if (linkIds.has(l.id)) bad(`link ids must be unique (${l.id})`)
    linkIds.add(l.id)
  }
  for (const gr of groups) {
    const missing = (gr.items ?? []).filter((i) => !ids.has(i))
    if (missing.length) bad(`group ${gr.id} names items not in the graph: ${missing.slice(0, 3).join(', ')}`)
  }
  if (graph.focus && !ids.has(String(graph.focus))) bad(`focus ${String(graph.focus)} is not an item`)
  const suggested = STAGES.includes(graph.suggested_stage as ProgramStage) ? (graph.suggested_stage as ProgramStage) : null
  return {
    contract: CONTRACT,
    program: programId,
    revision: String(graph.revision),
    stage,
    focus: (graph.focus as string) ?? null,
    title: (graph.title as string) || programId,
    suggested_stage: suggested,
    items,
    links,
    groups,
    notes: [...((graph.notes as string[]) ?? [])],
  }
}

export function validateResult(programId: string, desc: ProgramDescription, result: unknown): ActionResult {
  const fail = (m: string): never => {
    throw new ApiError(400, 'bad_result', `${programId}: ${m}`)
  }
  if (!result || typeof result !== 'object' || !RESULT_STATUSES.has(String((result as Json).status))) fail('act() must return a dict with a known status')
  const out = { ...(result as Json) } as unknown as ActionResult
  if (out.graph != null) {
    const g0 = out.graph as unknown as Json
    out.graph = validateGraph(programId, desc, g0, STAGES.includes(g0.suggested_stage as ProgramStage) ? (g0.suggested_stage as ProgramStage) : 'unfold')
  }
  if (out.status === 'started' && !out.task?.id) fail('a started action must return task.id')
  return out
}

function checkDescription(d: ProgramDescription): ProgramDescription {
  if (!d.kinds?.length) throw new Error('describe() must list kinds')
  for (const k of d.kinds) if (!ROLES.has(k.role)) throw new Error(`kind ${k.id} has role ${k.role}`)
  for (const r of d.relations ?? []) if (!POLARITIES.has(r.polarity)) throw new Error(`relation ${r.id} needs a polarity`)
  const out: ProgramDescription = { contract: String(d.contract ?? CONTRACT), kinds: d.kinds, relations: d.relations ?? [], actions: d.actions ?? [] }
  if (d.reads !== undefined) {
    // G1 candidate: reads = [{id: [\w.-]{1,64}, label?}]
    if (!Array.isArray(d.reads) || !d.reads.every((r) => r && typeof r.id === 'string' && READ_ID.test(r.id))) throw new Error('reads must be [{id, label?}] with ids like [\\w.-]{1,64}')
    out.reads = d.reads.map((r) => ({ id: r.id, ...(typeof r.label === 'string' ? { label: r.label } : {}) }))
  }
  return out
}

// ================================================================== the host

interface Entry {
  program: SimProgram
  describe: ProgramDescription | null
  error: string | null
}

export class SimPrograms {
  private entries = new Map<string, Entry>()
  /** next9: answers to file acts by idempotency key (never the bytes). */
  private fileActs = new Map<string, ActionResult>()
  private disabled = new Set<string>()
  /** SIM ONLY fixture: apps a swarm refuses ("app@swarm"), answered 403 program_refused as the host does. */
  private refused = new Set<string>()
  private host: HostServices
  private factories: (() => SimProgram)[]
  /** where a view last succeeded, newest first, per app (the host's program_homes table) */
  private opened = new Map<string, string[]>()

  constructor(host: HostServices, factories: (() => SimProgram)[] = [contractFixture, commonsExplorer, omegaDesign, omegaTools]) {
    this.host = host
    this.factories = factories
    this.reload()
  }

  /** Sim only: add an INVENTED app (e.g. 'ledger-fixture') to this host's catalogue. */
  installInvented(id: string): Program[] {
    const make = INVENTED[id]
    if (!make) throw new Error(`no invented app ${id}`)
    if (!this.factories.includes(make)) this.factories = [...this.factories, make]
    return this.reload()
  }

  /** Sim only: add an app made outside this module (a lazily loaded, URL-opted fixture such as ./evolvePc). */
  install(make: () => SimProgram): Program[] {
    if (!this.factories.includes(make)) this.factories = [...this.factories, make]
    return this.reload()
  }

  reload(): Program[] {
    this.entries.clear()
    for (const make of this.factories) {
      const program = make()
      let describe: ProgramDescription | null = null
      let error: string | null = null
      try {
        describe = checkDescription(program.describe())
      } catch (e) {
        error = `ValueError: ${e instanceof Error ? e.message : String(e)}`
      }
      this.entries.set(program.manifest.id, { program, describe, error })
    }
    return this.list()
  }

  private viewOf(id: string, e: Entry): Program {
    const m = e.program.manifest
    return { id, name: m.name, version: m.version, description: m.description, icon: m.icon, capabilities: [...m.capabilities], source: 'built-in', enabled: !this.disabled.has(id) && !e.error, error: e.error, ...(this.ui.has(id) ? { ui: true } : {}) }
  }
  /** SIM ONLY (demo D3): apps that ship their own interface here (the client serves it through programUi). */
  private ui = new Set<string>()
  shipsUi(id: string): void {
    this.ui.add(id)
  }

  list(): Program[] {
    return [...this.entries.entries()].map(([id, e]) => this.viewOf(id, e)).sort((a, b) => a.name.localeCompare(b.name))
  }

  private get(id: string): Entry {
    const e = this.entries.get(id)
    if (!e) throw new ApiError(404, 'not_found', `no program ${id}`)
    return e
  }

  detail(id: string): ProgramDetail {
    const e = this.get(id)
    return { ...this.viewOf(id, e), describe: e.describe ? clone(e.describe) : null }
  }

  setEnabled(id: string, enabled: boolean): Program {
    this.get(id)
    if (enabled) this.disabled.delete(id)
    else this.disabled.add(id)
    const out = this.viewOf(id, this.get(id))
    this.host.emit(out)
    return out
  }

  private ready(id: string): Entry & { describe: ProgramDescription } {
    const e = this.get(id)
    if (e.error || !e.describe) throw new ApiError(500, 'program_error', `${id} failed to load: ${e.error}`)
    if (this.disabled.has(id)) throw new ApiError(409, 'program_disabled', `${id} is disabled`)
    return e as Entry & { describe: ProgramDescription }
  }

  private ctx(id: string, swarmId: string): ProgramCtx {
    const caps = this.get(id).program.manifest.capabilities
    const need = (c: string) => {
      if (!caps.includes(c)) throw new ApiError(403, 'capability_missing', `${id} did not declare ${c} in plugin.json`)
    }
    const host = this.host
    return {
      swarm_id: swarmId,
      swarm: host.swarm(swarmId),
      beliefs: () => (need('commons:read'), host.beliefs(swarmId)),
      belief: (statement) => (need('commons:read'), host.belief(swarmId, statement)),
      agents: () => (need('commons:read'), host.agents().filter((a) => a.swarm_id === swarmId).map(({ id: aid, name, kind, hue }) => ({ id: aid, name, kind, hue }))),
      create_goal: async (title, detail = '') => {
        need('goals:write')
        return host.createGoal(swarmId, title, detail, `program:${id}`)
      },
    }
  }

  private call<T>(id: string, fn: () => T): T {
    try {
      return fn()
    } catch (e) {
      if (e instanceof ApiError) throw e
      throw new ApiError(500, 'program_error', `${id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** SIM ONLY fixture: this swarm refuses this app (its views answer 403 program_refused). */
  refuseIn(id: string, swarmId: string): void {
    this.refused.add(`${id}@${swarmId}`)
  }

  view(id: string, swarmId: string, focus?: string | null, stage?: string): WorkGraph {
    const e = this.ready(id)
    if (this.refused.has(`${id}@${swarmId}`)) throw new ApiError(403, 'program_refused', `${e.program.manifest.name} is not allowed in this swarm`)
    const st: ProgramStage = STAGES.includes(stage as ProgramStage) ? (stage as ProgramStage) : 'unfold'
    const ctx = this.ctx(id, swarmId)
    const graph = this.call(id, () => e.program.view(ctx, focus || null, st))
    const out = validateGraph(id, e.describe, graph, st)
    this.opened.set(id, [swarmId, ...(this.opened.get(id) ?? []).filter((s) => s !== swarmId)])
    return out
  }

  /**
   * GET /api/programs/{id}/homes as hive/core/programs.py homes() answers it: the swarms this app works in, best first,
   * limited to the swarms the caller can see. The sim's sources are its invented setup (SIM_APP_HOMES), then where a
   * view last succeeded.
   */
  homes(id: string, visible: Set<string>): { program: string; homes: { swarm_id: string; why: string }[] } {
    this.get(id)
    const out: { swarm_id: string; why: string }[] = []
    const add = (swarmId: string, why: string) => {
      if (visible.has(swarmId) && !out.some((h) => h.swarm_id === swarmId)) out.push({ swarm_id: swarmId, why })
    }
    for (const s of SIM_APP_HOMES[id] ?? SIM_DEFAULT_HOMES) add(s, 'the app is set up here')
    for (const s of this.opened.get(id) ?? []) add(s, 'opened here before')
    return { program: id, homes: out }
  }

  async act(id: string, swarmId: string, action: string, items: string[], params: Json = {}, baseRevision?: string | null,
    opts: { file?: { name: string; mime: string; size: number; content_base64: string } | null; person?: boolean; idempotencyKey?: string | null } = {}): Promise<ActionResult> {
    const e = this.ready(id)
    const declared = e.describe.actions.find((a) => a.id === action)
    if (!declared) throw new ApiError(400, 'bad_request', `${id} has no action '${action}'`)
    const ctx = this.ctx(id, swarmId)
    if (opts.file != null) {
      // next9: a file act is person activity and carries the host's idempotency key; a retry with the same key gets the
      // first answer back and the program never sees the bytes again
      if (!opts.idempotencyKey) throw new ApiError(400, 'bad_request', 'a file act needs an idempotency_key')
      const seen = this.fileActs.get(opts.idempotencyKey)
      if (seen) return clone(seen)
      ctx.file = await this.file(id, declared, opts.file, opts.person === true)
    }
    let out: Json
    try {
      out = await e.program.act(ctx, action, [...(items ?? [])], { ...params, base_revision: baseRevision ?? null })
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError(500, 'program_error', `${id}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const result = validateResult(id, e.describe, out)
    if (opts.file != null && opts.idempotencyKey) {
      this.fileActs.set(opts.idempotencyKey, clone(result))   // the answer only; no bytes are kept
      ctx.file = null
    }
    return result
  }

  /** G2 candidate rules (Platform's wire): a person only; the action must accept files; type, size and bytes checked. */
  private async file(id: string, action: { id: string; accepts_file?: { mimes: string[]; max_bytes: number } }, f: { name: string; mime: string; size: number; content_base64: string }, person: boolean): Promise<SimFile> {
    if (!person) throw new ApiError(403, 'person_required', 'a file comes only from a signed-in person')
    const acc = action.accepts_file
    if (!acc) throw new ApiError(400, 'file_not_accepted', `${id}: ${action.id} takes no file`)
    if (!f || typeof f !== 'object' || Object.keys(f).some((k) => !['name', 'mime', 'size', 'content_base64'].includes(k))) throw new ApiError(400, 'bad_file', 'file is {name, mime, size, content_base64}')
    if (typeof f.name !== 'string' || f.name.length < 1 || f.name.length > 255 || typeof f.mime !== 'string' || !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.content_base64 !== 'string')
      throw new ApiError(400, 'bad_file', 'file needs a name (1–255), a mime, a size and content_base64')
    const mime = f.mime.toLowerCase()
    if (!acc.mimes.some((m) => m === mime || (m.endsWith('/*') && mime.startsWith(m.slice(0, -1))))) throw new ApiError(415, 'file_type_refused', `${action.id} does not take ${mime}`)
    if (f.size > Math.min(acc.max_bytes, MAX_FILE)) throw new ApiError(413, 'file_too_large', `${action.id} takes at most ${acc.max_bytes} bytes`)
    const bytes = fromBase64(f.content_base64)
    if (!bytes || bytes.length !== f.size) throw new ApiError(400, 'bad_file', 'the bytes do not match the size')
    return { name: f.name, mime, size: f.size, sha256: await sha256Hex(bytes), bytes }
  }

  /** G1 candidate rules (Platform's wire): a declared read, JSON out, at most 4 MB serialised, never persisted. */
  read(id: string, swarmId: string, query: string, params: unknown): { program: string; query: string; result: unknown } {
    if (typeof query !== 'string' || !READ_ID.test(query)) throw new ApiError(400, 'bad_request', 'a read query is [\\w.-]{1,64}')
    const e = this.ready(id)
    if (!e.program.read || !(e.describe.reads ?? []).some((r) => r.id === query)) throw new ApiError(404, 'unknown_read', `${id} declares no read '${query}'`)
    if (params != null && (typeof params !== 'object' || Array.isArray(params))) throw new ApiError(400, 'bad_request', 'params must be an object')
    const ctx = this.ctx(id, swarmId)
    const result = this.call(id, () => e.program.read!(ctx, query, (params ?? {}) as Json))
    let text: string
    try {
      text = JSON.stringify(result ?? null)
    } catch {
      throw new ApiError(500, 'program_error', `${id}: read() must return JSON`)
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ApiError(500, 'bad_result', `${id}: read() must return a JSON object`)
    if (text.length > MAX_READ) throw new ApiError(413, 'read_too_large', `${id}: a read returns at most 4 MB`)
    return { program: id, query, result: JSON.parse(text) }
  }
}
