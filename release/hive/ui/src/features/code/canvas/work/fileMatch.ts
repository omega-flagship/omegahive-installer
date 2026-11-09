/**
 * Which file a request names (pure): "Fix add() in the calculator" → calculator.py. Used by the canvas's empty state,
 * where the person just says what should change before any file is open. Exactly one best match: open it and ask on
 * the whole file. None or several: the chooser opens with these candidates first, and the words are kept.
 */

const STOP = new Set(['the', 'and', 'for', 'fix', 'make', 'change', 'please', 'with', 'that', 'this', 'from', 'into', 'file', 'code', 'function', 'method', 'class', 'should', 'when', 'what', 'it', 'its', 'in', 'of', 'to', 'a', 'an', 'so', 'on', 'my', 'our', 'can', 'you', 'not', 'does', 'doesn', 'isn', 'work', 'works', 'actually', 'bug', 'broken'])
const base = (p: string) => p.split('/').pop() ?? p
const stem = (p: string) => base(p).replace(/\.[^.]+$/, '').toLowerCase()
const isTest = (p: string) => /(^|[/_.-])tests?([/_.-]|$)|_test\.|\.test\.|\.spec\./i.test(p)
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** function names the words point at: `add()` or `add(…)` */
export function namedFunctions(words: string): string[] {
  return [...new Set([...words.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]))]
}

/** The files the words name, best first; ties are all returned (the caller opens a single one, or asks the person). */
export function matchFiles(words: string, files: string[], texts: Record<string, string> = {}): string[] {
  const lower = words.toLowerCase()
  const tokens = [...new Set(lower.split(/[^a-z0-9_]+/).filter((t) => t.length >= 3 && !STOP.has(t)))]
  const fns = namedFunctions(words)
  const wantsTests = /\btests?\b/.test(lower)
  const scored = files.map((f) => {
    const s = stem(f)
    const parts = s.split(/[_\-.\s]+/).filter((x) => x.length >= 3)
    let score = 0
    if (lower.includes(base(f).toLowerCase())) score += 6
    for (const t of tokens) {
      if (t === s) score += 5
      else if (parts.includes(t)) score += 4
      else if (parts.some((p) => p.length >= 4 && (t.startsWith(p) || p.startsWith(t)))) score += 2
    }
    for (const fn of fns) {
      const n = fn.toLowerCase()
      if (parts.includes(n) || s === n) score += 2
      const text = texts[f]
      if (text && new RegExp(`\\b(def|function|fn|func)\\s+${escape(fn)}\\b|\\b${escape(fn)}\\s*[=:]\\s*(\\(|function|lambda)`).test(text)) score += 3
    }
    if (score > 0 && isTest(f) && !wantsTests) score -= 1
    return { f, score }
  })
  const best = Math.max(0, ...scored.map((x) => x.score))
  return best > 0 ? scored.filter((x) => x.score === best).map((x) => x.f) : []
}
