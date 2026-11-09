/**
 * Create's plan view: the contract between the host's plan engine and the page. Source of truth: the host's plan engine
 * (hive/core/create_plan_engine.py view(), list_for(), files(); the routes in hive/core/app.py; reducer R4.1,
 * modules/create/controller/create_plan_controller_r4_1.metta).
 *
 * Routes (all the signed-in person's own; someone else's plan is the same 404 as no plan):
 *   POST /api/create/plans {sentence}                → PlanView (the plan starts from one sentence)
 *   GET  /api/create/plans                           → PlanSummary[] (the person's plans, newest first)
 *   GET  /api/create/plans/{id}                      → PlanView
 *   GET  /api/create/plans/{id}/files?path=&ckpt=    → {ckpt, path, content} (one file as of a checkpoint or a piece's
 *                                                       candidate; without path: {ckpt, files}); 404 when it is not there
 *   GET  /api/create/plans/{id}/preview              → PreviewFiles {ref, ckpt, files} (the current preview's three UI
 *                                                       files, verified against their lock; 404 none yet, 409 unverified)
 *   POST /api/create/plans/{id}/answers {q, text}    → PlanView (the person answers a question)
 *   POST /api/create/plans/{id}/deploy {}            → PlanView (the person's go; available only when actions say so)
 *   POST /api/create/plans/{id}/stop {}              → PlanView (the person stops the plan)
 * There is no route to withdraw a question.
 * Events (hive event stream): create.plan.status {plan_id, phase, status, next_action}; create.plan.piece {plan_id,
 * piece, state, candidate, repairs}; create.plan.question {plan_id, q, about, text, choices, answered};
 * create.plan.preview {plan_id, ckpt, preview} (preview = the preview's ref).
 *
 * Everything here is data the page draws; the page decides nothing about the plan. Parse strictly and tolerantly:
 * unknown fields are ignored, an unknown phase/status/state is kept and drawn plainly. Older provisional and sim shapes
 * (assignee.name, inline draft text, checkpoint files, summary lines) are still read where it is cheap.
 */

/** The reducer's phase: claimed → planning → planned → (designing → designed) → testing-authored → building →
 * integrating → checking → (fixing ↔ checking) → previewing → ready-to-deploy → deployed; or stopped, blocked. */
export type PlanPhase =
  | 'claimed' | 'planning' | 'planned' | 'designing' | 'designed' | 'testing-authored' | 'building' | 'integrating'
  | 'checking' | 'fixing' | 'previewing' | 'ready-to-deploy' | 'deployed' | 'stopped' | 'blocked'

/** The engine's status (what the person is told; create_plan_engine._status plus the engine's own two). */
export type PlanStatus =
  | 'planning' | 'designing' | 'writing_tests' | 'checking_tests_are_red' | 'building' | 'fixing' | 'integrating'
  | 'checking' | 'previewing' | 'asking_you' | 'ready_to_deploy' | 'deploying' | 'deployed' | 'needs_you' | 'stopped'
  | 'checking_back' | 'engine_error' | 'assignee_unavailable'

/** Kept for display only (Jon 11-08: never lock the team). */
export type Team = string

/**
 * Who a piece is assigned to (Jon 11-08, "always generalise"): a team, one specialist mind, a capability any able mind
 * may take, a whole hive (this one or another), or open. `selector` is the plan's own ["team", swarm] | ["mind", agent]
 * | ["capability", cap] | ["hive", hive, cap] | ["open", cap]; the rest is the hive's resolution of it.
 */
export interface Assignee {
  selector: unknown[] | null
  kind: 'team' | 'mind' | 'capability' | 'hive' | 'open' | string
  ref: string | null
  resolved: boolean
  /** the display name ("Studio", "Code", "Sable (cartographer)", "the whole hive") */
  display: string
  /** why it is not resolved, or more about who (plain words from the hive) */
  detail: string | null
  /** another plan holding this assignee now, when one is */
  taken_by: string | null
}

/** The kind of thing a piece makes; its review kind follows from it (code → code review, design → design review…). */
export type ArtifactKind = 'code' | 'design' | 'doc' | 'media' | 'data' | 'test' | string

/** One piece's state (the reducer's piece records: Pc id status …). */
export type PieceState = 'waiting' | 'held' | 'started' | 'built' | 'reviewed' | 'fixing' | 'integrated' | 'blocked' | 'unassignable'

export interface PieceReview {
  kind: ArtifactKind
  state: 'pending' | 'passed' | 'failed' | 'unavailable' | 'waived'
  decision: 'pass' | 'fail' | null
  reviewer: string | null
  notes: string | null
  evidence: string | null
  /** the candidate it reviewed */
  candidate: string | null
}

export interface PlanPiece {
  id: string
  title: string
  /** display name only (the engine's `team` is the resolved assignee's display); the assignee is the truth */
  team: Team
  assignee: Assignee
  /** what the piece makes (the first of `kinds`) */
  kind: ArtifactKind
  kinds: ArtifactKind[]
  deps: string[]
  files: string[]
  state: PieceState | string
  /** the mind building it (its id from the engine; name and hue resolved from the hive's minds when known) */
  builder: { id: string; name: string; hue: number } | null
  /** the file it is writing now, when known (the engine says only that it is building: its first file then) */
  editing: string | null
  /** older/sim views only: the text written so far, inline. The engine serves text through the files route. */
  draft: { path: string; content: string; at?: string } | null
  /** the piece's built candidate (a checkpoint-like ref the files route reads), while it has one */
  candidate: string | null
  passed_reviews: string[]
  /** this piece went on without a review (the person's review setting allowed it) */
  unreviewed: boolean
  repairs: number
  review: PieceReview | null
  /** true for an acceptance-test piece (older/sim views; the engine authors tests outside the pieces) */
  tests: boolean
}

export interface PlanQuestion {
  q: string
  /** what it holds: one piece (and its dependants), the whole plan, the deploy, or a held plan */
  about: { kind: 'piece'; piece: string } | { kind: 'plan' } | { kind: 'deploy' } | { kind: 'blocked' }
  text: string
  choices: string[]
  answered: { text: string; at: string } | null
}

export interface PlanCheck {
  run: string
  ckpt: string
  /** base: the first run on the scaffold, which must fail (red) before building */
  base: boolean
  state: 'running' | 'passed' | 'failed' | 'unknown'
  failing: string[]
  /** the decisive output line */
  line: string | null
  /** the last lines the check printed */
  output: string | null
}

/** The latest integrated checkpoint. The engine sends no files here: the files route reads them. */
export interface PlanCheckpoint {
  ckpt: string
  workspace: string | null
  /** older/sim views only: the files inline */
  files?: Record<string, string>
  at?: string
  piece?: string | null
}

/** The current preview (a pinned UI bundle the preview route serves, verified). */
export interface PlanPreview { ckpt: string; ref: string | null; digest: string | null }

/** GET …/preview: the preview's verified files for the app frame. */
export interface PreviewFiles { ref: string; ckpt: string; files: Record<string, string> }

export interface PlanAction {
  name: 'deploy' | 'answer' | 'stop'
  available: boolean
  why_not: string | null
}

/** GET /api/create/plans: one row per plan of the person's. */
export interface PlanSummary { plan_id: string; sentence: string; phase: string; status: string; updated_at: string }

export interface PlanView {
  plan_id: string
  /** the person's sentence, as they said it */
  sentence: string
  /** the plan's own title, once planned */
  title: string | null
  acceptance: string[]
  phase: PlanPhase | string
  /** the engine's status (from the phase for older views) */
  status: PlanStatus | string
  /** one plain line of where it stands (worded from the status by the page) */
  status_line: string | null
  next_action: string | null
  /** the engine's last error (kept for diagnostics; never drawn raw) */
  last_error: string | null
  review_policy: string | null
  pieces: PlanPiece[]
  questions: PlanQuestion[]
  checks: PlanCheck[]
  checkpoint: PlanCheckpoint | null
  preview: PlanPreview | null
  /** older/sim views: plain lines of what was built */
  summary: string[] | null
  /** a review was waived on the way (the deploy go says so) */
  unreviewed: boolean
  actions: PlanAction[]
  /** once deployed: the hive app it became */
  installed: { app_id: string; name: string } | null
  journal: { seq: number; id: string; kind: string; verdict: string; at: string }[]
  effects: { kind: string; op: string; state: string }[]
  updated_at: string
}

/** The optional client methods (live.ts and SimClient carry them; a hive without them never shows the plan view). */
export interface PlanClient {
  createPlanStart?(sentence: string): Promise<unknown>
  createPlans?(): Promise<unknown>
  createPlan?(planId: string): Promise<unknown>
  createPlanPreview?(planId: string): Promise<unknown>
  createPlanAnswer?(planId: string, q: string, text: string): Promise<unknown>
  createPlanDeploy?(planId: string): Promise<unknown>
  createPlanStop?(planId: string): Promise<unknown>
  createPlanFile?(planId: string, path: string, ckpt: string): Promise<unknown>
}
