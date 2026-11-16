import type { ProgramDescription, WorkItem } from '../../api/types'
import { actionsFor, gateOf } from './model'

/**
 * The docket's verbs. Pure, so every parse is proved in node.
 *
 * Two ways in: single keys on the row under the cursor, and a command line (`support c1`, `dispatch scientist`,
 * `weigh h2`, `ex B`). Both end at the same act() through the same full-context confirm; neither can skip it.
 */

/** Row hotkeys: key -> action id. Shown only when the action applies to the row's kind. */
export const VERB_KEYS: [string, string, string][] = [
  ['s', 'add-support', 'support'],
  ['x', 'add-counterevidence', 'counter'],
  ['q', 'add-qualification', 'qualify'],
  ['c', 'challenge', 'challenge'],
  ['d', 'ask-scientist', 'dispatch scientist'],
  ['v', 'verify-claim', 'verify'],
  ['a', 'ask-challenger', 'ask challenger'],
  ['i', 'investigate-gap', 'investigate'],
  ['e', 'inspect-source', 'inspect'],
  ['r', 'correct', 'correct'],
]

/** Words people type, mapped to action ids. Any declared action id also works as itself. */
const ALIASES: [RegExp, string][] = [
  [/^(support|for|add-support)$/, 'add-support'],
  [/^(counter|oppose|against|contradict|add-counterevidence)$/, 'add-counterevidence'],
  [/^(qualify|add-qualification)$/, 'add-qualification'],
  [/^(dispatch scientist|dispatch|scientist|ask scientist|ask-scientist)$/, 'ask-scientist'],
  [/^(ask challenger|challenger|ask-challenger)$/, 'ask-challenger'],
  [/^(verify|verify-claim)$/, 'verify-claim'],
  [/^(investigate|investigate-gap)$/, 'investigate-gap'],
  [/^(inspect|inspect-source)$/, 'inspect-source'],
  [/^(audit|audit-symmetry)$/, 'audit-symmetry'],
  [/^(claim|add-claim)$/, 'add-claim'],
  [/^(hypothesis|add-hypothesis)$/, 'add-hypothesis'],
  [/^(gap|add-gap)$/, 'add-gap'],
]

export type Command =
  | { kind: 'action'; action: string; items: string[]; ignored: string[] }
  | { kind: 'weigh'; id: string }
  | { kind: 'open'; id: string }
  | { kind: 'exhibit'; mark: string }
  | { kind: 'help' }
  | { kind: 'clear' }
  | { kind: 'error'; message: string }

export const HELP: string[] = [
  'weigh <id>               put a claim or hypothesis on the balance',
  'open <id>                inspect an item (also: Enter on a row)',
  'ex <mark>                jump to an exhibit in the custody log',
  'support|counter|qualify <id>   add evidence to a claim or hypothesis',
  'challenge <id>           post a challenge task            [confirm]',
  'dispatch scientist [id]  ask the Scientist (agent)        [confirm]',
  'ask challenger <id>      ask the Challenger (agent)       [confirm]',
  'verify <id> · investigate <gap> · correct <evidence>',
  '<action-id> <id>         any action the program declares',
  'keys  1-4 pane · j/k move · Enter open · w weigh · : command · Esc close',
]

/**
 * Parse one command line. `items` resolves ids; `fallback` is the item under the cursor (or the question) for
 * verbs typed without an id. Flags (`--budget 2`) are not the program's to take: they are named back as ignored,
 * because cost and deadline are set by OmegaTruth and shown in the confirm.
 */
export function parseCommand(line: string, describe: ProgramDescription | null, items: Map<string, WorkItem>, fallback: string | null, question: string | null): Command {
  const raw = line.trim().replace(/\s+/g, ' ')
  if (!raw) return { kind: 'error', message: 'Type a command, or help.' }
  const words = raw.split(' ')
  const ignored = words.filter((w) => w.startsWith('--'))
  const plain = words.filter((w, i) => !w.startsWith('--') && !(i > 0 && words[i - 1].startsWith('--') && !items.has(w)))
  const head = plain[0].toLowerCase()
  if (head === 'help' || head === '?') return { kind: 'help' }
  if (head === 'clear') return { kind: 'clear' }
  if (head === 'weigh' || head === 'open' || head === 'inspect-item') {
    const id = plain[1]
    if (!id) return { kind: 'error', message: `${head} needs an id, e.g. ${head} c1` }
    if (!items.has(id)) return { kind: 'error', message: `No item ${id} in this case.` }
    return head === 'weigh' ? { kind: 'weigh', id } : { kind: 'open', id }
  }
  if (head === 'ex' || head === 'exhibit') {
    const mark = (plain[1] ?? '').toUpperCase().replace(/^EX\./, '')
    if (!/^[A-Z]+$/.test(mark)) return { kind: 'error', message: 'ex needs an exhibit mark, e.g. ex B' }
    return { kind: 'exhibit', mark }
  }
  // the verb is everything up to the first known id
  const at = plain.findIndex((w, i) => i > 0 && items.has(w))
  const verb = (at < 0 ? plain : plain.slice(0, at)).join(' ').toLowerCase()
  const ids = at < 0 ? [] : plain.slice(at).filter((w) => items.has(w))
  const unknown = at < 0 ? plain.slice(1).filter((w) => /^[a-z]\d+$/i.test(w)) : []
  if (unknown.length) return { kind: 'error', message: `No item ${unknown[0]} in this case.` }
  const declared = describe?.actions ?? []
  const id = ALIASES.find(([re]) => re.test(verb))?.[1] ?? (declared.some((a) => a.id === verb) ? verb : null)
  if (!id || !declared.some((a) => a.id === id)) return { kind: 'error', message: `Unknown command “${verb}”. Type help.` }
  const target = ids.length ? ids : [defaultTarget(id, describe, items, fallback, question)].filter((x): x is string => !!x)
  if (!target.length) return { kind: 'error', message: `${verb} needs an id.` }
  for (const t of target) {
    const it = items.get(t)!
    if (!actionsFor(describe, it.kind).some((a) => a.id === id)) return { kind: 'error', message: `${id} does not apply to ${it.kind} ${t}.` }
  }
  return { kind: 'action', action: id, items: target, ignored }
}

function defaultTarget(action: string, describe: ProgramDescription | null, items: Map<string, WorkItem>, fallback: string | null, question: string | null): string | null {
  const fits = (id: string | null) => {
    const it = id ? items.get(id) : undefined
    return !!it && actionsFor(describe, it.kind).some((a) => a.id === action)
  }
  if (fits(fallback)) return fallback
  if (fits(question)) return question
  return null
}

/** The hotkeys that apply to an item, with whether each asks to confirm. */
export function verbsFor(describe: ProgramDescription | null, item: WorkItem): { key: string; action: string; word: string; gated: boolean }[] {
  const ok = new Set(actionsFor(describe, item.kind).map((a) => a.id))
  return VERB_KEYS.filter(([, a]) => ok.has(a)).map(([key, action, word]) => ({ key, action, word, gated: !!gateOf(action) }))
}

/** An ASCII bar for a pan's weight, scaled to the heavier side. */
export function bar(weight: number, max: number, width = 16): string {
  const n = max > 0 ? Math.round((Math.max(0, weight) / max) * width) : 0
  return '█'.repeat(n) + '░'.repeat(width - n)
}
