/**
 * Create's plan view as the page draws it (pure; no React, no reads). The host's plan engine (create_plan_engine.py,
 * reducer R4.1) serves a PlanView (./contract.ts); this module parses it strictly and tolerantly, then words it: the
 * engine's status in one plain line, the plan-level timeline (Plan → Tests first → Build → Check → Review → Ready →
 * Deployed), one row per piece, the open questions, the person's deploy go, which file the code pane shows (and at
 * which checkpoint the files route reads it) and the board's assignee lanes.
 *
 * Parsing: a field of the wrong type falls back to its empty value; a malformed sub-item (piece, question, check,
 * action) is dropped alone, never the whole view; unknown fields are ignored; an unknown phase, status or state is kept
 * as a string and worded plainly. Only a view without a plan id is refused (null). Older provisional and sim shapes
 * (assignee.name, inline draft text, checkpoint files, summary lines, answered objects) are still read.
 *
 * Words: plain, no ids, digests or internal codes.
 */
import type { ArtifactKind, Assignee, PieceReview, PlanAction, PlanCheck, PlanCheckpoint, PlanPiece, PlanPreview, PlanQuestion, PlanStatus, PlanSummary, PlanView, PreviewFiles } from './contract'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const list = <T>(v: unknown, f: (x: unknown) => T | null): T[] => (Array.isArray(v) ? v.map(f).filter((x): x is T => x !== null) : [])

/** a stable hue for an id (a builder the hive's minds do not name) */
export function hueOf(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % 360
}

/** what the page knows of a mind by id (the hive's minds: name and hue), for naming a builder */
export type MindLookup = (id: string) => { name: string; hue: number } | null

// ------------------------------------------------------------------ parse

function parseAssignee(v: unknown, team: string): Assignee {
  if (isObj(v) && typeof v.kind === 'string') {
    const ref = str(v.ref)
    return {
      selector: Array.isArray(v.selector) ? v.selector : null, kind: v.kind, ref,
      resolved: typeof v.resolved === 'boolean' ? v.resolved : ref !== null,
      display: str(v.display) ?? str(v.name) ?? (team || ref || v.kind), detail: str(v.detail), taken_by: str(v.taken_by),
    }
  }
  // the engine before a resolution, or an older view: the team is all it says
  if (team) return { selector: null, kind: 'team', ref: team.toLowerCase(), resolved: true, display: team, detail: null, taken_by: null }
  return { selector: null, kind: 'open', ref: null, resolved: false, display: 'not assigned yet', detail: null, taken_by: null }
}

const REVIEW_STATES = ['pending', 'passed', 'failed', 'unavailable', 'waived'] as const
/** a review kind as the artifact it is for: code-review / review → code, design-review → design */
function reviewKindOf(rk: string | null): string | null {
  if (rk === null) return null
  const k = rk.replace(/[-_ ]?review$/i, '')
  return k || 'code'
}
function parseReview(v: unknown, kind: string, unreviewed: boolean): PieceReview | null {
  const waived: PieceReview = { kind, state: 'waived', decision: null, reviewer: null, notes: null, evidence: null, candidate: null }
  if (!isObj(v)) return unreviewed ? waived : null
  const raw = str(v.state)
  const decision = v.decision === 'pass' || v.decision === 'fail' ? v.decision : null
  let state: PieceReview['state']
  if (raw && (REVIEW_STATES as readonly string[]).includes(raw)) state = raw as PieceReview['state']
  else if (decision === 'pass') state = 'passed'
  else if (decision === 'fail') state = 'failed'
  else if (raw) state = 'pending' // the engine's effect states (journaled, sent, unknown…): asked, not answered yet
  else return unreviewed ? waived : null
  if (state === 'unavailable' && unreviewed) state = 'waived'
  const ev = v.evidence
  return {
    kind: reviewKindOf(str(v.kind)) ?? kind, state, decision, reviewer: str(v.reviewer), notes: str(v.notes),
    evidence: str(ev) ?? (isObj(ev) ? str(ev.ref) : null), candidate: str(v.candidate),
  }
}

function parseBuilder(b: unknown, assignee: Assignee, minds?: MindLookup): PlanPiece['builder'] {
  if (isObj(b) && typeof b.id === 'string' && typeof b.name === 'string') return { id: b.id, name: b.name, hue: num(b.hue) }
  if (typeof b !== 'string' || !b) return null
  const known = minds?.(b) ?? null
  // never an id on the page: the hive's name for the mind, else who the piece is assigned to
  return { id: b, name: known?.name ?? (assignee.resolved ? assignee.display : 'A builder'), hue: known?.hue ?? hueOf(b) }
}

function parsePiece(v: unknown, minds?: MindLookup): PlanPiece | null {
  if (!isObj(v)) return null
  const id = str(v.id)
  if (!id) return null
  const team = str(v.team) ?? ''
  const tests = v.tests === true
  const kinds = strs(v.kinds)
  const kind = str(v.kind) ?? kinds[0] ?? (tests ? 'test' : team.toLowerCase() === 'studio' ? 'design' : 'code')
  const assignee = parseAssignee(v.assignee, team)
  const files = strs(v.files)
  const d = v.draft
  const draft = isObj(d) && typeof d.path === 'string' && typeof d.content === 'string'
    ? { path: d.path, content: d.content, ...(typeof d.at === 'string' ? { at: d.at } : {}) }
    : null
  const candidate = str(v.candidate) ?? (typeof d === 'string' ? d : null)
  const unreviewed = v.unreviewed === true
  const state = str(v.state) ?? str(v.status) ?? 'waiting'
  return {
    id, title: str(v.title) ?? id, team, assignee, kind, kinds: kinds.length ? kinds : [kind],
    deps: strs(v.deps), files, state, builder: parseBuilder(v.builder, assignee, minds),
    editing: str(v.editing) ?? (v.editing === true ? files[0] ?? null : null), draft, candidate,
    passed_reviews: strs(v.passed_reviews), unreviewed,
    repairs: Math.max(0, Math.floor(num(v.repairs))), review: parseReview(v.review, kind, unreviewed), tests,
  }
}

function parseAbout(a: unknown): PlanQuestion['about'] {
  if (a === 'deploy') return { kind: 'deploy' }
  if (a === 'blocked') return { kind: 'blocked' }
  if (isObj(a)) {
    if (typeof a.piece === 'string' && (a.kind === undefined || a.kind === 'piece')) return { kind: 'piece', piece: a.piece }
    if (a.kind === 'deploy') return { kind: 'deploy' }
    if (a.kind === 'blocked') return { kind: 'blocked' }
  }
  return { kind: 'plan' }
}

function parseQuestion(v: unknown): PlanQuestion | null {
  if (!isObj(v)) return null
  const q = str(v.q)
  const text = str(v.text)
  if (!q || !text) return null
  const an = v.answered
  const answered = isObj(an) && typeof an.text === 'string' ? { text: an.text, at: str(an.at) ?? '' }
    : an === true ? { text: str(v.answer) ?? '', at: '' } : null
  return { q, about: parseAbout(v.about), text, choices: strs(v.choices), answered }
}

/** a check's state: the engine's outcome (pass / fail / unknown) or its effect state while it runs */
function checkState(s: string): PlanCheck['state'] {
  if (s === 'pass' || s === 'passed') return 'passed'
  if (s === 'fail' || s === 'failed') return 'failed'
  if (s === 'unknown' || s === 'done') return 'unknown'
  return 'running'
}
/** the check's decisive line in plain words: the engine's `CREATE-CHECK {passed, failing, notes}` line becomes its
 * first note (else "passed" / the failing files); any other line is kept as it is */
export function checkWords(line: string | null): string | null {
  if (!line) return null
  if (!line.startsWith('CREATE-CHECK')) return line
  const m = /^CREATE-CHECK (\{.*\})\s*$/.exec(line)
  if (!m) return null
  try {
    const d = JSON.parse(m[1]) as { passed?: unknown; failing?: unknown; notes?: unknown }
    const notes = strs(d.notes)
    if (notes.length) return notes[0]
    if (d.passed === true) return 'All passed'
    const failing = strs(d.failing)
    return failing.length ? `Failing in ${failing.join(', ')}` : null
  } catch {
    return null
  }
}
function parseCheck(v: unknown): PlanCheck | null {
  if (!isObj(v)) return null
  const run = str(v.run)
  const state = str(v.state)
  if (!run || !state) return null
  return { run, ckpt: str(v.ckpt) ?? '', base: v.base === true, state: checkState(state), failing: strs(v.failing), line: checkWords(str(v.line)), output: str(v.output) }
}

function parseFiles(v: unknown): Record<string, string> | null {
  if (!isObj(v)) return null
  const files: Record<string, string> = {}
  for (const [k, c] of Object.entries(v)) if (typeof c === 'string') files[k] = c
  return files
}

function parseCheckpoint(v: unknown): PlanCheckpoint | null {
  if (!isObj(v)) return null
  const ckpt = str(v.ckpt)
  if (!ckpt) return null
  const files = parseFiles(v.files)
  return {
    ckpt, workspace: str(v.workspace),
    ...(files ? { files } : {}), ...(typeof v.at === 'string' ? { at: v.at } : {}),
    ...(v.piece === null || typeof v.piece === 'string' ? { piece: v.piece } : {}),
  }
}

function parsePreview(v: unknown): PlanPreview | null {
  if (!isObj(v) || typeof v.ckpt !== 'string') return null
  return { ckpt: v.ckpt, ref: str(v.ref), digest: str(v.digest) }
}

function parseAction(v: unknown): PlanAction | null {
  if (!isObj(v)) return null
  if (v.name !== 'deploy' && v.name !== 'answer' && v.name !== 'stop') return null
  if (typeof v.available !== 'boolean') return null
  return { name: v.name, available: v.available, why_not: str(v.why_not) }
}

/** the phase as a status, for a view without one (the engine's own mapping, create_plan_engine._status) */
const PHASE_STATUS: Record<string, PlanStatus> = {
  claimed: 'planning', planning: 'planning', planned: 'writing_tests', designing: 'designing', designed: 'writing_tests',
  'testing-authored': 'checking_tests_are_red', building: 'building', fixing: 'fixing', integrating: 'integrating',
  checking: 'checking', previewing: 'previewing', 'ready-to-deploy': 'ready_to_deploy', deployed: 'deployed',
  stopped: 'stopped', blocked: 'needs_you',
}
export const statusOfPhase = (phase: string): string => PHASE_STATUS[phase] ?? phase

/** The host's view, parsed; null only when it is not a plan view at all (no plan id). */
export function parsePlanView(raw: unknown, minds?: MindLookup): PlanView | null {
  if (!isObj(raw)) return null
  const plan_id = str(raw.plan_id)
  if (!plan_id) return null
  const phase = str(raw.phase) ?? 'claimed'
  const title = str(raw.title)
  const ins = raw.installed
  const insId = isObj(ins) ? str(ins.program_id) ?? str(ins.app_id) : null
  const view: PlanView = {
    plan_id,
    sentence: str(raw.sentence) ?? '',
    title,
    acceptance: strs(raw.acceptance),
    phase,
    status: str(raw.status) ?? statusOfPhase(phase),
    status_line: null,
    next_action: str(raw.next_action),
    last_error: str(raw.last_error),
    review_policy: str(raw.review_policy),
    pieces: list(raw.pieces, (x) => parsePiece(x, minds)),
    questions: list(raw.questions, parseQuestion),
    checks: list(raw.checks, parseCheck),
    checkpoint: parseCheckpoint(raw.checkpoint),
    preview: parsePreview(raw.preview),
    summary: Array.isArray(raw.summary) ? strs(raw.summary) : null,
    unreviewed: raw.unreviewed === true,
    actions: list(raw.actions, parseAction),
    installed: isObj(ins) && insId ? { app_id: insId, name: str(ins.name) ?? title ?? 'your app' } : null,
    journal: list(raw.journal, (j) => (isObj(j) && typeof j.kind === 'string'
      ? { seq: num(j.seq), id: str(j.id) ?? '', kind: j.kind, verdict: str(j.verdict) ?? '', at: str(j.at) ?? '' } : null)),
    effects: list(raw.effects, (e) => (isObj(e) && typeof e.kind === 'string' ? { kind: e.kind, op: str(e.op) ?? '', state: str(e.state) ?? '' } : null)),
    updated_at: str(raw.updated_at) ?? '',
  }
  view.status_line = statusLine(view)
  return view
}

/** GET /api/create/plans: the person's plans (malformed rows dropped). */
export function parsePlanList(raw: unknown): PlanSummary[] {
  const rows = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.plans) ? raw.plans : []
  return list(rows, (r) => {
    if (!isObj(r) || typeof r.plan_id !== 'string') return null
    const phase = str(r.phase) ?? ''
    return { plan_id: r.plan_id, sentence: str(r.sentence) ?? '', phase, status: str(r.status) ?? statusOfPhase(phase), updated_at: str(r.updated_at) ?? '' }
  })
}

const FINISHED = new Set(['deployed', 'stopped'])
/** the plan to pick up again on the bench: the newest one still going (the list is newest first) */
export function runningPlan(plans: PlanSummary[]): PlanSummary | null {
  return plans.find((p) => !FINISHED.has(p.status) && !FINISHED.has(p.phase)) ?? null
}

/** GET …/preview: the verified preview files, or null when it is not that shape. */
export function parsePreviewFiles(raw: unknown): PreviewFiles | null {
  if (!isObj(raw)) return null
  const ref = str(raw.ref)
  const ckpt = str(raw.ckpt)
  const files = parseFiles(raw.files)
  if (!ref || !ckpt || !files) return null
  return { ref, ckpt, files }
}

/** GET …/files?path&ckpt: the file's text, or null when it is not that shape. */
export function parseFileText(raw: unknown): string | null {
  return isObj(raw) && typeof raw.content === 'string' ? raw.content : null
}

// ------------------------------------------------------------------ words

/** "Design review", "Code review", "Media review"… (the review follows the artifact's kind). */
export function reviewName(kind: ArtifactKind): string {
  const k = String(reviewKindOf(String(kind || 'code')) ?? 'code').replace(/[-_]+/g, ' ').trim()
  return `${k.charAt(0).toUpperCase()}${k.slice(1)} review`
}
const plainly = (s: string) => {
  const t = s.replace(/[-_]+/g, ' ').trim()
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}` : 'Unknown'
}
const lowerFirst = (s: string) => (s ? `${s.charAt(0).toLowerCase()}${s.slice(1)}` : s)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Every status the engine sends, in plain words (the head's status line). */
export const STATUS_WORDS: Record<PlanStatus, string> = {
  planning: 'Planning it…',
  designing: 'Designing it first…',
  writing_tests: 'Writing the acceptance test first…',
  checking_tests_are_red: 'Checking the test fails before anything is built…',
  building: 'Building the pieces…',
  fixing: 'Fixing what the check found…',
  integrating: 'Putting the pieces together…',
  checking: 'Checking the whole app…',
  previewing: 'Getting the preview ready…',
  asking_you: 'Waiting for your answer',
  ready_to_deploy: 'Ready to deploy: waiting for your go',
  deploying: 'Installing it…',
  deployed: 'Installed',
  needs_you: 'Stuck: it needs you',
  stopped: 'Stopped',
  checking_back: 'Checking what happened to the last step…',
  engine_error: 'The hive hit a problem with this plan',
  assignee_unavailable: 'Nobody can take one of the pieces right now',
}

/** One plain line of where the plan stands, from the engine's status (the phase for older views). */
export function statusLine(view: PlanView): string {
  const st = view.status
  const total = view.pieces.length
  if (st === 'building' && total > 0) {
    const inN = view.pieces.filter((p) => p.state === 'integrated').length
    const held = view.pieces.filter((p) => p.state === 'held').length
    return `Building: ${inN} of ${plural(total, 'piece')} in${held ? ` · ${held === 1 ? 'one piece waits' : `${held} pieces wait`} for your answer` : ''}`
  }
  if (st === 'deployed') return view.installed ? `Installed as ${view.installed.name}` : 'Installed'
  return (STATUS_WORDS as Record<string, string>)[st] ?? plainly(st)
}

export const openQuestions = (view: PlanView): PlanQuestion[] => view.questions.filter((q) => q.answered === null)

/** pieces held by an open question: the piece it is about and every piece that depends on it, however far */
function heldPieces(view: PlanView): Set<string> {
  const held = new Set<string>()
  const open = openQuestions(view)
  if (open.some((q) => q.about.kind === 'plan')) for (const p of view.pieces) if (p.state !== 'integrated') held.add(p.id)
  const seeds = open.flatMap((q) => (q.about.kind === 'piece' ? [q.about.piece] : []))
  const queue = [...seeds]
  while (queue.length) {
    const id = queue.shift()!
    if (held.has(id) && !seeds.includes(id)) continue
    held.add(id)
    for (const p of view.pieces) if (p.deps.includes(id) && !held.has(p.id)) queue.push(p.id)
  }
  return held
}

// ------------------------------------------------------------------ stages

export type PlanStageKey = 'plan' | 'tests' | 'build' | 'check' | 'review' | 'ready' | 'deployed'
export type PlanStageState = 'waiting' | 'active' | 'done' | 'failed' | 'skipped'
export interface PlanStage {
  key: PlanStageKey
  state: PlanStageState
  words: string
  /** the decisive output line (a check's), shown in mono */
  line?: string
  detail?: string
}

/** statuses that hold the plan until the person (or the hive) does something: the stage it was on turns failed */
const HELD_WORDS: Record<string, string> = {
  needs_you: 'Stuck: it needs your answer',
  stopped: 'Stopped',
  engine_error: 'The hive hit a problem here',
  assignee_unavailable: 'Nobody can take a piece right now',
}

/** The plan-level timeline; exactly one stage is active at a time (or none, once finished). */
export function planStages(view: PlanView): PlanStage[] {
  const { pieces } = view
  const st = view.status
  const total = pieces.length
  const integrated = pieces.filter((p) => p.state === 'integrated').length
  const base = view.checks.find((c) => c.base) ?? null
  const runs = view.checks.filter((c) => !c.base)
  const last = runs.length ? runs[runs.length - 1] : null
  const testsPiece = pieces.find((p) => p.tests) ?? null
  const finished = st === 'deployed'
  const atReady = st === 'previewing' || st === 'ready_to_deploy' || st === 'deploying' || finished
  const planning = st === 'planning'

  const plan: PlanStage = planning || (total === 0 && !finished)
    ? { key: 'plan', state: planning ? 'active' : 'waiting', words: planning ? 'Planning it…' : 'Plan' }
    : { key: 'plan', state: 'done', words: `A plan of ${plural(total, 'piece')}`, detail: pieces.map((p) => p.title).join(' · ') }

  let tests: PlanStage
  if (base?.state === 'failed') tests = { key: 'tests', state: 'done', words: 'The test fails first, as it should', ...(base.line ? { line: base.line } : {}) }
  else if (base?.state === 'passed') tests = { key: 'tests', state: 'failed', words: 'The test passed before anything was built; it has to fail first', ...(base.line ? { line: base.line } : {}) }
  else if (base?.state === 'running' || (plan.state === 'done' && st === 'checking_tests_are_red' && !base)) tests = { key: 'tests', state: 'active', words: 'Running the test on the empty app…' }
  else if (base?.state === 'unknown') tests = { key: 'tests', state: 'active', words: 'Checking what the first test run did…' }
  else if (plan.state === 'done' && (testsPiece || st === 'writing_tests') && !runs.length && !atReady)
    tests = { key: 'tests', state: 'active', words: 'Writing the acceptance test…' }
  else if (plan.state === 'done' && (runs.length || atReady)) tests = { key: 'tests', state: 'skipped', words: 'No acceptance test first' }
  else tests = { key: 'tests', state: 'waiting', words: 'Tests first' }

  const held = heldPieces(view)
  const heldCount = pieces.filter((p) => held.has(p.id) && p.state !== 'integrated').length
  let build: PlanStage
  if (runs.length || atReady || (total > 0 && integrated === total)) build = { key: 'build', state: 'done', words: `All ${plural(total, 'piece')} in` }
  else if (tests.state === 'done' || st === 'building' || st === 'integrating' || st === 'designing')
    build = { key: 'build', state: 'active', words: st === 'designing' ? 'Designing it first…' : `${integrated} of ${plural(total, 'piece')} in`, ...(heldCount ? { detail: `${plural(heldCount, 'piece')} waiting for your answer` } : {}) }
  else build = { key: 'build', state: 'waiting', words: 'Build' }

  let check: PlanStage
  const fixing = pieces.some((p) => p.state === 'fixing')
  if (!last) check = { key: 'check', state: 'waiting', words: 'Check' }
  else if (last.state === 'running' || last.state === 'unknown') check = { key: 'check', state: 'active', words: runs.length > 1 ? 'Checking again…' : 'Checking the whole app…' }
  else if (last.state === 'passed') check = { key: 'check', state: 'done', words: 'All checks pass', ...(last.line ? { line: last.line } : {}) }
  else if (fixing || st === 'fixing' || st === 'integrating' || st === 'building')
    check = { key: 'check', state: 'active', words: 'Fixing what the check found', ...(last.line ? { line: last.line } : {}) }
  else check = { key: 'check', state: 'failed', words: `${plural(Math.max(1, last.failing.length), 'check')} failed`, ...(last.line ? { line: last.line } : {}) }

  const reviews = pieces.map((p) => p.review)
  const reviewers = [...new Set(reviews.flatMap((r) => (r?.state === 'passed' && r.reviewer ? [r.reviewer] : [])))]
  let review: PlanStage
  if (view.unreviewed && (atReady || check.state === 'done')) review = { key: 'review', state: 'skipped', words: 'Not reviewed: your setting allowed it' }
  else if (total > 0 && pieces.every((p) => p.review?.state === 'passed') && (atReady || check.state === 'done'))
    review = { key: 'review', state: 'done', words: 'Reviewed', ...(reviewers.length ? { detail: `by ${reviewers.join(', ')}` } : {}) }
  else if (reviews.some((r) => r?.state === 'failed')) review = { key: 'review', state: 'active', words: 'A review asked for changes' }
  else review = { key: 'review', state: 'waiting', words: 'Review' }

  let ready: PlanStage
  if (st === 'previewing') ready = { key: 'ready', state: 'active', words: 'Getting the preview ready…' }
  else if (st === 'ready_to_deploy') ready = { key: 'ready', state: 'active', words: 'Ready to deploy', detail: 'Waiting for your go' }
  else if (st === 'deploying') ready = { key: 'ready', state: 'active', words: 'Ready to deploy', detail: 'Installing it…' }
  else if (finished) ready = { key: 'ready', state: 'done', words: 'Ready to deploy' }
  else ready = { key: 'ready', state: 'waiting', words: 'Ready' }

  const deployed: PlanStage = finished
    ? { key: 'deployed', state: 'done', words: view.installed ? `Installed as ${view.installed.name}` : 'Deployed' }
    : { key: 'deployed', state: 'waiting', words: 'Deploy' }

  const stages = [plan, tests, build, check, review, ready, deployed]
  // one active at a time: the furthest one along; earlier ones read as done
  const lastActive = stages.map((s) => s.state).lastIndexOf('active')
  stages.forEach((s, i) => { if (s.state === 'active' && i < lastActive) s.state = 'done' })
  // a held, stopped or failed plan: the stage it was on turns failed, saying why
  if (st in HELD_WORDS) {
    const at = lastActive >= 0 ? stages[lastActive] : stages.find((s) => s.state === 'failed') ?? stages.find((s) => s.state === 'waiting')
    if (at) { at.state = 'failed'; at.detail = HELD_WORDS[st] }
  } else if (lastActive < 0 && !finished && !stages.some((s) => s.state === 'failed') && !(st in STATUS_WORDS)) {
    // an unknown status: drawn plainly on the first stage still waiting
    const at = stages.find((s) => s.state === 'waiting')
    if (at) at.detail = plainly(st)
  }
  return stages
}

// ------------------------------------------------------------------ piece rows

export type PiecePhase = 'waiting' | 'held' | 'building' | 'testing' | 'review' | 'fixing' | 'integrated' | 'blocked'
export interface PieceRow {
  id: string
  title: string
  /** who it is assigned to (display name), and the full assignee */
  team: string
  assignee: Assignee
  kind: ArtifactKind
  files: string[]
  builder: PlanPiece['builder']
  phase: PiecePhase
  words: string
  repairs: number
  deps: string[]
  /** the review this piece calls for ("Design review", "Code review"…) */
  reviewName: string
}

function assigneeWords(a: Assignee): string {
  return a.resolved ? a.display : `${a.display} (finding who takes it)`
}

export function pieceRows(view: PlanView): PieceRow[] {
  const byId = new Map(view.pieces.map((p) => [p.id, p]))
  const held = heldPieces(view)
  const lastCheck = [...view.checks].reverse().find((c) => !c.base) ?? null
  return view.pieces.map((p) => {
    const who = assigneeWords(p.assignee)
    const rn = reviewName(p.review?.kind ?? p.kind)
    let phase: PiecePhase
    let words: string
    const pendingDeps = p.deps.filter((d) => byId.get(d)?.state !== 'integrated')
    if (p.state === 'integrated') {
      phase = 'integrated'
      const r = p.review
      words = r?.state === 'passed' ? `In the app · ${rn} passed` : r?.state === 'waived' || r?.state === 'unavailable' || p.unreviewed ? 'In the app · not reviewed' : 'In the app'
    } else if (p.state === 'blocked') {
      phase = 'blocked'; words = 'Stuck: it needs your answer'
    } else if (p.state === 'unassignable') {
      phase = 'blocked'; words = p.assignee.detail ? `Nobody can take it right now (${p.assignee.detail})` : 'Nobody can take it right now'
    } else if (p.state === 'held' || ((p.state === 'waiting') && held.has(p.id))) {
      phase = 'held'; words = 'Held by your question'
    } else if (p.state === 'waiting') {
      phase = 'waiting'
      words = pendingDeps.length
        ? `Waiting for ${pendingDeps.map((d) => lowerFirst(byId.get(d)?.title ?? 'another piece')).join(' and ')}`
        : p.assignee.taken_by ? `Waiting: ${who} is busy on another plan`
          : p.assignee.resolved ? 'Waiting for a free builder' : `Waiting for ${who}`
    } else if (p.state === 'started') {
      if (p.editing) { phase = 'building'; words = `${p.title} · ${who} · writing ${p.editing}` }
      else if (p.draft || p.candidate) { phase = 'testing'; words = `${p.title} · ${who} · testing its work` }
      else { phase = 'building'; words = `${p.title} · ${who} · thinking it through` }
    } else if (p.state === 'built' || p.state === 'reviewed') {
      phase = 'review'
      const r = p.review
      if (p.state === 'reviewed' || r?.state === 'passed') words = p.unreviewed && r?.state !== 'passed' ? 'Not reviewed: your setting allowed it' : `${rn} passed`
      else if (r?.state === 'waived' || r?.state === 'unavailable') words = 'Not reviewed: your setting allowed it'
      else words = r?.reviewer ? `${rn} with ${r.reviewer}` : `Waiting for ${lowerFirst(rn)}`
    } else if (p.state === 'fixing') {
      phase = 'fixing'
      words = p.review?.state === 'failed'
        ? `Fixing what the ${lowerFirst(rn)} found`
        : lastCheck?.state === 'failed' && lastCheck.line ? `Fixing: ${lastCheck.line}` : 'Fixing what the check found'
      if (p.editing) words += ` · writing ${p.editing}`
    } else {
      phase = 'waiting'; words = plainly(p.state)
    }
    return { id: p.id, title: p.title, team: p.assignee.display || p.team, assignee: p.assignee, kind: p.kind, files: p.files, builder: p.builder, phase, words, repairs: p.repairs, deps: p.deps, reviewName: rn }
  })
}

// ------------------------------------------------------------------ deploy go, the code pane

export function deployGo(view: PlanView): { available: boolean; why_not: string | null; unreviewed: boolean } {
  const a = view.actions.find((x) => x.name === 'deploy')
  if (a) return { available: a.available, why_not: a.available ? null : a.why_not ?? 'It isn’t ready yet.', unreviewed: view.unreviewed }
  return { available: false, why_not: view.status === 'deployed' ? 'It is already installed.' : 'It isn’t ready yet.', unreviewed: view.unreviewed }
}

export interface CurrentFile { path: string; content: string; piece: string; builder: PlanPiece['builder']; /** its builder is on it now */ writing: boolean }

/** file texts read through the files route, by checkpoint and path (null: not there at that checkpoint) */
export type FileTexts = Readonly<Record<string, string | null>>
export const fileKey = (ckpt: string, path: string): string => `${ckpt}\u0000${path}`
/** when each piece last changed, as the page heard it (create.plan.piece events; ms) */
export type Recent = Readonly<Record<string, number>>

/** Which piece's file the code pane shows, and where its text comes from (inline, or the files route at `ckpt`). */
export interface CodeTarget {
  piece: PlanPiece
  writing: boolean
  /** the checkpoint (or the piece's candidate) the files route reads; null when nothing is built yet */
  ckpt: string | null
  /** the files to try, in order (the first one there is shown) */
  paths: string[]
  /** older/sim views: the text inline */
  inline: { path: string; content: string } | null
}

const WRITING = new Set(['started', 'fixing'])
const BUILT = new Set(['built', 'reviewed'])
const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))]
function heardAt(p: PlanPiece, recent: Recent): number {
  const at = p.draft?.at ? Date.parse(p.draft.at) : NaN
  const r = recent[p.id]
  return Math.max(Number.isFinite(at) ? at : -Infinity, typeof r === 'number' ? r : -Infinity)
}

/**
 * The piece the code pane follows: of those being written (or built and waiting for review), the one changed most
 * recently (its draft's `at`, else the latest create.plan.piece event heard for it); then one being written over one
 * built, one typing a named file, and later in plan order. With none at work, the file the latest integration brought in.
 */
export function codeTarget(view: PlanView, recent: Recent = {}): CodeTarget | null {
  const order = new Map(view.pieces.map((p, i) => [p.id, i]))
  const latest = view.checkpoint?.ckpt ?? null
  const live = view.pieces.filter((p) => WRITING.has(p.state) || (BUILT.has(p.state) && (p.candidate || p.draft)))
  if (live.length) {
    const rank = (p: PlanPiece) => [heardAt(p, recent), WRITING.has(p.state) ? 1 : 0, p.editing ? 1 : 0, order.get(p.id)!] as const
    const best = live.reduce((a, b) => {
      const ra = rank(a); const rb = rank(b)
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] > ra[i] ? b : a
      return b
    })
    const inline = best.draft ? { path: best.draft.path, content: best.draft.content } : null
    return { piece: best, writing: WRITING.has(best.state), ckpt: best.candidate ?? latest, paths: uniq([best.draft?.path, best.editing, ...best.files]), inline }
  }
  const ck = view.checkpoint
  if (!ck) return null
  const has = (f: string) => !ck.files || f in ck.files
  const done = view.pieces.filter((p) => p.state === 'integrated' && p.files.some(has))
  if (!done.length) return null
  const piece = done.find((p) => p.id === ck.piece)
    ?? done.reduce((a, b) => (heardAt(b, recent) >= heardAt(a, recent) ? b : a))
  const paths = piece.files.filter(has)
  const inline = ck.files ? { path: paths[0], content: ck.files[paths[0]] } : null
  return { piece, writing: false, ckpt: ck.ckpt, paths, inline }
}

/** The file the code pane shows now, from the target and the texts read so far (null while its text is on its way). */
export function currentFile(view: PlanView, texts: FileTexts = {}, recent: Recent = {}): CurrentFile | null {
  const t = codeTarget(view, recent)
  if (!t) return null
  const out = (path: string, content: string): CurrentFile => ({ path, content, piece: t.piece.id, builder: t.piece.builder, writing: t.writing })
  if (t.inline) return out(t.inline.path, t.inline.content)
  if (!t.ckpt) return null
  for (const path of t.paths) {
    const c = texts[fileKey(t.ckpt, path)]
    if (typeof c === 'string') return out(path, c)
    if (c === undefined) {
      // its text at this checkpoint is on its way: the newest text read for the same file stays meanwhile
      const tail = `\u0000${path}`
      const prior = Object.keys(texts).reverse().find((k) => k.endsWith(tail) && typeof texts[k] === 'string')
      return prior ? out(path, texts[prior] as string) : null
    }
  }
  return null
}

/** The next file text the code pane needs from the files route (null: nothing to read). */
export function fileWant(view: PlanView, texts: FileTexts = {}, recent: Recent = {}): { ckpt: string; path: string } | null {
  const t = codeTarget(view, recent)
  if (!t || t.inline || !t.ckpt) return null
  for (const path of t.paths) {
    const c = texts[fileKey(t.ckpt, path)]
    if (c === undefined) return { ckpt: t.ckpt, path }
    if (typeof c === 'string') return null
  }
  return null
}

// ------------------------------------------------------------------ the board

export interface AssigneeLane { key: string; assignee: Assignee; pieces: PieceRow[] }
export interface Edge { from: string; to: string }

/** how deep a piece sits in the dependency graph (roots 0); a cycle or unknown dep never loops */
function depths(view: PlanView): Map<string, number> {
  const byId = new Map(view.pieces.map((p) => [p.id, p]))
  const memo = new Map<string, number>()
  const visit = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!
    const p = byId.get(id)
    if (!p || seen.has(id)) return 0
    seen.add(id)
    const d = p.deps.filter((x) => byId.has(x)).reduce((m, x) => Math.max(m, visit(x, seen) + 1), 0)
    seen.delete(id)
    memo.set(id, d)
    return d
  }
  for (const p of view.pieces) visit(p.id, new Set())
  return memo
}

const laneKey = (a: Assignee) => (a.kind === 'open' || !a.resolved ? `open:${a.kind}:${a.ref ?? a.display}` : `${a.kind}:${a.ref ?? a.display}`)

/** One lane per distinct assignee (first appearance order, open or unresolved ones last), pieces by depth, plus edges. */
export function assigneeLanes(view: PlanView): { lanes: AssigneeLane[]; edges: Edge[] } {
  const rows = pieceRows(view)
  const depth = depths(view)
  const order = new Map(view.pieces.map((p, i) => [p.id, i]))
  const lanes = new Map<string, AssigneeLane>()
  for (const r of rows) {
    const k = laneKey(r.assignee)
    if (!lanes.has(k)) lanes.set(k, { key: k, assignee: r.assignee, pieces: [] })
    lanes.get(k)!.pieces.push(r)
  }
  for (const l of lanes.values()) l.pieces.sort((a, b) => (depth.get(a.id)! - depth.get(b.id)!) || (order.get(a.id)! - order.get(b.id)!))
  const all = [...lanes.values()]
  const isOpen = (l: AssigneeLane) => l.key.startsWith('open:')
  const ids = new Set(view.pieces.map((p) => p.id))
  return {
    lanes: [...all.filter((l) => !isOpen(l)), ...all.filter(isOpen)],
    edges: view.pieces.flatMap((p) => p.deps.filter((d) => ids.has(d)).map((d) => ({ from: d, to: p.id }))),
  }
}

// ------------------------------------------------------------------ the running page

/**
 * A checkpoint's files as the app frame takes them (lib/appFrame appDocument): index.html, style.css and app.js, plus the
 * rest of the bundle but checks/, so appDocument can inline what the page links by a relative path (an icon in
 * index.html, a font or image in style.css) as data: URIs, the only way the frame's CSP lets them load (the host's
 * frame_document does the same). Null when a required file is missing.
 */
export function frameFiles(files: Record<string, string>): { 'index.html': string; 'style.css': string; 'app.js': string; [part: string]: string } | null {
  const html = files['index.html']
  const css = files['style.css']
  const js = files['app.js']
  if (typeof html !== 'string' || typeof css !== 'string' || typeof js !== 'string') return null
  // the whole bundle but the check: appDocument inlines the files index.html and style.css reference (an icon, a font)
  const bundle = Object.fromEntries(Object.entries(files).filter(([path, text]) => typeof text === 'string' && !path.startsWith('checks/')))
  return { ...bundle, 'index.html': html, 'style.css': css, 'app.js': js }
}
