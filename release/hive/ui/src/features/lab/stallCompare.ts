import type { Better, LabCase, LabCaseStatus, LabMetric, LabRunSummary } from '../../api/types'
import { fmtValue, formerNames, targetText } from './labUtil'

/**
 * The Lab's stalled-run reading and its two-version comparison (demo D3), from what every hive already reports.
 * Pure, and tested.
 */

// ---------------------------------------------------------------- stalled

/**
 * When a running run last made progress: its start plus the recorded durations of the cases it has finished (a suite
 * runs its cases one after another). An estimate from the hive's own fields, never a host clock reading, so the page
 * says "about".
 */
export function lastProgressAt(run: Pick<LabRunSummary, 'started_at'>, cases: Pick<LabCase, 'duration_ms'>[]): number {
  return Date.parse(run.started_at) + cases.reduce((t, c) => t + Math.max(0, c.duration_ms ?? 0), 0)
}

/** How long without progress before a running run reads as stalled: three times the suite's estimate, at least 10 min. */
export const stallAfterMs = (estimateS: number) => Math.max(10 * 60_000, estimateS * 3 * 1000)

/** Milliseconds since a running run last made progress, when that is past the stall line; otherwise null. */
export function stalledFor(run: Pick<LabRunSummary, 'status' | 'started_at'>, cases: Pick<LabCase, 'duration_ms'>[], estimateS: number, now = Date.now()): number | null {
  if (run.status !== 'running') return null
  const since = now - lastProgressAt(run, cases)
  return since >= stallAfterMs(estimateS) ? since : null
}

/** "about 47 minutes", "about 2 hours". */
export function aboutSince(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 90) return `about ${min} minute${min === 1 ? '' : 's'}`
  const h = Math.round(min / 60)
  return `about ${h} hour${h === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------- comparing two versions

export type Change = 'better' | 'worse' | 'same' | 'changed' | 'only-a' | 'only-b' | 'not-comparable' | 'unknown'

/**
 * Whether two recorded values can be judged against each other at all (lab-compare r1). `comparable` is the only
 * outcome that may say better or worse; `not_comparable` carries a plain reason; `unknown` means a value is missing or
 * unreadable. Anything not explicitly declared compatible fails closed.
 */
export type Verdict = 'comparable' | 'not_comparable' | 'unknown'

/** One side's measure exactly as its run recorded it: value, unit and definition are never rewritten. */
export interface Observation {
  value: number
  unit: string
  better: Better | null
  target: number | null
}

export interface MetricRow {
  name: string
  /** Names it had before on either side (renamed_from, legacy_names): a quiet detail, never a measure of its own. */
  formerly: string[]
  /** The direction both sides declare; null when they disagree or either omits it. */
  better: Better | null
  a: Observation | null
  b: Observation | null
  verdict: Verdict
  /** Why it cannot be judged (not_comparable / unknown); null when comparable. */
  reason: string | null
  change: Change
}
export interface CaseRow {
  id: string
  name: string
  group: string
  a: LabCaseStatus | null
  b: LabCaseStatus | null
  status: Change
  metrics: MetricRow[]
}
export interface Comparison {
  rows: CaseRow[]
  passed: { a: number; b: number }
  judged: { a: number; b: number }
  /** Comparable measures only. */
  metrics: Record<'better' | 'worse' | 'same', number>
  /** Measures that could not be judged: not comparable (with a reason) or unknown (a value unreadable). */
  unjudged: Record<'notComparable' | 'unknown', number>
  statuses: Record<'better' | 'worse', number>
}

const RANK: Record<LabCaseStatus, number> = { passed: 3, skipped: 2, failed: 1, error: 0 }
/** Within 0.5 % (or exactly equal for counts) reads as about the same. A display tolerance, not a significance test. */
export const close = (a: number, b: number) => a === b || Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 0.005

/** Judges two values already in the same unit and of the same definition. Callers go through `judgeMetric`. */
export function metricChange(better: Better, a: number | null, b: number | null): Change {
  if (a == null) return 'only-b'
  if (b == null) return 'only-a'
  if (better === 'equal') return a === b ? 'same' : 'changed'
  if (close(a, b)) return 'same'
  return (better === 'lower' ? b < a : b > a) ? 'better' : 'worse'
}

// ---------------------------------------------------------------- units

/**
 * The declared conversions: each unit's size in its dimension's base unit. Only units listed here convert, and only
 * within one dimension. Spellings are exact (case matters: "Mb" is megabits, not listed, so it never converts).
 * Bytes: decimal (kB/KB = 1000) and binary (KiB = 1024) are written out separately, never inferred.
 * A Map, so only these own entries are ever found (never "constructor", "toString" or any other inherited name).
 * r1.1: a unit must be declared here even when both sides record the same string ("furlongs" vs "furlongs" is not
 * comparable). Besides the convertible families, the units the hive's own suites record are declared as their own
 * dimension (they compare only with themselves). "ratio" and "unitless" are the explicit declarations for a measure
 * without a physical unit; an empty unit is never taken as one.
 */
type Dim = 'time' | 'bytes' | 'count' | 'ratio' | 'unitless' | 'energy' | 'power' | 'usd' | 'percent' | 'core-share' | 'steps' | 'tokens' | 'ops-rate' | 'per-15s' | 'core-time'
export const UNIT_TABLE: ReadonlyMap<string, { dim: Dim; factor: number }> = new Map<string, { dim: Dim; factor: number }>([
  ['ns', { dim: 'time', factor: 1e-9 }],
  ['µs', { dim: 'time', factor: 1e-6 }], // U+00B5 micro sign
  ['μs', { dim: 'time', factor: 1e-6 }], // U+03BC Greek mu
  ['us', { dim: 'time', factor: 1e-6 }],
  ['ms', { dim: 'time', factor: 1e-3 }],
  ['s', { dim: 'time', factor: 1 }],
  ['min', { dim: 'time', factor: 60 }],
  ['h', { dim: 'time', factor: 3600 }],
  ['B', { dim: 'bytes', factor: 1 }],
  ['kB', { dim: 'bytes', factor: 1000 }],
  ['KB', { dim: 'bytes', factor: 1000 }],
  ['MB', { dim: 'bytes', factor: 1000 ** 2 }],
  ['GB', { dim: 'bytes', factor: 1000 ** 3 }],
  ['KiB', { dim: 'bytes', factor: 1024 }],
  ['MiB', { dim: 'bytes', factor: 1024 ** 2 }],
  ['GiB', { dim: 'bytes', factor: 1024 ** 3 }],
  ['count', { dim: 'count', factor: 1 }],
  ['counts', { dim: 'count', factor: 1 }],
  ['ratio', { dim: 'ratio', factor: 1 }],
  ['unitless', { dim: 'unitless', factor: 1 }],
  ['J', { dim: 'energy', factor: 1 }],
  ['Wh', { dim: 'energy', factor: 3600 }],
  ['W', { dim: 'power', factor: 1 }],
  ['$', { dim: 'usd', factor: 1 }],
  ['%', { dim: 'percent', factor: 1 }],
  ['% of a core', { dim: 'core-share', factor: 1 }],
  ['steps', { dim: 'steps', factor: 1 }],
  ['tokens', { dim: 'tokens', factor: 1 }],
  ['ops/s', { dim: 'ops-rate', factor: 1 }],
  ['per 15 s', { dim: 'per-15s', factor: 1 }],
  ['core·s', { dim: 'core-time', factor: 1 }],
])

/** A unit is recorded only when it is a non-blank string. */
export const hasUnit = (u: unknown): u is string => typeof u === 'string' && u.trim() !== ''

export type Conversion = { ok: true; value: number } | { ok: false; verdict: 'not_comparable' | 'unknown'; reason: string }

/**
 * `value` in `from` expressed in `to`. Both units must be declared in UNIT_TABLE, in one dimension, even when they are
 * the same string. A result that is not finite, or a non-zero value that underflows to 0, is refused.
 */
export function conversion(value: number, from: string, to: string): Conversion {
  if (!hasUnit(from) || !hasUnit(to)) return { ok: false, verdict: 'unknown', reason: 'no unit recorded' }
  if (!Number.isFinite(value)) return { ok: false, verdict: 'unknown', reason: 'a value is missing or unreadable' }
  const f = UNIT_TABLE.get(from)
  const t = UNIT_TABLE.get(to)
  if (!f) return { ok: false, verdict: 'not_comparable', reason: `unit ${from} is not declared` }
  if (!t) return { ok: false, verdict: 'not_comparable', reason: `unit ${to} is not declared` }
  if (from === to) return { ok: true, value }
  if (f.dim !== t.dim) return { ok: false, verdict: 'not_comparable', reason: `units ${from} and ${to} have no declared conversion` }
  const out = (value * f.factor) / t.factor
  if (!Number.isFinite(out) || (out === 0 && value !== 0)) return { ok: false, verdict: 'unknown', reason: `${value} ${from} is out of range in ${to}` }
  return { ok: true, value: out }
}

/** `value` in `from` expressed in `to`, or null when `conversion` refuses it. */
export function convertUnit(value: number, from: string, to: string): number | null {
  const c = conversion(value, from, to)
  return c.ok ? c.value : null
}

// ---------------------------------------------------------------- comparability

/**
 * A recorded metric plus the definition fields a newer hive may send (a free-text definition, cohort, split, method).
 * Today's hives omit them; when either side carries one, both must carry the same value.
 */
export type MetricRecord = Pick<LabMetric, 'name' | 'value' | 'unit' | 'target'> & {
  better?: Better | string | null
  definition?: string | null
  cohort?: string | null
  split?: string | null
  method?: string | null
}
const DEFINITION_FIELDS = ['definition', 'cohort', 'split', 'method'] as const
const DIRECTIONS: readonly string[] = ['lower', 'higher', 'equal']

const observe = (m: MetricRecord | undefined): Observation | null =>
  m ? { value: m.value, unit: typeof m.unit === 'string' ? m.unit : '', better: DIRECTIONS.includes(m.better as string) ? (m.better as Better) : null, target: m.target ?? null } : null

/** Two observations lined up: the verdict and, only when comparable, B's value expressed in A's unit (never shown). */
export interface Alignment {
  better: Better | null
  a: Observation | null
  b: Observation | null
  verdict: Verdict
  reason: string | null
  /** B converted into A's unit through UNIT_TABLE, for judging only; null unless comparable. */
  bInA: number | null
}

/**
 * Whether B can be judged against A for one measure. Keeps both originals; converts B into A's unit only through
 * UNIT_TABLE; comparable only when definition, direction and units all agree. `dimension` is each case's measured
 * dimension (a different one is a different definition). Fails closed: anything undeclared is not comparable.
 */
export function alignMetric(ma: MetricRecord | undefined, mb: MetricRecord | undefined, dimension: { a?: string; b?: string } = {}): Alignment {
  const a = observe(ma)
  const b = observe(mb)
  const better = a?.better != null && a.better === b?.better ? a.better : null
  const out = (verdict: Verdict, reason: string | null, bInA: number | null = null): Alignment => ({ better, a, b, verdict, reason, bInA })
  if (!a) return out('unknown', 'only in B')
  if (!b) return out('unknown', 'only in A')
  if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) return out('unknown', 'a value is missing or unreadable')
  if (dimension.a != null && dimension.b != null && dimension.a !== dimension.b) return out('not_comparable', `different measures (${dimension.a} vs ${dimension.b})`)
  for (const f of DEFINITION_FIELDS) {
    const x = ma?.[f] ?? null
    const y = mb?.[f] ?? null
    if (x !== y) return out('not_comparable', `different ${f} (${x ?? 'none recorded'} vs ${y ?? 'none recorded'})`)
  }
  if (a.better == null || b.better == null) return out('not_comparable', 'no direction recorded (lower or higher is better)')
  if (a.better !== b.better) return out('not_comparable', `directions differ (${a.better} vs ${b.better} is better)`)
  // units: recorded, declared (even when identical), one dimension; reasons name A's unit first
  if (!hasUnit(a.unit) || !hasUnit(b.unit)) return out('unknown', 'no unit recorded')
  for (const u of [a.unit, b.unit]) if (!UNIT_TABLE.has(u)) return out('not_comparable', `unit ${u} is not declared`)
  if (UNIT_TABLE.get(a.unit)!.dim !== UNIT_TABLE.get(b.unit)!.dim) return out('not_comparable', `units ${a.unit} and ${b.unit} have no declared conversion`)
  const c = conversion(b.value, b.unit, a.unit)
  if (!c.ok) return out(c.verdict, c.reason)
  return out('comparable', null, c.value)
}

/**
 * One measure of two cases, by name, through every guard compareRuns applies: a measure recorded more than once in
 * either case is not comparable, and the cases' dimensions must match. The single path both compareRuns and the
 * Epistemic board use.
 */
export function alignCaseMetric(ca: Pick<LabCase, 'metrics' | 'dimension'> | undefined, cb: Pick<LabCase, 'metrics' | 'dimension'> | undefined, name: string): Alignment {
  const ma = ca?.metrics.filter((m) => m.name === name) ?? []
  const mb = cb?.metrics.filter((m) => m.name === name) ?? []
  const al = alignMetric(ma[0], mb[0], { a: ca?.dimension, b: cb?.dimension })
  if (ma.length > 1 || mb.length > 1) return { ...al, better: null, verdict: 'not_comparable', reason: 'this measure is recorded more than once in a run', bInA: null }
  return al
}

/** B against A for one measure: better or worse only when comparable, by the declared direction. */
export function judgeMetric(ma: MetricRecord | undefined, mb: MetricRecord | undefined, dimension: { a?: string; b?: string } = {}): Omit<MetricRow, 'name' | 'formerly'> {
  return toRow(alignMetric(ma, mb, dimension))
}

function toRow({ bInA, ...al }: Alignment): Omit<MetricRow, 'name' | 'formerly'> {
  const change: Change =
    al.verdict === 'comparable' ? metricChange(al.a!.better!, al.a!.value, bInA) : al.verdict === 'not_comparable' ? 'not-comparable' : !al.a ? 'only-b' : !al.b ? 'only-a' : 'unknown'
  return { ...al, change }
}

/**
 * One side as the compare table shows it: its value in its own recorded unit, and its own target (if it has one) in
 * that same unit. r1.1: the target is kept per side, never borrowed from the other run.
 */
export function sideText(o: Observation | null): { value: string; target: string | null } {
  if (o == null) return { value: '–', target: null }
  const t = o.better != null && o.target != null && Number.isFinite(o.target) ? targetText({ better: o.better, target: o.target, unit: o.unit }) : null
  return { value: fmtValue(o.value, o.unit), target: t ? `target ${t}` : null }
}

/** Plain words for each change of a measure. */
export const CHANGE_WORD: Record<Change, string> = { better: 'better', worse: 'worse', same: 'about the same', changed: 'changed', 'only-a': 'only in A', 'only-b': 'only in B', 'not-comparable': 'not comparable', unknown: 'unknown' }

/** Plain words for a case's pass/fail status change: "same", never the measures' "about the same". */
export const STATUS_WORD: Record<Change, string> = { ...CHANGE_WORD, same: 'same' }

/** What the page says for one measure: better or worse only for a comparable pair, otherwise why it cannot be judged. */
export function judgementText(m: Pick<MetricRow, 'verdict' | 'reason' | 'change' | 'better'>): string {
  if (m.verdict === 'not_comparable') return `not comparable: ${m.reason ?? 'no reason recorded'}`
  if (m.verdict !== 'comparable') return m.change === 'only-a' || m.change === 'only-b' ? CHANGE_WORD[m.change] : `unknown: ${m.reason ?? 'no reason recorded'}`
  return m.change !== 'same' && m.better && m.better !== 'equal' ? `${CHANGE_WORD[m.change]} (${m.better} is better)` : CHANGE_WORD[m.change]
}

function statusChange(a: LabCaseStatus | null, b: LabCaseStatus | null): Change {
  if (a == null) return 'only-b'
  if (b == null) return 'only-a'
  if (a === b) return 'same'
  return RANK[b] > RANK[a] ? 'better' : 'worse'
}

/** Version B against version A, case by case (matched by case id) and metric by metric (matched by name). */
export function compareRuns(aCases: LabCase[], bCases: LabCase[]): Comparison {
  const byA = new Map(aCases.map((c) => [c.id, c]))
  const byB = new Map(bCases.map((c) => [c.id, c]))
  const ids = [...new Set([...aCases.map((c) => c.id), ...bCases.map((c) => c.id)])]
  const rows: CaseRow[] = ids.map((id) => {
    const a = byA.get(id)
    const b = byB.get(id)
    const names = [...new Set([...(a?.metrics ?? []).map((m) => m.name), ...(b?.metrics ?? []).map((m) => m.name)])]
    // paired on name alone: a measure the host renamed is one measure; its old name is only a quiet detail
    const metrics = names.map((name): MetricRow => ({ name, formerly: formerNames([...(a?.metrics ?? []), ...(b?.metrics ?? [])].filter((m) => m.name === name), name), ...toRow(alignCaseMetric(a, b, name)) }))
    return { id, name: (b ?? a)!.name, group: (b ?? a)!.group, a: a?.status ?? null, b: b?.status ?? null, status: statusChange(a?.status ?? null, b?.status ?? null), metrics }
  })
  const count = (cases: LabCase[], s: LabCaseStatus) => cases.filter((c) => c.status === s).length
  const judged = (cases: LabCase[]) => cases.filter((c) => c.status !== 'skipped').length
  const all = rows.flatMap((r) => r.metrics)
  const n = (p: (m: MetricRow) => boolean) => all.filter(p).length
  const ok = (m: MetricRow) => m.verdict === 'comparable'
  return {
    rows,
    passed: { a: count(aCases, 'passed'), b: count(bCases, 'passed') },
    judged: { a: judged(aCases), b: judged(bCases) },
    metrics: {
      better: n((m) => ok(m) && m.change === 'better'),
      worse: n((m) => ok(m) && m.change === 'worse'),
      same: n((m) => ok(m) && m.change === 'same'),
    },
    unjudged: {
      notComparable: n((m) => m.verdict === 'not_comparable'),
      unknown: n((m) => m.verdict === 'unknown' && m.change === 'unknown'),
    },
    statuses: { better: rows.filter((r) => r.status === 'better').length, worse: rows.filter((r) => r.status === 'worse').length },
  }
}

/** The version a run was made from, as the page names it: its commit when the hive recorded one, else its date. */
export function versionLabel(r: Pick<LabRunSummary, 'commit_sha' | 'started_at'>): string {
  const when = new Date(r.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return r.commit_sha ? `${r.commit_sha.slice(0, 10)} · ${when}` : `${when} (no version recorded)`
}

/** The two runs to compare by default: the newest finished run (B) against the one before it (A). */
export function defaultPair(runs: LabRunSummary[]): { a: string | null; b: string | null } {
  const done = runs.filter((r) => r.status !== 'running' && r.status !== 'cancelled').sort((x, y) => y.started_at.localeCompare(x.started_at))
  return { a: done[1]?.id ?? null, b: done[0]?.id ?? null }
}
