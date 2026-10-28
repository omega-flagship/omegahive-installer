/** Subsequence fuzzy score: prefix, substring, then word-start matches rank higher. 0 = no match. */
export function fuzzy(q: string, text: string): number {
  if (!q) return 1
  const t = text.toLowerCase()
  const s = q.toLowerCase()
  if (t.startsWith(s)) return 100 - t.length * 0.1
  const idx = t.indexOf(s)
  if (idx >= 0) return 80 - idx
  let ti = 0
  let score = 0
  for (const ch of s) {
    const f = t.indexOf(ch, ti)
    if (f < 0) return 0
    score += f === ti ? 3 : f === 0 || t[f - 1] === ' ' ? 2 : 1
    ti = f + 1
  }
  return score
}
