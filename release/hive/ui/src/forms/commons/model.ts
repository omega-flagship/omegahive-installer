import { capFirst, expectation as sharedExpectation, sayBelief, surenessOf, compareSureness, truthNumbers as sharedTruthNumbers, truthWords as sharedTruthWords } from '../../lib/beliefSentence'
import type { ProgramDescription, Uncertainty, WorkGraph, WorkItem } from '../../api/types'

/**
 * The commons, as pure data: the swarm's shared beliefs as a sky (constellations of beliefs that share a term),
 * and one belief unfolded into the reports behind it, its rivals and the research it is missing.
 *
 * Everything here is read from the program's own view graphs (commons-explorer describe(): question, belief,
 * report, rival, gap; answers, supports, contradicts, rivals, shares-term, qualifies). Nothing is invented: a
 * belief's rivals, gaps, "well supported" and independence are what the program says. The only things this file
 * derives are presentation: a plain-words reading of the statement, the constellation a star is drawn in, and
 * where it sits.
 */

// ------------------------------------------------------------------ kinds by role

export interface Kinds {
  question: string
  belief: string
  report: string
  rival: string
  gap: string
}

const DEFAULT_KINDS: Kinds = { question: 'question', belief: 'belief', report: 'report', rival: 'rival', gap: 'gap' }

/** The program's kind ids for each role (its describe() wins over the defaults). */
export function kindsOf(describe: ProgramDescription | null | undefined): Kinds {
  const by = (role: string, fallback: string) => describe?.kinds.find((k) => k.role === role)?.id ?? fallback
  return {
    question: by('question', DEFAULT_KINDS.question),
    belief: by('claim', DEFAULT_KINDS.belief),
    report: by('evidence', DEFAULT_KINDS.report),
    rival: by('hypothesis', DEFAULT_KINDS.rival),
    gap: by('gap', DEFAULT_KINDS.gap),
  }
}

/** Relation polarity, from describe() when present. */
export function polarityOf(describe: ProgramDescription | null | undefined, rel: string): 'support' | 'oppose' | 'qualify' | 'neutral' {
  const declared = describe?.relations.find((r) => r.id === rel)?.polarity
  if (declared) return declared
  if (rel === 'supports') return 'support'
  if (rel === 'contradicts' || rel === 'rivals') return 'oppose'
  if (rel === 'qualifies') return 'qualify'
  return 'neutral'
}

// ------------------------------------------------------------------ truth

/** A NAL truth value (frequency, confidence). Other methods are shown by their label, never converted. */
export interface Truth {
  f: number
  c: number
}

export function nalOf(u: Uncertainty | null | undefined): Truth | null {
  if (!u || u.method !== 'nal') return null
  const { f, c } = u as { f: unknown; c: unknown }
  return typeof f === 'number' && typeof c === 'number' && Number.isFinite(f) && Number.isFinite(c) ? { f, c } : null
}

/** NAL expectation: how strongly the commons expects the statement to hold (0..1). */
export const expectation = (t: Truth) => sharedExpectation(t)

/** Plain words for a truth value: the one shared scale (lib/beliefSentence, uifix-r3 S3), capitalised. */
export function truthWords(t: Truth | null): string {
  return t ? capFirst(sharedTruthWords(t)) : 'Not assessed'
}

/** The numbers, labelled with their method. */
export function truthNumbers(t: Truth | null, u?: Uncertainty | null): string {
  if (t) return capFirst(sharedTruthNumbers(t))
  if (u && typeof u.method === 'string') return `${u.method}${'label' in u && typeof u.label === 'string' ? `: ${u.label}` : ''} (not converted)`
  return 'Unassessed (not zero)'
}

/** The numbers, labelled in words (never a bare "f" and "c"): "likelihood 0.58, confidence 0.47". */
export const truthShort = (t: Truth | null) => (t ? sharedTruthNumbers(t) : 'unassessed')

// ------------------------------------------------------------------ statements

type Node = string | Node[]

/** A small reader for the commons' s-expressions (atoms and lists; strings keep their text). Null if malformed. */
export function parseStatement(text: string): Node | null {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[()]|[^\s()"]+/g)
  if (!tokens) return null
  let pos = 0
  const read = (): Node | null => {
    const t = tokens[pos++]
    if (t === undefined || t === ')') return null
    if (t !== '(') return t.startsWith('"') ? t.slice(1, -1) : t
    const out: Node[] = []
    while (tokens[pos] !== ')') {
      if (pos >= tokens.length) return null
      const n = read()
      if (n === null) return null
      out.push(n)
    }
    pos++
    return out
  }
  const node = read()
  return node !== null && pos === tokens.length ? node : null
}

const NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/

/** The statement's terms, as the program reads them: a list's leading operator is not a term, numbers are not terms. */
export function termsOf(statement: string): string[] {
  const node = parseStatement(statement)
  if (node === null) return []
  const out: string[] = []
  const walk = (n: Node) => {
    if (Array.isArray(n)) for (const child of n.length && typeof n[0] === 'string' ? n.slice(1) : n) walk(child)
    else if (!NUMBER.test(n)) out.push(n)
  }
  walk(node)
  return out
}

const isVariable = (t: string) => /^[$?#]/.test(t)
const atom = (t: string) => (isVariable(t) ? t.slice(1) || t : t)

/**
 * A plain reading of a statement, for people: the shared belief sentence (lib/beliefSentence). The statement itself is
 * one step away, behind "Show as written". (--> vega star) "Vega is a star"; (==> A B) "If A, then B".
 */
export function readStatement(statement: string): string {
  // uifix-r3 (S3): the one shared reading; a form it cannot read says "A belief about …", never a guess
  return capFirst(sayBelief(statement).clause)
}

// ------------------------------------------------------------------ the sky

export interface GapRef {
  id: string
  label: string
  /** single | ambiguous | weak, as the program names it. */
  reason: string
  /** The belief it qualifies. */
  belief: string
}

export interface Star {
  id: string
  statement: string
  reading: string
  truth: Truth | null
  uncertainty: Uncertainty | null
  /** Independent sources (dots) behind it, as the program counts them. */
  independent: number
  sources: { id: string; label: string }[]
  at: string | null
  /** In the program's "well supported" group. */
  well: boolean
  gaps: GapRef[]
  /** The constellation it is drawn in (a shared term), or LONE. */
  constellation: string
}

export interface Constellation {
  id: string
  /** The shared term, or "Lone stars". */
  name: string
  stars: Star[]
}

export interface Sky {
  revision: string
  question: string
  lede: string | null
  stars: Star[]
  constellations: Constellation[]
  well: number
  gaps: GapRef[]
  notes: string[]
}

export const LONE = '~lone'

export const GAP_WORDS: Record<string, string> = {
  single: 'Rests on one independent source',
  ambiguous: 'Evidence is split',
  weak: 'Low confidence',
}
export const gapWords = (reason: string) => GAP_WORDS[reason] ?? 'Missing research'

export function starOf(it: WorkItem, wellIds: Set<string>, gaps: GapRef[], constellation: string): Star {
  const independent = typeof it.meta?.independent_sources === 'number' ? (it.meta.independent_sources as number) : (it.sources ?? []).length
  return {
    id: it.id,
    statement: it.label,
    reading: readStatement(it.label),
    truth: nalOf(it.uncertainty),
    uncertainty: it.uncertainty ?? null,
    independent,
    sources: (it.sources ?? []).map((s) => ({ id: s.id, label: s.label })),
    at: it.at ?? null,
    well: wellIds.has(it.id),
    gaps,
    constellation,
  }
}

function gapsByBelief(graph: WorkGraph, k: Kinds): Map<string, GapRef[]> {
  const byId = new Map(graph.items.map((i) => [i.id, i]))
  const out = new Map<string, GapRef[]>()
  for (const l of graph.links) {
    const g = byId.get(l.from)
    if (!g || g.kind !== k.gap || l.rel !== 'qualifies') continue
    const ref: GapRef = { id: g.id, label: g.label, reason: typeof g.meta?.reason === 'string' ? (g.meta.reason as string) : 'gap', belief: l.to }
    out.set(l.to, [...(out.get(l.to) ?? []), ref])
  }
  return out
}

/**
 * Which constellation each statement is drawn in: the term it shares with the most other beliefs (variables
 * excluded; ties go to the earlier term, so the subject first). A belief that would be alone in its constellation
 * joins a larger one among its terms, else it is a lone star.
 */
export function constellationsFor(statements: string[]): Map<string, string> {
  const termSets = statements.map((s) => [...new Set(termsOf(s).filter((t) => !isVariable(t)))])
  const freq = new Map<string, number>()
  for (const ts of termSets) for (const t of ts) freq.set(t, (freq.get(t) ?? 0) + 1)
  const out = new Map<string, string>()
  statements.forEach((s, i) => {
    let best: string | null = null
    for (const t of termSets[i]) if ((freq.get(t) ?? 0) >= 2 && (best === null || (freq.get(t) ?? 0) > (freq.get(best) ?? 0))) best = t
    out.set(s, best ?? LONE)
  })
  // a constellation of one is no constellation: join the largest group among its own terms, else the lone stars
  const size = new Map<string, number>()
  for (const c of out.values()) size.set(c, (size.get(c) ?? 0) + 1)
  statements.forEach((s, i) => {
    const c = out.get(s)!
    if (c === LONE || (size.get(c) ?? 0) >= 2) return
    let best: string | null = null
    for (const t of termSets[i]) if (t !== c && (size.get(t) ?? 0) >= 2 && (best === null || size.get(t)! > size.get(best)!)) best = t
    out.set(s, best ?? LONE)
  })
  return out
}

/** Strongest first by the one sureness order (compareSureness); unassessed stars last (uifix-r3.6). */
export const byStrength = (a: Star, b: Star) => (a.truth && b.truth ? compareSureness(b.truth, a.truth) : Number(!!b.truth) - Number(!!a.truth))

/** The overview graph as a sky. */
export function buildSky(graph: WorkGraph, describe?: ProgramDescription | null): Sky {
  const k = kindsOf(describe)
  const q = graph.items.find((i) => i.kind === k.question)
  const wellIds = new Set(graph.groups.find((g) => g.id === 'agreement')?.items ?? [])
  const gaps = gapsByBelief(graph, k)
  const beliefs = graph.items.filter((i) => i.kind === k.belief)
  const where = constellationsFor(beliefs.map((b) => b.label))
  const stars = beliefs.map((b) => starOf(b, wellIds, gaps.get(b.id) ?? [], where.get(b.label) ?? LONE))
  const groups = new Map<string, Star[]>()
  for (const s of stars) groups.set(s.constellation, [...(groups.get(s.constellation) ?? []), s])
  const constellations = [...groups.entries()]
    .map(([id, ss]) => ({ id, name: id === LONE ? 'Lone stars' : atom(id), stars: [...ss].sort((a, b) => byStrength(a, b) || a.statement.localeCompare(b.statement)) }))
    .sort((a, b) => (a.id === LONE ? 1 : b.id === LONE ? -1 : b.stars.length - a.stars.length || a.name.localeCompare(b.name)))
  return {
    revision: graph.revision,
    question: q?.label ?? graph.title ?? 'What does this swarm believe?',
    lede: q?.text ?? null,
    stars,
    constellations,
    well: stars.filter((s) => s.well).length,
    gaps: [...gaps.values()].flat(),
    notes: graph.notes ?? [],
  }
}

// ------------------------------------------------------------------ filters

export type Filter = 'all' | 'well' | 'gaps' | 'split'

export const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'well', label: 'Well supported' },
  { id: 'split', label: 'Split' },
  { id: 'gaps', label: 'Missing research' },
]

/** Whether a star matches the filter and the search words (statement, reading, constellation, source names). */
export function matches(s: Star, filter: Filter, query: string): boolean {
  if (filter === 'well' && !s.well) return false
  if (filter === 'gaps' && !s.gaps.length) return false
  if (filter === 'split' && !s.gaps.some((g) => g.reason === 'ambiguous')) return false
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = `${s.statement} ${s.reading} ${s.constellation} ${s.sources.map((x) => x.label).join(' ')}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

// ------------------------------------------------------------------ one belief, unfolded

export interface Report {
  id: string
  who: string
  truth: Truth | null
  outcome: string
  at: string | null
  /** Evidential stamps; reports sharing one are echoes, not independent. */
  origin: string
  locator: string | null
  stance: 'for' | 'against' | 'other'
  /** How many other reports share this one's origin. */
  echoes: number
  superseded: boolean
}

export interface Unfolded {
  revision: string
  star: Star
  reports: Report[]
  /** Distinct origins among the reports. */
  origins: number
  forCount: number
  againstCount: number
  rivals: Star[]
  gaps: GapRef[]
  notes: string[]
}

/** A belief's own view (stage unfold) as reports, rivals and gaps. Null when the graph is not about `focus`. */
export function unfold(graph: WorkGraph, focus: string, describe?: ProgramDescription | null): Unfolded | null {
  const k = kindsOf(describe)
  const byId = new Map(graph.items.map((i) => [i.id, i]))
  const it = byId.get(focus)
  if (!it || it.kind !== k.belief) return null
  const gaps = gapsByBelief(graph, k).get(focus) ?? []
  const wellIds = new Set(graph.groups.find((g) => g.id === 'agreement')?.items ?? [])
  const star = starOf(it, wellIds, gaps, '')
  const into = graph.links.filter((l) => l.to === focus)
  const raw = into
    .map((l) => ({ l, r: byId.get(l.from) }))
    .filter((x): x is { l: (typeof into)[number]; r: WorkItem } => !!x.r && x.r.kind === k.report)
  const originOf = (r: WorkItem) => (r.sources?.[0]?.origin as string | undefined) ?? r.id
  const counts = new Map<string, number>()
  for (const { r } of raw) counts.set(originOf(r), (counts.get(originOf(r)) ?? 0) + 1)
  const reports: Report[] = raw.map(({ l, r }) => {
    const p = polarityOf(describe, l.rel)
    const src = r.sources?.[0]
    return {
      id: r.id,
      who: src?.label ?? r.label,
      truth: nalOf(r.uncertainty),
      outcome: typeof r.meta?.outcome === 'string' ? (r.meta.outcome as string) : '',
      at: r.at ?? null,
      origin: originOf(r),
      locator: typeof src?.locator === 'string' ? src.locator : null,
      stance: p === 'support' ? 'for' : p === 'oppose' ? 'against' : 'other',
      echoes: (counts.get(originOf(r)) ?? 1) - 1,
      superseded: r.status === 'superseded',
    }
  })
  const rivals = into
    .filter((l) => byId.get(l.from)?.kind === k.rival)
    .map((l) => starOf(byId.get(l.from)!, new Set(), [], ''))
    .sort(byStrength)
  return {
    revision: graph.revision,
    star,
    reports,
    origins: counts.size,
    forCount: reports.filter((r) => r.stance === 'for').length,
    againstCount: reports.filter((r) => r.stance === 'against').length,
    rivals,
    gaps,
    notes: graph.notes ?? [],
  }
}

// ------------------------------------------------------------------ compare

export interface Side {
  star: Star
  forCount: number
  againstCount: number
  rivals: number
  gaps: GapRef[]
}

/** The program's compare graph, one side per belief asked about (in the order asked). */
export function compareSides(graph: WorkGraph, ids: string[], describe?: ProgramDescription | null): Side[] {
  const k = kindsOf(describe)
  const byId = new Map(graph.items.map((i) => [i.id, i]))
  const gaps = gapsByBelief(graph, k)
  return ids
    .map((id) => byId.get(id))
    .filter((it): it is WorkItem => !!it)
    .map((it) => {
      const into = graph.links.filter((l) => l.to === it.id)
      const isReport = (id: string) => byId.get(id)?.kind === k.report
      return {
        star: starOf(it, new Set(), gaps.get(it.id) ?? [], ''),
        forCount: into.filter((l) => isReport(l.from) && polarityOf(describe, l.rel) === 'support').length,
        againstCount: into.filter((l) => isReport(l.from) && polarityOf(describe, l.rel) === 'oppose').length,
        rivals: into.filter((l) => l.rel === 'rivals').length,
        gaps: gaps.get(it.id) ?? [],
      }
    })
}

// ------------------------------------------------------------------ placement

export interface Placed {
  x: number
  y: number
}

/** Smallest distance kept between two star centres (the 44px hit targets never overlap). */
export const MIN_GAP = 48

export interface Spacing {
  /** Column and row pitch (px). */
  col: number
  row: number
  /** Largest nudge from the cell centre (px). */
  jx: number
  jy: number
  /** Padding inside the field (px). */
  pad: number
}

/** Bare stars: a dense sky. */
export const BARE: Spacing = { col: 64, row: 76, jx: 7, jy: 13, pad: 30 }
/** Stars with their reading under them: labels LABEL_W wide never touch. */
export const labelled = (width: number): Spacing => (width < 400 ? { col: 112, row: 104, jx: 6, jy: 6, pad: 30 } : { col: 136, row: 104, jx: 8, jy: 7, pad: 30 })
/** A label's box under its star: centred, `col - 16` wide, from 18px below the centre, at most 40px tall. */
export const labelBox = (sp: Spacing) => ({ w: sp.col - 2 * sp.jx - 8, dy: 18, h: 40 })

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967295
}

/**
 * Where each star of a constellation sits in a field `width` wide: rows of columns, each star nudged by a stable
 * hash of its id so the field reads as a sky rather than a table, while every two centres stay at least MIN_GAP
 * apart (and labels, with `labelled` spacing, never touch) and every star stays inside the field.
 * Returns the positions and the field's height.
 */
export function placeStars(ids: string[], width: number, sp: Spacing = BARE): { at: Placed[]; height: number } {
  const usable = Math.max(sp.col, width - 2 * sp.pad)
  const cols = Math.max(1, Math.min(ids.length, Math.floor(usable / sp.col)))
  const colW = usable / cols
  const rows = Math.ceil(ids.length / cols)
  const top = sp.pad + MIN_GAP / 2
  const at = ids.map((id, i) => {
    const r = Math.floor(i / cols)
    const c = i % cols
    const inRow = r === rows - 1 ? ids.length - r * cols : cols
    const offset = (usable - inRow * colW) / 2
    return {
      x: sp.pad + offset + (c + 0.5) * colW + (hash(id + ':x') * 2 - 1) * sp.jx,
      y: top + r * sp.row + (hash(id + ':y') * 2 - 1) * sp.jy,
    }
  })
  return { at, height: Math.round(top + (rows - 1) * sp.row + sp.row - MIN_GAP / 2 + sp.pad / 2) }
}

/** The drawn radius of a star: more independent sources, a larger star (3 to 13 px). */
export const radiusOf = (s: Pick<Star, 'independent'>) => 3 + 2 * Math.min(5, Math.max(0, s.independent))

/** How bright a star is drawn: its sureness tone (uifix-r3.5: a tentative star is mid, never brighter or dimmer by f; unassessed stars are dim, never dark). */
export const brightnessOf = (s: Pick<Star, 'truth'>) => (s.truth ? 0.35 + 0.65 * surenessOf(s.truth).tone : 0.3)

/** Everything a screen reader hears for a star (no meaning is carried by colour or size alone). */
export function starLabel(s: Star): string {
  const parts = [
    s.reading,
    truthWords(s.truth),
    capFirst(truthShort(s.truth)),
    `${s.independent} independent ${s.independent === 1 ? 'source' : 'sources'}`,
    s.well ? 'well supported' : null,
    s.gaps.length ? `missing research: ${s.gaps.map((g) => gapWords(g.reason).toLowerCase()).join('; ')}` : null,
  ]
  return parts.filter(Boolean).join('. ')
}
