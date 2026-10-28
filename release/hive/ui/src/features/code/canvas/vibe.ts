/**
 * Plain words for code (the owner's rule: nobody has to read or write code). Pure helpers for the Code canvas:
 *  - describeChange: what one proposed change does, in words, from its before and after text;
 *  - summarize: the summary of a whole proposal (what changed, where, and what must go together);
 *  - runMarks / runTally: a test run's output turned into results beside the lines they name.
 *
 * The words are derived mechanically from the text, never invented: the proposal contract has no rationale field yet,
 * so "why" is the person's own request, quoted, and the summary says when the mind gave no reason of its own.
 */

const words = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** What one change does, in a short phrase (≤ 60 characters, no code unless a name is the clearest word). */
export function describeChange(before: string, after: string): string {
  const b = before.trim()
  const a = after.trim()
  if (!b && a) {
    if (/^(#|\/\/|;)/.test(a)) return 'adds a note'
    const n = a.split('\n').length
    return n > 1 ? `adds ${words(n, 'line')}` : 'adds a line'
  }
  if (b && !a) {
    const n = b.split('\n').length
    return n > 1 ? `removes ${words(n, 'line')}` : 'removes this line'
  }
  if (b === a) return 'changes only spacing'
  const out: string[] = []
  const defB = /\bdef (\w+)\(([^)]*)\)/.exec(b)
  const defA = /\bdef (\w+)\(([^)]*)\)/.exec(a)
  if (defB && defA && defB[1] !== defA[1]) out.push(`renames ${defB[1]} to ${defA[1]}`)
  if (/->\s*\w+\s*:/.test(a) && !/->/.test(b)) out.push('says what it returns')
  if (defA && /:\s*\w+/.test(defA[2]) && !(defB && /:\s*\w+/.test(defB[2]))) out.push('labels its inputs')
  if (/\bf"/.test(a) && !/\bf"/.test(b)) out.push('builds the text in one piece')
  const opB = /\b(\w+) ([-+*/]) (\w+)\b/.exec(b)
  const opA = /\b(\w+) ([-+*/]) (\w+)\b/.exec(a)
  const verb: Record<string, [string, string]> = { '+': ['adds', 'adding'], '-': ['subtracts', 'subtracting'], '*': ['multiplies', 'multiplying'], '/': ['divides', 'dividing'] }
  if (opB && opA && opB[1] === opA[1] && opB[3] === opA[3] && opB[2] !== opA[2]) out.push(`now ${verb[opA[2]][0]} instead of ${verb[opB[2]][1]}`)
  const idsB = new Set(b.match(/[A-Za-z_]\w*/g) ?? [])
  const idsA = new Set(a.match(/[A-Za-z_]\w*/g) ?? [])
  const gone = [...idsB].filter((x) => !idsA.has(x) && x.length > 2)
  const came = [...idsA].filter((x) => !idsB.has(x) && x.length > 2 && !['str', 'int', 'float', 'bool'].includes(x))
  if (!out.length && gone.length === 1 && came.length === 1) out.push(`renames ${gone[0]} to ${came[0]}`)
  if (!out.length) return b.split('\n').length > 1 ? `rewrites ${words(b.split('\n').length, 'line')}` : 'rewrites this line'
  const s = out.join(', ')
  return s.length > 60 ? `${s.slice(0, 59)}…` : s
}

export interface SummaryInput {
  instruction: string | null
  mind: string
  path: string
  changes: { line: number; lastLine: number; words: string }[]
  /** groups of change indexes (0-based) that must be decided together */
  together: number[][]
  /** the author's plain what/why (content.plain_summary), when the loaded service declares proposal-plain-summary */
  plain?: { what: string; why: string } | null
  /** whether the loaded service's proposals can carry a plain summary at all */
  canCarry?: boolean
}

/** The plain summary shown after the change is written in: one headline, the changes in words, and the why. */
export function summarize(s: SummaryInput): { headline: string; lines: string[]; why: string } {
  const file = s.path.split('/').pop() ?? s.path
  const first = Math.min(...s.changes.map((c) => c.line))
  const last = Math.max(...s.changes.map((c) => c.lastLine))
  const where = first === last ? `line ${first}` : `lines ${first}–${last}`
  const headline = `${s.mind} proposes ${words(s.changes.length, 'change')} to ${file} (${where}).`
  const lines = s.changes.map((c) => `${c.line === c.lastLine ? `Line ${c.line}` : `Lines ${c.line}–${c.lastLine}`}: ${c.words}.`)
  for (const g of s.together) if (g.length > 1) lines.push(`Changes ${g.map((i) => i + 1).join(', ')} only work together: keep all of them or none.`)
  const asked = s.instruction ? `You asked: “${s.instruction.trim()}”. ` : ''
  const why =
    s.canCarry && s.plain && (s.plain.what.trim() || s.plain.why.trim())
      ? `${s.mind} says: ${[s.plain.what.trim(), s.plain.why.trim()].filter(Boolean).join(' ')} (The author’s explanation, not a check.)`
      : s.canCarry
        ? `${asked}${s.mind} gave no reason with this proposal.`
        : `${asked}${s.mind} gave no reason of its own (this service’s proposals cannot carry one yet).`
  return { headline, lines, why }
}

export interface RunMark {
  path: string
  line: number
  text: string
  ok: boolean
}

/**
 * Results beside lines, from a test run's output: a `path:line: in name` frame followed by its `E   message` line (the
 * pytest shape), or a bare `path:line: message`. At most 50 marks; paths are kept only when they are plain relative paths.
 */
export function runMarks(output: string): RunMark[] {
  const out: RunMark[] = []
  const rows = output.split('\n')
  const safe = (p: string) => !p.startsWith('/') && !p.split('/').some((x) => x === '..' || !x)
  for (let i = 0; i < rows.length && out.length < 50; i++) {
    const m = /^([\w./-]+\.\w+):(\d+):\s*(.*)$/.exec(rows[i].trim())
    if (!m || !safe(m[1])) continue
    let text = m[3]
    for (let j = i + 1; j < Math.min(rows.length, i + 6); j++) {
      const e = /^E\s+(.*)$/.exec(rows[j].trim())
      if (e) {
        text = e[1]
        break
      }
      if (/^([\w./-]+\.\w+):(\d+):/.test(rows[j].trim())) break
    }
    out.push({ path: m[1], line: Number(m[2]), text: text.replace(/^in \w+$/, 'failed here').slice(0, 160), ok: false })
  }
  return out
}

/** "2 passed", "1 failed, 1 passed" from the run's last summary line; null when there is none. */
export function runTally(output: string): { passed: number; failed: number; text: string } | null {
  const lines = output.trim().split('\n').reverse()
  for (const l of lines) {
    const p = /(\d+) passed/.exec(l)
    const f = /(\d+) (failed|error)/.exec(l)
    if (p || f) {
      const passed = p ? Number(p[1]) : 0
      const failed = f ? Number(f[1]) : 0
      return { passed, failed, text: [failed ? `${failed} failed` : '', passed ? `${passed} passed` : ''].filter(Boolean).join(', ') }
    }
  }
  return null
}

/** The scope ranges for "the whole file" (saved bytes). */
export const wholeFile = (path: string, bytes: number): Record<string, [number, number][]> => ({ [path]: [[0, bytes]] })

/** Near the selection: the name of the function it is in (for a caption, "Test greet"), or null. */
export function enclosingName(text: string, line: number): string | null {
  const rows = text.split('\n').slice(0, line)
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = /^\s*(?:async\s+)?(?:def|function|class)\s+(\w+)/.exec(rows[i]) ?? /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/.exec(rows[i])
    if (m) return m[1]
  }
  return null
}

/** The scope a person authorised for a change: the whole file, or its lines (1-based, inclusive). */
export interface ScopeShown {
  path: string
  lines: { first: number; last: number } | null
  /** a whole function picked by the service's function parser (function-scopes) */
  fn?: string
}

/** The authorised scope in words, for the confirm: "Whole file: a.py", "Lines 28–36 of a.py", "Line 4 of a.py". */
export function scopeWords(s: ScopeShown): string {
  if (!s.lines) return `Whole file: ${s.path}`
  if (s.fn) return `Function ${s.fn} (${s.lines.first === s.lines.last ? `line ${s.lines.first}` : `lines ${s.lines.first}–${s.lines.last}`}) of ${s.path}`
  return s.lines.first === s.lines.last ? `Line ${s.lines.first} of ${s.path}` : `Lines ${s.lines.first}–${s.lines.last} of ${s.path}`
}
