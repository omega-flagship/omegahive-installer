// Phase 2 seed data and content for the simulator: policy, approvals, goals, traces, wakeups, memory.
import type { GoalStatus, PolicyMode, PolicyScope } from '../types'

export function hashStr(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export const SEED_RULES: { scope: PolicyScope; skill: string; mode: PolicyMode; note: string; daysAgo: number }[] = [
  { scope: 'hive', skill: 'fetch-*', mode: 'allow', note: 'Read-only telemetry feeds', daysAgo: 31 },
  { scope: 'hive', skill: 'compute-*', mode: 'allow', note: 'Pure computation, no side effects', daysAgo: 31 },
  { scope: 'hive', skill: 'send-file*', mode: 'deny', note: 'Nothing leaves the hive as a file', daysAgo: 30 },
  { scope: 'hive', skill: 'codex-*', mode: 'ask', note: 'Code changes always get a human look', daysAgo: 28 },
  { scope: 'swarm:s_forge', skill: 'shell*', mode: 'ask', note: 'Infra shell commands need an on-call human', daysAgo: 21 },
  { scope: 'swarm:s_forge', skill: 'metta', mode: 'allow', note: 'Forge runs its own MeTTa health checks', daysAgo: 20 },
  { scope: 'swarm:s_lyra', skill: 'remove-atom', mode: 'ask', note: 'Retracting a star fact is a big deal', daysAgo: 14 },
  { scope: 'agent:a_mira04', skill: 'write-file*', mode: 'allow', note: 'Mira writes light-curve CSVs to its own scratch dir', daysAgo: 9 },
  { scope: 'agent:a_anvl09', skill: 'space-commit', mode: 'allow', note: 'Anvil maintains the runbook space', daysAgo: 6 },
]

/** A command a mind might run, with a plausible result. `risky` ones usually hit an `ask` rule. */
export interface CmdTemplate {
  cmd: string
  result: string
  risky?: boolean
  error?: string
}

const SAFE_COMMON: CmdTemplate[] = [
  { cmd: '(remember "{belief}")', result: 'ok · stored in &self' },
  { cmd: '(episodes 3)', result: '3 episodes · newest 14 min ago' },
  { cmd: '(pin "{musing}")', result: 'pinned' },
  { cmd: '(hive-peers)', result: '{n} peers awake in the swarm' },
]

export const SWARM_CMDS: Record<string, CmdTemplate[]> = {
  s_lyra: [
    { cmd: '(query (--> $x variable))', result: '4 results: rr-lyrae, kic-8462, sheliak, epsilon-lyrae' },
    { cmd: '(search "RR Lyrae light curve 2026" archive)', result: '12 hits · newest 2026-09-30', error: 'error: archive timeout after 30s' },
    { cmd: '(compute-period rr-lyrae)', result: '0.5669 d ± 0.0003' },
    { cmd: '(web-search "KIC 8462852 dimming 2026")', result: '5 results · 2 preprints since August' },
    { cmd: '(read-file "curves/rr-lyrae.csv")', result: '1,204 rows · 2026-09-01 → 2026-09-30' },
    { cmd: '(shell "python fit_curve.py curves/rr-lyrae.csv")', result: 'period=0.56689 amplitude=0.81 χ²=1.04', risky: true },
    { cmd: '(write-file "curves/kic-8462.csv" "t,flux\\n…")', result: 'wrote 18.2 KB', risky: true },
    { cmd: '(remove-atom &self (--> kic-8462 artificial))', result: 'removed 1 atom', risky: true },
  ],
  s_kelp: [
    { cmd: '(query (--> reef-north $x))', result: '2 results: barren <0.58 0.47>, urchin-dominated <0.61 0.40>' },
    { cmd: '(fetch-telemetry buoy-7)', result: '17.8 °C · swell 1.2 m · kelp canopy 41%', error: 'error: buoy-7 offline since 06:10' },
    { cmd: '(search "otter sightings south holdfasts")', result: '3 notes · last sighting yesterday 16:40' },
    { cmd: '(web-search "sunflower star recovery 2026")', result: '4 results · 1 survey from Monterey' },
    { cmd: '(write-file "reports/reef-north.md" "# North reef · week 40\\nUrchin density +14%…")', result: 'wrote 3.1 KB', risky: true },
    { cmd: '(append-file "logs/transects.csv" "B,2026-10-03,42,urchin")', result: 'appended 1 row', risky: true },
    { cmd: '(space-transform &self (--> reef-south $x) (--> reef-south-2 $x))', result: 'rewrote 3 atoms', risky: true },
  ],
  s_forge: [
    { cmd: '(hive-status)', result: '12 minds · 7 awake · gateway healthy' },
    { cmd: '(metta "(match &self (--> $s degraded) $s)")', result: '[disk-node-3]' },
    { cmd: '(query (--> llm-latency $x))', result: '1 result: p95-elevated <0.44 0.52>' },
    { cmd: '(read-file "/var/log/hive/gateway.log")', result: 'last 200 lines · 3 WARN · 0 ERROR', error: 'error: permission denied' },
    { cmd: '(shell-confirm "systemctl restart hive-gateway")', result: 'hive-gateway restarted · healthy in 2.1s', risky: true },
    { cmd: '(shell "df -h /var/lib/hive")', result: '/dev/sdb1  200G  151G  49G  76% /var/lib/hive', risky: true },
    { cmd: '(codex-run "fix flaky test in build-main: test_queue_drain")', result: 'patch ready · 2 files · tests green', risky: true },
    { cmd: '(space-commit &runbook)', result: 'committed 4 atoms to &runbook', risky: true },
  ],
  none: [
    { cmd: '(web-search "kelp forest otter recovery 2026")', result: '6 results · 1 new paper' },
    { cmd: '(hive-swarms)', result: '3 swarms: Lyra, Kelp Commons, Forge' },
    { cmd: '(send-file "rumours.txt" "operator")', result: 'sent', risky: true },
  ],
}

export const COMMON_CMDS = SAFE_COMMON

export const HUMAN_ONLY_ATTEMPTS = ['(transfer-funds "a_bell10" 20)', '(purchase "gpu-hours" 4)', '(pay "archive-subscription" 12)']

export const THOUGHTS: Record<string, string[]> = {
  s_lyra: [
    'The September photometry is in. Check the commons before revising anything.',
    'KIC 8462 is noisy again. Look for independent evidence instead of re-asserting.',
    'Altair flagged a flare. If it holds, the flare → variable rule gets another stamp.',
    'Period drift is within error bars. Confirm, then publish with honest confidence.',
  ],
  s_kelp: [
    'Transect B numbers came back. Urchins up again on the north reef.',
    'Buoy telemetry first, then decide whether the warm-water rule needs revising.',
    'An otter sighting is weak evidence, but it is evidence. Note it.',
    'The operator wants a weekly summary. Gather the week before writing.',
  ],
  s_forge: [
    'p95 latency is creeping. Check the gateway before paging anyone.',
    'Nightly deploy is queued. Build is green; the gateway needs a restart for the new config.',
    'disk-node-3 alert again. Measure before believing it.',
    'Budget burn looks on track. Nothing to escalate.',
  ],
  none: ['Drifting between swarms. Listening for rumours worth carrying.', 'Two swarms disagree about tides. Worth a note to both.'],
}

export interface SeedGoal {
  key: string
  parent?: string
  title: string
  detail?: string
  priority: number
  status: GoalStatus
  by: string
  claimed?: string
  result?: string
  hoursAgo: number
  /** Claims that lapsed before. */
  attempts?: number
  /** Minutes left on a claimed goal's lease. */
  leaseMin?: number
  /** R17 review (INVENTED): who must accept the result, who did, how often it came back. */
  reviewBy?: string
  reviewedBy?: string
  returns?: number
  reviewNotes?: string
}

export const SEED_GOALS: Record<string, SeedGoal[]> = {
  s_lyra: [
    { key: 'rr', title: 'Refit the RR Lyrae period with September photometry', detail: 'Use the archive pull, fit, then publish a revised (--> rr-lyrae variable) with honest confidence.', priority: 0.82, status: 'claimed', by: 'user:operator', claimed: 'a_vega01', hoursAgo: 20 },
    { key: 'rr1', parent: 'rr', title: 'Pull September photometry from the archive', priority: 0.7, status: 'done', by: 'agent:a_vega01', claimed: 'a_mira04', result: '1,204 points, 2026-09-01 → 30', hoursAgo: 18 },
    { key: 'rr2', parent: 'rr', title: 'Fit the light curve', priority: 0.7, status: 'claimed', by: 'agent:a_vega01', claimed: 'a_vega01', hoursAgo: 18 },
    { key: 'rr3', parent: 'rr', title: 'Publish the revised period to the commons', priority: 0.6, status: 'open', by: 'agent:a_vega01', hoursAgo: 18 },
    { key: 'kic', title: 'Decide whether the KIC 8462 dimming is periodic', detail: 'Two stamps overlap with Altair. Find independent evidence first.', priority: 0.64, status: 'open', by: 'user:operator', hoursAgo: 30 },
    { key: 'flare', title: 'Propose a rule for flare stars', priority: 0.35, status: 'open', by: 'agent:a_deneb2', hoursAgo: 6 },
    { key: 'eps', title: 'Measure ε Lyrae double-double separation', priority: 0.42, status: 'done', by: 'user:operator', claimed: 'a_altr03', result: '2.3″ and 2.6″, matches the archive', hoursAgo: 52, reviewBy: 'person', reviewedBy: 'user:p_ada' },
    { key: 'm13', title: 'Census of variable stars in M13', detail: 'List every catalogued variable with its period and class.', priority: 0.6, status: 'submitted', by: 'user:operator', claimed: 'a_altr03', result: '42 variables, 37 with periods; table attached to the commons.', hoursAgo: 8, reviewBy: 'person', returns: 1, reviewNotes: 'Add the class for the five RR Lyrae.' },
    { key: 'sheliak', title: 'Book telescope time for the Sheliak eclipse', detail: 'Needs an observatory login that no mind has.', priority: 0.58, status: 'stalled', by: 'user:operator', attempts: 3, hoursAgo: 10 },
    { key: 'm57', title: 'Cross-check the M57 ring against the Hubble archive', priority: 0.5, status: 'failed', by: 'agent:a_deneb2', claimed: 'a_deneb2', result: 'Archive endpoint returned 503 for two hours. Retry later.', hoursAgo: 40 },
  ],
  s_kelp: [
    { key: 'urch', title: 'Survey north reef urchin density', detail: 'Three transects, counts per m², publish to the commons.', priority: 0.9, status: 'claimed', by: 'user:operator', claimed: 'a_nori06', hoursAgo: 26 },
    { key: 'urch1', parent: 'urch', title: 'Transect A', priority: 0.7, status: 'done', by: 'agent:a_nori06', claimed: 'a_nori06', result: '38 urchins / 10 m²', hoursAgo: 24 },
    { key: 'urch2', parent: 'urch', title: 'Transect B', priority: 0.7, status: 'claimed', by: 'agent:a_nori06', claimed: 'a_coral5', hoursAgo: 24, attempts: 1, leaseMin: 2.5 },
    { key: 'urch3', parent: 'urch', title: 'Transect C', priority: 0.7, status: 'open', by: 'agent:a_nori06', hoursAgo: 24 },
    { key: 'otter', title: 'Model the otter effect on canopy recovery', priority: 0.6, status: 'open', by: 'user:operator', hoursAgo: 12 },
    { key: 'buoy', title: 'Ingest the buoy-7 telemetry backlog', priority: 0.48, status: 'failed', by: 'user:operator', claimed: 'a_wrak08', result: 'Wrack is stopped; backlog untouched.', hoursAgo: 60 },
    { key: 'week', title: 'Summarise the week for the operator', priority: 0.4, status: 'done', by: 'user:operator', claimed: 'a_coral5', result: 'Sent: urchins up, canopy steady, one otter.', hoursAgo: 70 },
  ],
  s_forge: [
    { key: 'ship', title: 'Ship the nightly deploy', detail: 'Build, restart the gateway with the new config, then watch p95 for 30 minutes.', priority: 0.86, status: 'claimed', by: 'user:operator', claimed: 'a_anvl09', hoursAgo: 4 },
    { key: 'ship1', parent: 'ship', title: 'Run build-main', priority: 0.8, status: 'done', by: 'agent:a_anvl09', claimed: 'a_bell10', result: 'green in 4m12s', hoursAgo: 3.5 },
    { key: 'ship2', parent: 'ship', title: 'Restart the gateway with the new config', priority: 0.8, status: 'claimed', by: 'agent:a_anvl09', claimed: 'a_anvl09', hoursAgo: 3.5 },
    { key: 'ship3', parent: 'ship', title: 'Verify p95 latency after the deploy', priority: 0.7, status: 'open', by: 'agent:a_anvl09', hoursAgo: 3.5 },
    { key: 'pager', title: 'Rotate the on-call pager key', priority: 0.66, status: 'waiting', by: 'user:operator', claimed: 'a_anvl09', result: 'New key generated and staged. Needs your sign-off in the vault before I swap it.', hoursAgo: 5 },
    { key: 'disk', title: 'Investigate disk-node-3 alerts', priority: 0.72, status: 'open', by: 'agent:a_qnch11', hoursAgo: 9 },
    { key: 'probe', title: 'Probe the gateway for slow upstreams', priority: 0.55, status: 'submitted', by: 'agent:a_anvl09', claimed: 'a_bell10', result: 'Two upstreams over 2s p95; details in the findings.', hoursAgo: 2, reviewBy: 'agent:a_qnch11' },
    { key: 'budget', title: 'Weekly budget report', priority: 0.5, status: 'done', by: 'user:operator', claimed: 'a_bell10', result: '$32.40 this week, on track', hoursAgo: 50 },
    { key: 'ttl', title: 'Trim cache TTLs', priority: 0.3, status: 'cancelled', by: 'agent:a_anvl09', hoursAgo: 80 },
  ],
}

export const GOAL_IDEAS: Record<string, string[]> = {
  s_lyra: ['Re-observe Sheliak eclipse timing', 'Tidy the stellar vocabulary', 'Check Vega pole-on claim against new spectra', 'Find a second source for the Deneb supergiant class'],
  s_kelp: ['Count sunflower stars at the south reef', 'Estimate holdfast loss after the storm', 'Compare canopy cover to last October', 'Map crab predation on urchin larvae'],
  s_forge: ['Rotate gateway TLS certificates', 'Drain the retry queue', 'Load-test the LLM gateway at 2x', 'Prune old usage rows'],
}

export const SUBGOAL_SPLITS = [
  ['Gather the evidence', 'Analyse it', 'Publish to the commons'],
  ['Plan the work', 'Do it', 'Report back'],
  ['Check what the commons already believes', 'Collect new observations'],
]

export const GOAL_RESULTS = ['Done. Published to the commons.', 'Finished; notes pinned in &notes.', 'Complete. Confidence raised to 0.7.', 'Done, with one caveat in the episode log.']
export const GOAL_WAITS = ['Delivered a draft; needs your OK before it ships.', 'Done on my side. Waiting on you to confirm the numbers.', 'Report sent to the operator; waiting for a reply.']
export const GOAL_FAILS = ['Blocked: the archive is down.', 'Gave up: budget too low for this.', 'Evidence conflicts; needs a human call.']

export const SEED_WAKEUPS: { agent: string; cron?: string; atHours?: number; tz: string; text: string; enabled: boolean; lastHours?: number }[] = [
  { agent: 'a_vega01', cron: '0 21 * * *', tz: 'UTC', text: 'Night watch: pull fresh photometry and revise variable stars.', enabled: true, lastHours: 17 },
  { agent: 'a_vega01', cron: '30 7 * * 1', tz: 'Europe/Berlin', text: 'Weekly: summarise the week in the commons for the operator.', enabled: false },
  { agent: 'a_mira04', cron: '*/2 * * * *', tz: 'UTC', text: 'Check the light-curve queue and fit anything new.', enabled: true, lastHours: 0.02 },
  { agent: 'a_anvl09', cron: '0 9 * * 1-5', tz: 'America/New_York', text: 'Morning health check: gateway, queues, disk, budgets.', enabled: true, lastHours: 5 },
  { agent: 'a_anvl09', cron: '*/30 * * * *', tz: 'UTC', text: 'Poll build-main and report if it goes red.', enabled: false, lastHours: 26 },
  { agent: 'a_anvl09', atHours: 9, tz: 'UTC', text: 'After the deploy: verify p95 latency is back under 1.5 s.', enabled: true },
  { agent: 'a_coral5', atHours: 15, tz: 'UTC', text: 'Low-tide survey on the south holdfasts.', enabled: true },
  { agent: 'a_bell10', cron: '0 17 * * 5', tz: 'UTC', text: 'Weekly budget report to the operator.', enabled: true, lastHours: 50 },
  { agent: 'a_qnch11', cron: '*/10 * * * *', tz: 'UTC', text: 'Look at the alert queue. Stay asleep if it is empty.', enabled: true, lastHours: 0.1 },
]

export const SEED_APPROVALS: {
  agent: string
  command: string
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'used'
  minutesAgo: number
  decidedAfter?: number
}[] = [
  { agent: 'a_anvl09', command: '(shell-confirm "systemctl restart hive-gateway")', status: 'pending', minutesAgo: 2 },
  { agent: 'a_coral5', command: '(write-file "reports/reef-north.md" "# North reef · week 40\\nUrchin density +14% on transect A; no otters this week.")', status: 'pending', minutesAgo: 7 },
  { agent: 'a_deneb2', command: '(remove-atom &self (--> kic-8462 artificial))', status: 'pending', minutesAgo: 13 },
  { agent: 'a_anvl09', command: '(shell "df -h /var/lib/hive")', status: 'used', minutesAgo: 95, decidedAfter: 1 },
  { agent: 'a_vega01', command: '(shell "python fit_curve.py curves/rr-lyrae.csv")', status: 'used', minutesAgo: 180, decidedAfter: 3 },
  { agent: 'a_wisp12', command: '(send-file "rumours.txt" "operator")', status: 'denied', minutesAgo: 240, decidedAfter: 6 },
  { agent: 'a_nori06', command: '(append-file "logs/transects.csv" "A,2026-10-02,38,urchin")', status: 'approved', minutesAgo: 400, decidedAfter: 2 },
  { agent: 'a_qnch11', command: '(codex-run "bump gateway timeout to 45s")', status: 'denied', minutesAgo: 700, decidedAfter: 12 },
  { agent: 'a_altr03', command: '(remove-atom &self (--> vega pole-on))', status: 'expired', minutesAgo: 1500 },
]

export const EPISODES = [
  'operator asked about {term}',
  'revised a belief on {term}',
  'peer message about {term}',
  'woke on schedule',
  'claimed a task about {term}',
  'approval granted for a shell command',
  'published (--> {term} observed)',
]
