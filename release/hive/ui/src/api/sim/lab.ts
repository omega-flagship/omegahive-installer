import { ApiError } from '../client'
import type {
  HiveEvent,
  LabCase,
  LabCaseStatus,
  LabHistory,
  LabHistoryMetric,
  LabKind,
  LabMetric,
  LabRun,
  LabRunStatus,
  LabRunSummary,
  LabScorecardEntry,
  LabSeries,
  LabSuite,
} from '../types'
import { DEMO_STALLED_RUN } from './demo3'

/**
 * The simulator's Lab. It never invents results: every case comes from a real recording made with
 * `python3 -m hive.bench record` (fixtures/lab-record.json). "Run" replays a suite's recorded cases
 * with their recorded pacing, compressed to at most ~20 s. A few earlier runs are synthesised from
 * the recording (small jitter on metrics) so trend charts have a shape; those are marked
 * `demo: "example"` and the UI labels them as example history.
 */

// ---- the recording's shape (hive/bench/__main__.py record) ----

export interface RecordedCase {
  id: string
  name: string
  group?: string
  dimension?: string
  status: LabCaseStatus
  duration_ms?: number | null
  message?: string | null
  notes?: string | null
  metrics?: LabMetric[]
  series?: LabSeries[]
}
export interface RecordedRun {
  suite: string
  status: LabRunStatus
  /** unix seconds */
  started: number
  finished: number
  cases: RecordedCase[]
}
export interface LabRecord {
  runs: RecordedRun[]
}

/** hive/bench/catalog.py, mirrored so the demo can list suites the recording lacks. */
export const SIM_SUITES: { id: string; kind: LabKind; title: string; description: string; estimate_s: number; needs: string[] }[] = [
  { id: 'tests-hive', kind: 'tests', title: 'Hive server tests', description: 'API, policy, tasks, schedule, drift guards and the Docker driver, against real PeTTa spaces.', estimate_s: 10, needs: [] },
  { id: 'tests-runtime', kind: 'tests', title: 'Omega runtime tests', description: 'The agent runtime: command parser, memory paths, modules, attention, recall, persistence.', estimate_s: 15, needs: [] },
  { id: 'tests-memory', kind: 'tests', title: 'Memory safety (boots Omega)', description: 'Boots the real runtime: separate memory per mind, protected atoms survive bounding, atomic saves.', estimate_s: 20, needs: ['petta', 'chromadb'] },
  { id: 'tests-e2e', kind: 'tests', title: 'End to end with real Omegas', description: 'Three Omegas chat, publish and revise, survive a restart; approvals, tasks, memory control and a mixed Omega + Iter swarm.', estimate_s: 120, needs: ['petta', 'chromadb'] },
  { id: 'tests-ui', kind: 'tests', title: 'Web UI tests', description: 'Store, simulator and helpers of the web UI (vitest).', estimate_s: 10, needs: [] },
  { id: 'bench-core', kind: 'bench', title: 'Hive performance', description: 'Throughput and latency of the commons, gate, hub and gateway; revision accuracy; claim races.', estimate_s: 40, needs: [] },
  { id: 'bench-drift', kind: 'bench', title: 'Drift scenarios', description: 'Failure modes from DRIFT.md provoked on purpose: echo storms, retry storms, spend runaway, abandoned tasks, subtask explosions.', estimate_s: 20, needs: [] },
  { id: 'bench-bias', kind: 'bench', title: 'Bias and invariance', description: 'The same evidence must get the same treatment whatever the claim is about, whoever reports it and in whatever order; the policy gate must treat every mind alike.', estimate_s: 25, needs: [] },
  { id: 'bench-ops', kind: 'bench', title: 'Operations: resources, power, cost, reliability', description: 'A live three-Omega swarm: memory, CPU and disk idle and under load; energy per reply; projected cost per model; efficiency; task accuracy; crash, outage and restart recovery.', estimate_s: 200, needs: ['petta', 'chromadb'] },
  { id: 'bench-epistemic', kind: 'bench', title: 'Epistemic Resolve', description: "Crawford & Hammer's disciplined-update benchmark (AGI-26) run through the swarm commons, next to the paper's calibration mocks.", estimate_s: 10, needs: ['epistemic-resolve'] },
  { id: 'bench-swarm', kind: 'bench', title: 'Live Omega swarm', description: 'Three real Omegas on the offline model: boot time, reply latency, belief propagation, loop health.', estimate_s: 150, needs: ['petta', 'chromadb'] },
]

/** What the demo reports as missing for a suite the recording does not contain. */
export const NOT_RECORDED = 'demo-recording'

export interface SimLabOptions {
  emit: (e: HiveEvent) => void
  rng: () => number
  /** Loads the recording; defaults to the lazily imported fixture. */
  load?: () => Promise<LabRecord>
  /** Longest a replay may take (ms). */
  maxReplayMs?: number
  /** Shortest a replay may take (ms), so a 1 s suite still visibly streams. */
  minReplayMs?: number
  /** Synthetic example runs per recorded suite. */
  examples?: number
  /** Simulated REST latency. */
  latency?: boolean
  /**
   * Demo mode (D3, api/sim/demo3.ts): every run carries an INVENTED version (commit) so two versions can be compared,
   * and one suite has an example run that stopped making progress (stalled, still marked running).
   */
  demo?: boolean
}

const iso = (ms: number) => new Date(ms).toISOString()
const DAY = 86_400_000
const clone = <T,>(v: T): T => structuredClone(v)

export const DIMENSIONS = ['correctness', 'accuracy', 'latency', 'efficiency', 'resources', 'power', 'cost', 'reliability', 'bias', 'drift']

export function normaliseCase(c: RecordedCase, runId: string, suite = ''): LabCase {
  return {
    run_id: runId,
    id: String(c.id),
    name: String(c.name ?? c.id),
    group: String(c.group ?? ''),
    // recordings from before dimensions existed
    dimension: c.dimension || (suite.startsWith('tests') ? 'correctness' : 'drift'),
    status: c.status ?? 'error',
    duration_ms: c.duration_ms ?? null,
    message: c.message ?? null,
    notes: c.notes ?? null,
    metrics: (c.metrics ?? []).map((m) => ({ ...m, unit: m.unit ?? '', target: m.target ?? null, ok: m.ok ?? null })),
    series: (c.series ?? []).map((s) => ({ ...s, unit: s.unit ?? '', x: s.x ?? 'step', kind: s.kind ?? 'line', points: s.points ?? [] })),
  }
}

export function judge(value: number, better: LabMetric['better'], target: number | null): boolean | null {
  if (target == null) return null
  if (better === 'lower') return value <= target
  if (better === 'higher') return value >= target
  return Math.abs(value - target) < 1e-9
}

function summary(r: LabRun): LabRunSummary {
  const { log: _log, cases: _cases, ...rest } = r
  void _log
  void _cases
  return { ...rest }
}

/** An INVENTED version id for a demo run (hex, from the run id): never a real commit. */
export function inventedVersion(id: string): string {
  let h = 0x811c9dc5
  let g = 0x1b873593
  for (const c of id) {
    h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0
    g = Math.imul(g ^ c.charCodeAt(0), 0x5bd1e995) >>> 0
  }
  return (h.toString(16).padStart(8, '0') + g.toString(16).padStart(8, '0')).slice(0, 12)
}

function count(cases: LabCase[]) {
  const c = { passed: 0, failed: 0, skipped: 0, errors: 0 }
  for (const x of cases) {
    if (x.status === 'passed') c.passed++
    else if (x.status === 'failed') c.failed++
    else if (x.status === 'skipped') c.skipped++
    else c.errors++
  }
  return c
}

export class SimLab {
  private opts: Required<Omit<SimLabOptions, 'load' | 'demo'>> & { load: () => Promise<LabRecord>; demo?: boolean }
  private ready: Promise<void> | null = null
  private record = new Map<string, RecordedRun>()
  /** Every run, full, by id. */
  readonly runs = new Map<string, LabRun>()
  private timers = new Map<string, ReturnType<typeof setTimeout>[]>()
  private seq = 0

  constructor(options: SimLabOptions) {
    this.opts = {
      maxReplayMs: 20_000,
      minReplayMs: 2_500,
      examples: 6,
      latency: true,
      load: () => import('./fixtures/lab-record.json').then((m) => (m.default ?? m) as unknown as LabRecord),
      // an explicit undefined keeps the default
      ...(Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as SimLabOptions),
    }
  }

  private wait<T>(fn: () => T): Promise<T> {
    return this.ensure().then(
      () =>
        new Promise<T>((resolve, reject) => {
          const run = () => {
            try {
              resolve(fn())
            } catch (e) {
              reject(e)
            }
          }
          if (this.opts.latency) setTimeout(run, 60 + this.opts.rng() * 140)
          else run()
        }),
    )
  }

  ensure(): Promise<void> {
    this.ready ??= this.opts.load().then((rec) => this.seed(rec))
    return this.ready
  }

  private seed(rec: LabRecord) {
    for (const r of rec.runs ?? []) {
      // a later entry for the same suite wins (re-recordings appended to the file)
      this.record.set(r.suite, r)
    }
    for (const r of this.record.values()) {
      const started = r.started * 1000
      const finished = r.finished * 1000
      const id = `run_rec_${r.suite}`
      const cases = r.cases.map((c) => normaliseCase(c, id, r.suite))
      this.runs.set(id, {
        id,
        suite: r.suite,
        status: r.status,
        started_at: iso(started),
        finished_at: iso(finished),
        duration_ms: Math.round(finished - started),
        ...count(cases),
        commit_sha: null,
        demo: 'recorded',
        log: '',
        cases,
      })
      for (let k = 1; k <= this.opts.examples; k++) this.example(r, k, started, finished - started)
    }
    if (this.opts.demo) this.seedDemo()
  }

  /** Demo mode (D3): INVENTED versions on every run, and the stalled example run (see SimLabOptions.demo). */
  private seedDemo() {
    for (const r of this.runs.values()) r.commit_sha = inventedVersion(r.id)
    const rec = this.record.get(DEMO_STALLED_RUN.suite)
    if (!rec) return
    const id = `run_stalled_${rec.suite}`
    const startedMs = Date.now() - DEMO_STALLED_RUN.startedMinutesAgo * 60_000
    const cases = rec.cases.slice(0, DEMO_STALLED_RUN.cases).map((c) => normaliseCase(c, id, rec.suite))
    this.runs.set(id, {
      id,
      suite: rec.suite,
      status: 'running',
      started_at: iso(startedMs),
      finished_at: null,
      duration_ms: null,
      ...count(cases),
      commit_sha: inventedVersion(id),
      demo: 'example',
      log: `Example for the demo: the recording's first ${cases.length} cases, then no further progress. Not a real run.`,
      cases,
    })
  }

  /** Example history: the recorded run nudged a little, `k` days before the recording. */
  private example(r: RecordedRun, k: number, started: number, wall: number) {
    const rng = this.opts.rng
    const id = `run_ex${k}_${r.suite}`
    const at = started - k * DAY - Math.round(rng() * 5 * 3_600_000)
    const scale = 1 + (rng() - 0.5) * 0.24
    const cases = r.cases.map((raw) => {
      const c = normaliseCase(raw, id, r.suite)
      c.duration_ms = c.duration_ms == null ? null : Math.round(c.duration_ms * scale * (0.9 + rng() * 0.2) * 10) / 10
      c.metrics = c.metrics.map((m) => {
        if (m.better === 'equal' || !Number.isFinite(m.value)) return m
        // keep values that sit near their pass line exact: jitter must never flip a verdict
        const margin = m.target == null ? Infinity : Math.abs(m.value - m.target) / Math.max(Math.abs(m.target), 1e-9)
        if (margin < 0.3 || m.value === 0) return m
        const j = 1 + (rng() - 0.5) * 0.12
        let value = m.value * j
        if (Number.isInteger(m.value)) value = Math.round(value)
        value = Math.round(value * 1e6) / 1e6
        return { ...m, value, ok: judge(value, m.better, m.target) }
      })
      return c
    })
    const dur = Math.round(wall * scale)
    this.runs.set(id, {
      id,
      suite: r.suite,
      status: r.status,
      started_at: iso(at),
      finished_at: iso(at + dur),
      duration_ms: dur,
      ...count(cases),
      commit_sha: null,
      demo: 'example',
      log: 'Example history for the demo: synthesised from the recording with small jitter. Not a real run.',
      cases,
    })
  }

  private latest(suite: string): LabRun | undefined {
    let best: LabRun | undefined
    for (const r of this.runs.values()) if (r.suite === suite && (!best || r.started_at > best.started_at)) best = r
    return best
  }

  // ---------------------------------------------------------------- REST

  suites(): Promise<LabSuite[]> {
    return this.wait(() =>
      SIM_SUITES.map((s) => {
        const missing = this.record.has(s.id) ? [] : [NOT_RECORDED]
        const last = this.latest(s.id)
        return { ...s, needs: [...s.needs], missing, runnable: !missing.length, last_run: last ? summary(last) : null }
      }),
    )
  }

  listRuns(opts: { suite?: string; limit?: number } = {}): Promise<LabRunSummary[]> {
    return this.wait(() =>
      [...this.runs.values()]
        .filter((r) => !opts.suite || r.suite === opts.suite)
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .slice(0, opts.limit ?? 50)
        .map(summary),
    )
  }

  get(id: string): Promise<LabRun> {
    return this.wait(() => {
      const r = this.runs.get(id)
      if (!r) throw new ApiError(404, 'not_found', `no run ${id}`)
      return clone(r)
    })
  }

  history(suite: string, limit = 30): Promise<LabHistory> {
    return this.wait(() => {
      const runs = [...this.runs.values()]
        .filter((r) => r.suite === suite && r.status !== 'running')
        .sort((a, b) => a.started_at.localeCompare(b.started_at))
        .slice(-limit)
      const metrics = new Map<string, LabHistoryMetric>()
      for (const run of runs) {
        for (const c of run.cases) {
          for (const m of c.metrics) {
            const key = `${c.id}::${m.name}`
            let entry = metrics.get(key)
            if (!entry) {
              entry = { case_id: c.id, case: c.name, metric: m.name, unit: m.unit, better: m.better, target: m.target, points: [] }
              metrics.set(key, entry)
            }
            // as the host serves it (followups-r6): a renamed measure's old names, and the name an old run recorded
            if (m.legacy_names?.length) entry.legacy_names = [...m.legacy_names]
            entry.points.push({ run_id: run.id, at: run.started_at, value: m.value, ok: m.ok, ...(m.renamed_from ? { renamed_from: m.renamed_from } : {}) })
          }
        }
      }
      return { suite, runs: runs.map(summary), metrics: [...metrics.values()] }
    })
  }

  /** lab.py scorecard(): per dimension, from the latest finished (not cancelled) run of every suite. */
  scorecard(): Promise<LabScorecardEntry[]> {
    return this.wait(() => {
      const dims = new Map<string, LabScorecardEntry & { _suites: Set<string> }>()
      for (const suite of SIM_SUITES) {
        let run: LabRun | undefined
        for (const r of this.runs.values()) {
          if (r.suite === suite.id && r.status !== 'running' && r.status !== 'cancelled' && (!run || r.started_at > run.started_at)) run = r
        }
        if (!run) continue
        for (const c of run.cases) {
          let e = dims.get(c.dimension)
          if (!e) {
            e = { dimension: c.dimension, passed: 0, failed: 0, skipped: 0, errors: 0, score: null, suites: [], highlights: [], _suites: new Set() }
            dims.set(c.dimension, e)
          }
          if (c.status === 'passed') e.passed++
          else if (c.status === 'failed') e.failed++
          else if (c.status === 'skipped') e.skipped++
          else e.errors++
          e._suites.add(suite.id)
          for (const m of c.metrics) if (m.target != null && e.highlights.length < 6) e.highlights.push({ case: c.name, suite: suite.id, ...m })
        }
      }
      const out = [...dims.values()].map(({ _suites, ...e }) => {
        const judged = e.passed + e.failed + e.errors
        return { ...e, score: judged ? Math.round((e.passed / judged) * 1e4) / 1e4 : null, suites: [..._suites].sort() }
      })
      const rank = (d: string) => (DIMENSIONS.includes(d) ? DIMENSIONS.indexOf(d) : 99)
      return out.sort((a, b) => rank(a.dimension) - rank(b.dimension))
    })
  }

  start(suiteId: string): Promise<LabRun> {
    return this.wait(() => {
      const suite = SIM_SUITES.find((s) => s.id === suiteId)
      if (!suite) throw new ApiError(404, 'not_found', `no suite ${suiteId}`)
      for (const r of this.runs.values()) {
        if (r.suite === suiteId && r.status === 'running') throw new ApiError(409, 'already_running', `${suite.title} is already running`)
      }
      const rec = this.record.get(suiteId)
      if (!rec) throw new ApiError(400, 'missing_requirements', `${suite.title} is not in this demo's recording`)
      const id = `run_${Date.now().toString(36)}${(++this.seq).toString(36)}`
      const startedMs = Date.now()
      const run: LabRun = {
        id,
        suite: suiteId,
        status: 'running',
        started_at: iso(startedMs),
        finished_at: null,
        duration_ms: null,
        passed: 0,
        failed: 0,
        skipped: 0,
        errors: 0,
        commit_sha: this.opts.demo ? inventedVersion(id) : null,
        demo: 'replay',
        log: '',
        cases: [],
      }
      this.runs.set(id, run)
      this.emitRun(run)
      this.schedule(run, rec, startedMs)
      return clone(run)
    })
  }

  cancel(id: string): Promise<{ cancelling: true }> {
    return this.wait(() => {
      const run = this.runs.get(id)
      if (!run || run.status !== 'running') throw new ApiError(409, 'not_running', 'that run is not running')
      for (const t of this.timers.get(id) ?? []) clearTimeout(t)
      this.timers.delete(id)
      setTimeout(() => this.finish(run, 'cancelled'), 250)
      return { cancelling: true as const }
    })
  }

  stop(): void {
    for (const list of this.timers.values()) for (const t of list) clearTimeout(t)
    this.timers.clear()
  }

  // ---------------------------------------------------------------- replay

  /** When each recorded case lands, in ms from the start, paced by its recorded duration. */
  replayTimes(rec: RecordedRun): number[] {
    const wall = Math.max(0, (rec.finished - rec.started) * 1000)
    const total = Math.min(this.opts.maxReplayMs, Math.max(this.opts.minReplayMs, wall))
    const durs = rec.cases.map((c) => Math.max(0, c.duration_ms ?? 0))
    const sum = durs.reduce((a, b) => a + b, 0)
    // a small constant per case keeps 0 ms cases (and runner overhead) visibly spaced
    const eps = sum > 0 ? (sum / Math.max(1, durs.length)) * 0.15 + 1 : 1
    const denom = sum + eps * durs.length
    let acc = 0
    return durs.map((d) => {
      acc += d + eps
      return Math.round((acc / denom) * total)
    })
  }

  private schedule(run: LabRun, rec: RecordedRun, startedMs: number) {
    const times = this.replayTimes(rec)
    const timers: ReturnType<typeof setTimeout>[] = []
    const bench = run.suite.startsWith('bench-')
    rec.cases.forEach((raw, i) => {
      const at = times[i]
      if (bench && raw.id.split('::')[0] === run.suite) {
        const prev = i ? times[i - 1] : 0
        timers.push(setTimeout(() => this.opts.emit({ type: 'lab.log', at: iso(Date.now()), run_id: run.id, text: `running ${raw.name}` }), prev + 20))
      }
      timers.push(
        setTimeout(() => {
          const c = normaliseCase(raw, run.id, run.suite)
          run.cases.push(c)
          Object.assign(run, count(run.cases))
          this.opts.emit({ type: 'lab.case', at: iso(Date.now()), case: clone(c) })
          this.emitRun(run)
        }, at),
      )
    })
    const end = (times[times.length - 1] ?? 0) + 180
    timers.push(
      setTimeout(() => {
        const when = new Date(rec.started * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
        run.log = `Demo replay of the recording made ${when}: ${rec.cases.length} recorded cases, paced by their recorded durations (${Math.round((Date.now() - startedMs) / 100) / 10} s).`
        this.finish(run, rec.status)
      }, end),
    )
    this.timers.set(run.id, timers)
  }

  private finish(run: LabRun, status: LabRunStatus) {
    if (run.status !== 'running') return
    this.timers.delete(run.id)
    const finished = Date.now()
    run.status = status === 'passed' && (run.failed || run.errors) ? 'failed' : status
    run.finished_at = iso(finished)
    run.duration_ms = finished - Date.parse(run.started_at)
    this.emitRun(run)
  }

  private emitRun(run: LabRun) {
    this.opts.emit({ type: 'lab.run', at: iso(Date.now()), run: summary(run) })
  }
}
