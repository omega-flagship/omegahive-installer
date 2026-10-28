/**
 * The Ask's own memory of the person, kept only in their browser (the owner, 2026-10-07: "keep the memory local on the
 * browser side and put cloud hosted memory coming soon"). The hive stores nothing about the person: it sends a live
 * `memory` frame for this browser to keep, and this browser sends a few recalled notes back with each Ask turn
 * (`memory_notes`). Shapes here are this browser's; nothing in this folder makes a request of its own.
 */

export type MemoryKind = 'preference' | 'name' | 'place' | 'person' | 'project' | 'correction'
export const MEMORY_KINDS: readonly MemoryKind[] = ['preference', 'name', 'place', 'person', 'project', 'correction']

/** A NAL truth value: how often it holds (frequency) and how much evidence stands behind that (confidence). */
export interface Truth {
  frequency: number
  confidence: number
}

/** One belief about the person (AtomSpace-style: a statement with a truth value, revised as evidence arrives). */
export interface Belief {
  /** this browser's id; the host echoes it back as a revise's `target_id` (^[A-Za-z0-9_-]{1,64}$) */
  id: string
  kind: MemoryKind
  statement: string
  truth: Truth
  /** how many turns it was sent with */
  uses: number
  /** epoch ms; null until first sent */
  last_used_at: number | null
  created_at: number
  updated_at: number
  /** the turn that last taught it (null after a hand edit leaves it unchanged) */
  source_turn: string | null
}

export type TraceKind = 'remember' | 'revise' | 'edit' | 'forget' | 'forget_all' | 'lost' | 'restore'

/** One line of the journal: what happened to the memory, when, and from which turn. Append-only. */
export interface TraceEntry {
  id: string
  at: number
  turn_id: string | null
  kind: TraceKind
  /** plain words, local only; blanked when the belief it names is forgotten */
  summary: string
  belief_id: string | null
  /** the frame's seq within its turn (live frames only): how a stub read back later is matched */
  seq?: number
}

/** The item a live memory frame carries (host conductor.check_remember). */
export interface MemoryItem {
  statement: string
  kind: MemoryKind
  truth: Truth
}

/** A memory frame as the page reads it: live (with item) or the stored stub (op and digest only). */
export interface MemoryFrame {
  turn_id: string
  seq: number
  op: 'remember' | 'revise' | ''
  digest: string
  item?: MemoryItem
  target_id?: string | null
}

/** The host's caps on memory_notes (conductor.check_notes): 20 entries, 8 KB in all (ids and texts, UTF-8). */
export const NOTES_MAX = 20
export const NOTES_MAX_BYTES = 8 * 1024
export const NOTE_ID = /^[A-Za-z0-9_-]{1,64}$/
/** The host's cap on frames per turn (conductor.MAX_REMEMBER); the page keeps no more than this from one turn. */
export const FRAMES_PER_TURN = 8
export const STATEMENT_MAX = 500

export interface Note {
  id: string
  text: string
}

/**
 * One exchange the person had with a swarm, remembered "like I would" (the owner, 2026-10-08) without waking their personal
 * mind: the hive holds a copy only until this browser collects it (GET /api/me/mind/inbox), then this browser keeps
 * it and the hive deletes it (POST /api/me/mind/inbox/ack). Read-only here; the person may forget it.
 */
export interface Talk {
  /** the hive's inbox item id (^[A-Za-z0-9_-]{1,64}$) */
  id: string
  turn_id: string
  /** when the exchange was held (epoch ms, the hive's clock) */
  at: number
  /** the person's words, and the swarm's answer (as the hive cut them; `truncated` when it did) */
  words: string
  answer: string
  truncated: boolean
  /** when this browser kept it (epoch ms) */
  kept_at: number
  /** r2: how many Ask turns it was sent with as a note, and when last (absent: never) */
  uses?: number
  last_used_at?: number | null
}
/** The hive's cut per item is 16 KB (personal_inbox.fit); a held copy longer than this is not kept. */
export const TALK_TEXT_MAX = 16 * 1024
