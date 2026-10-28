import type { LabCase, LabCaseStatus, LabMetric, LabRunStatus, LabRunSummary, LabSeries } from '../../api/types'
import type { IconName } from '../../ui/Icon'
import { shown } from '../../lib/displayName'
import { ownerWords } from '../../lib/ownerWords'

/**
 * Categorical slots: the dataviz reference palette's dark steps, the same validated set the
 * Usage view uses (checked against this surface with validate_palette.js). Assigned in order.
 */
export const SLOTS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9']
/**
 * Lab chrome colours as CSS variables (index.css "Lab tiles"): the classic navy and inks in classic, the experience's
 * chrome inside an experience, so a light experience gets light tiles with its own readable ink. Charts must set
 * these through `style` (an SVG presentation attribute does not take var()).
 */
export const SURFACE = 'var(--lab-tile)'
export const INK3 = 'var(--color-ink-3)'
export const INK4 = 'var(--lab-ink-faint)'
export const GRID = 'color-mix(in srgb, var(--lab-hair) 7%, transparent)'
/** A hairline of the tile's ink at `pct` (classic: white at that opacity). */
export const hair = (pct: number) => `color-mix(in srgb, var(--lab-hair) ${pct}%, transparent)`
/** Status tones: the hive's good and bad (darkened on light chrome by the dress), a running blue that stays readable. */
export const GOOD = 'var(--color-good)'
export const BAD = 'var(--color-bad)'
export const RUNNING = 'var(--lab-running)'

type AnyStatus = LabRunStatus | LabCaseStatus
export const STATUS: Record<AnyStatus, { label: string; color: string; icon: IconName }> = {
  passed: { label: 'Passed', color: GOOD, icon: 'check' },
  failed: { label: 'Failed', color: BAD, icon: 'x' },
  error: { label: 'Error', color: BAD, icon: 'alert' },
  skipped: { label: 'Skipped', color: INK3, icon: 'ban' },
  cancelled: { label: 'Cancelled', color: INK3, icon: 'stop' },
  running: { label: 'Running', color: RUNNING, icon: 'live' },
}

/** Plain words for a suite's requirements (lab.py requirements()). */
export const NEED_TEXT: Record<string, string> = {
  petta: 'PeTTa (PETTA_PATH)',
  chromadb: 'the chromadb MeTTa library (HIVE_CHROMADB_LIB)',
  'epistemic-resolve': 'the Epistemic Resolve harness (HIVE_EPISTEMIC_RESOLVE)',
  'demo-recording': 'a recording (this demo has none for it)',
}
export const needsText = (missing: string[]) => missing.map((n) => NEED_TEXT[n] ?? n).join(' and ')

export const total = (r: Pick<LabRunSummary, 'passed' | 'failed' | 'skipped' | 'errors'>) => r.passed + r.failed + r.skipped + r.errors

/** A metric or axis value with its unit, at a precision that suits its size. */
export function fmtValue(v: number, unit = '', opts: { short?: boolean } = {}): string {
  if (!Number.isFinite(v)) return '–'
  const a = Math.abs(v)
  if (unit === '$') return `$${a < 0.01 && v !== 0 ? v.toFixed(4) : v.toFixed(2)}`
  if (unit === 'ms') {
    if (a >= 10_000) return `${(v / 1000).toFixed(1)} s`
    if (a >= 1000) return `${(v / 1000).toFixed(2)} s`
    return `${a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2)} ms`
  }
  let num: string
  if (v === 0) num = '0'
  else if (a < 0.001) num = v.toExponential(0)
  else if (Number.isInteger(v)) num = a >= 10_000 && opts.short ? `${(v / 1000).toFixed(1)}k` : v.toLocaleString('en-US')
  else if (a < 1) num = v.toFixed(a < 0.1 ? 3 : 2)
  else if (a < 100) num = v.toFixed(a < 10 ? 2 : 1)
  else num = Math.round(v).toLocaleString('en-US')
  return unit ? `${num} ${unit}` : num
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '–'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  const m = Math.floor(ms / 60_000)
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`
}

export const BETTER_TEXT = { lower: 'lower is better', higher: 'higher is better', equal: 'must equal' } as const
export const BETTER_ARROW = { lower: '↓', higher: '↑', equal: '=' } as const

/** "≤ 150 ms", "≥ 20 ops/s", "= 0". */
export function targetText(m: Pick<LabMetric, 'better' | 'target' | 'unit'>): string | null {
  if (m.target == null) return null
  const op = m.better === 'lower' ? '≤' : m.better === 'higher' ? '≥' : '='
  return `${op} ${fmtValue(m.target, m.unit)}`
}

/**
 * A case's measure by name, else by a name it was known by before (host-wording r1: the host renamed
 * "subgoals accepted" to "subtasks accepted"; old and new runs are both served under the new name, with the old one
 * in `legacy_names`). An exact name always wins.
 */
export const findMetric = (c: LabCase | undefined, name: string) =>
  c?.metrics.find((m) => m.name === name) ?? c?.metrics.find((m) => formerNames([m], m.name).includes(name))

/**
 * The names a measure was known by before (`renamed_from` on an old record, `legacy_names` on the metric), from any of
 * the records given, never its own name, each once. Only a quiet detail: measures are paired on `name` alone.
 */
export function formerNames(records: (Pick<LabMetric, 'name' | 'legacy_names' | 'renamed_from'> | undefined)[], name: string): string[] {
  const out: string[] = []
  for (const m of records) {
    if (!m) continue
    for (const n of [m.renamed_from, ...(Array.isArray(m.legacy_names) ? m.legacy_names : [])]) {
      if (typeof n === 'string' && n.trim() && n !== name && !out.includes(n)) out.push(n)
    }
  }
  return out
}
/** "formerly ‘memory per …’" (or several, joined), for the quiet detail line; null when there is none. */
export const formerlyText = (names: string[]): string | null => (names.length ? `formerly ${names.map((n) => `‘${n}’`).join(', ')}` : null)
export const findSeries = (c: LabCase | undefined, name: string) => c?.series.find((s) => s.name === name)
export const caseKey = (c: Pick<LabCase, 'id'>) => c.id.split('::').pop() ?? c.id

/** Series that can share one chart: same x axis, same unit, bars apart from lines. */
export function groupSeries(series: LabSeries[]): LabSeries[][] {
  const groups = new Map<string, LabSeries[]>()
  for (const s of series) {
    const k = `${s.x}|${s.unit}|${s.kind === 'bar' ? 'bar' : 'line'}`
    const g = groups.get(k)
    if (g) g.push(s)
    else groups.set(k, [s])
  }
  return [...groups.values()]
}

/** Reference lines (counterfactuals, models, limits) are drawn dashed. */
export const isReference = (name: string) => /naive|budget|model|ceiling|target|limit|wanted|perfect|prediction|diagonal/i.test(name)

/** "goal state (0 open, 1 claimed, 2 waiting, 4 done)" → {0: "open", 1: "claimed", …} */
export function codedLabels(name: string): Record<number, string> | null {
  const inner = /\(([^)]*)\)/.exec(name)?.[1]
  if (!inner) return null
  const out: Record<number, string> = {}
  for (const part of inner.split(',')) {
    const m = /^\s*(-?\d+)\s+(.+?)\s*$/.exec(part)
    if (!m) return null
    out[Number(m[1])] = m[2]
  }
  return Object.keys(out).length >= 2 ? out : null
}

/** The bit of a series name before any "(…)" legend. */
export const seriesTitle = (name: string) => labText(name.replace(/\s*\([^)]*\)\s*$/, '') || name)

/**
 * The host's bench and test wording, said in the hive's words where the Lab shows it (uifix-r1, S2). The host's bench
 * list still names some measures by the retired words; the Lab says what they mean instead. Display only: measures,
 * cases and series are matched on the host's own names, never on these. The table is keyed on the text after the
 * word swap (so "… two winners" is first "tasks with two winners").
 */
const LAB_PHRASES: Record<string, string> = {
  'tasks with two winners': 'tasks claimed twice',
  'tasks with a winner': 'tasks with one owner',
  'winners per task': 'owners per task',
}
const PHRASE = new RegExp(`(?<![\\w])(${Object.keys(LAB_PHRASES).join('|')})(?![\\w])`, 'gi')
/** A host Lab string (case or measure name, notes, suite text, series or axis name) as a person reads it. */
export function labText(text: string | null | undefined): string {
  if (!text) return text ?? ''
  return ownerWords(shown(text)).replace(PHRASE, (m) => {
    const to = LAB_PHRASES[m.toLowerCase()]
    return m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to
  })
}

export interface VerdictStep {
  actual: string
  want: string
  ok: boolean
}

/** Epistemic Resolve case notes: "quarantine (want reject) → reject (want reject)". */
export function parseVerdicts(notes: string | null | undefined): VerdictStep[] | null {
  if (!notes) return null
  const steps = notes.split('→').map((p) => /^\s*([\w-]+)\s*\(want\s+([\w-]+)\)\s*$/.exec(p))
  if (!steps.length || steps.some((m) => !m)) return null
  return steps.map((m) => ({ actual: m![1], want: m![2], ok: m![1] === m![2] }))
}

/** Abandoned-goal notes: "posted: open; claimed by mind 1: claimed; …" → [{label, state}] */
export function parseEvents(notes: string | null | undefined): { label: string; state: string }[] | null {
  if (!notes || !notes.includes(';')) return null
  const out = notes.split(';').map((p) => {
    const i = p.lastIndexOf(':')
    return i < 0 ? null : { label: p.slice(0, i).trim(), state: p.slice(i + 1).trim() }
  })
  return out.every(Boolean) ? (out as { label: string; state: string }[]) : null
}

/** Value of a series at x: steps hold their last value, lines take the nearest point. */
export function valueAt(s: LabSeries, x: number): number | null {
  const pts = s.points
  if (!pts.length) return null
  if (s.kind === 'step') {
    let v: number | null = null
    for (const [px, py] of pts) {
      if (px <= x + 1e-9) v = py
      else break
    }
    return v
  }
  let best = pts[0]
  for (const p of pts) if (Math.abs(p[0] - x) < Math.abs(best[0] - x)) best = p
  return best[1]
}

export interface CaseFilter {
  status: 'all' | 'failed' | 'skipped'
  q: string
}

export function filterCases(cases: LabCase[], f: CaseFilter): LabCase[] {
  const q = f.q.trim().toLowerCase()
  return cases.filter((c) => {
    if (f.status === 'failed' && c.status !== 'failed' && c.status !== 'error') return false
    if (f.status === 'skipped' && c.status !== 'skipped') return false
    if (q && !`${c.name} ${labText(c.name)} ${c.group} ${c.id}`.toLowerCase().includes(q)) return false
    return true
  })
}

/** Groups in first-seen order, failing groups first. */
export function groupCases(cases: LabCase[]): { group: string; cases: LabCase[]; failed: number; passed: number; skipped: number }[] {
  const map = new Map<string, LabCase[]>()
  for (const c of cases) {
    const g = map.get(c.group)
    if (g) g.push(c)
    else map.set(c.group, [c])
  }
  const out = [...map.entries()].map(([group, list]) => ({
    group,
    cases: list,
    failed: list.filter((c) => c.status === 'failed' || c.status === 'error').length,
    passed: list.filter((c) => c.status === 'passed').length,
    skipped: list.filter((c) => c.status === 'skipped').length,
  }))
  return out.sort((a, b) => Number(b.failed > 0) - Number(a.failed > 0))
}

/** Progress of a running suite: by cases against the last run's count, else by time against the estimate. */
export function runProgress(cases: number, expected: number | null, elapsedMs: number, estimateS: number): number {
  const byTime = estimateS > 0 ? elapsedMs / (estimateS * 1000) : 0
  const byCases = expected ? cases / expected : null
  const p = byCases != null ? Math.max(byCases, Math.min(byTime, byCases + 0.5 / Math.max(1, expected!))) : byTime
  return Math.max(0.02, Math.min(0.98, p))
}

// ---- axes ----

export function niceStep(range: number, count = 4): number {
  if (range <= 0 || !Number.isFinite(range)) return 1
  const raw = range / count
  const exp = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / exp
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp
}

export function niceDomain(lo: number, hi: number, count = 4): { lo: number; hi: number; ticks: number[] } {
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 1
    lo -= pad
    hi += pad
  }
  const step = niceStep(hi - lo, count)
  const a = Math.floor(lo / step + 1e-9) * step
  const b = Math.ceil(hi / step - 1e-9) * step
  const ticks: number[] = []
  for (let t = a; t <= b + step * 1e-6; t += step) ticks.push(Math.round(t / step) * step)
  return { lo: a, hi: b, ticks }
}

// ---- dimensions (lab.py scorecard order) ----

export const DIM_ORDER = ['correctness', 'accuracy', 'latency', 'efficiency', 'resources', 'power', 'cost', 'reliability', 'bias', 'drift']

export const DIM: Record<string, { label: string; icon: IconName; blurb: string; sources: string[] }> = {
  correctness: { label: 'Correctness', icon: 'check', blurb: 'Unit, integration and end-to-end tests', sources: ['tests-hive', 'tests-runtime', 'tests-memory', 'tests-e2e', 'tests-ui'] },
  accuracy: { label: 'Accuracy', icon: 'target', blurb: 'Revision maths, Epistemic Resolve, task answers', sources: ['bench-core', 'bench-epistemic', 'bench-ops'] },
  latency: { label: 'Latency', icon: 'clock', blurb: 'Commons, gate, hub, gateway and reply times', sources: ['bench-core', 'bench-swarm', 'bench-ops'] },
  efficiency: { label: 'Efficiency', icon: 'gauge', blurb: 'Model calls, tokens and CPU per reply', sources: ['bench-swarm', 'bench-ops'] },
  resources: { label: 'Resources', icon: 'cpu', blurb: 'Memory, CPU, threads and files, idle and under load', sources: ['bench-ops'] },
  power: { label: 'Power', icon: 'bolt', blurb: 'Energy per reply and idle draw', sources: ['bench-ops'] },
  cost: { label: 'Cost', icon: 'coin', blurb: 'Budgets, spend ceilings and projected cost per reply', sources: ['bench-drift', 'bench-ops'] },
  reliability: { label: 'Reliability', icon: 'reset', blurb: 'Claim races, crashes, outages and restarts', sources: ['bench-core', 'bench-swarm', 'bench-ops'] },
  bias: { label: 'Bias', icon: 'scale', blurb: 'Same evidence, same treatment: subject, source, order, gate', sources: ['bench-bias'] },
  drift: { label: 'Drift', icon: 'wave', blurb: 'Echo storms, self-repetition, runaway tasks', sources: ['bench-drift'] },
}
export const dimMeta = (d: string) => DIM[d] ?? { label: d.charAt(0).toUpperCase() + d.slice(1), icon: 'sparkles' as IconName, blurb: '', sources: [] }

/** Measured values that are not direct readings say so. */
export function provenanceChips(c: Pick<LabCase, 'name' | 'notes'>): string[] {
  const out: string[] = []
  if (/\bEstimated\b/.test(c.notes ?? '')) out.push('estimated')
  if (/projected/i.test(c.name)) out.push('projected')
  return out
}

/** "a / b / c" (or "allow/pending/deny") as names for x = 0, 1, 2. */
export function categoricalX(s: Pick<LabSeries, 'x' | 'points'>): Record<number, string> | null {
  if (!s.x.includes('/')) return null
  const parts = s.x.split('/').map((p) => p.trim())
  if (parts.length !== s.points.length || !s.points.every(([x], i) => x === i)) return null
  return Object.fromEntries(parts.map((p, i) => [i, p]))
}

export const DEMO_LABEL: Record<NonNullable<LabRunSummary['demo']>, { label: string; title: string }> = {
  recorded: { label: 'recorded', title: 'Real results from the recording' },
  example: { label: 'example', title: 'Example history for the demo: the recording with small jitter. Not a real run.' },
  replay: { label: 'replay', title: 'The recorded run, replayed in the browser' },
}

