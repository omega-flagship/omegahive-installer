/**
 * Learning, pure: what one memory frame does to the beliefs. `remember` merges into a belief of the same kind whose
 * statement is near-identical (NAL revision of their truths), else adds one; `revise` targets the belief the host
 * names by this browser's id. Nothing here touches storage or the network.
 */
import { cosine, lexicalEmbedder, normalise, type Embedder } from './embed'
import { clampTruth, revise } from './truth'
import { MEMORY_KINDS, STATEMENT_MAX, type Belief, type MemoryFrame, type MemoryItem, type MemoryKind, type TraceEntry } from './types'

/** Statements this close (lexical cosine) are the same belief said again. */
export const NEAR_IDENTICAL = 0.9

/** The private apps (Atlas, OmegaTruth, Truth), named anywhere in the words: never kept, never sent (the host's fence, twice). */
const PRIVATE = new Set(['atlas', 'omegatruth', 'truth'])
export function namesPrivate(text: string): boolean {
  let t = text
  for (let i = 0; i < 3; i++) {
    try {
      const d = decodeURIComponent(t)
      if (d === t) break
      t = d
    } catch {
      break
    }
  }
  return (t.toLowerCase().normalize('NFKC').match(/[a-z0-9]+/g) ?? []).some((w) => PRIVATE.has(w))
}

/** Words as kept: spacing collapsed, trimmed, at most 500 characters. */
export const cleanStatement = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, STATEMENT_MAX)

export function sameStatement(a: string, b: string, embedder: Embedder = lexicalEmbedder): boolean {
  if (normalise(a) === normalise(b)) return true
  return cosine(embedder.embed(a), embedder.embed(b)) >= NEAR_IDENTICAL
}

/** A frame's item read strictly: a known kind, 1–500 characters, a finite truth. Null otherwise. */
export function readItem(v: unknown): MemoryItem | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const t = o.truth as Record<string, unknown> | undefined
  if (typeof o.statement !== 'string' || !MEMORY_KINDS.includes(o.kind as MemoryKind) || !t || typeof t !== 'object') return null
  const statement = cleanStatement(o.statement)
  if (!statement || o.statement.length > STATEMENT_MAX) return null
  if (typeof t.frequency !== 'number' || typeof t.confidence !== 'number' || !Number.isFinite(t.frequency) || !Number.isFinite(t.confidence)) return null
  if (t.frequency < 0 || t.frequency > 1 || t.confidence < 0 || t.confidence > 1) return null
  return { statement, kind: o.kind as MemoryKind, truth: clampTruth({ frequency: t.frequency, confidence: t.confidence }) }
}

export interface LearnCtx {
  now: number
  newId: () => string
  traceId: () => string
  embedder?: Embedder
}

/** One live frame learned: the belief as it now stands (new or changed) and the journal line for it. */
export function learn(beliefs: readonly Belief[], frame: MemoryFrame & { item: MemoryItem }, ctx: LearnCtx): { belief: Belief; entry: TraceEntry; merged: boolean } {
  const emb = ctx.embedder ?? lexicalEmbedder
  const item = frame.item
  const entry = (kind: 'remember' | 'revise', b: Belief): TraceEntry => ({ id: ctx.traceId(), at: ctx.now, turn_id: frame.turn_id, seq: frame.seq, kind, summary: b.statement, belief_id: b.id })
  const target = frame.op === 'revise' && frame.target_id ? beliefs.find((b) => b.id === frame.target_id) : undefined
  if (target) {
    // the same statement said again is more evidence for it; a different one replaces it with the new evidence only
    const same = sameStatement(target.statement, item.statement, emb)
    const b: Belief = {
      ...target,
      statement: item.statement,
      kind: item.kind === 'correction' ? target.kind : item.kind,
      truth: same ? revise(target.truth, item.truth) : clampTruth(item.truth),
      updated_at: ctx.now,
      source_turn: frame.turn_id,
    }
    return { belief: b, entry: entry('revise', b), merged: true }
  }
  const twin = beliefs.find((b) => b.kind === item.kind && sameStatement(b.statement, item.statement, emb))
  if (twin) {
    const b: Belief = { ...twin, statement: item.statement, truth: revise(twin.truth, item.truth), updated_at: ctx.now, source_turn: frame.turn_id }
    return { belief: b, entry: entry('remember', b), merged: true }
  }
  const b: Belief = { id: ctx.newId(), kind: item.kind, statement: item.statement, truth: clampTruth(item.truth), uses: 0, last_used_at: null, created_at: ctx.now, updated_at: ctx.now, source_turn: frame.turn_id }
  return { belief: b, entry: entry('remember', b), merged: false }
}
