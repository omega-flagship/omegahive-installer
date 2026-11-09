/**
 * Memory durability M1 (Jon, 2026-10-08: "We need to ensure the local browser version doesn't loose its memory when
 * cache is cleared"): the person's own copy of what their mind remembers, as one versioned JSON file they download,
 * and restore from. Nothing here makes a request: the file goes from this browser to the person's disk and back.
 *
 * The file carries no plaintext principal. It names its person by `person_hash`, a SHA-256 of the hive and principal
 * salted with the database's own salt (lib/askMemory/hash); the salt travels in the file so the person's own browser
 * (even after its site data was cleared, so with a new salt) can check the file is theirs, and so the forgotten-words
 * fingerprints in its tombstones stay checkable. A restore MERGES through the store's rules, never overwrites:
 * - forgetting wins: an entry forgotten here (by id, or its words, at or after it was last changed) or forgotten
 *   everything here since it was last changed is not brought back; the file's own forgets (tombstones, and its forget
 *   everything) are applied here to what they name;
 * - a newer copy wins: an entry already here is replaced only by a strictly newer one (its use count is the larger);
 * - the same words already known under another id are not added twice.
 * The plan is pure (planRestore) and runs twice: once for the preview, and again inside the one storage transaction
 * that writes it (backend `restore`), against what storage holds then.
 */
import { namesPrivate } from './beliefs'
import { normalise } from './embed'
import { sha256, wordsHash } from './hash'
import type { Tombstone } from './backend'
import { MEMORY_KINDS, NOTE_ID, STATEMENT_MAX, TALK_TEXT_MAX, type Belief, type Talk } from './types'

export const FILE_FORMAT = 'omegahive-mind-memory'
export const FILE_VERSION = 1
/** A file larger than this is not read (a person's browser memory is far smaller). */
export const FILE_MAX_BYTES = 8 * 1024 * 1024
export const FILE_MAX_ENTRIES = 20_000

export type FileEntry = ({ type: 'belief' } & Belief) | ({ type: 'talk' } & Talk)

export interface MemoryFile {
  format: typeof FILE_FORMAT
  version: typeof FILE_VERSION
  /** the hive as the page reached it (lib/askMemory hiveKey: mode and origin) */
  hive: string
  /** sha256(person, hive, salt): whose memory this is, without saying who */
  person_hash: string
  exported_at: string
  /** the forget-everything generation of the database it came from (that database's own count) */
  generation: number
  /** when that database last forgot everything (epoch ms; 0: never) */
  forgot_all_at: number
  /** that database's fingerprint salt: person_hash and every tombstone's word fingerprints are made with it */
  salt: string
  entries: FileEntry[]
  tombstones: Tombstone[]
}

/** Whose memory: the hive and principal, salted (domain-separated from the words fingerprints). */
export const personHash = (salt: string, hive: string, principal: string): string => sha256(`ask-memory-person:v1\n${salt}\n${hive}\n${principal}`)

export interface FileSource {
  beliefs: Belief[]
  talks: Talk[]
  tombs: Tombstone[]
  gen: number
  gen_at: number
  salt: string
}

/** The file for this person's memory as storage holds it now. */
export function buildFile(src: FileSource, owner: { principal: string; hive: string }, now: number): MemoryFile {
  return {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    hive: owner.hive,
    person_hash: personHash(src.salt, owner.hive, owner.principal),
    exported_at: new Date(now).toISOString(),
    generation: src.gen,
    forgot_all_at: src.gen_at,
    salt: src.salt,
    entries: [...src.beliefs.map((b) => ({ type: 'belief' as const, ...b })), ...src.talks.map((t) => ({ type: 'talk' as const, ...t }))],
    // a tombstone restored from another file keeps that file's salt; it is written out with it
    tombstones: src.tombs.map((t) => ({ ...t })),
  }
}

/** Why a file is not restored, said plainly to the person. */
export type FileProblem = 'unreadable' | 'not_memory' | 'newer_version' | 'damaged' | 'someone_else' | 'too_large'
export const FILE_PROBLEM_WORDS: Record<FileProblem, string> = {
  unreadable: 'That file could not be read. Nothing was restored.',
  not_memory: 'That file is not a saved copy of your mind’s memory. Nothing was restored.',
  newer_version: 'That file was saved by a newer version of the hive than this page understands. Nothing was restored.',
  damaged: 'That file is damaged: some of it is missing or not in the right shape. Nothing was restored.',
  someone_else: 'That file belongs to someone else, or to another hive. Only your own memory can be restored here. Nothing was restored.',
  too_large: 'That file is too large to be a saved copy of your mind’s memory. Nothing was restored.',
}

const HEX64 = /^[0-9a-f]{64}$/
const HEX = /^[0-9a-f]{16,128}$/
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const unit = (v: unknown) => num(v) && v >= 0 && v <= 1
const text = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0)
const optId = (v: unknown) => v === null || (typeof v === 'string' && v.length <= 128)

function readBelief(r: Record<string, unknown>): Belief | null {
  const t = r.truth
  if (typeof r.id !== 'string' || !NOTE_ID.test(r.id) || !MEMORY_KINDS.includes(r.kind as Belief['kind']) || !text(r.statement, STATEMENT_MAX)) return null
  if (!isObj(t) || !unit(t.frequency) || !unit(t.confidence)) return null
  if (!num(r.uses) || r.uses < 0 || !num(r.created_at) || !num(r.updated_at) || !(r.last_used_at === null || num(r.last_used_at)) || !optId(r.source_turn)) return null
  return {
    id: r.id,
    kind: r.kind as Belief['kind'],
    statement: r.statement,
    truth: { frequency: t.frequency as number, confidence: t.confidence as number },
    uses: Math.floor(r.uses),
    last_used_at: r.last_used_at as number | null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    source_turn: r.source_turn as string | null,
  }
}

function readTalk(r: Record<string, unknown>): Talk | null {
  if (typeof r.id !== 'string' || !NOTE_ID.test(r.id) || typeof r.turn_id !== 'string' || r.turn_id.length > 128) return null
  if (!num(r.at) || !num(r.kept_at) || !text(r.words, TALK_TEXT_MAX, true) || !text(r.answer, TALK_TEXT_MAX, true) || typeof r.truncated !== 'boolean') return null
  if ((r.uses !== undefined && (!num(r.uses) || r.uses < 0)) || (r.last_used_at !== undefined && r.last_used_at !== null && !num(r.last_used_at))) return null
  return { id: r.id, turn_id: r.turn_id, at: r.at, words: r.words, answer: r.answer, truncated: r.truncated, kept_at: r.kept_at, ...(r.uses !== undefined ? { uses: Math.floor(r.uses as number), last_used_at: (r.last_used_at as number | null | undefined) ?? null } : {}) }
}

function readTomb(r: unknown): Tombstone | null {
  if (!isObj(r) || typeof r.id !== 'string' || !NOTE_ID.test(r.id) || !num(r.at)) return null
  if (r.words !== undefined && (!Array.isArray(r.words) || r.words.length > 64 || !r.words.every((w) => typeof w === 'string' && HEX64.test(w)))) return null
  if (r.salt !== undefined && (typeof r.salt !== 'string' || !HEX.test(r.salt))) return null
  if (r.more !== undefined) {
    if (!Array.isArray(r.more) || r.more.length > 16) return null
    for (const g of r.more) if (!isObj(g) || typeof g.salt !== 'string' || !HEX.test(g.salt) || !Array.isArray(g.words) || g.words.length > 64 || !g.words.every((w) => typeof w === 'string' && HEX64.test(w))) return null
  }
  const more = (r.more as { salt: string; words: string[] }[] | undefined)?.map((g) => ({ salt: g.salt, words: [...g.words] }))
  return { id: r.id, at: r.at, ...(r.words ? { words: [...(r.words as string[])] } : {}), ...(r.salt ? { salt: r.salt as string } : {}), ...(more?.length ? { more } : {}) }
}

/**
 * Read a file the person chose, for this person on this hive. Anything not exactly in shape is refused whole (never
 * half-restored), as is another person's file (or one from another hive).
 */
export function readFile(raw: string, owner: { principal: string; hive: string }): { ok: true; file: MemoryFile } | { ok: false; problem: FileProblem } {
  if (raw.length > FILE_MAX_BYTES) return { ok: false, problem: 'too_large' }
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return { ok: false, problem: 'unreadable' }
  }
  if (!isObj(v) || v.format !== FILE_FORMAT) return { ok: false, problem: 'not_memory' }
  if (!num(v.version) || !Number.isInteger(v.version) || v.version < 1) return { ok: false, problem: 'damaged' }
  if (v.version > FILE_VERSION) return { ok: false, problem: 'newer_version' }
  if (typeof v.hive !== 'string' || typeof v.person_hash !== 'string' || !HEX64.test(v.person_hash) || typeof v.salt !== 'string' || !HEX.test(v.salt)) return { ok: false, problem: 'damaged' }
  if (typeof v.exported_at !== 'string' || !Number.isFinite(Date.parse(v.exported_at)) || !num(v.generation) || v.generation < 0 || !num(v.forgot_all_at) || v.forgot_all_at < 0) return { ok: false, problem: 'damaged' }
  if (!Array.isArray(v.entries) || !Array.isArray(v.tombstones) || v.entries.length + v.tombstones.length > FILE_MAX_ENTRIES) return { ok: false, problem: v.entries && Array.isArray(v.entries) ? 'too_large' : 'damaged' }
  // whose: checked before anything in it is read further
  if (v.hive !== owner.hive || personHash(v.salt, owner.hive, owner.principal) !== v.person_hash) return { ok: false, problem: 'someone_else' }
  const entries: FileEntry[] = []
  const seen = new Set<string>()
  for (const e of v.entries) {
    if (!isObj(e)) return { ok: false, problem: 'damaged' }
    const one = e.type === 'belief' ? readBelief(e) : e.type === 'talk' ? readTalk(e) : null
    if (!one || seen.has(`${e.type}:${one.id}`)) return { ok: false, problem: 'damaged' }
    seen.add(`${e.type}:${one.id}`)
    entries.push(e.type === 'belief' ? { type: 'belief', ...(one as Belief) } : { type: 'talk', ...(one as Talk) })
  }
  const tombstones: Tombstone[] = []
  for (const t of v.tombstones) {
    const one = readTomb(t)
    if (!one) return { ok: false, problem: 'damaged' }
    tombstones.push(one)
  }
  return {
    ok: true,
    file: { format: FILE_FORMAT, version: FILE_VERSION, hive: v.hive, person_hash: v.person_hash, exported_at: v.exported_at, generation: v.generation, forgot_all_at: v.forgot_all_at, salt: v.salt, entries, tombstones },
  }
}

/** What a restore would do (or did), counted for the preview. */
export interface RestorePlan {
  /** new here */
  add: Belief[]
  /** here already, and the file's copy is newer */
  update: Belief[]
  addTalks: Talk[]
  /** here, and the file says it was forgotten (or everything was) after it last changed: forgotten here too */
  forgetBeliefs: { id: string; at: number }[]
  forgetTalks: { id: string; at: number }[]
  /** the file's tombstones that add a protection here, already merged (union) with this database's for the same id */
  tombs: Tombstone[]
  /** the file's forget everything, newer than this database's: kept here as its own watermark (null: none newer) */
  watermark: number | null
  skipped: { forgotten: number; known: number; older: number; private: number }
}

export interface RestoreLocal {
  beliefs: Belief[]
  talks: Talk[]
  tombs: Tombstone[]
  salt: string
  /** when this database last forgot everything (0: never) */
  gen_at: number
}

/** Were these words forgotten here at or after `since`? Each tombstone's fingerprints are checked with its own salt. */
export function forgottenSince(tombs: readonly Tombstone[], salt: string, statement: string, since: number): boolean {
  const memo = new Map<string, string>()
  const h = (s: string) => memo.get(s) ?? (memo.set(s, wordsHash(s, statement)), memo.get(s)!)
  return tombs.some((t) => t.at >= since && groupsOf(t, salt).some((g) => g.words.includes(h(g.salt))))
}

/** A tombstone's fingerprints as groups, each with the salt it was made with (`dbSalt` for its own unsalted words). */
export function groupsOf(t: Tombstone, dbSalt: string): { salt: string; words: string[] }[] {
  return [{ salt: t.salt ?? dbSalt, words: t.words ?? [] }, ...(t.more ?? [])].filter((g) => g.words.length)
}

/**
 * Two tombstones for the same id, merged as a union (r1.1 P1): the latest `at`, and every fingerprint of both, each
 * kept with its own salt. The result's own `words` are this database's (salt `dbSalt`); other salts go in `more`.
 */
export function mergeTombs(a: Tombstone, b: Tombstone, dbSalt: string, bSalt = dbSalt): Tombstone {
  const by = new Map<string, Set<string>>()
  const add = (salt: string, words: readonly string[]) => {
    const set = by.get(salt) ?? by.set(salt, new Set()).get(salt)!
    for (const w of words) set.add(w)
  }
  for (const g of groupsOf(a, dbSalt)) add(g.salt, g.words)
  for (const g of groupsOf(b, bSalt)) add(g.salt, g.words)
  const own = [...(by.get(dbSalt) ?? [])].sort()
  const more = [...by.entries()].filter(([salt, w]) => salt !== dbSalt && w.size).map(([salt, w]) => ({ salt, words: [...w].sort() })).sort((x, y) => (x.salt < y.salt ? -1 : 1))
  return { id: a.id, at: Math.max(a.at, b.at), ...(own.length ? { words: own } : {}), ...(more.length ? { more } : {}) }
}

/** Whether `merged` protects anything `was` did not (a later time, or a fingerprint it lacked). */
function adds(was: Tombstone | undefined, merged: Tombstone, dbSalt: string): boolean {
  if (!was) return true
  if (merged.at > was.at) return true
  const have = new Set(groupsOf(was, dbSalt).flatMap((g) => g.words.map((w) => `${g.salt}:${w}`)))
  return groupsOf(merged, dbSalt).some((g) => g.words.some((w) => !have.has(`${g.salt}:${w}`)))
}

/** The merge, pure: the same inputs give the same plan (the preview and the transaction run it alike). */
export function planRestore(local: RestoreLocal, file: MemoryFile): RestorePlan {
  const plan: RestorePlan = { add: [], update: [], addTalks: [], forgetBeliefs: [], forgetTalks: [], tombs: [], watermark: file.forgot_all_at > local.gen_at ? file.forgot_all_at : null, skipped: { forgotten: 0, known: 0, older: 0, private: 0 } }
  const localTomb = new Map(local.tombs.map((t) => [t.id, t]))
  const fileTomb = new Map(file.tombstones.map((t) => [t.id, t]))
  // 1. the file's forgets, applied here to what they name (forgetting is authoritative)
  for (const t of file.tombstones) {
    // merged as a union with this database's own tombstone for the id, if any: its fingerprints keep their salts
    const was = localTomb.get(t.id)
    const merged = mergeTombs(was ?? { id: t.id, at: t.at }, t, local.salt, file.salt)
    if (adds(was, merged, local.salt)) plan.tombs.push(merged)
  }
  const fileForgets = (id: string, statement: string | null, changed: number): number | null => {
    const byId = fileTomb.get(id)
    if (byId && byId.at >= changed) return byId.at
    if (statement !== null) {
      const byWords = file.tombstones.find((t) => t.at >= changed && forgottenSince([t], file.salt, statement, changed))
      if (byWords) return byWords.at
    }
    if (file.forgot_all_at > local.gen_at && file.forgot_all_at >= changed) return file.forgot_all_at
    return null
  }
  const gone = new Set<string>()
  for (const b of local.beliefs) {
    const at = fileForgets(b.id, b.statement, b.updated_at)
    if (at !== null) {
      plan.forgetBeliefs.push({ id: b.id, at })
      gone.add(b.id)
    }
  }
  // a talk is forgotten by its id, or by its question's or its answer's words (Kimi r1 P1)
  const fileForgetsTalk = (t: Talk): number | null => fileForgets(t.id, t.words, t.at) ?? fileForgets(t.id, t.answer, t.at)
  for (const t of local.talks) {
    const at = fileForgetsTalk(t)
    if (at !== null) plan.forgetTalks.push({ id: t.id, at })
  }
  // 2. the file's entries, through this database's rules
  const here = new Map(local.beliefs.filter((b) => !gone.has(b.id)).map((b) => [b.id, b]))
  const known = new Set([...here.values()].map((b) => normalise(b.statement)))
  const talksHere = new Set(local.talks.map((t) => t.id))
  const forgottenHere = (id: string, changed: number, statement: string | null) =>
    localTomb.has(id) || local.gen_at >= changed || (statement !== null && forgottenSince(local.tombs, local.salt, statement, changed))
  for (const e of file.entries) {
    if (e.type === 'talk') {
      const { type: _t, ...talk } = e
      void _t
      if (fileForgetsTalk(talk) !== null || forgottenHere(talk.id, talk.at, talk.words) || forgottenHere(talk.id, talk.at, talk.answer)) plan.skipped.forgotten++
      else if (namesPrivate(talk.words) || namesPrivate(talk.answer)) plan.skipped.private++
      else if (talksHere.has(talk.id)) plan.skipped.known++
      else {
        plan.addTalks.push(talk)
        talksHere.add(talk.id)
      }
      continue
    }
    const { type: _t, ...b } = e
    void _t
    if (fileForgets(b.id, b.statement, b.updated_at) !== null || forgottenHere(b.id, b.updated_at, b.statement)) {
      plan.skipped.forgotten++
      continue
    }
    if (namesPrivate(b.statement)) {
      plan.skipped.private++
      continue
    }
    const mine = here.get(b.id)
    if (mine) {
      if (b.updated_at > mine.updated_at) {
        plan.update.push({ ...b, uses: Math.max(mine.uses, b.uses), last_used_at: Math.max(mine.last_used_at ?? 0, b.last_used_at ?? 0) || null })
      } else plan.skipped.older++
      continue
    }
    if (known.has(normalise(b.statement))) {
      plan.skipped.known++
      continue
    }
    plan.add.push(b)
    known.add(normalise(b.statement))
  }
  return plan
}

/** Nothing would change. */
export const planEmpty = (p: RestorePlan): boolean => !p.add.length && !p.update.length && !p.addTalks.length && !p.forgetBeliefs.length && !p.forgetTalks.length && !p.tombs.length && p.watermark === null

/** The preview, in plain words (one line each; empty lines left out). */
export function planWords(p: RestorePlan): string[] {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  const out: string[] = []
  if (p.add.length) out.push(`${n(p.add.length, 'note', 'notes')} added`)
  if (p.update.length) out.push(`${n(p.update.length, 'note', 'notes')} updated to the file’s newer copy`)
  if (p.addTalks.length) out.push(`${n(p.addTalks.length, 'swarm conversation', 'swarm conversations')} added`)
  const forgets = p.forgetBeliefs.length + p.forgetTalks.length
  if (forgets) out.push(`${n(forgets, 'thing', 'things')} forgotten here, because you forgot ${forgets === 1 ? 'it' : 'them'} on the copy the file came from`)
  if (p.tombs.length) out.push(`${n(p.tombs.length, 'forget marker', 'forget markers')} kept here, so what you forgot there can’t come back`)
  if (p.watermark !== null) out.push(`your “forget everything” of ${new Date(p.watermark).toLocaleDateString()} kept here too: nothing from before it is kept again`)
  const s = p.skipped
  if (s.forgotten) out.push(`${n(s.forgotten, 'thing', 'things')} left out: you forgot ${s.forgotten === 1 ? 'it' : 'them'} since`)
  if (s.known + s.older) out.push(`${n(s.known + s.older, 'thing', 'things')} already here`)
  if (s.private) out.push(`${n(s.private, 'thing', 'things')} left out: ${s.private === 1 ? 'it names' : 'they name'} a private app`)
  return out
}
