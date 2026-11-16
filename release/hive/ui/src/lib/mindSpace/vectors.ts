/**
 * The vector part of memory, Chroma-style but in this browser: one embedding per held belief and per remembered
 * memory (exchange, episode), keyed by the atom's id. It only finds candidates; the space decides what is held, its truth and its rank.
 * It is kept equal to the space's held ids (MindCore adds and removes entries as the space does).
 */
import { cosine, type Embedder } from '../askMemory/embed'

export type EntryType = 'belief' | 'memory'
export interface VectorEntry {
  type: EntryType
  vec: Float32Array
}

export class VectorIndex {
  private readonly entries = new Map<string, VectorEntry>()
  constructor(readonly embedder: Embedder) {}

  put(id: string, type: EntryType, text: string, vec?: Float32Array): void {
    this.entries.set(id, { type, vec: vec ?? this.embedder.embed(text) })
  }
  delete(id: string): void {
    this.entries.delete(id)
  }
  clear(): void {
    this.entries.clear()
  }
  has(id: string): boolean {
    return this.entries.has(id)
  }
  get size(): number {
    return this.entries.size
  }
  ids(): string[] {
    return [...this.entries.keys()]
  }
  /** for persistence: [id, type, vector] */
  dump(): [string, EntryType, Float32Array][] {
    return [...this.entries].map(([id, e]) => [id, e.type, e.vec])
  }

  /** The `k` nearest entries with positive similarity, nearest first. */
  nearest(query: string, k: number): { id: string; similarity: number }[] {
    const q = this.embedder.embed(query)
    const out: { id: string; similarity: number }[] = []
    for (const [id, e] of this.entries) {
      const s = cosine(q, e.vec)
      if (s > 0) out.push({ id, similarity: s })
    }
    out.sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1))
    return out.slice(0, k)
  }
}
