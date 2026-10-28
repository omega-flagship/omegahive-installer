import type { AgentKind, CatalogModel, ModelOption, Swarm } from '../types'

export const SIM_MODELS: (ModelOption & { inPerM: number; outPerM: number })[] = [
  { id: 'anthropic/claude-opus-5-5', provider: 'anthropic', label: 'Claude Opus 5.5', local: false, inPerM: 15, outPerM: 75 },
  { id: 'anthropic/claude-sonnet-5-5', provider: 'anthropic', label: 'Claude Sonnet 5.5', local: false, inPerM: 3, outPerM: 15 },
  { id: 'anthropic/claude-haiku-5', provider: 'anthropic', label: 'Claude Haiku 5', local: false, inPerM: 0.8, outPerM: 4 },
  { id: 'openai/gpt-5-mini', provider: 'openai', label: 'GPT-5 mini', local: false, inPerM: 0.25, outPerM: 2 },
  { id: 'ollama/qwen3-14b', provider: 'ollama', label: 'Qwen3 14B (local)', local: true, inPerM: 0, outPerM: 0 },
  { id: 'mock/echo', provider: 'mock', label: 'Echo (mock)', local: true, inPerM: 0, outPerM: 0 },
]

/** A small made-up OpenRouter catalogue for the simulator's model picker. */
export const SIM_CATALOG: CatalogModel[] = [
  { id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', description: 'Balanced model for agents and coding.', context_length: 1_000_000, max_completion_tokens: 64_000, in_per_m: 3, out_per_m: 15, inputs: ['text', 'image', 'file'], outputs: ['text'], tools: true, reasoning: true },
  { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', description: 'The most capable Claude.', context_length: 1_000_000, max_completion_tokens: 64_000, in_per_m: 15, out_per_m: 75, inputs: ['text', 'image', 'file'], outputs: ['text'], tools: true, reasoning: true },
  { id: 'openai/gpt-5.6-sol', name: 'OpenAI: GPT-5.6 Sol', description: 'Frontier reasoning model.', context_length: 400_000, max_completion_tokens: 128_000, in_per_m: 2.5, out_per_m: 10, inputs: ['text', 'image'], outputs: ['text'], tools: true, reasoning: true },
  { id: 'google/gemini-3.1-pro-preview', name: 'Google: Gemini 3.1 Pro Preview', description: 'Long-context multimodal model.', context_length: 1_048_576, max_completion_tokens: 65_536, in_per_m: 2, out_per_m: 12, inputs: ['text', 'image', 'audio', 'video'], outputs: ['text'], tools: true, reasoning: true },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek: V4 Pro', description: 'Open-weight reasoning model.', context_length: 262_144, max_completion_tokens: 32_000, in_per_m: 0.55, out_per_m: 2.19, inputs: ['text'], outputs: ['text'], tools: true, reasoning: true },
  { id: 'moonshotai/kimi-k3', name: 'MoonshotAI: Kimi K3', description: 'Agentic open-weight model.', context_length: 262_144, max_completion_tokens: 32_000, in_per_m: 0.6, out_per_m: 2.5, inputs: ['text', 'image'], outputs: ['text'], tools: true, reasoning: false },
  { id: 'z-ai/glm-5.1', name: 'Z.ai: GLM 5.1', description: 'Fast open-weight generalist.', context_length: 200_000, max_completion_tokens: 32_000, in_per_m: 0.45, out_per_m: 1.8, inputs: ['text'], outputs: ['text'], tools: true, reasoning: true },
  { id: 'meta-llama/llama-4-maverick:free', name: 'Meta: Llama 4 Maverick (free)', description: 'Free tier, rate-limited.', context_length: 131_072, max_completion_tokens: 8_192, in_per_m: 0, out_per_m: 0, inputs: ['text', 'image'], outputs: ['text'], tools: false, reasoning: false },
  { id: 'mistralai/mistral-small-4', name: 'Mistral: Small 4', description: 'Small, fast and cheap.', context_length: 128_000, max_completion_tokens: 16_000, in_per_m: 0.1, out_per_m: 0.3, inputs: ['text', 'image'], outputs: ['text'], tools: true, reasoning: false },
  { id: 'qwen/qwen3.5-coder', name: 'Qwen: Qwen3.5 Coder', description: 'Code-specialised open model.', context_length: 262_144, max_completion_tokens: 32_000, in_per_m: 0.3, out_per_m: 1.2, inputs: ['text'], outputs: ['text'], tools: true, reasoning: false },
]

export interface SeedSwarm {
  id: string
  name: string
  description: string
  hue: number
  vocab: string[]
  /** [statement, f, c] */
  beliefs: [string, number, number][]
  musings: string[]
}

/** Invented hierarchy and offerings for visual review; no live service is invoked. */
export const SEED_TEAMS: Record<string, Pick<Swarm, 'coordinator_id' | 'parent_mind_id' | 'parent_swarm_id' | 'child_swarm_ids' | 'services'>> = {
  s_forge: { coordinator_id: 'a_anvl09', parent_mind_id: null, parent_swarm_id: null, child_swarm_ids: ['s_lyra'], services: ['code-review'] },
  s_lyra: { coordinator_id: 'a_vega01', parent_mind_id: 'a_anvl09', parent_swarm_id: 's_forge', child_swarm_ids: [], services: [] },
  s_kelp: { coordinator_id: 'a_coral5', parent_mind_id: null, parent_swarm_id: null, child_swarm_ids: [], services: [] },
}

export interface SeedAgent {
  id: string
  name: string
  kind: AgentKind
  swarm_id: string | null
  model: string
  hue: number
  persona: string
  budget_usd: number
  /** Personality flavour used by the reply generator. */
  voice: 'precise' | 'warm' | 'terse' | 'poetic' | 'wry'
  start: 'awake' | 'asleep' | 'stopped'
}

export const SEED_SWARMS: SeedSwarm[] = [
  {
    id: 's_lyra',
    name: 'Lyra',
    description: 'Sky-survey swarm. Watches variable stars and argues about what they mean.',
    hue: 258,
    vocab: ['star', 'vega', 'deneb', 'altair', 'variable', 'luminous', 'binary', 'nebula', 'redshift', 'pulsar', 'cepheid', 'flare', 'observed', 'periodic'],
    beliefs: [
      ['(--> vega star)', 1, 0.95],
      ['(--> vega luminous)', 0.94, 0.86],
      ['(--> deneb supergiant)', 0.88, 0.74],
      ['(--> altair fast-rotator)', 0.91, 0.7],
      ['(==> (--> star cepheid) (--> star periodic))', 0.97, 0.9],
      ['(--> vega dust-disk-host)', 0.81, 0.63],
      ['(--> sheliak binary)', 0.92, 0.77],
      ['(--> ring-nebula planetary)', 0.96, 0.82],
      ['(--> rr-lyrae variable)', 0.89, 0.71],
      ['(==> (--> star flare) (--> star variable))', 0.72, 0.55],
      ['(--> kic-8462 dimming-anomaly)', 0.64, 0.41],
      ['(--> epsilon-lyrae double-double)', 0.86, 0.68],
      ['(--> m57 ring-observed)', 0.93, 0.72],
      ['(--> vega pole-on)', 0.77, 0.52],
    ],
    musings: [
      'Light curve on RR Lyrae came in clean. Period holds at 0.567 days.',
      'Someone keeps asserting KIC 8462 is artificial. Evidence is thin; confidence stays low.',
      'Vega is pole-on, which is why it looks so even. I would like more spectra before I commit.',
      'Cross-checked the ring nebula against the archive. Revised upward.',
    ],
  },
  {
    id: 's_kelp',
    name: 'Kelp Commons',
    description: 'Coastal-ecology swarm. Models a kelp forest and its urchins, otters and tides.',
    hue: 168,
    vocab: ['kelp', 'urchin', 'otter', 'tide', 'grazes', 'eats', 'canopy', 'barren', 'warm-water', 'recovers', 'sunflower-star', 'holdfast'],
    beliefs: [
      ['(--> urchin kelp-grazer)', 0.96, 0.88],
      ['(--> otter urchin-eater)', 0.93, 0.84],
      ['(==> (--> reef barren) (--> reef urchin-dominated))', 0.87, 0.73],
      ['(--> kelp canopy-former)', 0.98, 0.9],
      ['(==> warm-water (--> kelp stressed))', 0.82, 0.69],
      ['(--> sunflower-star urchin-predator)', 0.9, 0.66],
      ['(--> reef-north barren)', 0.58, 0.47],
      ['(--> holdfast habitat)', 0.91, 0.62],
      ['(==> (--> otter present) (--> kelp recovers))', 0.79, 0.6],
      ['(--> spring-tide reef-exposing)', 0.84, 0.58],
      ['(--> reef-south canopy)', 0.71, 0.5],
      ['(--> crab urchin-larva-eater)', 0.6, 0.38],
    ],
    musings: [
      'North reef transect: urchin density up 14%. That pulls (--> reef-north barren) higher.',
      'Otter sighting near the south holdfasts. Small, but it counts as evidence.',
      'Water at 17.8 °C today. Holding the warm-water stress rule steady.',
      'Two of us disagree about reef-south. Choice kept the stronger stamp.',
    ],
  },
  {
    id: 's_forge',
    name: 'Forge',
    description: 'Infra swarm. Keeps the hive itself healthy: builds, queues, budgets, uptime.',
    hue: 32,
    vocab: ['service', 'healthy', 'degraded', 'queue', 'latency', 'build', 'green', 'deploy', 'budget', 'gateway', 'backlog', 'cache'],
    beliefs: [
      ['(--> gateway healthy)', 0.97, 0.91],
      ['(--> build-main green)', 0.93, 0.85],
      ['(--> queue-backlog low)', 0.81, 0.7],
      ['(==> (--> service degraded) (--> service needs-page))', 0.95, 0.88],
      ['(--> cache-hit-rate high)', 0.76, 0.64],
      ['(--> llm-latency p95-elevated)', 0.44, 0.52],
      ['(--> nightly-deploy safe)', 0.83, 0.61],
      ['(--> disk-node-3 degraded)', 0.31, 0.57],
      ['(--> budget-burn on-track)', 0.88, 0.72],
      ['(==> (--> build-main red) (--> deploy blocked))', 0.99, 0.93],
    ],
    musings: [
      'p95 on the gateway crept to 2.4s, then settled. Not paging anyone.',
      'Main is green. Nightly deploy can proceed.',
      'Disk on node-3 looked bad, then fine. Conflicting stamps went through choice.',
      'Burn rate across the hive is on track for the month.',
    ],
  },
]

export const SEED_AGENTS: SeedAgent[] = [
  { id: 'a_vega01', name: 'Vega', kind: 'omega', swarm_id: 's_lyra', model: 'anthropic/claude-sonnet-5-5', hue: 248, voice: 'precise', start: 'awake', budget_usd: 40,
    persona: 'You are Vega, a careful observational astronomer. You never round up your confidence. You cite evidence stamps when you can.' },
  { id: 'a_deneb2', name: 'Deneb', kind: 'omega', swarm_id: 's_lyra', model: 'anthropic/claude-opus-5-5', hue: 205, voice: 'poetic', start: 'awake', budget_usd: 80,
    persona: 'You are Deneb, the swarm\'s theorist. You look for rules that generalise across stars and state them as implications.' },
  { id: 'a_altr03', name: 'Altair', kind: 'omega', swarm_id: 's_lyra', model: 'anthropic/claude-haiku-5', hue: 285, voice: 'terse', start: 'asleep', budget_usd: 15,
    persona: 'You are Altair. Fast, terse, and sceptical. You flag anomalies and leave the theory to others.' },
  { id: 'a_mira04', name: 'Mira', kind: 'iter', swarm_id: 's_lyra', model: 'ollama/qwen3-14b', hue: 320, voice: 'wry', start: 'awake', budget_usd: 0,
    persona: 'You are Mira, a variable-star tracker that runs on local hardware. You have a dry sense of humour about being periodic.' },
  { id: 'a_coral5', name: 'Coral', kind: 'omega', swarm_id: 's_kelp', model: 'anthropic/claude-sonnet-5-5', hue: 352, voice: 'warm', start: 'awake', budget_usd: 30,
    persona: 'You are Coral, a field ecologist. You care about the forest as a whole and explain trade-offs gently.' },
  { id: 'a_nori06', name: 'Nori', kind: 'omega', swarm_id: 's_kelp', model: 'anthropic/claude-haiku-5', hue: 150, voice: 'precise', start: 'awake', budget_usd: 12,
    persona: 'You are Nori. You count urchins, otters and stipes, and you publish numbers rather than opinions.' },
  { id: 'a_sedg07', name: 'Sedge', kind: 'iter', swarm_id: 's_kelp', model: 'openai/gpt-5-mini', hue: 95, voice: 'terse', start: 'asleep', budget_usd: 8,
    persona: 'You are Sedge, a tide-pool watcher. Short reports, always with time and place.' },
  { id: 'a_wrak08', name: 'Wrack', kind: 'module', swarm_id: 's_kelp', model: 'mock/echo', hue: 185, voice: 'wry', start: 'stopped', budget_usd: 0,
    persona: 'Wrack is an ingestion module that turns buoy telemetry into assertions.' },
  { id: 'a_anvl09', name: 'Anvil', kind: 'omega', swarm_id: 's_forge', model: 'anthropic/claude-sonnet-5-5', hue: 24, voice: 'precise', start: 'awake', budget_usd: 25,
    persona: 'You are Anvil, the hive\'s site-reliability engineer. Calm under pressure, allergic to hand-waving.' },
  { id: 'a_bell10', name: 'Bellows', kind: 'iter', swarm_id: 's_forge', model: 'anthropic/claude-haiku-5', hue: 45, voice: 'warm', start: 'awake', budget_usd: 6,
    persona: 'You are Bellows. You watch budgets and token burn and nudge others when they overspend.' },
  { id: 'a_qnch11', name: 'Quench', kind: 'omega', swarm_id: 's_forge', model: 'openai/gpt-5-mini', hue: 8, voice: 'wry', start: 'asleep', budget_usd: 10,
    persona: 'You are Quench, the on-call responder. You go quiet until something breaks, then you are very loud.' },
  { id: 'a_wisp12', name: 'Wisp', kind: 'module', swarm_id: null, model: 'anthropic/claude-haiku-5', hue: 58, voice: 'poetic', start: 'awake', budget_usd: 5,
    persona: 'Wisp is a free-roaming scout. It belongs to no swarm and carries rumours between them.' },
]

export const NAME_IDEAS = [
  'Lumen', 'Orrery', 'Tessel', 'Halcyon', 'Ember', 'Sable', 'Quill', 'Nimbus', 'Fable', 'Cinder', 'Moth', 'Castor',
  'Rook', 'Juno', 'Pike', 'Wren', 'Thistle', 'Kestrel', 'Lark', 'Onyx', 'Pollen', 'Echo', 'Drift', 'Spindle',
]

export const PERSONA_TEMPLATES: { label: string; text: string }[] = [
  { label: 'Observer', text: 'You watch carefully and publish only what you have evidence for. Keep confidence honest.' },
  { label: 'Theorist', text: 'You look for general rules across the commons and express them as implications.' },
  { label: 'Sceptic', text: 'You challenge weak beliefs, ask for evidence, and flag anomalies quickly.' },
  { label: 'Steward', text: 'You keep the swarm healthy: summarise, tidy the vocabulary, and help newcomers.' },
]

export const LOG_TEMPLATES = [
  'hub: heartbeat ok rtt={rtt}ms',
  'metta: (match &self {pat} $x) -> {n} results',
  'skills: invoked {skill} in {ms}ms',
  'llm: {model} prompt={pt} completion={ct}',
  'atomspace: {n} atoms, {m} links',
  'commons: query {pat} -> {n} hits',
  'memory: consolidated {n} episodes',
  'scheduler: next wake in {s}s',
]

export const SKILLS = ['search-archive', 'compute-period', 'summarise', 'fetch-telemetry', 'plot-curve', 'diff-beliefs', 'notify']

// ---------------------------------------------------------------- admin surfaces (all invented)

/** The simulator's role library. `minds` lists seeded agents; the client keeps it current. */
export const SEED_ROLES: { id: string; name: string; summary: string; prompt: string; default_model: string | null; default_budget: number | null; rules: { skill: string; mode: 'allow' | 'ask' | 'deny' }[]; builtin: boolean; minds: string[] }[] = [
  {
    id: 'r_observer',
    name: 'Observer',
    summary: 'Watches, records and reports; changes nothing outside the hive',
    prompt: 'You are {name}, an observer in {swarm}. {purpose} Record what you see as beliefs with honest confidence, and ask before acting outside the hive.',
    default_model: 'anthropic/claude-haiku-5',
    default_budget: 10,
    rules: [
      { skill: 'shell*', mode: 'deny' },
      { skill: 'write-file*', mode: 'ask' },
    ],
    builtin: true,
    minds: ['a_altr03', 'a_nori06'],
  },
  {
    id: 'r_analyst',
    name: 'Analyst',
    summary: 'Weighs evidence, settles disagreements, proposes tasks',
    prompt: 'You are {name}, the analyst of {swarm}. {purpose} When beliefs conflict, look for the evidence that would settle them and propose a task to get it.',
    default_model: 'anthropic/claude-sonnet-5-5',
    default_budget: 40,
    rules: [{ skill: 'web-search', mode: 'allow' }],
    builtin: true,
    minds: ['a_vega01', 'a_coral5', 'a_anvl09'],
  },
  {
    id: 'r_builder',
    name: 'Builder',
    summary: 'Writes and tests code in an isolated workspace',
    prompt: 'You are {name}, a builder in {swarm}. Work in your own workspace, run the tests before you report, and never apply a change without approval.',
    default_model: 'anthropic/claude-sonnet-5-5',
    default_budget: 25,
    rules: [
      { skill: 'code-edit', mode: 'allow' },
      { skill: 'code-run', mode: 'ask' },
      { skill: 'shell*', mode: 'ask' },
    ],
    builtin: false,
    minds: ['a_bell10'],
  },
]

export const SEED_PEOPLE: { id: string; email: string; name: string; role: 'admin' | 'member'; daysAgo: number; seenHoursAgo: number | null; disabled?: boolean; googleBound?: boolean }[] = [
  { id: 'p_ada', email: 'ada@example.org', name: 'Ada Brightwater', role: 'admin', daysAgo: 41, seenHoursAgo: 2, googleBound: true },
  { id: 'p_tomas', email: 'tomas@example.org', name: 'Tomás Reyes', role: 'member', daysAgo: 19, seenHoursAgo: 30, googleBound: true },
  { id: 'p_ines', email: 'ines@example.org', name: 'Inès Morel', role: 'member', daysAgo: 6, seenHoursAgo: null },
  { id: 'p_kofi', email: 'kofi@example.org', name: 'Kofi Mensah', role: 'member', daysAgo: 60, seenHoursAgo: 400, disabled: true, googleBound: true },
]

export const SEED_INVITES: { id: string; email: string; name: string; role: 'admin' | 'member'; daysAgo: number; days: number; status: 'pending' | 'accepted' | 'expired' | 'revoked' }[] = [
  { id: 'i_jun', email: 'jun@example.org', name: 'Jun Park', role: 'member', daysAgo: 1, days: 7, status: 'pending' },
  { id: 'i_sara', email: 'sara@example.org', name: 'Sara Lind', role: 'admin', daysAgo: 3, days: 14, status: 'pending' },
  { id: 'i_ines', email: 'ines@example.org', name: 'Inès Morel', role: 'member', daysAgo: 8, days: 7, status: 'accepted' },
]

/** Invented failure patterns for the health page: [agent, kind, severity, skill, count, minutesAgo, command, result, meaning, hint]. */
export const SEED_HEALTH: [string, string, 'high' | 'medium' | 'low' | 'info', string, number, number, string, string, string, string][] = [
  ['a_deneb2', 'refused', 'high', 'shell', 7, 4, '(shell "curl -s https://survey.example/feed")', 'refused: shell is denied for this mind', 'A rule refuses this skill, and the mind keeps trying it', 'Give the mind another way to fetch the feed, or allow the skill for it in Roles or Inbox rules.'],
  ['a_deneb2', 'timeout', 'medium', 'web-search', 3, 22, '(web-search "cepheid period luminosity 2026")', 'error: timed out after 30s', 'Searches are timing out', 'Usually transient. If it persists, check the hive’s network or the search provider.'],
  ['a_coral5', 'waiting', 'medium', 'write-file', 2, 9, '(write-file "notes/bloom.md" "...")', 'waiting for approval', 'Commands are waiting for a person to approve them', 'Open Inbox and decide; the mind is paused on these.'],
  ['a_sedg07', 'bad-args', 'low', 'metta', 4, 48, '(metta "(match &self (--> $x kelp)")', 'error: unbalanced parentheses', 'Malformed MeTTa from the model', 'Minor. A stronger model or a clearer role prompt usually fixes it.'],
  ['a_qnch11', 'budget', 'high', 'llm', 1, 15, '(think)', 'refused: budget_exhausted ($10.00 of $10.00)', 'The mind hit its spending limit and stopped thinking', 'Raise its budget in its Model tab, or a limit in Usage.'],
  ['a_anvl09', 'error', 'low', 'code-run', 2, 180, '(code-run "pytest -q")', 'exit 1: 2 failed, 41 passed', 'Tests failed in its workspace', 'Earlier, not counted. Open the mind’s trace to see which tests.'],
]

/** Things the Code page lists in the demo. Only the invented `repo:sim-suggestions` opens (sim/codeService.ts); the rest have no code service. */
export const SIM_CODE_TARGETS: { id: string; kind: 'hive' | 'program' | 'mind' | 'service' | 'repository'; label: string; detail: string; owner: string; mind?: string; private?: boolean; built_in?: boolean; branch?: string; commit?: string }[] = [
  { id: 'hive', kind: 'hive', label: 'OmegaHive', detail: 'The hive itself: the API, the policy gate, the scheduler and this interface.', owner: 'operator', built_in: true, branch: 'main', commit: 'a17c3e5f90b2' },
  { id: 'program:planner', kind: 'program', label: 'Task planner', detail: 'Splits tasks into subtasks and hands them to minds with the right role.', owner: 'operator', built_in: true, branch: 'main', commit: 'a17c3e5f90b2' },
  { id: 'program:review', kind: 'program', label: 'Review panel', detail: 'Collects findings under a review mandate and asks a second mind to judge them.', owner: 'operator', branch: 'main', commit: 'a17c3e5f90b2' },
  { id: 'mind:a_anvl09', kind: 'mind', label: 'Anvil', detail: 'Its loop, skills and memory schema.', owner: 'operator', mind: 'a_anvl09' },
  { id: 'mind:a_wisp12', kind: 'mind', label: 'Wisp', detail: 'A module mind that formats reports.', owner: 'ada@example.org', mind: 'a_wisp12', private: true },
  { id: 'service:search', kind: 'service', label: 'Search relay', detail: 'Web search with caching and per-mind quotas.', owner: 'operator' },
  { id: 'repo:forge-tools', kind: 'repository', label: 'forge-tools', detail: 'The Forge swarm’s shared scripts and their tests.', owner: 'operator', branch: 'main', commit: 'b41f07e9a2c3' },
  // Request L: listed by the hive, but the Code service has no editable copy of it (sim/codeService.ts SIM_UNREGISTERED_TARGET).
  { id: 'repo:old-notebooks', kind: 'repository', label: 'Old notebooks', detail: 'Invented: an earlier analysis repository the hive still lists. The Code service has no editable copy of it.', owner: 'operator', branch: 'main', commit: '0b7d41c2e9a85f3361d0c4e7aa9152b8c6d3e0f1' },
  // The only target that opens in the sim: an invented repository served by sim/codeService.ts (not a real project).
  { id: 'repo:sim-suggestions', kind: 'repository', label: 'Invented fixture repository', detail: 'Simulator only: invented source for trying minds’ suggestions (selection → proposal → per-hunk decision). Not a real project.', owner: 'operator', branch: 'main', commit: '5ce7a1d09b3e44f1a2c0de55aa01b2c3d4e5f607' },
]

/** Spending limits beyond the per-swarm default: [scope, period, limit, note]. */
export const SEED_BUDGETS: [string, 'day' | 'month' | 'total', number, string][] = [
  ['hive', 'month', 1200, 'Whole-hive ceiling'],
  ['swarm:s_forge', 'month', 150, 'Forge is experimental'],
  ['agent:a_deneb2', 'day', 12, 'Opus is expensive'],
]
