/**
 * The speed workload, shared by the Node run (speed.test.ts, MeTTaScript called directly) and the browser run
 * (scripts/mind-metta-bench, through the worker). Synthetic, deterministic sentences; nothing personal.
 */
const WORDS = ('answers short long morning evening tea coffee music jazz piano garden walk river city town project ' +
  'design code review meeting family weekend travel train book film paint colour blue green quiet loud early late ' +
  'notes lists plans weather rain sun dog cat bike kitchen bread soup ' +
  'prefers likes dislikes enjoys avoids usually often rarely').split(' ')

/** A small PRNG (mulberry32), so every run sees the same sentences. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function sentence(r: () => number, n = 7): string {
  return Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ')
}

export const SIZES = [50, 200, 1000] as const

export interface Stat {
  n: number
  median: number
  p95: number
  min: number
  max: number
}
export function stat(xs: number[]): Stat {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]
  return { n: s.length, median: q(0.5), p95: q(0.95), min: s[0], max: s[s.length - 1] }
}

/** What one run measures, in milliseconds. */
export interface SpeedReport {
  where: string
  cold: Stat
  sizes: Record<number, { addBelief: Stat; reviseBelief: Stat; recall: Stat; infer: Stat; exportMs: number; exportBytes: number }>
}
