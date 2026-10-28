import { describe, expect, it } from 'vitest'
import { scanShown, scanShownTree } from './shownStrings.testkit'
import { labText } from './features/lab/labUtil'
import { ownerWords } from './lib/ownerWords'
import { plural, pluralAtLeast } from './lib/plural'
import { SIM_SUITES } from './api/sim/lab'
import record from './api/sim/fixtures/lab-record.json'

/**
 * uifix-r1 wording sweep (UI review 2026-10-12: S1, S2, C13). the owner's owner words: a swarm is a swarm, never a team; work
 * is Motivations and Tasks (no goals, subgoals or boards); agents are minds. The older guard (wordingGuard.test.ts)
 * covers "goal", "board" and "dot" and a list of team phrases; this one bans "team" outright in shown text, adds
 * "subgoal", checks the Lab's host words and checks shown counts take the plural helper.
 *
 * Allowances are exact: `file:text`, the whole shown string as the scanner reads it, with a reason. Never a whole file.
 */
type Allow = { at: string; why: string }
const exact = (list: Allow[]) => (rel: string, text: string) => list.some((a) => a.at === `${rel}:${text}`)

// ------------------------------------------------------------------------------------------------ "team" for a swarm
const BANNED_TEAM = /(?<![-_/.$\w])(teams?|teammates?)(?![-_/(\w]|\.\w)/i
const HOST_ROOMS = "the simulator's copy of the hive server's own team-room text (hive/core rooms.py); it changes with the server"
const HOST_MOTIVATIONS = "the simulator's copy of the hive server's own motivation error text (hive/core motivations.py)"
const HOST_INTENTS = "the simulator's copy of the hive server's own intent error text (hive/core ask_intents.py)"
const ALLOWED_TEAM: Allow[] = [
  { at: 'features/guided/scripts/people.ts:Scripts can join over plain HTTP with a member token too. Bridges to Slack and Teams are planned.', why: 'Microsoft Teams, the chat product, not a swarm' },
  { at: "api/sim/rooms.ts:Your swarm's team room: minds reach each other here with @Name.", why: HOST_ROOMS },
  { at: "api/sim/rooms.ts:a swarm's team room follows its swarm; its owner or an admin may change its topic", why: HOST_ROOMS },
  { at: "api/sim/rooms.ts:a swarm's team room holds its owner and its minds; it follows the swarm", why: HOST_ROOMS },
  { at: 'api/sim/rooms.ts:team', why: `${HOST_ROOMS}: the room's name, "<swarm> team"` },
  { at: "api/sim/rooms.ts:this swarm's team room is unavailable; an admin repairs it with POST /api/swarms/", why: HOST_ROOMS },
  { at: 'api/sim/motivations.ts:a team motivation is scoped to its own swarm', why: HOST_MOTIVATIONS },
  { at: 'api/sim/motivations.ts:a motivation is owned by a person (user:u_...) or a team (swarm:s_...)', why: HOST_MOTIVATIONS },
  { at: "api/sim/motivations.ts:a team's motivations are made by its owner or an admin", why: HOST_MOTIVATIONS },
  { at: "api/sim/motivations.ts:that task is in a team this motivation doesn't cover", why: HOST_MOTIVATIONS },
  { at: "api/sim/intents.ts:to_swarm is the team swarm's id", why: HOST_INTENTS },
  { at: "api/sim/intents.ts:that team does not offer 'code'", why: HOST_INTENTS },
  { at: 'api/sim/intents.ts:templates not registered for that team', why: HOST_INTENTS },
  // keys and search words the scanner reads because they sit inside shown JSX or a shown object (never on screen)
  { at: 'experiences/omegatown/index.tsx:teams', why: "the tab key ('teams' view); its shown label is Swarms" },
  { at: 'features/tasks/MotivationsPage.tsx:team', why: "a VISIBILITY_WORDS key (owner kind 'team' = swarm-owned); the words shown say swarm" },
  { at: 'features/palette/navCommands.ts:team swarm groups commons beliefs archived archive restore lifecycle vocabulary connections', why: 'search words, never shown: the old name still finds Swarms' },
  { at: 'features/palette/navCommands.ts:invite colleague team member admin email google access remove', why: 'search words, never shown: people search for their team when inviting people (people, not a swarm)' },
  { at: 'lib/intent/features.ts:team motivations', why: 'words people may type, never shown: the old name still reaches Motivations' },
]
const allowedTeam = exact(ALLOWED_TEAM)

describe('wording guard: the "team" scanner itself (uifix-r1, S1)', () => {
  it('catches team, teams and teammate in prose, labels, JSX text and attributes', () => {
    const src = [
      "const a = { title: 'Research team' }",
      'const b = <h2>What kind of team?</h2>',
      "const c = [{ value: 'members', label: 'Team' }]",
      'const d = <Page eyebrow="From an idea to a working team" />',
      "const e = { blurb: 'Teams of minds with one purpose' }",
      "const f = { why: 'a mind @-mentions a teammate' }",
    ].join('\n')
    expect(scanShown('x/words.tsx', src, BANNED_TEAM, allowedTeam)).toEqual([
      'x/words.tsx:1: Research team',
      'x/words.tsx:2: What kind of team?',
      'x/words.tsx:3: Team',
      'x/words.tsx:4: From an idea to a working team',
      'x/words.tsx:5: Teams of minds with one purpose',
      'x/words.tsx:6: a mind @-mentions a teammate',
    ])
  })
  it('leaves keys, identifiers, routes and API paths alone', () => {
    const src = "const a = ownerKind(m) === 'team'\nconst b = { kind: 'team-room', key: 'team' }\nconst c = `/api/teams/${id}/templates`\nconst d = <div data-team={id} className=\"team-chip\" />\nconst e = route.team\n"
    expect(scanShown('x/keys.tsx', src, BANNED_TEAM, allowedTeam)).toEqual([])
  })
  it('an allowance is one exact string in one file, never the file', () => {
    const src = "const a = { body: 'Bridges to Slack and Teams are planned.' }\nconst b = { body: 'Pick a team' }\n"
    expect(scanShown('features/guided/scripts/people.ts', src, BANNED_TEAM, allowedTeam)).toEqual([
      'features/guided/scripts/people.ts:1: Bridges to Slack and Teams are planned.',
      'features/guided/scripts/people.ts:2: Pick a team',
    ])
  })
})

describe('wording guard: a swarm is a swarm, never a team (uifix-r1, S1)', () => {
  it('no shown string says team, teams or teammate', () => {
    const hits = scanShownTree(BANNED_TEAM, allowedTeam)
    if (hits.length) throw new Error(`${hits.length} shown strings say team for a swarm (file:line):\n${hits.join('\n')}`)
    expect(hits).toEqual([])
  }, 60_000)
  it('every allowance still matches something (a stale one is removed, not kept)', () => {
    const used = new Set<string>()
    scanShownTree(BANNED_TEAM, (rel, text) => {
      const key = `${rel}:${text}`
      if (ALLOWED_TEAM.some((a) => a.at === key)) used.add(key)
      return true
    })
    expect(ALLOWED_TEAM.map((a) => a.at).filter((at) => !used.has(at))).toEqual([])
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------ "subgoal" / "subboard"
const BANNED_SUB = /(?<![-_/.$\w])sub(goals?|boards?)(?![-_/(\w]|\.\w)/i
const ALLOWED_SUB: Allow[] = [
  { at: 'features/lab/Drift.tsx:subgoals accepted', why: "the host bench's measure name, used only to look the measure up; the Lab shows it as \"subtasks accepted\" (labText)" },
]

describe('wording guard: subtasks, never subgoals (uifix-r1, S2)', () => {
  it('the scanner catches a shown subgoal and leaves identifiers alone', () => {
    const src = "const a = { label: 'Subgoals under one task' }\nconst b = `${n} subgoals wide`\nconst c = <Card subgoals={kids} />\nconst d = x.subgoals.length\n"
    expect(scanShown('x/sub.tsx', src, BANNED_SUB, () => false)).toEqual(['x/sub.tsx:1: Subgoals under one task', 'x/sub.tsx:2: subgoals wide'])
  })
  it('no shown string says subgoal or subboard', () => {
    const hits = scanShownTree(BANNED_SUB, exact(ALLOWED_SUB))
    if (hits.length) throw new Error(`${hits.length} shown strings say subgoal (file:line):\n${hits.join('\n')}`)
    expect(hits).toEqual([])
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------ the Lab's host words
const RETIRED = /(?<![-_/.$\w])(sub)?(goals?|boards?|dots?|teams?)(?![-_/(\w]|\.\w)/i

describe('the Lab says the host bench words in the hive words (uifix-r1, S2)', () => {
  it('the claim race measures say what they mean', () => {
    expect(labText('goals with two winners')).toBe('tasks claimed twice')
    expect(labText('goals with a winner')).toBe('tasks with one owner')
    expect(labText('winners per goal')).toBe('owners per task')
    expect(labText('Goal claim race')).toBe('Task claim race')
    expect(labText('Subgoal explosion')).toBe('Subtask explosion')
    expect(labText('subgoals accepted')).toBe('subtasks accepted')
    expect(labText('memory per dot')).toBe('memory per mind')
    expect(labText('Eight dots race to claim each of 25 goals at the same moment')).toBe('Eight minds race to claim each of 25 tasks at the same moment')
  })
  it('every name, note, group, series and axis in the recorded Lab, and every suite text, reads without a retired word', () => {
    const shownKeys = new Set(['name', 'notes', 'group', 'x', 'title', 'description'])
    const bad: string[] = []
    const walk = (v: unknown, key?: string) => {
      if (Array.isArray(v)) return v.forEach((x) => walk(x, key))
      if (v && typeof v === 'object') return Object.entries(v).forEach(([k, x]) => walk(x, k))
      // renamed_from and legacy_names are the "formerly …" detail, shown as the old name on purpose (followups-r6)
      if (typeof v === 'string' && key && shownKeys.has(key) && RETIRED.test(labText(v))) bad.push(`${key}: ${labText(v)}`)
    }
    walk(record)
    walk(SIM_SUITES)
    expect(bad).toEqual([])
  })
  it('identifiers, routes and file names in host text are left as they are', () => {
    expect(ownerWords('POST /api/agent/goals/{id}/claim · work.goals · goal_id · dot.ts')).toBe('POST /api/agent/goals/{id}/claim · work.goals · goal_id · dot.ts')
    expect(ownerWords('Goals board')).toBe('Task list')
    // snake_case and kebab-case tokens are identifiers, never prose (stand-in P3)
    for (const id of ['goals_board', 'goal-board', 'goal_boards', 'goals-boards', 'my_goals', 'goal_id', 'sub-goal', 'dot_count', 'team-room', 'board-goal']) expect(ownerWords(id)).toBe(id)
    expect(ownerWords('see goals_board and the goal board')).toBe('see goals_board and the task list')
    expect(ownerWords('GOALS')).toBe('TASKS')
  })
})

// ------------------------------------------------------------------------------------------------ "1 tasks" (C13)
describe('shown counts agree with their number (uifix-r1, C13)', () => {
  it('the one plural helper: 0, 1, 2 and a floor', () => {
    expect([0, 1, 2].map((n) => plural(n, 'task'))).toEqual(['0 tasks', '1 task', '2 tasks'])
    expect(plural(1, 'person', 'people')).toBe('1 person')
    expect([pluralAtLeast(1, false, 'task'), pluralAtLeast(1, true, 'task'), pluralAtLeast(3, true, 'task')]).toEqual(['1 task', '1+ tasks', '3+ tasks'])
  })

  /**
   * A count spliced straight in front of a fixed plural noun ("${x.length} tasks", "{n} files") says "1 tasks" when
   * there is one. Shown counts go through plural() instead. Allowed: counts that are never one, each with its reason.
   */
  const COUNT_THEN_PLURAL = /(?:\$\{|\{)\s*[\w.?!]*(?:length|count|total|size|Count|Total)\s*\}\s+([a-z]+s)\b/g
  const NOT_NOUNS = new Set(['is', 'was', 'has', 'as', 'this', 'its', 'us', 'yes', 'plus', 'across', 'unless', 'does', 'goes', 'runs', 'needs', 'says', 'takes', 'holds', 'means', 'shows', 'keeps', 'reads', 'stays', 'gets', 'sends', 'makes', 'wants'])
  /** Exact file plus the exact spliced text the scan reads (`${x.length} nouns`), each with its reason. */
  const COUNT_ALLOWED: Allow[] = [
    { at: 'features/programs/Rail.tsx:${subjects.length} items', why: 'the many branch: one subject is named by its label instead' },
    { at: 'features/programs/Rail.tsx:${items.length} items', why: 'the many branch: one item reads "Actions for <label>"' },
    { at: 'experiences/canvas/HivePanel.tsx:${pending.length} invitations', why: 'the many branch: one reads "One invitation is"' },
    { at: 'experiences/canvas/index.tsx:${refs.length} motivations', why: 'the many branch (two places): one motivation is named by its title' },
    { at: 'experiences/canvas/motives.ts:${refs.length} motivations', why: 'the many branch: one reads "the motivation"' },
    { at: 'features/updates/UpdatesPage.tsx:${data.apps.length} apps', why: 'the many branch: one reads "The one app is"' },
    { at: 'features/code/map/MapView.tsx:${byPrefix.length} revisions', why: 'only when more than one revision matches' },
    { at: 'features/code/suggestions/WorkbenchSuggestionPanel.tsx:${picked.length} ranges', why: 'only when more than one range is picked' },
    { at: 'features/dot/SpendingPause.tsx:${refusal.count} calls', why: 'only when more than one call was refused' },
    { at: 'features/lab/pc/model.ts:${picked.length} reports', why: 'only when more than one report matches' },
    { at: 'lib/intent/hiveMap.ts:${hits.length} hives', why: 'the clarifying question, asked only when several hives match' },
    { at: 'lib/intent/swarmDelete.ts:${hits.length} swarms', why: 'the clarifying question, asked only when several swarms share the name' },
    { at: 'lib/mindSpace/core.ts:${out.length} times', why: 'an engine error raised only when the count is not one' },
    { at: 'api/askIntents.ts:${words.length} characters', why: 'said only when the words are over the limit (thousands of characters)' },
    { at: 'experiences/construct/commands.ts:${FEATURES.length} features', why: 'the hive map heading: the registry always holds many features' },
    { at: 'features/showreel/pln/rules.ts:${rule.params.length} premises', why: "a developer error about a rule's arity, never shown to people" },
  ]
  it('no shown count is spliced in front of a fixed plural noun', async () => {
    const fsName = 'node:fs'
    const { readdirSync, readFileSync, statSync } = (await import(/* @vite-ignore */ fsName)) as {
      readdirSync: (p: string) => string[]
      readFileSync: (p: string, e: 'utf8') => string
      statSync: (p: string) => { isDirectory: () => boolean }
    }
    const root = new URL('.', import.meta.url).pathname.replace(/\/$/, '')
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = `${d}/${n}`
        if (statSync(p).isDirectory()) return walk(p)
        return /\.(ts|tsx)$/.test(n) && !/\.(test|testkit)\.tsx?$/.test(n) && !/\.d\.ts$/.test(n) ? [p] : []
      })
    const hits: string[] = []
    const usedCounts = new Set<string>()
    for (const f of walk(root)) {
      const rel = f.slice(root.length + 1)
      if (rel.startsWith('api/sim/') && !rel.startsWith('api/sim/ask.ts')) continue // the host's own text, mirrored
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
        for (const m of line.matchAll(COUNT_THEN_PLURAL)) {
          if (NOT_NOUNS.has(m[1])) continue
          const key = `${rel}:${m[0]}`
          if (COUNT_ALLOWED.some((a) => a.at === key)) { usedCounts.add(key); continue }
          hits.push(`${rel}:${i + 1}: ${m[0]}`)
        }
      })
    }
    if (hits.length) throw new Error(`${hits.length} shown counts can say "1 …s"; use plural() (file:line):\n${hits.join('\n')}`)
    expect(hits).toEqual([])
    // a stale count allowance (its text gone or changed) is removed, not kept
    expect(COUNT_ALLOWED.map((a) => a.at).filter((at) => !usedCounts.has(at))).toEqual([])
  }, 60_000)
})
