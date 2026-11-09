/**
 * The personal mind's memory, as three linked parts (Jon, 2026-10-09: "chroma + AtomSpace + history is the magic of
 * memory when linking is done well"):
 *  - the AtomSpace (MeTTaScript): beliefs `(Current (Belief id) ...)` and remembered exchanges and episodes
 *    `(Current (Memory id) ...)` (Platform's minds' carrier), with (stv f c) truth values and evidential stamps, both
 *    revised by the hive's own law (lib_hive hive-integrate!, whose revision is lib_nal's Truth_Revision);
 *  - vectors, Chroma-style but in this browser: one embedding per belief and per memory, keyed by the atom's id (the
 *    `Embedder` of lib/askMemory/embed.ts, lexical v1, so a real local model drops in);
 *  - history: an append-only journal of events in the space itself (&history), each naming the id it touched and the
 *    turn it came from. It holds no words, so forgetting stays complete while the journal stays append-only.
 *
 * Link schema: vector entry id = atom id (`Said`, `Words`, `Current (Belief|Memory id)`) = Event target id; the
 * Event turn joins a turn's memory (the exchange) to the beliefs learned in it.
 */
import type { Evidence, Stv } from './atoms'

export type { Evidence, Stv }

/** Belief and memory ids: as the Ask memory's (^[A-Za-z0-9_-]{1,64}$). */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Belief kinds: a short lower-case word (preference, name, place, person, project, correction, fact, ...). */
export const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/
export const MAX_TEXT = 2000

export type Refusal = 'forgotten' | 'id-taken' | 'id-conflict' | 'unknown' | 'invalid'
export interface Refused {
  ok: false
  refused: Refusal
  why?: string
}

/** A truth value with the evidence behind it. */
export interface Held {
  stv: Stv
  stamp: Evidence[]
}

/** What lib_hive's hive-integrate! did with new evidence for a belief. */
export type Outcome = 'adopted' | 'revised' | 'chosen' | 'kept'
export interface Integrated {
  ok: true
  id: string
  outcome: Outcome
  /** the belief before (null: new) */
  before: Held | null
  /** the evidence offered */
  input: Held
  /** the belief now */
  after: Held
  /** no evidence was given, so a fresh stamp was minted (see `warning`) */
  minted?: true
  warning?: string
}

export interface WhenOpts {
  /** seconds since the epoch when the evidence arose (default: now). Words forgotten at or after it are refused. */
  at?: number
  /** the turn it came from (joins history to the exchange) */
  turn?: string
}

export interface EvidenceOpts extends WhenOpts {
  /**
   * The evidence behind this truth value, lib_hive's (ev agent n). Omitted: new evidence is minted from this space
   * (ev <self> n). Re-sending the SAME source (a replayed turn) must pass the same evidence, or it counts twice; with
   * the same evidence, overlap is detected and nothing is revised (no confidence inflation).
   */
  evidence?: Evidence[]
  /** refuse (throw) instead of minting when `evidence` is missing */
  strictEvidence?: boolean
}

export interface Belief {
  id: string
  /** a distilled belief, or a remembered exchange or episode */
  type: 'belief' | 'memory'
  kind: string
  statement: string
  at: number
  stv: Stv
  stamp: Evidence[]
}

export interface RecallItem {
  id: string
  type: 'belief' | 'memory'
  /** cosine similarity from the vector index (TypeScript) */
  similarity: number
  /** decayed promotion (MeTTa: mind-promotion) */
  attention: number
  /** the rank score (MeTTa: mind-score) */
  score: number
  text: string
  kind: string
  stv: Stv
  stamp: Evidence[]
}

export interface RecallResult {
  items: RecallItem[]
  /** candidates handed to the space by the vector index */
  candidates: number
  embedder: string
}

export interface HistoryEvent {
  event: Evidence
  op: string
  at: number
  turn: string | null
  id: string | null
  detail: string
}
export interface Explanation {
  id: string
  held: boolean
  events: HistoryEvent[]
  /** other ids touched in the same turns (e.g. the memory of the exchange a belief was learned from) */
  linked: { turn: string; id: string; held: boolean }[]
}

export type LinkType = 'Inheritance' | 'Implication'
export const TERM_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
export interface Premise {
  link: LinkType
  from: string
  to: string
  /** given truth; or take it from a held belief (`belief`), so the truth comes from the space */
  stv?: Stv
  belief?: string
}
export type PlnRule = 'deduction' | 'induction' | 'abduction' | 'other'
export interface InferTrace {
  ok: true
  premises: { link: LinkType; from: string; to: string; stv: Stv; belief?: string }[]
  conclusions: {
    rule: PlnRule
    /** lib_pln's truth function for that rule */
    formula: string
    /** the formula's inputs: the term priors lib_pln uses ((STV $X), evaluated in MeTTa) and the premise truths */
    inputs: { priors: Record<string, Stv>; T1: Stv; T2: Stv }
    link: LinkType
    from: string
    to: string
    stv: Stv
  }[]
}

export interface ImportReport {
  ok: true
  beliefs: { merged: number; skipped: number }
  memories: { merged: number; skipped: number }
  tombstones: number
  watermark: number
  /** ids held before that the merged tombstones or watermark now cover */
  purged: string[]
}

export interface SpaceStats {
  beliefs: number
  memories: number
  tombstones: number
  events: number
  watermark: number
}
