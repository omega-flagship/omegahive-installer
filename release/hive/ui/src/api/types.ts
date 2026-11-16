// Purpose: the hive API's shapes as the UI reads them, in lockstep with hive/API.md.
// Types mirroring hive/API.md (Phase 1 + Phase 2). Keep this file in lockstep with the contract.
import type { MemoryThemes } from '../lib/memoryTheme'

export type AgentKind = 'omega' | 'iter' | 'module'
export type AgentStatus = 'created' | 'starting' | 'awake' | 'asleep' | 'stopped' | 'error'

export interface Agent {
  /** A person's personal mind: that person's principal (hive/core/personal.py agents.personal_of); else null/absent. */
  personal_of?: string | null
  /**
   * Platform r2.4 (agent_view): the host's answer to "may this viewer Remind / put this mind to sleep", and whether it is
   * the viewer's own personal mind. Absent on older hosts: treated as false (api/idleMinds hostAllows).
   */
  may_remind?: boolean
  may_sleep?: boolean
  is_mine?: boolean
  /**
   * The host's answer to "may this viewer act on this mind" (edit, start, stop, sleep, wake, delete, reset its memory,
   * change who sees it): its owner (a personal mind's person) or a hive admin (hive/core/visibility.py Viewer.controls).
   * Seeing a mind is not acting on it. Absent on events and older hosts: the UI hides a control only when this is false.
   */
  may_control?: boolean
  /** What its owner chose for its belief link (BeliefLinkDomains; null for the mind's default). It moves on every
   *  change, so a page showing the link reads it again when this does. Absent on older hosts. */
  belief_link?: BeliefLinkDomains
  /** Who created it, who can see it, and with whom it is shared (R13). */
  owner?: string | null
  visibility?: Visibility
  shared_with?: string[]
  id: string
  name: string
  kind: AgentKind
  swarm_id: string | null
  model: string
  persona: string
  hue: number
  status: AgentStatus
  driver: string
  budget_usd: number
  spent_usd: number
  connected: boolean
  /** Why status is "error" (server sets it; absent in older servers). */
  last_error?: string | null
  last_active_at: string | null
  created_at: string
  /** Phase 2: minutes of idleness before the hive puts the mind to sleep (0 = never). Absent on Phase 1 servers. */
  idle_sleep_minutes?: number
  /** How its model is reached (OpenRouter provider routing). Absent on older servers. */
  options?: AgentOptions
  /** Mind-to-mind messages an hour (hive/core/throughput.py): its own limit (null: the hive default) and use. */
  throughput?: Throughput | null
  /** Its role (hive/core/roles.py) and that role's text rendered for this mind. */
  role_id?: string | null
  role_prompt?: string
  /** Coffee Room membership (hive/core/rooms.py, Coffee Room plan r1): automatic for a public mind in a public swarm unless
   *  an admin took it out; private or shared minds (or swarms) join only if an admin adds them; app modules never join.
   *  Absent on hives without a Coffee Room. */
  coffee?: CoffeeMembership
}

export type CoffeeMembership = 'member' | 'opted_out' | 'private' | 'not_a_mind'

export interface RoleRule {
  skill: string
  mode: 'allow' | 'ask' | 'deny'
}
/** A reusable bundle that shapes a mind: prompt template, default model and budget, approval rules. */
export interface Role {
  id: string
  name: string
  summary: string
  /** Placeholders: {name}, {swarm}, {purpose}. */
  prompt: string
  default_model: string | null
  default_budget: number | null
  rules: RoleRule[]
  builtin: boolean
  created_at: string
  updated_at: string
  /** Minds that have this role. */
  minds: string[]
}

// ---- Providers and the OpenRouter catalogue (hive/core/providers.py) ----

export type RouteSort = 'price' | 'throughput' | 'latency'

export interface ToolsCatalogue {
  offline_candidate: boolean
  items: { id: string; title: string; summary: string; maker: string; origin: string;
    effects: string[]; qualification: string; qualification_scope: string; activatable: boolean }[]
}

export type IterVariant = 'omega' | 'metta'

export interface AgentOptions {
  tools?: string[]
  /** The key that pays for this mind (a key id); absent means the provider's hive default. */
  key?: string
  /** Which Iter loop a kind=iter mind runs: iter.py (omega, the default) or iter.metta on PeTTa (metta). */
  iter_variant?: IterVariant
  route?: {
    /** Preferred upstream providers, by OpenRouter tag, in order. */
    order?: string[]
    /** Whether OpenRouter may fall back to other providers (default true). */
    allow_fallbacks?: boolean
    sort?: RouteSort
  }
}

export interface ProviderAccount {
  label?: string | null
  limit?: number | null
  usage?: number | null
  limit_remaining?: number | null
  free_tier?: boolean | null
  error?: string
}

/** GET /api/providers: never carries a key, only a hint. */
export interface ProviderStatus {
  name: string
  label: string
  local: boolean
  needs_key: boolean
  /** Whether YOU can pay for a call on this provider (a key you own, one you were granted, the hive's key on its
   * terms), or it is local or mock; you may not be able to see the key that pays. Never proof of an answer. */
  connected: boolean
  /** Additive readiness evidence, for the route YOU pay by; optional for older hosts, which remain unverified here. */
  configured?: boolean
  readiness?: 'answered' | 'unverified' | 'not_answering' | 'test_only'
  answer_ready?: boolean
  test_only?: boolean
  /** Where the key you pay with comes from; null when you cannot pay, or may not see that key. */
  source: 'stored' | 'env' | null
  key_hint: string
  key_env: string
  base_url: string
  /** The featured model names (without the provider prefix). */
  models: string[]
  /** How many of this provider's keys YOU may see (yours, and the hive keys offered to you); not the hive's inventory,
   * and not whether you can pay (see connected). */
  keys?: number
  account?: ProviderAccount | null
  /** fetched_at and error describe the hive's default key's fetch: null unless that is the key you pay with. */
  catalog?: { count: number; fetched_at: number | null; error: string | null }
}

/** GET /api/keys: a provider key as people see it. Never carries the secret. */
export interface KeyInfo {
  id: string
  provider: string
  provider_label: string
  label: string
  /** "user:operator" today; with sign-in, the person who added it. "hive" for an environment key. */
  owner: string
  hint: string
  /** Pays for minds on this provider that have no key of their own. */
  default: boolean
  created_at: number | null
  account?: ProviderAccount | null
  /** Spent through this hive with this key. */
  spent_usd: number
  /** Minds this key pays for; assigned=false means they use it as the default. */
  minds: { id: string; name: string; hue: number; status: AgentStatus; assigned: boolean }[]
  env?: boolean
}

export interface CatalogModel {
  id: string
  name: string
  description: string
  context_length: number
  max_completion_tokens?: number | null
  /** USD per million tokens; null when OpenRouter lists no price. */
  in_per_m: number | null
  out_per_m: number | null
  inputs: string[]
  outputs: string[]
  tools: boolean
  reasoning: boolean
  created?: number | null
}

export interface Catalog {
  models: CatalogModel[]
  /** When the hive last fetched it; null unless you pay by the hive's own OpenRouter key (or are an admin). */
  fetched_at: number | null
  error: string | null
  /** Whether you may ask the hive to fetch it again; absent (older hosts) reads as no. */
  can_refresh?: boolean
}

/** One upstream serving an OpenRouter model. */
export interface ModelEndpoint {
  name: string
  provider: string
  tag: string
  context_length: number
  max_completion_tokens?: number | null
  in_per_m: number | null
  out_per_m: number | null
  quantization?: string | null
  uptime?: number | null
  status?: number | null
  latency_ms?: number | null
  throughput?: number | null
  tools: boolean
}

/** A message-throughput limit and its use over the last hour (hive/core/throughput.py). */
export interface Throughput {
  messages_per_hour: number | null
  messages_per_hour_effective: number
  messages_last_hour: number
}

/** The hive's defaults for mind-to-mind messages an hour, inherited by minds and swarms with none of their own. */
export interface HiveThroughput {
  defaults: { mind: number; swarm: number }
  priority_from: number
  window_seconds: number
}

export interface Swarm {
  id: string
  name: string
  description: string
  hue: number
  member_ids: string[]
  created_at: string
  /** The mind that coordinates this swarm (a member), if set. "The mind is the coordinator." */
  coordinator_id?: string | null
  /** The mind elsewhere that contains this swarm (holarchy), and that mind's swarm. */
  parent_mind_id?: string | null
  parent_swarm_id?: string | null
  /** Swarms contained by minds of this swarm. */
  child_swarm_ids?: string[]
  /** Request kinds this swarm accepts from other swarms (C39). */
  services?: string[]
  owner?: string | null
  visibility?: Visibility
  shared_with?: string[]
  /** A person's personal-mind swarm: that person's principal (hive/core/personal.py swarms.personal_of); else null/absent. */
  personal_of?: string | null
  /** When it was archived (put away, history kept), or null/absent while it is in use. */
  archived_at?: string | null
  /** Who archived it (a principal), while archived. */
  archived_by?: string | null
  /** Its minds' mind-to-mind messages an hour, together (hive/core/throughput.py). */
  throughput?: Throughput | null
}

export interface UpdateSwarmBody {
  name?: string
  description?: string
  coordinator_id?: string | null
  parent_mind_id?: string | null
  /** Admin: its minds' mind-to-mind messages an hour together; null returns to the hive default. */
  messages_per_hour?: number | null
}

export interface Message {
  id: string
  agent_id: string
  conversation_id: string
  direction: 'in' | 'out'
  sender: string
  text: string
  created_at: string
  /** Health's idle question, verified and its id tag removed for people by the hive (health.people_message): shown "Health check". */
  health_check?: boolean
  /** A note the hive sent the mind to instruct it (Hive.mind_only: a goal and how to claim it, an approval, a notice): the
   *  mind's input, never a chat turn, so no page draws it (lib/mindOnly). */
  mind_only?: boolean
  /** A room delivery's source: the room message it copies (rooms.py _deliver), which a link to this message opens. */
  source_message_id?: string
}

export interface TruthValue {
  f: number
  c: number
}

export interface Belief {
  swarm_id: string
  statement: string
  tv: TruthValue
  stamp: string[]
  sources: string[]
  updated_at: string
}

export type AssertionOutcome =
  | 'adopted'
  | 'revised'
  | 'chosen'
  | 'kept'
  | 'duplicate'
  | 'quarantined'
  | 'denied'

export interface Assertion {
  agent_id: string
  statement: string
  tv: TruthValue
  stamp: string[]
  outcome: AssertionOutcome
  created_at: string
}

export interface BeliefDetail extends Belief {
  assertions: Assertion[]
  choices: { kept: string[]; rejected: string[] }[]
}

export interface Usage {
  agent_id: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  cost_usd: number
  created_at: string
  /** 1 while this is the hive's worst-case settlement of a call whose cost never came back and nobody has corrected. */
  estimated?: number
}

export interface ModelOption {
  id: string
  provider: string
  label: string
  local: boolean
}

export interface HiveInfo {
  name: string
  version: string
  agents: number
  swarms: number
  awake: number
  beliefs: number
  spent_usd: number
  /** Server settings the UI needs to draw exact bars (absent on older servers). */
  limits?: HiveLimits
}

export interface HiveLimits {
  goal_lease_minutes: number
  hive_budget_usd: number
  max_llm_calls_per_minute: number
}

// ---- REST bodies ----

/** Who can see a mind or swarm (hive/core/visibility.py). Admins always can. */
export type Visibility = 'private' | 'shared' | 'public'

/** What a mind's owner chose for its belief link: null keeps the mind's default, 'all', the subjects a list names, or
 *  [] for none (PUT /api/agents/{id}/belief-link). */
export type BeliefLinkDomains = null | 'all' | string[]

/**
 * Which of a mind's own beliefs its swarm sees through the link, never a copy (Jon on #334 and #354; hive/core/hive.py
 * belief_link). A belief's subject is the first field of its statement, as "coffee" in (--> (x coffee hot) temp).
 */
export interface BeliefLink {
  agent_id: string
  domains: BeliefLinkDomains
  /** What it links while its owner hasn't chosen: every belief for a public mind, none for a person's own mind, a
   *  researcher, or a private or shared mind (link_default). Moves with the mind's visibility. */
  default: 'all' | 'none'
  /** Why the default is none ('personal', 'researcher', or the mind's visibility); null when it is every belief. */
  default_reason: 'personal' | 'researcher' | 'private' | 'shared' | null
  /** What applies now: the default, or what the owner chose. */
  linked: 'all' | 'none' | string[]
  /** The statement patterns its read grants hold now. */
  patterns: string[]
  /** The subjects its saved beliefs are about now, for a reader with rights.read_topics; null for anyone else. */
  known_domains: string[] | null
  /** How this person stands to the mind (hive.py LINK_RIGHTS): its owner (the mind's owner, the person it is the own mind
   *  of, or an admin for a mind with neither), an admin auditing a person's own mind, or an admin. */
  as: 'owner' | 'admin-audit' | 'admin'
  /** What this person may do with the link: only its owner widens it, an admin may narrow it (Jon on #360 and #354). */
  rights: BeliefLinkRights
}

/** A reader's rights over a mind's belief link, by how they stand to it (hive.py LINK_RIGHTS, hive/API.md BeliefLink). */
export interface BeliefLinkRights {
  read_beliefs: boolean
  read_setting: boolean
  read_topics: boolean
  narrow: boolean
  widen: boolean
}

export interface CreateSwarmBody {
  name: string
  description?: string
  hue?: number
  visibility?: Visibility
  /** People, as principals (user:u_…), when visibility is 'shared'. */
  shared_with?: string[]
}

export interface CreateAgentBody {
  name: string
  kind: AgentKind
  swarm_id?: string | null
  model: string
  persona?: string
  hue?: number
  budget_usd?: number
  options?: AgentOptions
  role_id?: string | null
  visibility?: Visibility
  shared_with?: string[]
}

export type CreatedAgent = Agent & { token: string }

export type PatchAgentBody = Partial<
  Pick<Agent, 'name' | 'swarm_id' | 'model' | 'persona' | 'hue' | 'budget_usd' | 'idle_sleep_minutes' | 'options' | 'role_id'>
> & {
  /** Admin: the mind's mind-to-mind messages an hour; null returns to the hive default. */
  messages_per_hour?: number | null
  /** Admin only: put the mind in (true) or take it out of (false) the Coffee Room. */
  coffee?: boolean
}

export type AgentAction = 'start' | 'stop' | 'sleep' | 'wake'

/** Gateway refusals before an LLM call (API.md "LLM spend is checked before the call"). */
export type LlmErrorCode = 'no_budget' | 'unpriced_model' | 'budget_exhausted' | 'hive_budget_exhausted' | 'rate_limited'

export interface ApiErrorBody {
  error: { code: string; message: string }
}

// ---- Phase 2: policy, approvals, goals, traces, wakeups, memory ----

export type PolicyMode = 'allow' | 'ask' | 'deny'
export type PolicyScope = 'hive' | `swarm:${string}` | `agent:${string}`

export interface PolicyRule {
  id: string
  /** Most specific scope wins: agent > swarm > hive > defaults. */
  scope: PolicyScope
  /** Glob over skill names: "shell*", "write-file", "*". */
  skill: string
  mode: PolicyMode
  note: string
  created_at: string
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'used'
export type Risk = 'low' | 'medium' | 'high'

export interface Approval {
  id: string
  agent_id: string
  skill: string
  /** Full MeTTa command text, e.g. (shell-confirm "ls /"). */
  command: string
  /** Why it needs a human: the rule note or "human-only". */
  reason: string
  risk: Risk
  status: ApprovalStatus
  decided_by: string | null
  created_at: string
  decided_at: string | null
  /**
   * GET /api/approvals: whether this viewer may answer it, the host's answer routes' own rule (the mind's owner or a hive
   * admin; its owner alone when the mind is set to owner_only). Absent on live events; the store then keeps the last
   * read's, or takes a no from the mind's may_control (a yes there does not settle owner_only).
   */
  may_answer?: boolean
  /**
   * `ask`: a skill whose policy asks a person, answered once or for longer. `grant`: a mind's request for an explicit-only
   * skill it lacks (hive/core/policy.py grantable), which a hive admin answers with a rule (For a time, Always) or a
   * refusal; the host refuses Once for it.
   */
  kind?: 'ask' | 'grant'
}

/**
 * `waiting`: delivered, waiting on a person (the lease is paused).
 * `stalled`: the lease lapsed 3 times; a person has to act (PATCH status "open").
 */
export type GoalStatus = 'open' | 'claimed' | 'waiting' | 'stalled' | 'submitted' | 'done' | 'failed' | 'cancelled'

export interface Goal {
  id: string
  swarm_id: string
  parent_id: string | null
  title: string
  detail: string
  /** 0..1 */
  priority: number
  status: GoalStatus
  /** "user:operator" | "agent:<id>" */
  created_by: string
  claimed_by: string | null
  result: string | null
  created_at: string
  updated_at: string
  /** A claim is a lease (HIVE_GOAL_LEASE_MINUTES, default 60). Null when not held or paused. */
  lease_until?: string | null
  /** Claims that lapsed so far; 3 lapses stall the goal. */
  attempts?: number
  /** The mind this goal is assigned to, if any. */
  assignee?: string | null
  /** R17: who must accept a result before it is done (none | requester | person | agent:<id> | mandate:<id>). */
  review_by?: string
  review_notes?: string | null
  returns?: number
  reviewed_by?: string | null
  reviewed_at?: string | null
  submitted_at?: string | null
}

/** One entry of GET /api/goals/{id}/reviews (hive/core/goals.py goal_reviews), oldest first. */
export interface GoalReview {
  id: string
  goal_id: string
  at: string
  /** `agent:<id>` or a person's principal. */
  by: string
  action: 'submit' | 'accept' | 'return' | string
  notes: string
  result_digest: string | null
}

export type GateDecision = 'allow' | 'ask' | 'deny'

export interface TraceCommand {
  command: string
  result: string
  gated?: GateDecision
}

/** One loop iteration that called the model. */
export interface Trace {
  id: number
  agent_id: string
  iteration: number
  /** The new message that triggered it (null for autonomous turns). */
  input: string | null
  /** Raw model output. */
  response: string
  commands: TraceCommand[]
  llm_ms: number | null
  tokens: number | null
  created_at: string
}

/** Host trace storage, separate from any app's archive product mode. */
export interface TraceArchiveIndex {
  days: { day: string; entries: number; updated_at: string }[]
  logs: { file: string; bytes: number; sha256: string; created_at: string }[]
}

export interface Wakeup {
  id: string
  agent_id: string
  /** 5-field cron, e.g. "0 9 * * 1-5". Exactly one of cron / at is set. */
  cron: string | null
  /** One-shot ISO time. */
  at: string | null
  /** IANA zone, default "UTC". */
  tz: string
  text: string
  enabled: boolean
  next_run_at: string | null
  last_run_at: string | null
}

export interface MemorySpace {
  name: string
  atoms: number
  bytes: number
}

export interface MemoryAtom {
  index: number
  text: string
}

export interface CreatePolicyBody {
  scope: PolicyScope
  skill: string
  mode: PolicyMode
  note?: string
}

export interface CreateGoalBody {
  title: string
  detail?: string
  priority?: number
  parent_id?: string | null
  /** A mind of this swarm, by id or name: the task is for it alone. */
  assignee?: string
}

export type PatchGoalBody = Partial<Pick<Goal, 'status' | 'priority' | 'title' | 'detail'>>

export type CreateWakeupBody = { text: string; tz?: string } & ({ cron: string; at?: undefined } | { at: string; cron?: undefined })

export type PatchWakeupBody = Partial<Pick<Wakeup, 'enabled' | 'cron' | 'at' | 'tz' | 'text'>>

// ---- The Lab: test suites and benchmarks (hive/core/lab.py) ----

export type LabKind = 'tests' | 'bench'
export type LabRunStatus = 'running' | 'passed' | 'failed' | 'error' | 'cancelled' | 'skipped'
export type LabCaseStatus = 'passed' | 'failed' | 'skipped' | 'error'
export type Better = 'lower' | 'higher' | 'equal'
/** What a case measures (lab.py scorecard order). */
export type LabDimension =
  | 'correctness'
  | 'accuracy'
  | 'latency'
  | 'efficiency'
  | 'resources'
  | 'power'
  | 'cost'
  | 'reliability'
  | 'bias'
  | 'drift'

export interface LabRunSummary {
  id: string
  suite: string
  status: LabRunStatus
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  passed: number
  failed: number
  skipped: number
  errors: number
  commit_sha: string | null
  /**
   * Simulator only, never sent by a real hive. "recorded": real results from the recording;
   * "example": synthetic history jittered from the recording; "replay": a recorded run replayed.
   */
  demo?: 'recorded' | 'example' | 'replay'
}

export interface LabSuite {
  id: string
  kind: LabKind
  title: string
  description: string
  estimate_s: number
  needs: string[]
  missing: string[]
  runnable: boolean
  last_run: LabRunSummary | null
}

export interface LabMetric {
  name: string
  value: number
  unit: string
  better: Better
  /** The pass line (lower: <=, higher: >=, equal: ==). Null is informational. */
  target: number | null
  ok: boolean | null
  /**
   * Names this measure had before (the host renamed its bench strings, "dot" → "mind"). Shown only as a quiet detail;
   * runs are paired on `name` alone, so a renamed measure is still one measure.
   */
  legacy_names?: string[]
  /** On an old record the host serves under the new name: the name it was recorded with. A quiet detail only. */
  renamed_from?: string
}

export interface LabSeries {
  name: string
  unit: string
  kind: 'line' | 'bar' | 'step'
  /** x-axis label */
  x: string
  points: [number, number][]
  /** On an old record the host serves under the series' current name: the name it was recorded with. */
  renamed_from?: string
}

export interface LabCase {
  run_id: string
  id: string
  name: string
  group: string
  /** Older servers omit it: correctness for test suites, drift otherwise. */
  dimension: LabDimension | string
  status: LabCaseStatus
  duration_ms: number | null
  message: string | null
  notes: string | null
  metrics: LabMetric[]
  series: LabSeries[]
  /** An old record served under its case's current title: the title it was recorded with (a quiet detail only). */
  renamed_from?: string
}

export type LabRun = LabRunSummary & { log: string; cases: LabCase[] }

export interface LabScorecardEntry {
  dimension: LabDimension | string
  passed: number
  failed: number
  skipped: number
  errors: number
  /** passed / (passed + failed + errors); null when nothing was judged. */
  score: number | null
  suites: string[]
  /** Up to 6 metrics with targets. */
  highlights: (LabMetric & { case: string; suite: string })[]
}

export interface LabHistoryPoint {
  run_id: string
  at: string
  value: number
  ok: boolean | null
  /** This run recorded the measure under an older name (a quiet detail; the series is still one series). */
  renamed_from?: string
}

export interface LabHistoryMetric {
  case_id: string
  case: string
  metric: string
  unit: string
  better: Better | null
  target: number | null
  points: LabHistoryPoint[]
  /** Names the measure had before; history keys on `case_id::<current name>`, so old and new runs are one series. */
  legacy_names?: string[]
}

export interface LabHistory {
  suite: string
  /** Oldest first. */
  runs: LabRunSummary[]
  metrics: LabHistoryMetric[]
}

// ---- Hive programs (hive/PROGRAMS.md, contract 0.1) ----

export type ProgramStage = 'unfold' | 'map' | 'compare' | 'detail'
export const PROGRAM_STAGES: ProgramStage[] = ['unfold', 'map', 'compare', 'detail']
export type ProgramRole = 'question' | 'claim' | 'evidence' | 'hypothesis' | 'assessment' | 'explanation' | 'gap' | 'source' | 'other'
export type Polarity = 'support' | 'oppose' | 'qualify' | 'neutral'

export interface ProgramKind {
  id: string
  label?: string
  role: ProgramRole
}
export interface ProgramRelation {
  id: string
  label?: string
  polarity: Polarity
}
export interface ProgramAction {
  id: string
  label?: string
  /** Kinds the action applies to; absent means any. */
  applies_to?: string[]
  /** The stage the action leads to, as a hint ("detail?"). */
  stage?: string
  /** Param name -> what it means. */
  params?: Record<string, string>
  /** Candidate (G2, PROGRAMS.md §9c): the action takes one file from the person (types, and at most max_bytes ≤ 20 MB). */
  accepts_file?: { mimes: string[]; max_bytes: number }
  /** §9d: a human act through the full named-person intent gate (always host-confirmed). */
  person_activity?: boolean
  /** §9d: the effective host confirm (true when the app opts in or the action is person_activity). */
  confirm?: boolean
}
/** Candidate (G1, PROGRAMS.md §9c): a declared read (POST /api/programs/{id}/read). */
export interface ProgramRead {
  id: string
  label?: string
}
export interface ProgramDescription {
  contract: string
  kinds: ProgramKind[]
  relations: ProgramRelation[]
  actions: ProgramAction[]
  /** Candidate (G1): the reads the app declares; absent on a hive without the read route. */
  reads?: ProgramRead[]
}

/** GET /api/programs */
export interface Program {
  id: string
  name: string
  version: string
  description: string
  icon: string
  capabilities: string[]
  /** "built-in" or "plugin-dir" */
  source: string
  /** A test app (plugin.json "test": true, such as the contract fixture): All apps lists it, the everyday menus do not. */
  test?: boolean
  enabled: boolean
  error: string | null
  /** Source identity already returned by the host. Release changes invalidate host-owned app views. */
  digest?: string | null
  /** The app ships its own interface (pinned ui/ files), shown in an isolated frame. */
  ui?: boolean
  /** The manifest's identity block, validated by the host (programs.check_app). */
  app?: { theme?: import('../shell/appLook').AppTheme; home?: string | null; tagline?: string }
  /** P14: "person" opens in each person's own private space; "swarm" (the default) in shared swarms, as before. */
  placement?: 'person' | 'swarm'
}
/** GET /api/programs/{id} */
export interface ProgramDetail extends Program {
  describe: ProgramDescription | null
  /** Copied from the host-verified pinned manifest; never Context._program or a frame value. */
  person_swarm?: import('./personSwarms').PinnedPersonSwarm | null
}

/** Host-only metadata from the same manifest bytes included in the verified UI release digest. */
export interface ProgramUiRelease extends MemoryThemes {
  digest: string
}

/** GET /api/programs/{id}/ui. Release data stays in the host, outside appDocument/srcdoc. */
export interface ProgramUiBundle {
  program: string
  files: { 'index.html': string; 'app.js': string; 'style.css': string; [part: string]: string }
  scripts?: string[]
  /** Absent on older servers/simulators; memory-open then fails closed without a bound release. */
  release?: ProgramUiRelease
}

export interface NalUncertainty {
  method: 'nal'
  f: number
  c: number
}
export interface PlnUncertainty {
  method: 'pln'
  strength: number
  confidence: number
}
export interface QualitativeUncertainty {
  method: 'qualitative'
  status: string
}
/** Any other method: shown by its label and method name, never converted. */
export interface OtherUncertainty {
  method: string
  label?: string
  [key: string]: unknown
}
/** Labelled with its method. Missing means unassessed, which is not zero. */
export type Uncertainty = NalUncertainty | PlnUncertainty | QualitativeUncertainty | OtherUncertainty

export type SourceStatus = 'retrieved' | 'inspected' | 'cited' | 'unavailable'
export interface WorkSource {
  id: string
  label: string
  kind?: string
  url?: string
  local_ref?: string
  date?: string
  locator?: string
  status?: SourceStatus | string
  /** Shared by sources with a common origin: they are not independent. */
  origin?: string
  [key: string]: unknown
}

export type ItemStatus = 'current' | 'corrected' | 'superseded' | 'retracted'
export interface ItemRevision {
  revision: string
  label?: string
  note?: string
  at?: string
}
export interface WorkItem {
  id: string
  kind: string
  label: string
  text?: string
  status?: ItemStatus | string
  flags?: string[]
  uncertainty?: Uncertainty | null
  sources?: WorkSource[]
  revisions?: ItemRevision[]
  at?: string
  weight?: number
  meta?: Record<string, unknown>
  atom?: string
}
export interface WorkLink {
  id: string
  from: string
  to: string
  rel: string
  weight?: number
}
export interface WorkGroup {
  id: string
  label?: string
  items: string[]
}
/** A full snapshot (v0.1 has no deltas). */
export interface WorkGraph {
  contract?: string
  program?: string
  stage?: ProgramStage
  revision: string
  focus?: string | null
  title?: string
  suggested_stage?: ProgramStage | null
  items: WorkItem[]
  links: WorkLink[]
  groups: WorkGroup[]
  notes: string[]
}

export type ActionStatus = 'done' | 'started' | 'needs_input' | 'stale' | 'refused' | 'error'
export interface ProgramTask {
  /** A swarm goal id in v0.1. */
  id: string
  kind: 'goal' | string
  status: string
}
export interface ActionResult {
  receipt?: { id: string; state: 'committed' | 'pending' | 'unknown' | 'refused'; at: string; digest?: string }
  status: ActionStatus
  graph?: WorkGraph | null
  task?: ProgramTask
  needs?: Record<string, string>
  detail?: { sources?: WorkSource[]; [key: string]: unknown }
  message?: string
}

export interface ProgramViewBody {
  swarm_id: string
  /** P13 read-only view input; never focus, rule input or action params. */
  untrusted_intent?: string
  focus?: string | null
  stage?: ProgramStage
}
export interface ProgramActBody {
  idempotency_key?: string
  swarm_id: string
  action: string
  items: string[]
  params?: Record<string, unknown>
  base_revision?: string | null
  /** Candidate (G2): one file from the person, for an action that declares accepts_file. Never stored by the hive. */
  file?: { name: string; mime: string; size: number; content_base64: string }
  /** §9d: the host's confirm token, at the top level; minted by the host after the person confirms. Never in params. */
  confirm_token?: string
}
/** §9d: POST /api/programs/{id}/confirm → a single-use token for one confirmed act (120 s). */
export interface ConfirmToken {
  confirm_token: string
  expires_at: string
  expires_in: number
}
/** Candidate (G1): POST /api/programs/{id}/read → {program, query, result}. Only `result` reaches the frame. */
export interface ProgramReadResult {
  program: string
  query: string
  result: unknown
}

// ---- Live events (WS /api/events) ----

export type ThinkingPhase = 'llm' | 'skills' | 'idle'

interface EventBase<T extends string> {
  type: T
  at: string
}

/** A mind's statement to its person's stage (hive/core/stage.py): each item named with where it comes from and, for a
 *  creation, its stored kind, so the stage arranges it in the same event. */
export interface StageSaid {
  principal: string
  seq: number
  agent_id: string
  say: 'show' | 'recall' | 'compare'
  items: { key: string; source: 'artifact' | 'mind' | 'task'; stored?: string }[]
  /** The task the mind holds now, or null. */
  task: string | null
}

export type HiveEvent =
  /** `stream`: where this socket's subscription begins in the hive's live stream (hive/core/events.py; absent on an
   *  older hive). api/live.ts compares it with what was read before it and with the next hello. */
  | (EventBase<'hello'> & { hive: HiveInfo; stream?: { id: string; at: number } })
  | (EventBase<'agent.updated'> & { agent: Agent })
  | (EventBase<'agent.deleted'> & { agent_id: string })
  | (EventBase<'swarm.updated'> & { swarm: Swarm })
  | (EventBase<'swarm.deleted'> & { swarm_id: string })
  | (EventBase<'room'> & { room_id: string; what: string })
  | (EventBase<'artifact.revision'> & { swarm_id: string; artifact_id: string; revision: number; digest: string; created_at: string })
  /** J3 r4.3 (proposed, person-scoped, body-free): a notice to read the Studio session ledger again; never itself a receipt */
  | (EventBase<'studio.session'> & { session_id: string; state?: string; step?: number; rev?: number; outcome?: string })
  /** host R3: each step's admitted / proposal_ready / outcome / closed notice (ids only, person-scoped) */
  | (EventBase<'studio.step'> & { session_id: string; step: number; phase?: string; step_state?: string; proposal_revision?: number | null; outcome?: string | null; session_state?: string })
  | (EventBase<'message'> & { message: Message })
  | (EventBase<'agent.thinking'> & { agent_id: string; phase: ThinkingPhase })
  | (EventBase<'belief.published'> & { swarm_id: string; assertion: Assertion })
  | (EventBase<'belief.updated'> & { belief: Belief; outcome?: 'adopted' | 'revised' | 'chosen' })
  | (EventBase<'usage'> & { usage: Usage })
  | (EventBase<'log'> & { agent_id: string; line: string })
  // Phase 2
  | (EventBase<'approval.created'> & { approval: Approval })
  | (EventBase<'person_request.created'> & { request: PersonAsk })
  | (EventBase<'person_request.updated'> & { request: PersonAsk })
  | (EventBase<'approval.updated'> & { approval: Approval })
  | (EventBase<'policy.updated'> & { rules: PolicyRule[] })
  | (EventBase<'goal.updated'> & { goal: Goal })
  | (EventBase<'agent.trace'> & { trace: Trace })
  | (EventBase<'wakeup.updated'> & { wakeup: Wakeup })
  | (EventBase<'wakeup.fired'> & { wakeup_id: string; agent_id: string })
  // Lab
  | (EventBase<'lab.run'> & { run: LabRunSummary })
  | (EventBase<'lab.case'> & { case: LabCase })
  | (EventBase<'lab.log'> & { run_id: string; text: string })
  // Programs
  | (EventBase<'program.updated'> & { program: Program })
  /** Content-free host invalidation for loaded app releases; removal/uninstall uses digest null. */
  | (EventBase<'program.release_changed'> & { program: string; digest: string | null })
  | (EventBase<'health.alert'> & { alert: HealthAlert })
  // Providers
  | (EventBase<'providers.updated'> & { providers: ProviderStatus[] })
  // Spending, cross-swarm work, app actions, outside agents, sharing
  | (EventBase<'budget.refused'> & { agent_id: string; code: string; count: number; hidden?: boolean } & Partial<RefusedLimit>)
  /** the spend-rate guard is pacing a mind's paid calls (once per pace): when a call fits again (`until`, ISO), and the
   *  limit it paces for whoever may see it */
  | (EventBase<'budget.slowed'> & { agent_id: string; retry_after: number; until: string; hidden?: boolean; scope?: string; period?: string; limit_usd?: number })
  | (EventBase<'budgets.updated'> & { budgets: BudgetLine[] })
  | (EventBase<'request.updated'> & { request: CollabRequest })
  | (EventBase<'program.action'> & { record: ProgramActionRecord })
  | (EventBase<'harness.connected'> & { invite: HarnessConnection })
  | (EventBase<'share.updated'> & { share: ShareRecord })
  // the stage (hive/core/stage.py): a mind's Show, Recall or Compare, sent only to the person its turn answers
  | (EventBase<'stage.said'> & StageSaid)
  // Motivations (host phase 1, hive/core/motivations.py): content changes, and link changes per (motivation, swarm)
  | (EventBase<'motivation.updated'> & { motivation: Motivation })
  | (EventBase<'motivation.links'> & { motivation_id: string; swarm_id: string; linked: string[]; unlinked: string[] })
  // Hive power (Off, Quiet and Wake all): to everyone, including while off
  | (EventBase<'hive.power'> & { state: 'on' | 'off'; since: string | null })
  // Surface missing-UI batch 1: kinds the host already sent (visibility.py rules: app.* admins only; the rest scoped)
  | (EventBase<'connection.updated'> & { connection: ConnectionAgreement })
  | (EventBase<'budget.overrun'> & { reservation: string; agent?: string | null; held_usd: number; actual_usd: number; source?: 'settle' | 'late-after-release' | 'resolve' | 'correct' | 'provider-record' })
  // one per expiry pass that settled calls at their worst case (admins only): how many, the total and who paid
  | (EventBase<'budget.estimated'> & { count: number; total_usd: number; payers: { payer: string; count: number; total_usd: number }[]; reservations: string[]; free?: { model: string; count: number }[] })
  | (EventBase<'app.grants_revoked'> & { program: string; by: string | null })
  | (EventBase<'app.grants_restored'> & { program: string; by: string | null })
  | (EventBase<'app.grants_restore_applied'> & { program: string; restored_by: string | null })
  | (EventBase<'app.grants_renewed'> & { program: string; by: string | null; grants: string[] })
  | (EventBase<'app.grants_refused'> & { program: string; by: string | null; reason: string })
  // The MeTTa coding controller (hive/core/code_controller_engine.py view(), reducer R3.12): typed, carry request_id
  | (EventBase<'code.controller.status'> & { request_id: string; status: string; phase: string; candidate: string | null })
  // Create's plan engine (create_plan_engine.py): status on any change of (status, phase, next_action); piece once per
  // change of a piece's (state, candidate, repairs); question when shown (answered false) and when answered (only
  // {plan_id, q, answered: true}); preview when a verified preview is made (preview = its ref)
  | (EventBase<'create.plan.status'> & { plan_id: string; phase: string | null; status: string; next_action: string | null })
  | (EventBase<'create.plan.piece'> & { plan_id: string; piece: string; state: string; candidate: string | null; repairs: number })
  | (EventBase<'create.plan.question'> & { plan_id: string; q: string; answered: boolean; about?: string | { piece: string }; text?: string; choices?: string[] })
  | (EventBase<'create.plan.preview'> & { plan_id: string; ckpt: string; preview: string })
  | (EventBase<'code.controller.applied'> & { request_id: string; candidate: string; workspace_id: string; paths: string[]; application_id: string | null; after: { generation: number; tree_digest: string } | null })
  /** A mind drafted a report into this person's feedback area, or a draft it made was dismissed or used (features/feedback). */
  | (EventBase<'feedback.draft'> & { principal?: string; draft: FeedbackDraft })
  | (EventBase<'feedback.draft.removed'> & { principal?: string; id: string })

/** One spending limit with what has been spent against it (GET /api/budgets, budgets.updated). */
export interface BudgetLine {
  id: string
  scope: string
  period: 'day' | 'month' | 'total'
  limit_usd: number
  spent_usd: number
  note: string
  origin: 'rule' | 'default'
}

/** A model call refused for spending (budget.refused): the mind is paused until a limit has room. */
export interface BudgetRefusal {
  code: string
  /** Refusals so far (the hive reports the first, then every 20th). */
  count: number
  at: string
  /** the limit that refused it, when the hive names one */
  limit?: RefusedLimit
  /** the limit that refused it is one this viewer may not see (another person's allowance or key spending): the hive
   *  sends the refusal with no limit, and the page says a spending limit it can't change stopped the mind */
  hidden?: boolean
}

/** The limit that refused a call, as budget.refused names it: `scope` (hive, agent:<id>, swarm:<id>, person:<id>, key:<id>,
 *  keyuse:<id>), its period (day, month, total, all-time), the limit, the spend recorded against it, the worst cases
 *  already held against it by calls not yet settled, and the refused call's own worst case (`call_usd`), which is why a
 *  limit with some room left still refused it. */
export interface RefusedLimit {
  scope: string
  period: string
  limit_usd: number
  spent_usd: number
  held_usd?: number
  call_usd?: number
}

/** One limit a mind's next paid call is admitted against (GET /api/agents/{id}/limits): its label (scope:period), what is
 *  spent and held against it, and the room left. */
export interface SeenLimit extends Required<Omit<RefusedLimit, 'call_usd'>> {
  label: string
  room_usd: number
  hidden?: undefined
}

/** A limit this viewer may not see (another person's allowance or key spending), in its place among a mind's limits with
 *  nothing about whose it is or its numbers. */
export interface UnseenLimit {
  hidden: true
  label: null
  scope: null
  period: null
  limit_usd: null
  spent_usd: null
  held_usd: null
  room_usd: null
}

export type CallLimit = SeenLimit | UnseenLimit

/** GET /api/agents/{id}/limits: every limit the mind's next paid call is admitted against, least room first, so the first
 *  stops it next. None for a free model; `reason` when a call would not settle at all (no_key, unpriced_model…). */
export interface CallLimits {
  free: boolean
  reason: string | null
  limits: CallLimit[]
}

/**
 * A cross-swarm request (hive/core/collab.py request_view). The state is the receiving goal's status through
 * REQUEST_STATE (open → queued, claimed → working, waiting → needs-approval, submitted → in-review, done → completed,
 * failed, cancelled), `accepted` when there is no receiving goal, and `cancelled` once cancelled_at is set. Submitted
 * work is `in-review` until the requester accepts (completed) or returns it (working again): never completed.
 */
export type RequestState = 'queued' | 'accepted' | 'working' | 'needs-approval' | 'in-review' | 'completed' | 'failed' | 'cancelled'
export interface CollabRequest {
  id: string
  kind: string
  title: string
  from_swarm: string
  from_goal: string | null
  from_principal: string
  to_swarm: string
  receiving_goal: string | null
  state: RequestState
  depth: number
  created_at: string
  cancelled_at: string | null
  budget: { root: string; limit_usd: number; allocated_usd: number }
  result?: unknown
  [extra: string]: unknown
}

/** An app action that finished (program.action). */
export interface ProgramActionRecord {
  id: string
  program: string
  swarm_id: string
  actor: string
  action: string
  status: string | null
}

/** The invitation an outside agent used to join (harness.connected). */
export interface HarnessConnection {
  id: string
  name: string
  swarm_id: string
  status: string
  agent_id: string | null
  [extra: string]: unknown
}

/** A memory share between minds (share.updated). */
export interface ShareRecord {
  id: string
  owner_id: string
  grantee_id: string
  status: string
  [extra: string]: unknown
}

/** The boundary a mind's running process actually has (GET /api/agents/{id}/isolation). */
export interface AgentIsolation {
  environment: string
  os_sandbox: boolean
  profile: string | null
  note?: string
  /** false when the hive has no process for this mind (not started since it last started): there is no boundary yet */
  running?: boolean
}

/** A person's access to a goal's coding work (GET /api/goals/{id}/grants). */
export interface GoalGrant {
  id: string
  goal_id: string
  principal: string
  scope: 'edit' | 'read'
  workspace_id: string | null
  created_by: string
  created_at: string
  expires_at: number
  revoked_at: string | null
  active: boolean
}

export type HiveEventType = HiveEvent['type']
export type EventOf<T extends HiveEventType> = Extract<HiveEvent, { type: T }>

/** Error checking across minds (hive/core/health.py). */
export type HealthSeverity = 'high' | 'medium' | 'low' | 'info'
export interface HealthIssue {
  kind: string
  severity: HealthSeverity
  meaning: string
  hint: string
  count: number
  skill: string
  example: { command: string; result: string }
  last_at: string | null
  iteration: number | null
  /** False once the problem is older than an hour: listed as earlier, not counted. */
  recent: boolean
}
export interface MindHealth {
  id: string
  name: string
  swarm_id: string | null
  status: string
  health: 'high' | 'medium' | 'low' | 'ok'
  issues: HealthIssue[]
  checked_commands: number
}
export interface HealthOverview {
  minds: MindHealth[]
  totals: Record<'high' | 'medium' | 'low' | 'ok', number>
}
export interface HealthAlert {
  agent_id: string
  name: string
  kind: string
  severity: HealthSeverity
  count: number
  skill: string
  result: string
  hint: string
}

/** Host connection agreement; scopes grant only the named operations while active. */
export type AgreementScope = { kind: 'requests'; direction: 'from->to' | 'to->from'; kinds: string[] } | { kind: 'memory'; side: 'from' | 'to'; mind: string; space: string; pattern?: string | null; access: 'read' }
export interface ConnectionAgreement {
  id: string; from_swarm: string; to_swarm: string; purpose: string; deliverable: string; success: string
  from_coordinator: string; to_coordinator: string; scopes: AgreementScope[]
  starts_at: string; ends_at: string | null; until_revoked: boolean; review_at: string | null
  budget_usd: number; allocated_usd: number; on_end: 'drain' | 'cancel'; status: 'active' | 'paused' | 'revoked' | 'ended'
  created_by: string; created_at: string; history: { at: string; by: string; event: string; reason?: string }[]
  summary: string; note: string
}
export interface CreateRequestConnection {
  from_swarm: string; to_swarm: string; purpose: string; deliverable: string; success: string
  from_coordinator: string; to_coordinator: string
  scopes: Extract<AgreementScope, { kind: 'requests' }>[]
  days: number; budget_usd: number; on_end: 'drain' | 'cancel'
}
export type ConnectionAction = 'pause' | 'resume' | 'renew' | 'revoke'

/** R18: what is waiting to load, who asked, what must not be interrupted. */
export interface UpdateRequest { id: string; target: string; note: string; receipts: string[]; requested_by: string; created_at: string }
export interface UpdateHold { id: string; scope: string; reason: string; held_by: string; created_at: string; until: string | null; released_at?: string | null; released_by?: string | null }
/** POST /api/updates/holds (admin): restart holds the platform, all holds everything, program:<id> one app. */
export interface PlaceHoldBody { scope: 'restart' | 'all' | `program:${string}`; reason: string; until?: string }
export interface AppUpdate {
  target: string; id: string; name: string; loaded_version: string | null; disk_version: string | null
  loaded_digest: string | null; disk_digest: string | null; load_error: string | null
  update_available: boolean; removed_on_disk: boolean; request: UpdateRequest | null
}
export interface PlatformUpdate {
  target: 'platform'; running_build: string | null; running_release: HiveRelease | null; source_build: string | null; started_at: string
  update_available: boolean; commits_waiting: { commit: string; subject: string }[]; supervised: boolean; request: UpdateRequest | null
  /** What the Mac updater of an installed hive knows (its state file, which the launcher names); null without one. */
  installer: InstallerUpdate | null
}
/** The release an installer laid the hive's code out from (RELEASE_COMMIT, RELEASE_VERSION beside hive/); a git
 *  checkout has none. version is null for a build without a release number. */
export interface HiveRelease { version: string | null; commit: string }
/** An installed Mac hive's updater: the newest signed release it took (offered while above the running release, with
 *  its signed label and notes), when it last took one, why its last check could not check (until one takes a
 *  statement), a Not now waiting out its day, why an accepted update of the offer failed, whether a Check now is
 *  running, and whether it is otherwise checking or installing now. Applying the platform update runs it. */
export interface InstallerUpdate {
  newest: string | null
  offer: { version: string; label: string; notes: string } | null
  checked_at: string | null
  /** the later checks' failure, until a check takes a statement: the plain reason the page says, and the log's detail */
  check_failed: { reason: string; detail: string; at: string | null } | null
  checking: boolean
  deferred_until: string | null
  failed: { version: string; error: string; at: string | null } | null
  updating: boolean
}
/** What Check now answers (POST /api/updates/check): the release on offer, up to date, or why it could not check,
 *  with the updater's view after the check. */
export interface UpdateChecked { result: 'offer' | 'current' | 'failed'; error: string | null; installer: InstallerUpdate | null }
/** What applying an update answers: an app reloaded, a restart under way, or an installed release's update started. */
export interface UpdateApplied {
  target: string; ok: boolean; restarting?: boolean; updating?: boolean; to?: string | null; label?: string; error?: string | null
}
export interface UpdateHistoryRow { id: string; target: string; by: string; at: string; before: Record<string, unknown>; after: Record<string, unknown>; ok: boolean; error: string | null; overrode: string[] }
export interface UpdatesOverview { platform: PlatformUpdate; apps: AppUpdate[]; holds: UpdateHold[]; history: UpdateHistoryRow[] }

/** R19: the explorer. Every thing as a node with the same facets; grouped and paged on the server. */
export type ExploreKind = 'mind' | 'swarm' | 'app' | 'room'
export type ExploreFacet = 'kind' | 'where' | 'state' | 'swarm' | 'purpose' | 'role' | 'owner' | 'visibility' | 'health' | 'spend' | 'active' | 'tag' | 'group'
export interface ExploreNode {
  id: string; kind: ExploreKind; name: string; parent: string | null
  facets: Record<Exclude<ExploreFacet, 'tag' | 'group'>, string> & { tag: string[]; group: string[] }; detail: Record<string, unknown>
}
export interface ExploreGroupDef { id: string; name: string; members: string[] }
export interface ExploreGroup { facet: ExploreFacet; value: string; path: string; count: number; groups?: ExploreGroup[] | null; items?: ExploreNode[] | null; next?: number | null }
export interface ExploreSpec {
  kinds?: ExploreKind[]; filters?: Partial<Record<ExploreFacet, string[]>>; q?: string; group_by?: ExploreFacet[]
  open?: string[]; cursor?: Record<string, number>; limit?: number; sort?: 'name' | 'state' | 'active'
}
export interface ExploreResult {
  total: number; facets: Record<ExploreFacet, Record<string, number>>; facet_names: ExploreFacet[]
  groups?: ExploreGroup[]; items?: ExploreNode[]; next?: number | null
}
export interface ExploreArrangement { order?: Record<string, string[]>; pinned?: string[]; collapsed?: string[]; layout?: 'list' | 'grid' | 'tree' }
export interface ExploreView { id: string; name: string; spec: ExploreSpec; arrangement: ExploreArrangement; updated_at: string }

/** R15 rooms: DMs, groups, channels and projects as one thing (hive/core/rooms.py). */
export type RoomKind = 'dm' | 'group' | 'channel' | 'project' | 'session' | 'coffee'
export interface RoomMember { member: string; role: string; name: string }
export interface Room {
  id: string; kind: RoomKind; name: string; topic: string; owner: string
  visibility: 'private' | 'shared' | 'public'; shared_with: string[]; swarm_id: string | null
  seq: number; created_at: string; updated_at: string
  /** turn_cap: mind turns in a row before the room waits for a person, or null (off: throughput limits bound minds). */
  settings: { minds_follow: boolean; turn_cap: number | null }
  members: RoomMember[]; unread?: number; joined?: boolean; me?: string
  /**
   * The room's other name, the one a mind's conversation id may use and a link by conversation opens: "coffee" for the
   * Coffee Room (also `pinned: true`; one per hive, never deleted, archived or re-kinded), c_<mind> for a mind's DM,
   * team_<swarm> for a swarm's room. Rooms without one carry none.
   */
  alias?: string | null; pinned?: boolean
  /** The message this room was started from ("Talk privately" / "Start a group"), as the host checked it. */
  origin?: RoomOrigin | null
  /** A swarm's own room (rooms.py is_team): it follows its swarm, and only its topic can change. */
  team?: boolean
}
export interface RoomOrigin { room_id: string; message_id: string }
export interface RoomMessage {
  id: string; room_id: string; seq: number; sender: string; name: string; text: string
  mentions: string[]; delivered_to: string[]; created_at: string
  /**
   * Mind messages in a row this one makes (rooms.py mind_run): 0 for a person's message or an orchestrator mind's
   * carry-on, either of which starts a new run; the hive's stop notice repeats the count of the message it stopped.
   */
  mind_run: number
  /** `@here` in the Coffee Room: the awake minds it reached (at most 5). */
  here_reached?: string[]
  /** A mind's unprompted note: no mentions, wakes nobody. */
  note?: boolean
  /** Health's idle question mirrored into the mind's DM room, its id tag removed (lib/healthQuestion). */
  health_check?: boolean
  /** The DM room copy of a note only the mind reads (Hive.mind_only): kept by the hive, left out of the room's page. */
  mind_only?: boolean
  /**
   * The message this room copy was made from (rooms.py source_message_id): a mind's reply or a chat message keeps its
   * own id here, so a link naming that message finds the copy; null for a message first said in the room.
   */
  source_message_id?: string | null
}

/** A focused working thread with one mind (hive/core/sessions.py). */
export interface WorkSession {
  id: string; room_id: string; agent_id: string; goal_id: string | null; owner: string; title: string
  status: 'active' | 'ended'; budget_usd: number; spent_usd: number; created_at: string; ended_at: string | null
  workspace: Record<string, unknown> | null
  mind: { id: string; name: string; hue?: number; status?: string }
  goal: { id: string; title: string; status: string } | null
  /** 'ask': a Universal Ask thread (core/sessions.py view); absent on an older host */
  purpose?: string | null
}
export type SessionItem =
  | ({ type: 'message'; at: string } & RoomMessage)
  | { type: 'step'; at: string; iteration: number; steps: { command: string; result: string; gated?: string | null }[] }
  | { type: 'approval'; at: string; id: string; skill: string; command: string; reason: string; risk: string; status: string }

/** GET /api/settings: how this hive is configured (admin only, no secrets). */
export interface HiveSettings {
  hive: { name: string; build: string | null; release: HiveRelease | null; started_at: string; supervised: boolean; base_paths: string[] }
  signin: { password: boolean; password_from_env: boolean; family_google: boolean
    hive_google: { configured: boolean; callback_path: string; note: string } }
  disk: { free_bytes: number; total_bytes: number; hive_data_bytes: number }
  apps: { homes: Record<string, string[]>; sandbox_apps: string[]; sandbox_runtimes: string[]; local_only_swarms: string[] }
}

/**
 * GET /api/feedback (hive/core/feedback.py): what the hive adds to a person's feedback or bug report, for any signed-in
 * person. `to` is where reports go, from the one setting HIVE_FEEDBACK_TO: the feedback board (offered once GitHub
 * answers it as public: `public` true; false while private; null while not known), a report service, none, or a value
 * the hive could not use (said, with its reason).
 */
export interface FeedbackContext {
  /** "Mac v0.31 (build f9648d4386)"; "build 5b1290bfc5" for a hive run from git */
  version: string
  /** "own hive, Mac install", "the hive at staging.example.org", "a hive run from source on Linux" */
  which: string
  system: string
  to: FeedbackDestination
  /** this person's most recent error answers, newest first */
  errors: HiveErrorAnswer[]
}
export type FeedbackDestination =
  | { kind: 'board'; owner: string; repo: string; url: string; public: boolean | null }
  | { kind: 'service'; url: string; host: string }
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
/** One error answer the hive gave this person, by its id (the X-Hive-Error-Id header the page saw). */
export interface HiveErrorAnswer {
  id: string
  at: string
  method: string
  /** the route's pattern, so no id is named: "/api/swarms/{swarm_id}" */
  route: string
  status: number
  code: string
  message: string
  /** an error the hive did not expect: where it was raised, "KeyError at hive/core/ask.py:1130 in _close" */
  raised?: string
}
/** POST /api/feedback/send: the report service took the report; `reference` is its id there, when it gave one. */
export interface FeedbackSent { sent: true; to: string; reference: string | null }
/**
 * A report a mind drafted with its skill (hive-report-problem) when it noticed something broken, waiting in its person's
 * feedback area (GET /api/feedback/drafts) until they open it into a report or dismiss it. It sends nothing itself.
 */
export interface FeedbackDraft {
  /** fd- and 8 hex digits */
  id: string
  kind: 'bug' | 'ux' | 'idea'
  title: string
  words: string
  steps: string | null
  expected: string | null
  source: { kind: 'mind'; agent: string; name: string; conversation: string | null }
  /** when the mind drafted it (or last said it again), UTC */
  created: string
}

/** GET /api/usage/me: the signed-in person's own spend this month. */
export interface MySpendSummary {
  principal: string; since: string; hive_paid_usd: number; own_keys_usd: number; own_keys: number
  allowance_usd: number | null; allowance_origin: 'rule' | 'member-default' | null; remaining_usd: number | null
  /** what calls not yet settled hold against the allowance (absent from a hive before held amounts were shown) */
  held_usd?: number
  by_mind: { agent_id: string; name: string; cost_usd: number }[]
}

/** A person's request to the hive's admins (hive/core/person_requests.py). */
export interface PersonAsk {
  id: string
  kind: 'mind' | 'allowance' | 'swarm_access'
  requested_by: string
  payload: Record<string, unknown>
  note: string
  status: 'pending' | 'granted' | 'declined'
  decided_by: string | null
  decided_at: string | null
  decision: string | null
  result: Record<string, unknown> | null
  created_at: string
}

// ---------------------------------------------------------------- Motivations above Tasks (host phase 1)
// The built contract: hive/API.md "Motivations and the Tasks query (phase 1)", hive/core/motivations.py. A motivation is
// the why; a task is today's goal, unchanged (every goal route, event and shape stays as it is).

export type MotivationStatus = 'active' | 'paused' | 'achieved' | 'retired'

/** The reader view (GET /api/motivations/{id}); an editor also gets `shared_with` and `links_version`. */
export interface Motivation {
  id: string
  title: string
  why: string
  /** `user:u_…` (a person), `swarm:s_…` (a team) or `agent:a_…` (a mind's own, scoped to its swarm). */
  owner: string
  /** The team it is scoped to; null for a person's motivation that spans teams. */
  swarm_id: string | null
  status: MotivationStatus
  visibility: Visibility
  /** Content revision: moves on title, why, status and visibility edits only, never on links. */
  rev: number
  /** Sub-motivations exist in the data but are switched off on the hive (Jon Q1): always null for now. */
  parent_id: string | null
  /** Who made it: a person's principal or `agent:<id>` (a mind, Jon Q2). */
  created_by: string
  created_at: string
  updated_at: string
  status_changed_at: string | null
  /** May this viewer edit it (and link tasks to it)? Absent on a motivation.updated event (the reader view). */
  editable?: boolean
  shared_with?: string[]
  links_version?: number
}

/** One readable link on a task (GET /api/tasks item `motivations`). */
export interface MotivationRef {
  id: string
  title: string
  status: MotivationStatus
}

export interface TaskRequestRef {
  id: string
  kind: string
  state: string
  direction: 'in' | 'out'
}

/** A GET /api/tasks item: the swarm goal list row plus the viewer's readable links and visible requests. */
export type TaskItem = Goal & { motivations: MotivationRef[]; requests: TaskRequestRef[] }

export interface TaskQuery {
  /** `mo_…`, or `none` for Unsorted (no link to any motivation this viewer can read). */
  motivation?: string
  swarm?: string
  mind?: string
  /** One status or a comma list. */
  status?: string
  q?: string
  top?: boolean
  sort?: 'priority' | 'updated'
  cursor?: string
  limit?: number
}

export interface TaskCounts {
  total: number
  by_status: Record<string, number>
}

export interface TaskList {
  items: TaskItem[]
  counts: TaskCounts
  cursor: string | null
}

export interface MotivationList {
  items: Motivation[]
  cursor: string | null
}

export interface CreateMotivationBody {
  title: string
  why?: string
  /** Defaults to the caller. `swarm:<id>` for a team motivation (the swarm's owner or an admin). */
  owner?: string
  swarm_id?: string | null
  visibility?: Visibility
  shared_with?: string[]
}

export interface PatchMotivationBody {
  title?: string
  why?: string
  status?: MotivationStatus
  expected_rev: number
}

export interface MotivationLinkBody {
  operation_id: string
  op: 'link' | 'unlink' | 'move'
  goal_ids: string[]
  cascade: boolean
  expected_to_rev: number
  expected_to_links_version?: number
  from_motivation_id?: string
  expected_from_rev?: number
  expected_from_links_version?: number
}

export interface MotivationLinkResult {
  operation_id: string
  applied: string[]
  unchanged: string[]
  motivation: Motivation
  from_motivation?: Motivation
  replayed?: boolean
}
