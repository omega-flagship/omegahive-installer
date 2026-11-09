/**
 * Recall, Chroma-style and local: rank the beliefs for this request and send the best within the host's caps (20
 * notes, 8 KB). Score = 0.6 × similarity + 0.4 × attention, where similarity is the embedder's cosine to the request
 * (v1: LEXICAL, see embed.ts) and attention = confidence × recency × use. A belief that is mostly not true, or that
 * names a private app, is never sent.
 *
 * r2 (Jon, 2026-10-09: "it should be used when talking to me - it should get to know me"): the person's swarm
 * conversations are a second recall source, ranked the same way under the same caps. Each is its own note ("you
 * asked …; the answer was …", trimmed) with a fixed, modest truth (TALK_TRUTH). It is never sent when it names a
 * private app, when everything was forgotten since it was held (the watermark, R2), or when its words were forgotten
 * (a forget marker's fingerprints, R3/R4); forgetting it removes it from the store, so from recall. Recall sits behind
 * the small `Recaller` interface, so the MeTTa memory core (mindSpace.recall) can take its place later.
 */
import { cosine, lexicalEmbedder, type Embedder } from './embed'
import { namesPrivate } from './beliefs'
import type { Tombstone } from './backend'
import { forgottenSince } from './file'
import { NOTES_MAX, NOTES_MAX_BYTES, type Belief, type MemoryKind, type Note, type Talk, type Truth } from './types'

const DAY = 86_400_000
/** attention halves every 30 days without use */
export const HALF_LIFE_DAYS = 30
export const W_SIMILARITY = 0.6
export const W_ATTENTION = 0.4

const KIND_WORD: Record<MemoryKind, string> = { preference: 'preference', name: 'name', place: 'place', person: 'person', project: 'project', correction: 'correction' }

/** The note's words as the model reads them: "name: Call them Jon". */
export const noteText = (b: Pick<Belief, 'kind' | 'statement'>): string => `${KIND_WORD[b.kind]}: ${b.statement}`

/**
 * A conversation is sent only when it is about what is being asked: its similarity to the request must reach this
 * (lexical v1: unrelated questions measure about 0.3 against a conversation, related ones 0.55 and above). Notes the
 * Ask learned keep their own rule (the best few, whatever the score).
 */
export const TALK_MIN_SIMILARITY = 0.45

/** A swarm conversation's truth as a note: it happened (frequency 1), modestly weighted against what the Ask learned. */
export const TALK_TRUTH: Truth = { frequency: 1, confidence: 0.5 }
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
/** A conversation's words as the model reads them. */
export const talkNote = (t: Pick<Talk, 'words' | 'answer'>): string => `conversation: you asked “${clip(t.words, 160)}”; the answer was “${clip(t.answer, 240)}”`

export function attention(b: Pick<Belief, 'truth' | 'uses' | 'last_used_at' | 'updated_at'>, now: number): number {
  const since = b.last_used_at ?? b.updated_at
  const age = Math.max(0, now - since) / DAY
  const recency = 0.5 ** (age / HALF_LIFE_DAYS)
  const use = (1 + b.uses) / (2 + b.uses)
  return b.truth.confidence * recency * use
}

const bytes = (s: string) => new TextEncoder().encode(s).length

export interface Recalled {
  notes: Note[]
  /** the beliefs sent, best first */
  ids: string[]
}

/** What forgetting says about the talks: the forget markers (with this database's salt) and the forget-everything time. */
export interface Forgets {
  tombs: readonly Tombstone[]
  salt: string | null
  /** when everything was last forgotten (0: never) */
  genAt: number
}

export interface RecallOpts {
  now: number
  embedder?: Embedder
  /** a cached vector for a source's text (by id), when the caller keeps them */
  vectors?: (id: string, text: string) => Float32Array
  maxItems?: number
  maxBytes?: number
  /** r2: the person's swarm conversations, a second source */
  talks?: readonly Talk[]
  /** r2: required with talks; without it no talk is sent (a talk is never sent unchecked) */
  forgets?: Forgets
}

/** One thing that may be sent as a note. */
interface Source {
  /** a conversation must be about the request (TALK_MIN_SIMILARITY) */
  talk?: true
  id: string
  text: string
  vecText: string
  truth: Truth
  uses: number
  last_used_at: number | null
  updated_at: number
}

/** Whether a conversation may be sent at all (R2/R3/R4 and the private-app fence). */
export function talkSendable(t: Talk, f: Forgets | undefined): boolean {
  if (!f || namesPrivate(t.words) || namesPrivate(t.answer)) return false
  if (f.genAt >= t.at) return false
  if (f.salt !== null && (forgottenSince(f.tombs, f.salt, t.words, t.at) || forgottenSince(f.tombs, f.salt, t.answer, t.at))) return false
  if (f.tombs.some((x) => x.id === t.id)) return false
  return true
}

/** The recall seam: today this local ranking; later the MeTTa memory core's mindSpace.recall, behind the same shape. */
export interface Recaller {
  recall(beliefs: readonly Belief[], request: string, opts: RecallOpts): Recalled
}

export function recall(beliefs: readonly Belief[], request: string, opts: RecallOpts): Recalled {
  const emb = opts.embedder ?? lexicalEmbedder
  const q = emb.embed(request)
  const vec = opts.vectors ?? ((_id: string, text: string) => emb.embed(text))
  const sources: Source[] = [
    ...beliefs.filter((b) => b.truth.frequency >= 0.5 && !namesPrivate(b.statement)).map((b) => ({ id: b.id, text: noteText(b), vecText: b.statement, truth: b.truth, uses: b.uses, last_used_at: b.last_used_at, updated_at: b.updated_at })),
    ...(opts.talks ?? [])
      .filter((t) => talkSendable(t, opts.forgets))
      .map((t) => ({ talk: true as const, id: t.id, text: talkNote(t), vecText: `${t.words}\n${t.answer}`, truth: TALK_TRUTH, uses: t.uses ?? 0, last_used_at: t.last_used_at ?? null, updated_at: t.at })),
  ]
  const ranked = sources
    .map((b) => ({ b, sim: Math.max(0, cosine(q, vec(b.id, b.vecText))) }))
    .filter(({ b, sim }) => !b.talk || sim >= TALK_MIN_SIMILARITY)
    .map(({ b, sim }) => ({ b, score: W_SIMILARITY * sim + W_ATTENTION * attention(b, opts.now) }))
    .sort((x, y) => y.score - x.score || y.b.updated_at - x.b.updated_at || (x.b.id < y.b.id ? -1 : 1))
  const notes: Note[] = []
  let size = 0
  const maxItems = Math.min(opts.maxItems ?? NOTES_MAX, NOTES_MAX)
  const maxBytes = Math.min(opts.maxBytes ?? NOTES_MAX_BYTES, NOTES_MAX_BYTES)
  for (const { b } of ranked) {
    if (notes.length >= maxItems) break
    const text = b.text
    const n = bytes(b.id) + bytes(text)
    if (size + n > maxBytes) continue
    size += n
    notes.push({ id: b.id, text })
  }
  return { notes, ids: notes.map((n) => n.id) }
}

/** This browser's own recall (the default Recaller). */
export const localRecaller: Recaller = { recall }
