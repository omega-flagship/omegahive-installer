/**
 * SIM: Create's plan engine for the plan view, in the host engine's own shape (hive/core/create_plan_engine.py view(),
 * list_for(), files(), the preview route; reducer R4.1). The page reads the sim and the live hive through the SAME
 * code path: checkpoint {ckpt, workspace} with no files, file text through the files route (a checkpoint or a piece's
 * candidate), the running page through the preview route's files. Deterministic and clock-driven, like
 * controllerSim.ts: each plan keeps its own queue of timed steps and every read (or the SimClient's ticker) runs the
 * steps that are due. Any sentence starts the scripted plan for "make me a small web page that shows the weather in
 * London" (the person's own words are kept). Invented minds and data only.
 *
 * Timeline (scale 1; SimClient passes scale 0 under vitest, so every step is due at once):
 *   0 s      planning
 *   4 s      planned (writing_tests): 4 pieces; the look question is raised at once and holds only `look`
 *   ~6.5 s   the acceptance check is authored: ckpt_0 = the scaffold + checks/acceptance_check.py (checking_tests_are_red)
 *   ~9 s     the base check is red ("1 failed: shows the temperature for London") → building
 *   then     lease 2: `layout` (Studio) and `logic` (Code) build in parallel, each streaming its file as a candidate a
 *            few lines at a time (a sim liberty: the engine names a candidate once the builder answers), then review
 *            2.5 s by Sable, then integrate (a new checkpoint); `icon` (Iris, a specialist mind) takes the next free
 *            slot; `look` waits for the person's answer and for `layout`, then follows the answer.
 *   all in   check (2.5 s) red on app.js: '1 failed: shows "°C" after the temperature' → `logic` fixing (repairs 1)
 *            → review → re-integrates → check green → previewing 2 s (a verified preview, create.plan.preview) →
 *            ready_to_deploy (deploy available) → the person's go → deploying 1.5 s → deployed.
 *
 * Flags (read when a plan starts): ?simplan=unreviewed (no reviewer can run: every review unavailable, pieces go on
 * unreviewed, `unreviewed`); ?simplan=fail (the fix fails twice → blocked (needs_you) with a hold question: "Try again"
 * fixes it, "Stop" stops the plan); ?simplan=hive (`logic` goes to the whole hive, unresolved, and resolves to a mind
 * 3 s after the plan is made).
 */
import { ApiError } from '../client'
import { appJs, CHECK_PATH, CHECK_PY, ICON_SVG, INDEX_HTML, paletteFor, SCAFFOLD, styleCss } from './planSimFiles'

export type PlanSimMode = 'normal' | 'unreviewed' | 'fail' | 'hive'

const MS = {
  plan: 4000, author: 2500, think: 1500, tick: 250, selfTest: 800, review: 2500, integrate: 600, check: 2500,
  preview: 2000, deploy: 1500, hiveResolve: 3000,
}
const LINES_PER_TICK = 2
const FIX_LINES_PER_TICK = 4
const LEASE = 2
const FIX_ROUNDS = 2
const UI_FILES = ['index.html', 'style.css', 'app.js'] as const

interface Mind { id: string; name: string; hue: number }
const WREN: Mind = { id: 'a_sim_wren', name: 'Wren', hue: 205 }
const ANVIL: Mind = { id: 'a_sim_anvil', name: 'Anvil', hue: 28 }
const IRIS: Mind = { id: 'a_sim_iris', name: 'Iris', hue: 300 }
const QUILL: Mind = { id: 'a_sim_quill', name: 'Quill', hue: 150 }
/** the invented minds by id (a test or a page names builders from the hive's minds; the engine sends only ids) */
export const SIM_PLAN_MINDS: Record<string, { name: string; hue: number }> = Object.fromEntries([WREN, ANVIL, IRIS, QUILL].map((m) => [m.id, { name: m.name, hue: m.hue }]))
const REVIEWER = 'Sable'

type Assignee = { selector: unknown[]; kind: string; ref: string | null; resolved: boolean; display: string; detail: string | null; taken_by: string | null }
const who = (selector: unknown[], kind: string, ref: string | null, display: string, resolved = true, detail: string | null = null): Assignee =>
  ({ selector, kind, ref, resolved, display, detail, taken_by: null })
const STUDIO = who(['team', 'studio'], 'team', 'studio', 'Studio')
const CODE = who(['team', 'code'], 'team', 'code', 'Code')
const IRIS_ASSIGNEE = who(['mind', 'a_sim_iris'], 'mind', 'a_sim_iris', 'Iris (illustrator)')
const WHOLE_HIVE = who(['hive', 'this', 'code'], 'hive', null, 'the whole hive', false, 'finding a mind across the hive')
const QUILL_ASSIGNEE = who(['hive', 'this', 'code'], 'mind', 'a_sim_quill', 'Quill (from the hive)')

const LOOK_Q = 'q_look'
const LOOK_TEXT = 'Should it look calm and minimal, or bright and playful?'
const BLOCKED_TEXT = 'I tried the allowed number of times (2) and it is still not right. Try again, or stop?'

const checkLine = (passed: boolean, failing: string[], notes: string[]) => `CREATE-CHECK ${JSON.stringify({ passed, failing, notes })}`

interface Review { kind: string; state: string; decision: 'pass' | 'fail' | null; reviewer: string | null; notes: string | null; evidence: string | null; candidate: string | null }
interface Piece {
  id: string; title: string; assignee: Assignee; kind: string; deps: string[]; files: string[]
  state: 'waiting' | 'held' | 'started' | 'built' | 'reviewed' | 'fixing' | 'integrated' | 'blocked'
  builder: Mind | null; mind: Mind; candidate: string | null; repairs: number; unreviewed: boolean; passed: string[]
  review: Review | null
  /** the finished text of each file as this round writes it */
  out: Record<string, string>
}
interface Question { q: string; about: string | { piece: string }; text: string; choices: string[]; answer: string | null }
interface Check { run: string; ckpt: string; base: boolean; state: string; failing: string[]; line: string | null; output: string | null }
interface Step { at: number; seq: number; fn: () => void }

interface Plan {
  id: string; sentence: string; mode: PlanSimMode; started: number; t: number; created: number
  phase: string; pieces: Piece[]; questions: Question[]; checks: Check[]
  /** integrated checkpoints in order, and every snapshot (checkpoints and candidates) by id */
  ckpts: string[]; snaps: Map<string, Record<string, string>>; cands: number
  preview: { ref: string; digest: string; app_id: string; source_digest: string; ckpt: string } | null
  unreviewed: boolean; installed: { program_id: string; digest: string; installed_at: string } | null
  deploying: boolean; baseRed: boolean; suite: boolean
  fixRounds: number; fixAttempts: number; queue: Step[]; seq: number
}

export interface PlanSimEvent { type: 'create.plan.status' | 'create.plan.piece' | 'create.plan.question' | 'create.plan.preview'; plan_id: string; [k: string]: unknown }

export interface PlanSimOptions {
  now?: () => number
  /** multiplies every delay; 0 makes every step due at once (vitest) */
  scale?: number
  mode?: () => PlanSimMode
  emit?: (e: PlanSimEvent) => void
}

const iso = (ms: number) => new Date(ms).toISOString()
const TERMINAL = new Set(['deployed', 'stopped'])
const PHASE_STATUS: Record<string, string> = {
  claimed: 'planning', planning: 'planning', planned: 'writing_tests', 'testing-authored': 'checking_tests_are_red',
  building: 'building', fixing: 'fixing', integrating: 'integrating', checking: 'checking', previewing: 'previewing',
  'ready-to-deploy': 'ready_to_deploy', deployed: 'deployed', stopped: 'stopped', blocked: 'needs_you',
}

export class SimPlans {
  private plans = new Map<string, Plan>()
  private n = 0
  constructor(private o: PlanSimOptions = {}) {}
  private now() { return this.o.now ? this.o.now() : Date.now() }
  private ms(d: number) { return d * (this.o.scale ?? 1) }

  // ---------------------------------------------------------------- routes

  /** POST /api/create/plans {sentence} */
  start(sentence: unknown): Record<string, unknown> {
    if (typeof sentence !== 'string' || !sentence.trim() || sentence.trim().length > 2000) throw new ApiError(400, 'bad_request', 'say what to make in 1-2000 characters')
    const mode = this.o.mode?.() ?? 'normal'
    const now = this.now()
    const p: Plan = {
      id: `plan_sim_${++this.n}`, sentence: sentence.trim(), mode, started: now, t: now, created: this.n, phase: 'planning', pieces: [],
      questions: [], checks: [], ckpts: [], snaps: new Map(), cands: 0, preview: null, unreviewed: false, installed: null,
      deploying: false, baseRed: false, suite: false, fixRounds: 0, fixAttempts: 0, queue: [], seq: 0,
    }
    this.plans.set(p.id, p)
    this.at(p, MS.plan, () => this.planned(p))
    this.o.emit?.({ type: 'create.plan.status', plan_id: p.id, phase: p.phase, status: this.status(p), next_action: this.nextAction(p) })
    return this.view(p)
  }
  /** GET /api/create/plans: the person's plans, newest first */
  list(): Record<string, unknown>[] {
    return [...this.plans.keys()].map((id) => this.tick(id)).sort((a, b) => b.created - a.created)
      .map((p) => ({ plan_id: p.id, sentence: p.sentence, phase: p.phase, status: this.status(p), updated_at: iso(p.t) }))
  }
  /** GET /api/create/plans/{id} */
  get(id: string): Record<string, unknown> { return this.view(this.tick(id)) }
  /** POST /api/create/plans/{id}/answers {q, text}: records the answer and releases what it held */
  answer(id: string, q: unknown, text: unknown): Record<string, unknown> {
    const p = this.tick(id)
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new ApiError(400, 'bad_request', 'an answer is 1-4000 characters')
    const qq = p.questions.find((x) => x.q === q)
    if (!qq || qq.answer !== null || TERMINAL.has(p.phase)) throw new ApiError(409, 'answer_refused', 'that answer was not taken')
    this.changed(p, () => {
      qq.answer = text.trim()
      if (qq.about === 'blocked') {
        if (/\bstop/i.test(text)) this.stopNow(p)
        else {
          // a fresh allowance: the held fixing phase comes back
          p.fixRounds = 0
          const logic = this.piece(p, 'logic')
          p.phase = 'fixing'
          this.routeFix(p, logic)
        }
      } else {
        for (const pc of p.pieces) if (pc.state === 'held' && !this.isHeld(p, pc)) pc.state = 'waiting'
        this.tryStart(p)
      }
    })
    return this.view(p)
  }
  /** POST /api/create/plans/{id}/deploy {}: the person's go */
  deploy(id: string): Record<string, unknown> {
    const p = this.tick(id)
    if (!this.deployReady(p)) throw new ApiError(409, 'deploy_refused', 'not ready to deploy')
    this.changed(p, () => {
      p.deploying = true
      this.at(p, MS.deploy, () => {
        p.deploying = false
        p.phase = 'deployed'
        p.installed = { program_id: 'london-weather', digest: p.preview?.digest ?? '', installed_at: iso(p.t) }
      })
    })
    return this.view(p)
  }
  /** POST /api/create/plans/{id}/stop {}: the person stops the plan (a finished plan just answers its view) */
  stop(id: string): Record<string, unknown> {
    const p = this.tick(id)
    if (!TERMINAL.has(p.phase)) this.changed(p, () => this.stopNow(p))
    return this.view(p)
  }
  /** GET /api/create/plans/{id}/files?path=&ckpt= ({ckpt, path, content}; without a path {ckpt, files}) */
  files(id: string, path?: string | null, ckpt?: string | null): Record<string, unknown> {
    const p = this.tick(id)
    const at = ckpt || p.ckpts[p.ckpts.length - 1]
    if (!at) throw new ApiError(404, 'not_found', 'nothing is built yet')
    const snap = p.snaps.get(at)
    if (!snap) throw new ApiError(404, 'not_found', 'not a checkpoint of this plan')
    if (path === undefined || path === null) return { ckpt: at, files: { ...snap } }
    if (!(path in snap)) throw new ApiError(404, 'not_found', 'no such file at that checkpoint')
    return { ckpt: at, path, content: snap[path] }
  }
  /** the client's one-file read (createPlanFile) */
  file(id: string, path: string, ckpt: string): Record<string, unknown> { return this.files(id, path, ckpt) }
  /** GET /api/create/plans/{id}/preview: the current preview's verified UI files */
  preview(id: string): { ref: string; ckpt: string; files: Record<string, string> } {
    const p = this.tick(id)
    if (!p.preview) throw new ApiError(404, 'not_found', 'no preview yet')
    const snap = p.snaps.get(p.preview.ckpt)!
    const files: Record<string, string> = Object.fromEntries(UI_FILES.map((f) => [f, snap[f]]))
    // a sim liberty: an image the page links is carried too, so the invented page shows its icon (the host's preview
    // bundle is the three UI files only)
    for (const m of snap['index.html'].matchAll(/\bsrc="\.\/([\w./-]+\.svg)"/g)) if (typeof snap[m[1]] === 'string') files[m[1]] = snap[m[1]]
    return { ref: p.preview.ref, ckpt: p.preview.ckpt, files }
  }
  /** run what is due on every unfinished plan (the SimClient's ticker); true while any plan is still moving */
  advanceAll(): boolean {
    let moving = false
    for (const id of this.plans.keys()) { const p = this.tick(id); if (p.queue.length) moving = true }
    return moving
  }

  // ---------------------------------------------------------------- the clock

  private tick(id: string): Plan {
    const p = this.plans.get(id)
    if (!p) throw new ApiError(404, 'not_found', `no plan ${id}`)
    const now = this.now()
    this.changed(p, () => {
      for (;;) {
        p.queue.sort((a, b) => a.at - b.at || a.seq - b.seq)
        const s = p.queue[0]
        if (!s || s.at > now) break
        p.queue.shift()
        p.t = s.at
        s.fn()
      }
      p.t = Math.max(p.t, now)
    })
    return p
  }
  private at(p: Plan, delay: number, fn: () => void) { p.queue.push({ at: p.t + this.ms(delay), seq: p.seq++, fn }) }

  /** run `fn`, then emit what changed, as the engine does: status on (phase, status, next_action), a piece on (state,
   * candidate, repairs), a question when shown and when answered, the preview when one is made */
  private changed(p: Plan, fn: () => void) {
    const head = () => [p.phase, this.status(p), this.nextAction(p)].join('|')
    const before = { head: head(), pieces: p.pieces.map((x) => `${x.state}|${x.candidate}|${x.repairs}`), qs: p.questions.map((q) => q.answer !== null), pv: p.preview?.ref ?? null }
    fn()
    const emit = this.o.emit
    if (!emit) return
    if (before.head !== head()) emit({ type: 'create.plan.status', plan_id: p.id, phase: p.phase, status: this.status(p), next_action: this.nextAction(p) })
    p.pieces.forEach((x, i) => {
      if (before.pieces[i] !== `${x.state}|${x.candidate}|${x.repairs}`) emit({ type: 'create.plan.piece', plan_id: p.id, piece: x.id, state: x.state, candidate: x.candidate, repairs: x.repairs })
    })
    p.questions.forEach((q, i) => {
      if (i >= before.qs.length) emit({ type: 'create.plan.question', plan_id: p.id, q: q.q, about: q.about, text: q.text, choices: [...q.choices], answered: false })
      else if (!before.qs[i] && q.answer !== null) emit({ type: 'create.plan.question', plan_id: p.id, q: q.q, answered: true })
    })
    if (p.preview && p.preview.ref !== before.pv) emit({ type: 'create.plan.preview', plan_id: p.id, ckpt: p.preview.ckpt, preview: p.preview.ref })
  }

  // ---------------------------------------------------------------- the plan

  private planned(p: Plan) {
    const hive = p.mode === 'hive'
    const mk = (id: string, title: string, assignee: Assignee, kind: string, files: string[], deps: string[], mind: Mind): Piece => ({
      id, title, assignee: { ...assignee }, kind, deps, files, state: 'waiting', builder: null, mind, candidate: null, repairs: 0,
      unreviewed: false, passed: [], review: null, out: {},
    })
    p.pieces = [
      mk('layout', 'The page and its layout', STUDIO, 'design', ['index.html'], [], WREN),
      mk('look', 'Colours and type', STUDIO, 'design', ['style.css'], ['layout'], WREN),
      mk('logic', 'Fetching and showing the weather', hive ? WHOLE_HIVE : CODE, 'code', ['app.js'], [], hive ? QUILL : ANVIL),
      mk('icon', 'A small weather icon', IRIS_ASSIGNEE, 'media', ['icon.svg'], [], IRIS),
    ]
    p.phase = 'planned'
    p.questions.push({ q: LOOK_Q, about: { piece: 'look' }, text: LOOK_TEXT, choices: ['Calm and minimal', 'Bright and playful'], answer: null })
    this.piece(p, 'look').state = 'held'
    if (hive) this.at(p, MS.hiveResolve, () => {
      this.piece(p, 'logic').assignee = { ...QUILL_ASSIGNEE }
      this.tryStart(p)
    })
    // tests first: the test author writes the acceptance check on the scaffold; it must fail there before building
    this.at(p, MS.author, () => {
      if (p.phase === 'stopped') return
      p.suite = true
      this.checkpoint(p, { ...SCAFFOLD, [CHECK_PATH]: CHECK_PY })
      p.phase = 'testing-authored'
      this.runCheck(p, true)
    })
  }

  private checkpoint(p: Plan, files: Record<string, string>): string {
    const ck = `ckpt_${p.ckpts.length}`
    p.ckpts.push(ck)
    p.snaps.set(ck, files)
    return ck
  }
  private latest(p: Plan): Record<string, string> { return p.snaps.get(p.ckpts[p.ckpts.length - 1]) ?? SCAFFOLD }

  private piece(p: Plan, id: string) { return p.pieces.find((x) => x.id === id)! }
  private openQs(p: Plan) { return p.questions.filter((q) => q.answer === null) }
  /** a piece question holds that piece and everything depending on it */
  private isHeld(p: Plan, pc: Piece): boolean {
    const seeds = this.openQs(p).flatMap((q) => (typeof q.about === 'object' ? [q.about.piece] : []))
    const seen = new Set<string>()
    const up = (id: string): boolean => {
      if (seeds.includes(id)) return true
      if (seen.has(id)) return false
      seen.add(id)
      return this.piece(p, id)?.deps.some(up) ?? false
    }
    return up(pc.id) || this.openQs(p).some((q) => q.about === 'plan')
  }
  private busy(p: Plan) { return p.pieces.filter((x) => x.state === 'started' || x.state === 'fixing').length }

  /** the reducer's may-start: deps integrated, not held, assignee resolved, a free lease slot (after the base red) */
  private tryStart(p: Plan) {
    if (!p.baseRed || p.phase === 'blocked' || p.phase === 'stopped') return
    for (const pc of p.pieces) {
      if (pc.state !== 'waiting' && pc.state !== 'held') continue
      if (this.isHeld(p, pc)) { pc.state = 'held'; continue }
      pc.state = 'waiting'
      if (!pc.assignee.resolved || this.busy(p) >= LEASE) continue
      if (pc.deps.every((d) => this.piece(p, d).state === 'integrated')) this.startPiece(p, pc)
    }
    this.buildPhase(p)
  }

  /** building / fixing / integrating follow from the piece records (the reducer's settle) */
  private buildPhase(p: Plan) {
    if (!p.baseRed || ['checking', 'previewing', 'ready-to-deploy', 'deployed', 'stopped', 'blocked'].includes(p.phase)) return
    if (p.pieces.some((x) => x.state === 'fixing')) p.phase = 'fixing'
    else if (p.pieces.some((x) => ['waiting', 'held', 'started', 'built'].includes(x.state))) p.phase = p.checks.some((c) => !c.base) ? 'fixing' : 'building'
    else if (p.pieces.some((x) => x.state === 'reviewed')) p.phase = 'integrating'
  }

  private contentFor(p: Plan, path: string): string {
    if (path === 'index.html') return INDEX_HTML
    if (path === 'style.css') return styleCss(paletteFor(p.questions.find((q) => q.q === LOOK_Q)?.answer ?? null))
    if (path === 'icon.svg') return ICON_SVG
    if (path === 'app.js') return appJs(this.logicFixed(p))
    return SCAFFOLD[path] ?? ''
  }
  /** the units fix lands on the first attempt; under ?simplan=fail only on the third (after the person says try again) */
  private logicFixed(p: Plan) { return p.fixAttempts >= (p.mode === 'fail' ? 3 : 1) }

  private startPiece(p: Plan, pc: Piece) {
    pc.state = 'started'
    this.write(p, pc, LINES_PER_TICK)
  }
  /** think, stream each file into a fresh candidate a few lines at a time, test its own work, then hand it to review */
  private write(p: Plan, pc: Piece, perTick: number) {
    pc.builder = pc.mind
    pc.candidate = null
    pc.review = null
    const files = pc.files.map((f) => [f, this.contentFor(p, f)] as const)
    pc.out = Object.fromEntries(files)
    let delay = MS.think
    for (const [path, content] of files) {
      const lines = content.split('\n')
      for (let n = perTick; ; n += perTick) {
        const upto = Math.min(n, lines.length)
        this.at(p, delay, () => {
          if (p.phase === 'stopped') return
          const cand = `cand_${pc.id}_${++p.cands}`
          p.snaps.set(cand, { ...this.latest(p), [path]: lines.slice(0, upto).join('\n') + (upto === lines.length ? '' : '\n') })
          pc.candidate = cand
        })
        delay += MS.tick
        if (upto >= lines.length) break
      }
    }
    this.at(p, delay + MS.selfTest, () => this.built(p, pc))
  }

  private reviewKind(pc: Piece) { return `${pc.kind}-review` }

  private built(p: Plan, pc: Piece) {
    if (p.phase === 'stopped') return
    const cand = `cand_${pc.id}_${++p.cands}`
    p.snaps.set(cand, { ...this.latest(p), ...pc.out })
    pc.candidate = cand
    pc.state = 'built'
    pc.review = { kind: this.reviewKind(pc), state: 'journaled', decision: null, reviewer: null, notes: null, evidence: null, candidate: cand }
    this.buildPhase(p)
    this.tryStart(p) // its lease slot is free again
    this.at(p, MS.review, () => {
      if (p.phase === 'stopped') return
      if (p.mode === 'unreviewed') {
        pc.review = { kind: this.reviewKind(pc), state: 'unavailable', decision: null, reviewer: null, notes: null, evidence: null, candidate: cand }
        pc.unreviewed = true
        p.unreviewed = true
      } else {
        const visual = pc.kind === 'design' || pc.kind === 'media'
        pc.review = {
          kind: this.reviewKind(pc), state: 'done', decision: 'pass', reviewer: REVIEWER,
          notes: visual ? 'Looked at the rendered page; it reads clearly.' : 'Read the change and ran the check.',
          evidence: visual ? `render-${pc.id}-${pc.repairs + 1}` : null, candidate: cand,
        }
        pc.passed = [this.reviewKind(pc)]
      }
      pc.state = 'reviewed'
      this.buildPhase(p)
      this.at(p, MS.integrate, () => this.integrate(p, pc))
    })
  }

  private integrate(p: Plan, pc: Piece) {
    if (p.phase === 'stopped') return
    this.checkpoint(p, { ...this.latest(p), ...pc.out })
    pc.state = 'integrated'
    pc.builder = null
    pc.candidate = null
    if (p.pieces.every((x) => x.state === 'integrated')) { this.runCheck(p, false); return }
    this.tryStart(p)
  }

  private runCheck(p: Plan, base: boolean) {
    const ckpt = p.ckpts[p.ckpts.length - 1]
    const c: Check = { run: `run-checks-${p.checks.length + 1}`, ckpt, base, state: 'journaled', failing: [], line: null, output: null }
    p.checks.push(c)
    if (!base) p.phase = 'checking'
    this.at(p, MS.check, () => {
      if (p.phase === 'stopped') return
      const say = (passed: boolean, failing: string[], notes: string[]) => {
        const line = checkLine(passed, failing, notes)
        Object.assign(c, { state: passed ? 'pass' : 'fail', failing, line, output: line })
      }
      if (base) {
        say(false, ['app.js'], ['1 failed: shows the temperature for London'])
        p.baseRed = true
        p.phase = 'building'
        this.tryStart(p)
        return
      }
      if (this.logicFixed(p)) {
        say(true, [], ['2 passed'])
        p.phase = 'previewing'
        this.at(p, MS.preview, () => this.ready(p))
        return
      }
      say(false, ['app.js'], ['1 failed: shows "°C" after the temperature'])
      const logic = this.piece(p, 'logic')
      if (p.fixRounds >= FIX_ROUNDS) {
        p.phase = 'blocked'
        p.questions.push({ q: `hold-${p.questions.length + 1}`, about: 'blocked', text: BLOCKED_TEXT, choices: ['Try again', 'Stop'], answer: null })
        logic.builder = null
        return
      }
      p.fixRounds++
      p.phase = 'fixing'
      this.routeFix(p, logic)
    })
  }

  /** route-fix: the failing file's owner reopens its piece with the check's output */
  private routeFix(p: Plan, pc: Piece) {
    pc.state = 'fixing'
    pc.repairs++
    p.fixAttempts++
    this.write(p, pc, FIX_LINES_PER_TICK)
  }

  private ready(p: Plan) {
    if (p.phase === 'stopped') return
    const ckpt = p.ckpts[p.ckpts.length - 1]
    const snap = p.snaps.get(ckpt)!
    const hex = fnvHex(UI_FILES.map((f) => snap[f]).join('\u0000'))
    p.preview = { ref: `preview-${hex}`, digest: `sha256:${hex}${hex}`, app_id: 'london-weather', source_digest: `sha256:${hex}`, ckpt }
    p.phase = 'ready-to-deploy'
  }

  private stopNow(p: Plan) {
    p.phase = 'stopped'
    p.queue = []
    p.deploying = false
    for (const pc of p.pieces) pc.builder = null
  }

  // ---------------------------------------------------------------- the view

  private deployReady(p: Plan) { return this.status(p) === 'ready_to_deploy' }

  private status(p: Plan): string {
    if (p.deploying) return 'deploying'
    const st = PHASE_STATUS[p.phase] ?? p.phase
    if (TERMINAL.has(p.phase) || p.phase === 'blocked') return st
    // the person's answer is all that is left to wait on: the engine's (rest awaiting-answer)
    if (this.openQs(p).length && !p.queue.length) return 'asking_you'
    return st
  }
  private nextAction(p: Plan): string | null {
    const st = this.status(p)
    if (st === 'ready_to_deploy') return p.unreviewed ? '(tell confirm-unreviewed-deploy)' : '(tell confirm-deploy)'
    if (st === 'asking_you') return '(rest awaiting-answer)'
    if (st === 'needs_you') return '(tell ask-person (blocked (cap-exceeded 2)))'
    if (TERMINAL.has(st)) return '(rest done)'
    return '(rest awaiting-results)'
  }

  private view(p: Plan): Record<string, unknown> {
    const open = this.openQs(p).length
    const terminal = TERMINAL.has(p.phase)
    const ready = this.deployReady(p)
    const base = `/api/create/plans/${p.id}`
    const latest = p.ckpts[p.ckpts.length - 1] ?? null
    return {
      plan_id: p.id, engine: 'metta-plan-controller/R4.1', reducer_sha256: 'sim', sentence: p.sentence,
      title: p.pieces.length ? 'London weather' : null, summary: p.pieces.length ? 'London weather' : p.sentence,
      acceptance: p.pieces.length ? ['Shows London’s weather now and for the next three days', 'Shows the temperature with its unit (°C)', 'Uses the look you choose'] : [],
      phase: p.phase, status: this.status(p), review_policy: p.mode === 'unreviewed' ? 'review-waivable' : 'review-required',
      unreviewed: p.unreviewed && ready, next_action: this.nextAction(p), last_error: null,
      pieces: p.pieces.map((x) => ({
        id: x.id, title: x.title, kinds: [x.kind], team: x.assignee.resolved ? x.assignee.display : x.kind,
        assignee: { ...x.assignee }, deps: [...x.deps], files: [...x.files], state: x.state, status: x.state,
        passed_reviews: [...x.passed], builder: x.builder?.id ?? null, editing: x.state === 'started', draft: x.candidate,
        candidate: x.candidate, repairs: x.repairs, unreviewed: x.unreviewed, review: x.review ? { ...x.review } : null,
        tests: p.suite ? [CHECK_PATH] : [],
      })),
      questions: p.questions.map((q) => ({ q: q.q, about: typeof q.about === 'object' ? { ...q.about } : q.about, text: q.text, choices: [...q.choices], answered: q.answer !== null, answer: q.answer })),
      checks: p.checks.map((c) => ({ ...c, failing: [...c.failing] })),
      checkpoint: { ckpt: latest, workspace: latest ? `ws_sim_${p.id}` : null },
      preview: p.preview ? { ...p.preview } : null,
      installed: p.installed ? { ...p.installed } : null,
      actions: [
        { name: 'answer', label: 'Answer', method: 'POST', path: `${base}/answers`, body: { q: 'question id', text: 'string, 1-4000 characters' }, available: open > 0 && !terminal, why_not: open > 0 && !terminal ? null : 'no question is waiting for you' },
        { name: 'deploy', label: 'Deploy', method: 'POST', path: `${base}/deploy`, body: {}, available: ready, why_not: ready ? null : 'nothing is ready to deploy yet' },
        { name: 'stop', label: 'Stop', method: 'POST', path: `${base}/stop`, body: {}, available: !terminal, why_not: terminal ? 'this plan is finished' : null },
      ],
      journal: [], effects: [],
      updated_at: iso(p.t),
    }
  }
}

/** a 32-hex content digest (FNV-1a, four rounds) for the sim's preview ref */
function fnvHex(s: string): string {
  let out = ''
  for (let r = 0; r < 4; r++) {
    let h = 0x811c9dc5 ^ r
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    out += h.toString(16).padStart(8, '0')
  }
  return out
}
