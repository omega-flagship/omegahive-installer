import { describe, expect, it } from 'vitest'
import { scanShown, scanShownTree } from './shownStrings.testkit'

/**
 * Wording guard (Jon's standing rule): people never see "goal(s)" or "board(s)". The hive's words are Motivations
 * (the why) above Tasks (the work), and Canvas is a canvas. Internal identifiers, routes and API fields keep their
 * names; only strings shown to people are scanned: JSX text, the people-facing JSX attributes (aria-label, title,
 * placeholder, label and the like), strings inside JSX expressions, and the people-facing properties of objects
 * (toast and notice titles and bodies, labels, blurbs, placeholders).
 */
/** The word itself, not part of an identifier, class name or path (cx-goal-m, goal.status, work.goals, hive_goals). */
/**
 * Also "team" where it means the swarm itself (F12): a swarm is the thing, as in the nav; "team" is kept only for a
 * swarm's members (its Team tab, Launch's Team step, "a team of minds").
 */
const BANNED = /(?<![-_/.$\w])(goals?|boards?|all teams|no teams|another team|this team|cross-team|team service|team motivations?|across teams|its team|a team or a mind|teams and minds|nested teams|team owners|the team['’]s owner|see the team|(?:one|every|each|any|which|other|either) teams?|teams? or all|team['’]s tasks|a team['’]s)(?![-_/(\w]|\.\w)/i

/**
 * The short named list of allowed hits. `at` is a file (every hit in it) or `file:exact text`; `why` says why it is
 * not the retired feature's word, or whose lane it is in.
 */
const ALLOWED: { at: string; why: string }[] = [
  { at: 'api/sim/motivations.ts', why: "the simulator's copy of the hive server's own motivation error text (hive/core)" },
  { at: 'api/sim/SimClient.ts', why: "the simulator's copy of the hive server's own error text (hive/core); it changes with the server" },
  { at: 'features/auditMap.ts', why: 'names API fields (review_by, goal.updated) in the engineering map' },
  { at: 'features/palette/navCommands.ts', why: 'search words, never shown: the old names still find Tasks and Motivations' },
  { at: 'lib/intent/features.ts', why: 'words people may type, never shown: the old names still reach Tasks' },
  { at: 'forms/caseFile/fixture.ts', why: "sample case text about a library's board (its governing body), not the retired feature" },
  { at: 'forms/lifeMap/sample.ts', why: "mirrors an app-declared action label; the app's owner renames it first" },
]
const allowed = (rel: string, text: string) => ALLOWED.some((a) => (a.at.endsWith('/') ? rel.startsWith(a.at) : a.at === rel || a.at === `${rel}:${text}`))

/** Every shown string in the tree under `src` that says a banned word, as `file:line: text`. */
export function scan(): string[] {
  return scanShownTree(BANNED, allowed)
}
/** One file's hits (`rel`: its path under src, used for the allowance list and the report). */
export function scanSource(rel: string, src: string, hits: string[] = []): string[] {
  return scanShown(rel, src, BANNED, allowed, hits)
}

describe('wording guard: the scanner itself (stand-in r4 P3)', () => {
  it('catches a one-word Title-case label in a tuple or table', () => {
    const src = "const stops: [string, string, string][] = [['#/goals', 'Goals', 'work.goals'], ['#/usage', 'Usage', 'money.usage']]\n"
    expect(scanSource('x/tour.ts', src)).toEqual(['x/tour.ts:1: Goals'])
  })
  it('catches a template fragment before ${…} when the template reads as prose', () => {
    const src = "const a = `${n} mind${n === 1 ? ' is' : 's are'} awake and ${g} goal${g === 1 ? ' is' : 's are'} open.`\n"
    expect(scanSource('x/answer.ts', src)).toEqual(['x/answer.ts:1: goal'])
  })
  it('still leaves keys, routes and identifiers alone', () => {
    const src = "const a = setDeck('goals'); const b = { page: 'goals', id: 'work.goals' }; const c = x === 'goal' ? 1 : 2; const d = `#/goals/${id}`\n"
    expect(scanSource('x/keys.ts', src)).toEqual([])
  })
})

describe('wording guard: no "goal" or "board" in what people see', () => {
  it('every shown string says Task, Motivation or Canvas', () => {
    const hits = scan()
    if (hits.length) throw new Error(`${hits.length} shown strings say goal, board or team-for-swarm (file:line):\n${hits.join('\n')}`)
    expect(hits).toEqual([])
  }, 60_000)
})

/**
 * followups-r6 item 10 (Jon): minds were once called "dots", and the old word still showed. A shown "dot" or "dots"
 * meaning a mind fails, the same way. Not caught: the product name OmegaDot(s) (a letter before), code identifiers and
 * routes (features/dot, the route 'dot', DotPanel, data-dot, dot.ts: a letter, -, _, / or . touching it), and keys the
 * scanner never reads.
 */
const BANNED_DOT = /(?<![-_/.$\w])dots?(?![-_/(\w]|\.\w)/i
/**
 * The allowed uses, each as `file` + its EXACT shown text (followups-r7 item 2, stand-in r6 P3): never a whole file, so
 * an unrelated "dot" added to one of these files still fails (pinned below).
 */
const ALLOWED_DOT: { file: string; text: string; why: string }[] = [
  { file: 'experiences/still/index.tsx', text: 'marked with a dot open on this paper; the rest open their full page, and come back here when closed.', why: 'a dot is the mark printed beside a link on the paper, not a mind' },
  { file: 'features/palette/navCommands.ts', text: 'home scene minds dots overview', why: 'search words, never shown: the old name still finds the hive' },
  { file: 'lib/appFrameParts.ts', text: 'plain .js file names (no dots before .js)', why: 'the "." in a file name (no dots before .js), not a mind' },
]
const allowedDot = (rel: string, text: string) => ALLOWED_DOT.some((a) => a.file === rel && a.text === text)

describe('wording guard: the "dot" allowances are exact (followups-r7 item 2)', () => {
  // the three allowed files, read as text by vite (no node fs)
  const sources = import.meta.glob(['./experiences/still/index.tsx', './features/palette/navCommands.ts', './lib/appFrameParts.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  const source = (rel: string) => {
    const s = sources[`./${rel}`]
    if (typeof s !== 'string') throw new Error(`not read: ${rel}`)
    return s
  }
  for (const a of ALLOWED_DOT) {
    it(`${a.file}: its allowed text passes, and nothing else in it is allowed`, () => {
      const src = source(a.file)
      expect(src).toContain(a.text.slice(0, 24))   // the allowance names text that is really there
      expect(scanShown(a.file, src, BANNED_DOT, allowedDot)).toEqual([])
      // an unrelated "dot" label added to the same file still fails
      const lines = src.split('\n').length
      const added = `${src}\nexport const zzUnrelated = { title: 'Wake this dot' }\n`
      expect(scanShown(a.file, added, BANNED_DOT, allowedDot)).toEqual([`${a.file}:${lines + 1}: Wake this dot`])
      // and so does the allowed text with one word changed: the allowance is the exact text, not a prefix
      const near = `${src}\nexport const zzNear = { body: ${JSON.stringify(`${a.text} Pick a dot.`)} }\n`
      expect(scanShown(a.file, near, BANNED_DOT, allowedDot)).toHaveLength(1)
    })
  }
})

describe('wording guard: the "dot" scanner itself (followups-r6 item 10)', () => {
  it('catches a shown dot or dots meaning a mind, in prose, a label and JSX text', () => {
    const src = "const a = { title: 'Wake this dot' }\nconst b = `${n} dots are awake`\nconst c = <p>Pick a dot</p>\nconst d = [['#/x', 'Dots', 'k']]\n"
    expect(scanShown('x/words.tsx', src, BANNED_DOT, allowedDot)).toEqual(['x/words.tsx:1: Wake this dot', 'x/words.tsx:2: dots are awake', 'x/words.tsx:3: Pick a dot', 'x/words.tsx:4: Dots'])
  })
  it('leaves the product name, identifiers, routes and file names alone', () => {
    const src = "const a = { title: 'Welcome to OmegaDots' }\nconst b = { title: 'OmegaDot hive' }\nconst c = navigate({ name: 'dot', id })\nconst d = `#/dot/${id}`\nconst e = { body: 'see features/dot/DotPanel.tsx and dot.ts' }\nconst f = <div data-dot={id} className=\"dot-ring\" />\n"
    expect(scanShown('x/keys.tsx', src, BANNED_DOT, allowedDot)).toEqual([])
  })
})

describe('wording guard: no "dot" for a mind in what people see (followups-r6 item 10)', () => {
  it('every shown string says mind or minds', () => {
    const hits = scanShownTree(BANNED_DOT, allowedDot)
    if (hits.length) throw new Error(`${hits.length} shown strings say dot or dots for a mind (file:line):\n${hits.join('\n')}`)
    expect(hits).toEqual([])
  }, 60_000)
})
