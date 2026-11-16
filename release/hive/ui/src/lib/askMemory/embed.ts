/**
 * Local similarity, Chroma-style but on this device only. Version 1 is LEXICAL: hashed word and character-trigram
 * counts, compared by cosine. It finds "short answers" near "shorter answers", not "brief replies" near "concise
 * responses". A real local embedding model is a follow-up; it drops in behind `Embedder` without changing recall.
 */

export interface Embedder {
  /** names the vector space; vectors from different embedders are never compared */
  readonly id: string
  /** a unit-length vector (or all zeros for empty text) */
  embed(text: string): Float32Array
}

const DIM = 512

/** Lower case, spacing collapsed, punctuation at the ends dropped: how statements are compared for "the same". */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')
}

function fnv(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** The v1 embedder: words (weight 1) and character trigrams of each word (weight 0.5), hashed into 512 buckets. */
export const lexicalEmbedder: Embedder = {
  id: 'lexical-hash-v1',
  embed(text) {
    const v = new Float32Array(DIM)
    const words = normalise(text).match(/[\p{L}\p{N}]+/gu) ?? []
    for (const w of words) {
      v[fnv(`w:${w}`) % DIM] += 1
      const padded = ` ${w} `
      for (let i = 0; i + 3 <= padded.length; i++) v[fnv(`t:${padded.slice(i, i + 3)}`) % DIM] += 0.5
    }
    let n = 0
    for (let i = 0; i < DIM; i++) n += v[i] * v[i]
    if (n > 0) {
      const k = 1 / Math.sqrt(n)
      for (let i = 0; i < DIM; i++) v[i] *= k
    }
    return v
  },
}

/** Cosine of two unit vectors (0 when either is empty or they differ in length). */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let d = 0
  for (let i = 0; i < a.length; i++) d += a[i] * b[i]
  return Math.max(-1, Math.min(1, d))
}
