import type { Polarity, ProgramDescription, Uncertainty, WorkGraph, WorkItem, WorkLink } from '../../api/types'
import type { Level } from './types'

/* ================================================================ territories and structures */

export type TerritoryId = 'sleep' | 'endocrine' | 'metabolic' | 'body' | 'mind' | 'context'

export interface Territory {
  id: TerritoryId
  label: string
  /** The legacy luminous hue (on dark). */
  color: string
  /** The same hue as ink on paper (legacy .paper palette). */
  ink: string
  /** One line for the biography's chapter opening. */
  gist: string
}

/**
 * Luminous hues exactly as the legacy styles.css (--sleep, --endo, --met, --body, --mind, --ctx). The paper inks are
 * the legacy .paper inks darkened just enough to clear 4.5:1 on every paper surface (measured: contrast.test.ts).
 */
export const TERRITORIES: Territory[] = [
  { id: 'sleep', label: 'Sleep', color: '#5fd0ff', ink: '#0b6694', gist: 'the clock, the night and the breath' },
  { id: 'endocrine', label: 'Endocrine', color: '#f5b545', ink: '#7f5800', gist: 'the slow messengers' },
  { id: 'metabolic', label: 'Metabolic', color: '#4fd6a0', ink: '#18714a', gist: 'fuel, stores and their keeping' },
  { id: 'body', label: 'Body', color: '#ff5a6e', ink: '#b42a42', gist: 'heart, lungs and moving muscle' },
  { id: 'mind', label: 'Mind', color: '#b48cff', ink: '#6a44c4', gist: 'attention, mood and effort' },
  { id: 'context', label: 'Context', color: '#7d95c4', ink: '#4a5f8a', gist: 'the world the body moves through' },
]
export const TERRITORY: Record<TerritoryId, Territory> = Object.fromEntries(TERRITORIES.map((t) => [t.id, t])) as Record<TerritoryId, Territory>

export interface Structure {
  id: string
  label: string
  territory: TerritoryId
  /** Anchor in figure space (400 x 900; context sits outside the silhouette). */
  x: number
  y: number
  words: RegExp
}

/** Anatomy sites. Positions follow the legacy figure (head ~95, throat ~165, heart ~270, abdomen ~420). */
export const STRUCTURES: Structure[] = [
  { id: 'circadian-clock', label: 'Circadian clock', territory: 'sleep', x: 214, y: 70, words: /circadian|clock|onset|chronotype|melatonin|phase|wake time|bedtime/i },
  { id: 'sleep-architecture', label: 'Sleep architecture', territory: 'sleep', x: 178, y: 62, words: /sleep|efficien|deep|rem\b|awaken|insomnia|nap/i },
  { id: 'airway', label: 'Airway', territory: 'sleep', x: 200, y: 178, words: /airway|snor|apnoea|apnea|breathing|oxygen|spo2/i },
  { id: 'pituitary', label: 'Pituitary', territory: 'endocrine', x: 200, y: 112, words: /pituitar|hypothalam|prolactin|lh\b|fsh\b|acth|growth hormone|igf/i },
  { id: 'thyroid', label: 'Thyroid', territory: 'endocrine', x: 200, y: 160, words: /thyroid|tsh|\bt4\b|\bt3\b|thyrox/i },
  { id: 'adrenal', label: 'Adrenal', territory: 'endocrine', x: 238, y: 346, words: /adrenal|cortisol|dhea|aldosterone/i },
  { id: 'gonads', label: 'Gonads', territory: 'endocrine', x: 200, y: 512, words: /testosterone|oestr|estr|gonad|androgen|shbg|libido/i },
  { id: 'liver', label: 'Liver and iron', territory: 'metabolic', x: 222, y: 362, words: /liver|hepat|ferritin|iron|alt\b|ast\b|ggt|transferrin/i },
  { id: 'pancreas', label: 'Glucose control', territory: 'metabolic', x: 182, y: 396, words: /glucose|insulin|hba1c|glyc|pancrea|diabet/i },
  { id: 'gut', label: 'Gut', territory: 'metabolic', x: 200, y: 432, words: /gut|digest|bowel|meal|diet|appetite|weight|lipid|cholesterol/i },
  { id: 'heart', label: 'Heart', territory: 'body', x: 188, y: 272, words: /heart|cardio|pulse|hrv|blood pressure|resting rate|bpm/i },
  { id: 'lungs', label: 'Lungs', territory: 'body', x: 240, y: 262, words: /lung|vo2|respirat|breath rate/i },
  { id: 'muscle', label: 'Muscle and movement', territory: 'body', x: 146, y: 650, words: /muscle|step|exercise|walk|strength|activity|movement|fatigue/i },
  { id: 'cortex', label: 'Attention', territory: 'mind', x: 230, y: 86, words: /attention|focus|cognit|memory|concentrat|adhd/i },
  { id: 'affect', label: 'Mood', territory: 'mind', x: 170, y: 100, words: /mood|anxi|stress|affect|motivation|irritab/i },
  { id: 'light', label: 'Light and screens', territory: 'context', x: 352, y: 120, words: /light|screen|lux|daylight|evening/i },
  { id: 'intake', label: 'Intake', territory: 'context', x: 360, y: 330, words: /caffeine|alcohol|coffee|medication|supplement|substance|dose/i },
  { id: 'travel', label: 'Travel and schedule', territory: 'context', x: 346, y: 540, words: /travel|time.?zone|shift|schedule|jet|commute|noise|hotel/i },
]
export const STRUCTURE: Record<string, Structure> = Object.fromEntries(STRUCTURES.map((s) => [s.id, s]))

const TERRITORY_WORDS: [TerritoryId, RegExp][] = [
  ['sleep', /sleep|circadian|wake|insomnia|apnoea|apnea|breathing|night/i],
  ['endocrine', /hormon|endocrin|thyroid|tsh|cortisol|pituitar|testosterone|prolactin/i],
  ['metabolic', /glucose|insulin|hba1c|metabol|ferritin|iron|liver|diet|weight/i],
  ['body', /heart|cardio|exercise|fatigue|muscle|lung|hrv|pulse/i],
  ['mind', /mood|attention|focus|cognit|anxiety|stress|motivation/i],
  ['context', /travel|caffeine|alcohol|medication|light|screen|noise|schedule/i],
]

/** Accepts the legacy ids (SLEEP_SYS...), short names and plain words. */
const TERRITORY_ALIASES: Record<string, TerritoryId> = {
  sleep: 'sleep', sleep_sys: 'sleep',
  endocrine: 'endocrine', endo: 'endocrine', endo_sys: 'endocrine', hormones: 'endocrine', hormonal: 'endocrine',
  metabolic: 'metabolic', met: 'metabolic', met_sys: 'metabolic', metabolism: 'metabolic',
  body: 'body', body_sys: 'body', physical: 'body',
  mind: 'mind', mind_sys: 'mind', mental: 'mind', cognition: 'mind',
  context: 'context', ctx: 'context', ctx_sys: 'context', environment: 'context',
}

export function territoryFrom(v: unknown): TerritoryId | null {
  if (typeof v !== 'string') return null
  return TERRITORY_ALIASES[v.trim().toLowerCase()] ?? null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/* ================================================================ the graph, indexed */

export interface Indexed {
  graph: WorkGraph
  byId: Map<string, WorkItem>
  out: Map<string, WorkLink[]>
  into: Map<string, WorkLink[]>
  polarity: (rel: string) => Polarity
}

export function indexGraph(graph: WorkGraph, describe: ProgramDescription | null): Indexed {
  const byId = new Map(graph.items.map((i) => [i.id, i]))
  const out = new Map<string, WorkLink[]>()
  const into = new Map<string, WorkLink[]>()
  for (const l of graph.links) {
    if (!out.has(l.from)) out.set(l.from, [])
    if (!into.has(l.to)) into.set(l.to, [])
    out.get(l.from)!.push(l)
    into.get(l.to)!.push(l)
  }
  const pol = new Map((describe?.relations ?? []).map((r) => [r.id, r.polarity]))
  return { graph, byId, out, into, polarity: (rel) => pol.get(rel) ?? 'neutral' }
}

export const linksOf = (ix: Indexed, id: string): WorkLink[] => [...(ix.out.get(id) ?? []), ...(ix.into.get(id) ?? [])]
export const other = (l: WorkLink, id: string): string => (l.from === id ? l.to : l.from)

/* ================================================================ placement */

export type PlacedVia = 'meta' | 'structure-words' | 'link' | 'words' | 'default'
export interface Placement {
  territory: TerritoryId
  structure: string | null
  /** Figure-space coordinate for the mark. */
  x: number
  y: number
  via: PlacedVia
}

const OBS_KINDS = new Set(['observation', 'event'])
const REASONING = new Set(['hypothesis', 'prediction', 'experiment', 'question'])

function directPlacement(item: WorkItem): { territory: TerritoryId; structure: string | null; via: PlacedVia } | null {
  const m = item.meta ?? {}
  const sid = str(m.structure) ?? str(m.anatomy) ?? str(m.site)
  if (sid && STRUCTURE[sid]) return { territory: STRUCTURE[sid].territory, structure: sid, via: 'meta' }
  const t = territoryFrom(m.territory) ?? territoryFrom(m.system) ?? territoryFrom(m.domain)
  const text = [item.label, str(m.marker), str(m.type), str(m.measure)].filter(Boolean).join(' ')
  if (t) {
    const s = STRUCTURES.find((x) => x.territory === t && x.words.test(text))
    return { territory: t, structure: s?.id ?? null, via: 'meta' }
  }
  if (item.kind === 'observation' || item.kind === 'event') {
    const s = STRUCTURES.find((x) => x.words.test(text))
    if (s) return { territory: s.territory, structure: s.id, via: 'structure-words' }
  }
  return null
}

function wordsPlacement(item: WorkItem): { territory: TerritoryId; structure: string | null } | null {
  const text = [item.label, item.text, str(item.meta?.marker)].filter(Boolean).join(' ')
  const s = STRUCTURES.find((x) => x.words.test(text))
  if (s) return { territory: s.territory, structure: s.id }
  const t = TERRITORY_WORDS.find(([, re]) => re.test(text))
  return t ? { territory: t[0], structure: null } : null
}

/** Golden-angle spiral around an anchor: stable, never overlapping for small counts. */
export function spiral(k: number, r0 = 11, step = 8): [number, number] {
  if (k === 0) return [0, 0]
  const a = k * 2.399963
  const r = r0 + step * Math.sqrt(k)
  return [Math.cos(a) * r, Math.sin(a) * r]
}

/** Where a territory's membrane sits in figure space: the centroid of its structures. */
export function territoryCentre(t: TerritoryId): { x: number; y: number; r: number } {
  const ss = STRUCTURES.filter((s) => s.territory === t)
  const x = ss.reduce((a, s) => a + s.x, 0) / ss.length
  const y = ss.reduce((a, s) => a + s.y, 0) / ss.length
  const spread = Math.max(...ss.map((s) => Math.hypot(s.x - x, s.y - y)))
  return { x, y, r: Math.max(70, spread + 52) }
}

/**
 * Places every item on the figure. Order of evidence: the item's own meta (structure, territory/system),
 * then structure words in its own name (observations and events), then the items it is linked to
 * (recorded-about, supports, predicts, tests...), then words, then Context.
 */
export function placeAll(ix: Indexed): Map<string, Placement> {
  const base = new Map<string, { territory: TerritoryId; structure: string | null; via: PlacedVia }>()
  for (const it of ix.graph.items) {
    if (it.kind === 'subject' || it.kind === 'question' || it.kind === 'literature') continue
    const d = directPlacement(it)
    if (d) base.set(it.id, d)
  }
  // two passes over links let hypotheses inherit from observations, then predictions and experiments from hypotheses
  for (let pass = 0; pass < 3; pass++) {
    for (const it of ix.graph.items) {
      if (base.has(it.id) || it.kind === 'subject') continue
      const votes = new Map<string, number>()
      const structVotes = new Map<string, number>()
      for (const l of linksOf(ix, it.id)) {
        const p = base.get(other(l, it.id))
        if (!p) continue
        votes.set(p.territory, (votes.get(p.territory) ?? 0) + 1)
        if (p.structure) structVotes.set(p.structure, (structVotes.get(p.structure) ?? 0) + 1)
      }
      if (!votes.size) continue
      const t = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0] as TerritoryId
      const s = [...structVotes.entries()].filter(([sid]) => STRUCTURE[sid].territory === t).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
      base.set(it.id, { territory: t, structure: s?.[0] ?? null, via: 'link' })
    }
  }
  for (const it of ix.graph.items) {
    if (base.has(it.id) || it.kind === 'subject') continue
    const w = wordsPlacement(it)
    base.set(it.id, w ? { ...w, via: 'words' } : { territory: 'context', structure: null, via: 'default' })
  }
  // coordinates: observations and events spiral around their structure; reasoning floats beside it
  const counters = new Map<string, number>()
  const out = new Map<string, Placement>()
  const sorted = [...ix.graph.items].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.id.localeCompare(b.id))
  for (const it of sorted) {
    const b = base.get(it.id)
    if (!b) continue
    const anchor = b.structure ? STRUCTURE[b.structure] : null
    const tc = territoryCentre(b.territory)
    const ax = anchor ? anchor.x : tc.x
    const ay = anchor ? anchor.y : tc.y
    const key = (REASONING.has(it.kind) ? 'r:' : OBS_KINDS.has(it.kind) ? 'o:' : 'x:') + (b.structure ?? b.territory)
    const k = counters.get(key) ?? 0
    counters.set(key, k + 1)
    let [dx, dy] = spiral(k + (OBS_KINDS.has(it.kind) ? 1 : 0))
    if (REASONING.has(it.kind)) {
      // reasoning sits out to the side of the anatomy it concerns, away from the spine
      const side = ax >= 200 ? 1 : -1
      dx = side * (44 + 20 * k)
      dy = -18 + 26 * (k % 2)
    }
    out.set(it.id, { territory: b.territory, structure: b.structure, x: ax + dx, y: ay + dy, via: b.via })
  }
  return out
}

/* ================================================================ semantic zoom */

/**
 * What each depth shows. 'full' is an interactive, labelled mark; 'glimmer' a quiet speck (density without
 * detail); 'hidden' is not drawn. Corrections and superseded records surface only at Provenance.
 */
export type Presence = 'full' | 'glimmer' | 'hidden'

export function presence(item: WorkItem, level: Level): Presence {
  const retired = item.status === 'corrected' || item.status === 'superseded' || item.status === 'retracted'
  if (retired) return level >= 3 ? 'full' : 'hidden'
  switch (item.kind) {
    case 'subject':
    case 'question':
      return 'full'
    case 'hypothesis':
      return level >= 1 ? 'full' : 'glimmer'
    case 'prediction':
    case 'experiment':
      return level >= 1 ? 'full' : 'hidden'
    case 'observation':
      return level >= 2 ? 'full' : 'glimmer'
    case 'event':
    case 'literature':
      return level >= 3 ? 'full' : 'hidden'
    default:
      return level >= 2 ? 'full' : 'hidden'
  }
}

/** Structures are named from the Structures depth; at Systems only territories are. */
export const showsStructures = (level: Level) => level >= 1
export const showsValues = (level: Level) => level >= 2
export const showsProvenance = (level: Level) => level >= 3

/* ================================================================ uncertainty: by method, never fused */

export interface UncertaintyText {
  assessed: boolean
  method: string
  /** Short form for a chip: "NAL f 0.80 c 0.62". */
  short: string
  /** Full sentence with what the number is not. */
  long: string
}

const n2 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '?')

export function uncertaintyText(u: Uncertainty | null | undefined): UncertaintyText {
  if (!u) return { assessed: false, method: 'none', short: 'Unassessed', long: 'Not assessed. Unassessed is not zero and not low confidence.' }
  if (u.method === 'nal' && 'f' in u) return { assessed: true, method: 'nal', short: `NAL f ${n2(u.f)} · c ${n2(u.c)}`, long: `NAL truth value: frequency ${n2(u.f)}, confidence ${n2(u.c)}.` }
  if (u.method === 'pln' && 'strength' in u) return { assessed: true, method: 'pln', short: `PLN s ${n2(u.strength)} · c ${n2(u.confidence)}`, long: `PLN: strength ${n2(u.strength)}, confidence ${n2(u.confidence)}.` }
  if (u.method === 'qualitative' && 'status' in u) return { assessed: true, method: 'qualitative', short: `Qualitative · ${String(u.status)}`, long: `Qualitative assessment: ${String(u.status)}.` }
  const rec = u as { method: string; label?: string; value?: unknown }
  const val = typeof rec.value === 'number' ? ` ${n2(rec.value)}` : ''
  const lab = rec.label ? String(rec.label) : 'Labelled only by its method'
  return { assessed: true, method: rec.method, short: `${rec.method}${val}`, long: `${lab} (method: ${rec.method}${val ? `, value${val}` : ''}).` }
}

/** Link weights are heuristic, never probabilities. */
export const weightText = (w: number | undefined) => (w == null ? null : `heuristic weight ${w.toFixed(2)}`)

/* ================================================================ values and privacy-safe names */

export interface Reading {
  value: string
  unit: string
  low: number | null
  high: number | null
  rangeSource: string | null
  /** The range is a general one, not the subject's own laboratory's (legacy ref.generic). */
  generic: boolean
  /** Where the value sits: 'below' | 'within' | 'above' | null (no comparable range). */
  state: 'below' | 'within' | 'above' | null
  /** 0..1 position across a padded scale, for the range bar. */
  pos: number | null
}

export function readingOf(item: WorkItem): Reading | null {
  const m = item.meta ?? {}
  const v = m.value
  if (v == null) return null
  const unit = str(m.unit) ?? str(m.units) ?? ''
  const ref = (m.ref ?? m.reference) as { low?: unknown; high?: unknown; source?: unknown; generic?: unknown; comparable?: unknown } | undefined
  const low = typeof ref?.low === 'number' ? ref.low : null
  const high = typeof ref?.high === 'number' ? ref.high : null
  let state: Reading['state'] = null
  let pos: number | null = null
  if (typeof v === 'number' && ref?.comparable !== false && (low != null || high != null)) {
    state = low != null && v < low ? 'below' : high != null && v > high ? 'above' : 'within'
    const lo = low ?? (high as number) * 0.5
    const hi = high ?? (low as number) * 2
    const span = hi - lo || 1
    pos = Math.max(0, Math.min(1, (v - (lo - span * 0.35)) / (span * 1.7)))
  }
  return { value: typeof v === 'number' ? fmtNum(v) : String(v), unit, low, high, rangeSource: str(ref?.source), generic: ref?.generic === true, state, pos }
}

export function fmtNum(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 1 : 0)
}

/**
 * A name that is safe at rest: the marker if the record names one, otherwise the label with any figures sealed.
 * Values never appear in a resting name, tooltip or accessible label.
 */
export function restingName(item: WorkItem): string {
  const marker = str(item.meta?.marker) ?? (str(item.meta?.type) ? nice(String(item.meta!.type).split('.').pop()!) : null)
  if (marker) return marker
  if (item.kind === 'observation') return item.label.replace(/(?<![A-Za-z\d])[-+]?\d[\d.,:/]*\s*(%|[a-zµμ/]+\b)?/gi, '•').replace(/(•\s*)+/g, '• ').replace(/[\s•:,;(]+$/, '').trim()
  return item.label
}

/** Display form of a key: "ReferralProlactinTotal" reads "Referral prolactin total" (legacy util.nice). */
export function nice(s: string): string {
  return s
    .replace(/[_-]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\b([A-Z][a-z]+)\b/g, (w, _m, i: number) => (i === 0 ? w : w.toLowerCase()))
}

/** A value as a sentence, for the biography and the reading sheet. Only ever rendered once revealed. */
export function readingSentence(r: Reading): string {
  const v = `${r.value}${r.unit ? ` ${r.unit}` : ''}`
  if (r.low == null && r.high == null) return `${v}; no reference range is recorded for it`
  const range = r.low != null && r.high != null ? `${fmtNum(r.low)}–${fmtNum(r.high)}` : r.low != null ? `above ${fmtNum(r.low)}` : `below ${fmtNum(r.high!)}`
  const whose = r.generic ? 'a general range, not this laboratory’s' : 'the laboratory’s own interval'
  if (r.state == null) return `${v}; ${whose} is ${range}, but the two cannot be compared`
  const where = r.state === 'within' ? 'within' : r.state === 'below' ? 'below' : 'above'
  return `${v}, ${where} ${whose} of ${range}`
}

/* ================================================================ marks: what each depth draws */

export interface Mark {
  item: WorkItem
  place: Placement
  presence: Presence
  /** Older records folded into this structure's newest mark (density without clutter). */
  folded: number
}

/** Newest records per structure drawn in full at Values; older ones fold into a count. Years of history stay legible. */
export const MAX_FULL_PER_STRUCTURE = 5

/**
 * What the map draws at a depth, as of a date (timeline scrub), optionally isolating one territory.
 * Pure: the same graph, level and date always give the same marks.
 */
export function marksAt(ix: Indexed, place: Map<string, Placement>, level: Level, opts: { asOf?: string | null; territory?: TerritoryId | null } = {}): Mark[] {
  const asOf = opts.asOf ?? null
  const groups = new Map<string, WorkItem[]>()
  const out: Mark[] = []
  for (const it of ix.graph.items) {
    const p = place.get(it.id)
    if (!p) continue
    if (asOf && it.at && it.at.slice(0, 10) > asOf) continue
    let pr = presence(it, level)
    if (pr === 'hidden') continue
    if (opts.territory && p.territory !== opts.territory && pr === 'full' && level < 3) pr = 'glimmer'
    if (pr === 'full' && OBS_KINDS.has(it.kind) && level < 3) {
      const key = p.structure ?? p.territory
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(it)
      continue
    }
    out.push({ item: it, place: p, presence: pr, folded: 0 })
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.id.localeCompare(b.id))
    const keep = list.slice(0, MAX_FULL_PER_STRUCTURE)
    const rest = list.length - keep.length
    keep.forEach((it, i) => out.push({ item: it, place: place.get(it.id)!, presence: 'full', folded: i === 0 ? rest : 0 }))
    for (const it of list.slice(MAX_FULL_PER_STRUCTURE)) out.push({ item: it, place: place.get(it.id)!, presence: 'glimmer', folded: 0 })
  }
  return out
}

/* ================================================================ gaps: the record is never complete */

export interface Gaps {
  /** Months between the first and last record with nothing recorded at all. */
  silentMonths: string[]
  /** Measured values with no reference range to read them against. */
  noRange: WorkItem[]
  /** Records Atlas could not place on the body from their own words or links. */
  unplaced: WorkItem[]
  /** Reasoning with no uncertainty assessed (not zero: unassessed). */
  unassessed: WorkItem[]
}

export function gapsOf(ix: Indexed, place: Map<string, Placement>): Gaps {
  const months = new Set<string>()
  for (const it of ix.graph.items) if ((it.kind === 'observation' || it.kind === 'event') && it.at) months.add(it.at.slice(0, 7))
  const sorted = [...months].sort()
  const silentMonths: string[] = []
  if (sorted.length > 1) {
    let [y, m] = sorted[0].split('-').map(Number)
    const last = sorted[sorted.length - 1]
    for (;;) {
      m++
      if (m > 12) {
        m = 1
        y++
      }
      const ym = `${y}-${String(m).padStart(2, '0')}`
      if (ym >= last) break
      if (!months.has(ym)) silentMonths.push(ym)
    }
  }
  const items = ix.graph.items
  return {
    silentMonths,
    noRange: items.filter((i) => i.kind === 'observation' && isCurrent(i) && typeof i.meta?.value === 'number' && (() => {
      const r = readingOf(i)
      return !!r && r.low == null && r.high == null
    })()),
    unplaced: items.filter((i) => i.kind !== 'question' && place.get(i.id)?.via === 'default'),
    unassessed: items.filter((i) => (i.kind === 'hypothesis' || i.kind === 'prediction') && isCurrent(i) && !i.uncertainty),
  }
}

/** Runs of silent months as readable spans: ["June – September 2024"]. */
export function silentSpans(months: string[]): { from: string; to: string; label: string; n: number }[] {
  const spans: { from: string; to: string; n: number }[] = []
  for (const ym of months) {
    const prev = spans[spans.length - 1]
    if (prev && nextMonth(prev.to) === ym) {
      prev.to = ym
      prev.n++
    } else spans.push({ from: ym, to: ym, n: 1 })
  }
  return spans.map((s) => ({ ...s, label: s.from === s.to ? monthLabel(s.from) : s.from.slice(0, 4) === s.to.slice(0, 4) ? `${MONTHS[+s.from.slice(5, 7) - 1]} – ${monthLabel(s.to)}` : `${monthLabel(s.from)} – ${monthLabel(s.to)}` }))
}
function nextMonth(ym: string): string {
  let [y, m] = ym.split('-').map(Number)
  m++
  if (m > 12) {
    m = 1
    y++
  }
  return `${y}-${String(m).padStart(2, '0')}`
}

/* ================================================================ the camera over the figure */

export interface FigureFrame {
  /** Screen px per figure unit. */
  z: number
  /** Screen position of figure point (0,0). */
  ox: number
  oy: number
}

/**
 * Fits the figure (and the Context column beside it) into a free rectangle of the stage, then zooms toward a
 * point of interest. Systems and Structures show the whole person; Values and Provenance lean in when a
 * territory or structure is in focus.
 */
export function frameFor(area: { x: number; y: number; w: number; h: number }, level: Level, focus: { x: number; y: number } | null): FigureFrame {
  const fit = Math.min((area.h * 0.92) / FIG_H_, (area.w * 0.94) / 440)
  const lean = focus ? [1, 1.2, 1.45, 1.3][level] : [1, 1.04, 1.08, 1][level]
  const z = fit * lean
  const cx = focus && lean > 1.1 ? focus.x : 214
  const cy = focus && lean > 1.1 ? focus.y : FIG_H_ / 2 - 6
  return { z, ox: area.x + area.w / 2 - cx * z, oy: area.y + area.h / 2 - cy * z }
}
const FIG_H_ = 900

/* ================================================================ provenance */

export interface ProvenanceStep {
  id: string
  label: string
  rel: string
  status: string
  at?: string
}

/** The record's chain back to the ledger: extracted-from events, then what it corrects or supersedes. */
export function provenanceOf(ix: Indexed, id: string): { extracted: ProvenanceStep[]; corrects: ProvenanceStep[]; correctedBy: ProvenanceStep[]; literature: ProvenanceStep[] } {
  const step = (lid: string, rel: string): ProvenanceStep | null => {
    const it = ix.byId.get(lid)
    return it ? { id: it.id, label: it.label, rel, status: String(it.status ?? 'current'), at: it.at } : null
  }
  const outs = ix.out.get(id) ?? []
  const ins = ix.into.get(id) ?? []
  const pick = (ls: WorkLink[], rels: string[], dir: 'to' | 'from') => ls.filter((l) => rels.includes(l.rel)).map((l) => step(l[dir], l.rel)).filter((x): x is ProvenanceStep => !!x)
  return {
    extracted: pick(outs, ['extracted-from'], 'to'),
    corrects: pick(outs, ['corrects', 'supersedes'], 'to'),
    correctedBy: pick(ins, ['corrects', 'supersedes'], 'from'),
    literature: [...pick(outs, ['supports', 'contradicts', 'qualifies'], 'to'), ...pick(ins, ['supports', 'contradicts', 'qualifies'], 'from')].filter((s) => ix.byId.get(s.id)?.kind === 'literature'),
  }
}

/** Evidence around a hypothesis or prediction, kept apart by polarity (support, opposition, qualification). */
export function evidenceOf(ix: Indexed, id: string): Record<Polarity, { item: WorkItem; link: WorkLink }[]> {
  const res: Record<Polarity, { item: WorkItem; link: WorkLink }[]> = { support: [], oppose: [], qualify: [], neutral: [] }
  for (const l of linksOf(ix, id)) {
    if (l.rel === 'recorded-about') continue
    const it = ix.byId.get(other(l, id))
    if (!it) continue
    res[ix.polarity(l.rel)].push({ item: it, link: l })
  }
  return res
}

/** Structures a hypothesis spans: the structures of everything it is linked to (its reveal field). */
export function structuresSpanned(ix: Indexed, place: Map<string, Placement>, id: string): string[] {
  const s = new Set<string>()
  const own = place.get(id)?.structure
  if (own) s.add(own)
  for (const l of linksOf(ix, id)) {
    const p = place.get(other(l, id))
    const it = ix.byId.get(other(l, id))
    if (p?.structure && it && (it.kind === 'observation' || it.kind === 'event')) s.add(p.structure)
  }
  return [...s].sort()
}

/* ================================================================ timeline strata */

export interface Stratum {
  month: string // YYYY-MM
  label: string
  rows: { territory: TerritoryId; items: WorkItem[] }[]
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MON = MONTHS.map((m) => m.slice(0, 3))

export function fmtDate(at: string | undefined | null): string {
  if (!at || at.length < 10) return ''
  return `${+at.slice(8, 10)} ${MON[+at.slice(5, 7) - 1]} ${at.slice(0, 4)}`
}
export const monthLabel = (ym: string) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`

/** Events and observations through time, newest month first, by territory within a month. */
export function strata(ix: Indexed, place: Map<string, Placement>, includeRetired = true): Stratum[] {
  const by = new Map<string, Map<TerritoryId, WorkItem[]>>()
  for (const it of ix.graph.items) {
    if (it.kind !== 'observation' && it.kind !== 'event') continue
    if (!includeRetired && it.status && it.status !== 'current') continue
    const at = it.at ?? str(it.meta?.observed_at)
    if (!at) continue
    const ym = at.slice(0, 7)
    const t = place.get(it.id)?.territory ?? 'context'
    if (!by.has(ym)) by.set(ym, new Map())
    const m = by.get(ym)!
    if (!m.has(t)) m.set(t, [])
    m.get(t)!.push(it)
  }
  return [...by.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, m]) => ({
      month,
      label: monthLabel(month),
      rows: TERRITORIES.filter((t) => m.has(t.id)).map((t) => ({ territory: t.id, items: m.get(t.id)!.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')) })),
    }))
}

/* ================================================================ today */

export interface TodaySummary {
  subject: WorkItem | null
  question: WorkItem | null
  latestAt: string | null
  recent: WorkItem[]
  openHypotheses: WorkItem[]
  activeExperiments: WorkItem[]
  duePredictions: WorkItem[]
  corrections: WorkItem[]
  perTerritory: { territory: TerritoryId; observations: number; hypotheses: number }[]
}

const isCurrent = (i: WorkItem) => !i.status || i.status === 'current'

export function today(ix: Indexed, place: Map<string, Placement>): TodaySummary {
  const items = ix.graph.items
  const obs = items.filter((i) => i.kind === 'observation' && isCurrent(i) && i.at).sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
  const latestAt = obs[0]?.at ?? null
  const cutoff = latestAt ? new Date(Date.parse(latestAt) - 21 * 864e5).toISOString() : null
  const status = (i: WorkItem) => String(i.meta?.domain_status ?? '')
  return {
    subject: items.find((i) => i.kind === 'subject') ?? null,
    question: (ix.graph.focus && ix.byId.get(ix.graph.focus)?.kind === 'question' ? ix.byId.get(ix.graph.focus) : items.find((i) => i.kind === 'question')) ?? null,
    latestAt,
    recent: cutoff ? obs.filter((o) => (o.at ?? '') >= cutoff).slice(0, 6) : [],
    openHypotheses: items.filter((i) => i.kind === 'hypothesis' && isCurrent(i) && !/rejected|retired|closed/.test(status(i))),
    activeExperiments: items.filter((i) => i.kind === 'experiment' && /active|running|planned/.test(status(i) || 'planned')),
    duePredictions: items.filter((i) => i.kind === 'prediction' && isCurrent(i)).sort((a, b) => String(a.meta?.due ?? a.at ?? '').localeCompare(String(b.meta?.due ?? b.at ?? ''))),
    corrections: items.filter((i) => i.status === 'corrected' || i.status === 'superseded' || (i.flags ?? []).includes('affected-by-correction')),
    perTerritory: TERRITORIES.map((t) => ({
      territory: t.id,
      observations: items.filter((i) => i.kind === 'observation' && isCurrent(i) && place.get(i.id)?.territory === t.id).length,
      hypotheses: items.filter((i) => i.kind === 'hypothesis' && isCurrent(i) && place.get(i.id)?.territory === t.id).length,
    })),
  }
}

/* ================================================================ kinds */

export const KIND_WORD: Record<string, string> = {
  subject: 'Subject', question: 'Question', event: 'Recorded event', observation: 'Observation', hypothesis: 'Hypothesis',
  literature: 'Literature', prediction: 'Prediction', experiment: 'Experiment',
}
/** Legacy KIND palette (on dark). */
export const KIND_COLOR: Record<string, string> = {
  subject: '#eaf3ff', hypothesis: '#b48cff', literature: '#6fa3ff', prediction: '#f2d38a', experiment: '#5fe0c0',
  observation: '#cfe9ff', event: '#9fb0c8', question: '#eef3fa',
}
/** Legacy relation family: light and desaturated, never a territory hue. */
export const POLARITY_COLOR: Record<Polarity, string> = { support: '#9fe6c4', oppose: '#ff9aa6', qualify: '#ffd68a', neutral: '#eef3fa' }
export const POLARITY_INK: Record<Polarity, string> = { support: '#1f7a50', oppose: '#b42a42', qualify: '#7f5800', neutral: '#2b3445' }
export const POLARITY_WORD: Record<Polarity, string> = { support: 'Leans toward', oppose: 'Leans against', qualify: 'Qualifies', neutral: 'Linked' }

/** Actions an item offers, from describe(). */
export function actionsFor(describe: ProgramDescription | null, kind: string) {
  // agent-only actions (worker-resolve, worker-stage) are never a person's button
  return (describe?.actions ?? []).filter((a) => !(a as { agents?: boolean }).agents && (!a.applies_to || a.applies_to.includes(kind)))
}

/** "Late caffeine…" reads "late caffeine…" inside a sentence; acronyms (TSH, HbA1c) keep their case. */
export const lowerFirst = (s: string) => (s && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s)

export const greeting = (d = new Date()) => {
  const h = d.getHours()
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}
