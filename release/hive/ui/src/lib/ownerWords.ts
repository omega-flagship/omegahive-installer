/**
 * Host text a person reads, said in the hive's own words (the owner's standing rule): work is Motivations and Tasks, never
 * goals or boards; agents are minds, never dots. The static wording guards cover the UI's own strings; this covers
 * text the host sends (bench names, case titles, notes), which the UI shows but does not own.
 *
 * Only whole words change. Identifiers, routes, keys and file names stay as they are: a letter, digit, `-`, `_`, `/`,
 * `.` or `$` touching the word (goal_id, work.goals, /api/goals, dot.ts, cx-goal) leaves it alone. A leading capital,
 * or all capitals, is kept.
 */
const EDGE_BEFORE = '(?<![-_/.$\\w])'
const EDGE_AFTER = '(?![-_/(\\w]|\\.\\w)'
const word = (w: string) => new RegExp(`${EDGE_BEFORE}(${w})${EDGE_AFTER}`, 'gi')

function keepCase(from: string, to: string): string {
  if (from.length > 1 && from === from.toUpperCase()) return to.toUpperCase()
  return from[0] === from[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to
}

const SWAPS: [RegExp, (m: string) => string][] = [
  [word('goals?\\s+boards?'), (m) => keepCase(m, /s$/i.test(m) ? 'task lists' : 'task list')],
  [word('subgoals'), (m) => keepCase(m, 'subtasks')],
  [word('subgoal'), (m) => keepCase(m, 'subtask')],
  [word('goals'), (m) => keepCase(m, 'tasks')],
  [word('goal'), (m) => keepCase(m, 'task')],
  [word('boards'), (m) => keepCase(m, 'task lists')],
  [word('board'), (m) => keepCase(m, 'task list')],
  [word('dots'), (m) => keepCase(m, 'minds')],
  [word('dot'), (m) => keepCase(m, 'mind')],
]

/** `text` with the retired words said as the hive's words; everything else unchanged. Null and undefined read as ''. */
export function ownerWords(text: string | null | undefined): string {
  if (!text) return text ?? ''
  let out = text
  for (const [re, to] of SWAPS) out = out.replace(re, to)
  return out
}
