/**
 * Where beliefs and the journal live: IndexedDB in the browser (one database per person per hive), or memory in tests.
 * Nothing here is ever sent anywhere.
 *
 * Forgetting is authoritative across tabs (stand-in r1 P1). Every change is ONE commit, applied as a read-check-write
 * inside ONE transaction, by the same `apply` for both backends:
 * - forgetting one belief deletes it, blanks its words in every stored journal line, and leaves a tombstone for its id;
 * - forgetting everything clears beliefs, journal and tombstones and raises the generation;
 * - every other write (a learned belief, an edit, a use, a journal line) carries the generation and, for a belief, the
 *   `updated_at` it was made from; it is REFUSED when the generation is older than the stored one, the id has a
 *   tombstone, the belief it was made from is gone, or the stored copy is newer. A refused commit writes nothing
 *   (a use of several notes counts the ones still stored, and reports the rest as refused, so the tab reads again).
 * - a use touches only `uses` and `last_used_at` of the stored copy, never the rest of a tab's cached belief.
 *
 * Forgotten words stay forgotten (stand-in r2 P1). A tombstone also keeps SHA-256 fingerprints of the words the belief
 * was ever kept under (lib/askMemory/hash, normalised as the merge compares them; never the words themselves). A learned
 * belief carries when its turn began (`turn_at`) and the generation it began under (`gen`): it is refused when a
 * tombstone made at or after that time has its words, or when everything was forgotten since. A refusal says why, so a
 * tab retries only a write that lost to another tab's newer edit, and never one refused by a forget.
 *
 * r3b: the fingerprints are salted with a random salt made once per database and kept in `meta` (never sent, never
 * logged), so the same words give different fingerprints in different databases. Forget everything also keeps WHEN
 * (`meta` gen `at`, this browser's clock): a turn timed by the host (`by_time`: rejoined after a reload, so this page
 * holds no mark of its own) is refused when it began at or before the latest forget everything.
 *
 * Personal mind (r1): `talks` holds the person's swarm conversations collected from the hive's held copies (types
 * Talk). A collect is one commit; it reports which held copies are SETTLED (written in this transaction, here
 * already, or deliberately not kept because they were forgotten): only those are acknowledged to the hive, and only
 * after the transaction completed. Forgetting one leaves a tombstone for its id, so a copy delivered again is never
 * kept. Forget everything clears them too. A restore from the person's own file (lib/askMemory/file) is one commit,
 * planned inside the transaction against what storage holds then; a tombstone it brings keeps the file's salt.
 */
import { newSalt, wordsHash } from './hash'
import { namesPrivate } from './beliefs'
import { forgottenSince, mergeTombs, planRestore, type MemoryFile, type RestorePlan } from './file'
import { TALK_TEXT_MAX, type Belief, type Talk, type TraceEntry } from './types'

/** Local storage data, not a frame-wire reply. P8 derives host-only review snapshots from it;
 * a snapshot itself grants no currentness authority, so each operation still needs its live host guard. */
export interface Snapshot {
  beliefs: Belief[]
  trace: TraceEntry[]
  /** the forget-everything generation: raised by each forget everything */
  gen: number
  /** when the latest forget everything was (this browser's clock; 0: never) */
  gen_at: number
  /** this database's fingerprint salt (lib/askMemory/hash): never sent, never logged */
  salt: string
  /** each forgotten belief's tombstone (fingerprints only), so a tab refuses forgotten words before drawing them */
  tombs: Tombstone[]
  /** the person's swarm conversations, collected from the hive's held copies */
  talks: Talk[]
  /**
   * r2.3: the person's own setting "Use my swarm talk in answers" (kept in their memory's `meta`). True only when
   * stored as exactly on; missing, unreadable or anything else is off.
   */
  talk_recall: boolean
}

export type Commit =
  /**
   * a belief learned or edited: `base` is the stored `updated_at` it was made from (null: a new belief); a learned one
   * also carries `turn_at`, when its turn began (an edit is the person's own words now, and carries none), and
   * `by_time` when that start is the host's (a rejoined turn): then a forget everything at or after it refuses it too
   */
  | { op: 'put'; gen: number; belief: Belief; base: number | null; base_statement?: string; trace: TraceEntry[]; turn_at?: number; by_time?: boolean }
  /** the turn carrying these notes was admitted: each stored one was used once more, at `at` */
  | { op: 'use'; gen: number; ids: string[]; at: number }
  /**
   * forget one: delete, tombstone, blank its words in the stored journal; `trace` (the forget line) only if current;
   * `said`: the words this tab knew it by (the stored belief's and journal's are added). They are fingerprinted with
   * the stored salt inside the transaction; only the fingerprints are written (this commit itself is never stored)
   */
  | { op: 'forget'; gen: number; id: string; at: number; trace: TraceEntry[]; said: string[]; base?: number; base_statement?: string }
  /** forget everything at `at`: the new generation is at least `gen`; `trace` is the one line that says so */
  | { op: 'forget_all'; gen: number; at: number; trace: TraceEntry[] }
  /** journal lines only (a lost memory) */
  | { op: 'note'; gen: number; trace: TraceEntry[] }
  /** held swarm conversations collected from the hive: each is kept unless forgotten (or here already) */
  | { op: 'talks'; talks: Talk[] }
  /**
   * forget one swarm conversation: delete it and leave a tombstone for its id AND its words (the question and the
   * answer, fingerprinted with the stored salt as for a belief), so a copy delivered again under another id stays
   * forgotten (Kimi r1 P1)
   */
  | { op: 'forget_talk'; id: string; at: number; said?: string[] }
  /** merge the person's own file (planned inside the transaction); `trace` is the one line that says so */
  | { op: 'restore'; file: MemoryFile; trace: TraceEntry[] }
  /** r2.3: the person's "Use my swarm talk in answers" setting */
  | { op: 'setting'; talk_recall: boolean }

/**
 * Why a commit was refused: `gen` everything was forgotten since; `tomb` it (or its words) was forgotten; `gone` the
 * belief it was made from is no longer stored; `newer` the stored copy changed since (another tab's edit or learning).
 */
export type Refusal = 'gen' | 'tomb' | 'gone' | 'newer'

export interface Applied {
  /** false: refused (stale generation, a tombstone, gone, or newer in storage): this tab's view is stale */
  ok: boolean
  /** the stored generation after this commit */
  gen: number
  /** why it was refused (ok false) */
  why?: Refusal
  /** talks: the held copies settled by this commit (safe to acknowledge to the hive once it completed) */
  settled?: string[]
  /** restore: what it did */
  plan?: RestorePlan
}

export interface MemoryBackend {
  /**
   * r1.1 P1: whether a completed commit survives this page closing. Only IndexedDB is; memory (tests, or a browser
   * that refuses IndexedDB) is not, so nothing kept there may ever let the hive delete its copy. Absent: not durable.
   */
  readonly durable?: boolean
  load(): Promise<Snapshot>
  commit(c: Commit, guard?: MemoryCommitGuard): Promise<Applied>
  close(): void
}

/** Host-only P8 action fence. It is never serialized or accepted from an app frame. */
export interface MemoryCommitGuard {
  current(): boolean
  signal: AbortSignal
}
export class MemoryCommitCancelled extends Error {
  constructor() { super('The host memory review is no longer current.') }
}
const checkGuard = (guard?: MemoryCommitGuard) => {
  if (guard && (guard.signal.aborted || !guard.current())) throw new MemoryCommitCancelled()
}
/** Check in the same synchronous turn as every storage mutation, after intervening reads. */
function guardedTx(tx: Tx, guard?: MemoryCommitGuard): Tx {
  if (!guard) return tx
  const writes = new Set(['setGen', 'setTalkRecall', 'putBelief', 'delBelief', 'putTomb', 'putTrace', 'putTalk', 'delTalk', 'clear'])
  return new Proxy(tx, { get(target, key) {
    const value = Reflect.get(target, key)
    return typeof key === 'string' && writes.has(key)
      ? (...args: unknown[]) => { checkGuard(guard); return Reflect.apply(value, target, args) }
      : value
  } })
}

export interface Tombstone {
  id: string
  at: number
  /** salted fingerprints of the words it was kept under (lib/askMemory/hash `wordsHash`); absent on a v2 tombstone */
  words?: string[]
  /** the salt its fingerprints were made with, when not this database's own (a tombstone restored from a file) */
  salt?: string
  /**
   * r1.1: more fingerprints of the same forgotten thing, each group with the salt it was made with (merged in from
   * another copy's tombstone for the same id). Tombstones are only ever merged as a union: the latest `at`, every
   * fingerprint kept; no protection is ever dropped.
   */
  more?: { salt: string; words: string[] }[]
}

const byTime = (a: TraceEntry, b: TraceEntry) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** One transaction's view of the stores (all of it inside one transaction). */
interface Tx {
  gen(): Promise<number>
  /** when the latest forget everything was (0: never) */
  genAt(): Promise<number>
  setGen(n: number, at: number): void
  /** this database's salt, made (once, in this transaction) if there is none yet */
  salt(): Promise<string>
  belief(id: string): Promise<Belief | undefined>
  tomb(id: string): Promise<boolean>
  tombOf(id: string): Promise<Tombstone | undefined>
  tombs(): Promise<Tombstone[]>
  trace(): Promise<TraceEntry[]>
  beliefs(): Promise<Belief[]>
  talks(): Promise<Talk[]>
  setTalkRecall(on: boolean): void
  talk(id: string): Promise<Talk | undefined>
  putBelief(b: Belief): void
  delBelief(id: string): void
  putTomb(t: Tombstone): void
  putTrace(t: TraceEntry): void
  putTalk(t: Talk): void
  delTalk(id: string): void
  clear(): void
}

/**
 * Were these words forgotten at or after `since` (when the turn that said them began)? Words forgotten before a turn
 * began may be said again in it: that is new evidence, and is learned.
 */
export function forgotten(tombs: readonly Tombstone[], salt: string, statement: string, since: number): boolean {
  // each tombstone's fingerprints with the salt they were made with (this database's, unless restored from a file)
  return forgottenSince(tombs, salt, statement, since)
}

/** A held copy as this browser keeps it, if it is one (the hive's shape, re-checked; nothing past its caps). */
export function talkOk(t: Talk): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(t.id) && typeof t.turn_id === 'string' && t.turn_id.length <= 128 && Number.isFinite(t.at) && typeof t.words === 'string' && typeof t.answer === 'string' && t.words.length <= TALK_TEXT_MAX && t.answer.length <= TALK_TEXT_MAX
}

/** Forget one belief inside a transaction: delete it, tombstone it with its words' fingerprints, blank its journal words. */
async function forgetIn(tx: Tx, id: string, at: number, said: string[]): Promise<void> {
  const was = await tx.belief(id)
  const lines = (await tx.trace()).filter((t) => t.belief_id === id && t.summary)
  const salt = await tx.salt()
  const words = new Set(said.map((w) => wordsHash(salt, w)))
  if (was) words.add(wordsHash(salt, was.statement))
  for (const t of lines) words.add(wordsHash(salt, t.summary))
  tx.delBelief(id)
  await putTombMerged(tx, { id, at, words: [...words] }, salt)
  for (const t of lines) tx.putTrace({ ...t, summary: '' })
}

/** Forget one talk inside a transaction: delete it; tombstone its id with the fingerprints of its question and answer. */
async function forgetTalkIn(tx: Tx, id: string, at: number, said: string[]): Promise<void> {
  const was = await tx.talk(id)
  const salt = await tx.salt()
  const words = new Set([...said, ...(was ? [was.words, was.answer] : [])].filter((w) => w.trim()).map((w) => wordsHash(salt, w)))
  tx.delTalk(id)
  await putTombMerged(tx, { id, at, ...(words.size ? { words: [...words] } : {}) }, salt)
}

/** Write a tombstone merged (as a union) with any already stored for its id: never a protection dropped (r1.1 P1). */
async function putTombMerged(tx: Tx, t: Tombstone, salt?: string): Promise<void> {
  const dbSalt = salt ?? (await tx.salt())
  const was = await tx.tombOf(t.id)
  tx.putTomb(was ? mergeTombs(was, t, dbSalt) : mergeTombs({ id: t.id, at: t.at }, t, dbSalt))
}

/** The read-check-write of one commit (shared by both backends, so the in-memory tests exercise the real rules). */
async function apply(tx: Tx, c: Commit): Promise<Applied> {
  const gen = await tx.gen()
  if (c.op === 'forget_all') {
    const next = Math.max(gen + 1, c.gen)
    tx.clear()
    tx.setGen(next, Math.max(c.at, await tx.genAt()))
    for (const t of c.trace) tx.putTrace(t)
    return { ok: true, gen: next }
  }
  if (c.op === 'forget') {
    // P8 binds a host confirm to the words it showed; ordinary authoritative forgets retain their old contract.
    if (c.base !== undefined) {
      if (c.gen < gen) return { ok: false, gen, why: 'gen' }
      const current = await tx.belief(c.id)
      if (!current) return { ok: false, gen, why: 'gone' }
      if (current.updated_at !== c.base || c.base_statement !== undefined && current.statement !== c.base_statement) return { ok: false, gen, why: 'newer' }
    }
    // deletion is never refused: whatever the tab's generation, the id is gone and stays gone, and so are its words
    await forgetIn(tx, c.id, c.at, c.said)
    if (c.gen >= gen) for (const t of c.trace) tx.putTrace(t)
    return { ok: true, gen }
  }
  if (c.op === 'setting') {
    tx.setTalkRecall(c.talk_recall === true)
    return { ok: true, gen }
  }
  if (c.op === 'forget_talk') {
    await forgetTalkIn(tx, c.id, c.at, c.said ?? [])
    return { ok: true, gen }
  }
  if (c.op === 'talks') {
    // each held copy: forgotten (its id has a tombstone, or everything was forgotten since it was held) is settled
    // and not kept; here already is settled; anything else is written now. All in this one transaction.
    const genAt = await tx.genAt()
    const settled: string[] = []
    for (const t of c.talks) {
      if (!talkOk(t)) continue
      // forgotten: its id, or its words (a copy delivered again under another id), or everything since it was held
      const tombs = await tx.tombs()
      const salt = await tx.salt()
      const forgot = (await tx.tomb(t.id)) || forgotten(tombs, salt, t.words, t.at) || forgotten(tombs, salt, t.answer, t.at)
      if (forgot || genAt >= t.at || namesPrivate(t.words) || namesPrivate(t.answer)) {
        settled.push(t.id)
        continue
      }
      if (!(await tx.talk(t.id))) tx.putTalk(t)
      settled.push(t.id)
    }
    return { ok: true, gen, settled }
  }
  if (c.op === 'restore') {
    const salt = await tx.salt()
    const genAt = await tx.genAt()
    const plan = planRestore({ beliefs: await tx.beliefs(), talks: await tx.talks(), tombs: await tx.tombs(), salt, gen_at: genAt }, c.file)
    // the file's forget everything, kept as this database's own watermark (r1.1 P1): the generation advances, so
    // nothing learned, collected or recalled from before it is ever kept again; written in this same transaction
    let next = gen
    if (plan.watermark !== null) {
      next = gen + 1
      tx.setGen(next, Math.max(genAt, plan.watermark))
    }
    for (const f of plan.forgetBeliefs) await forgetIn(tx, f.id, f.at, [])
    for (const f of plan.forgetTalks) await forgetTalkIn(tx, f.id, f.at, [])
    // every imported protection is merged into what is stored now (including the tombstones just written above)
    for (const t of plan.tombs) await putTombMerged(tx, t, salt)
    for (const b of [...plan.add, ...plan.update]) tx.putBelief(b)
    for (const t of plan.addTalks) tx.putTalk(t)
    for (const t of c.trace) tx.putTrace(t)
    return { ok: true, gen: next, plan }
  }
  if (c.gen < gen) return { ok: false, gen, why: 'gen' }
  if (c.op === 'note') {
    for (const t of c.trace) tx.putTrace(t)
    return { ok: true, gen }
  }
  if (c.op === 'use') {
    // each stored one counts its use; one that is gone (forgotten) is skipped, and reported so the tab reads again
    let all = true
    for (const id of c.ids) {
      if (await tx.tomb(id)) {
        all = false
        continue
      }
      const b = await tx.belief(id)
      if (b) {
        tx.putBelief({ ...b, uses: b.uses + 1, last_used_at: Math.max(b.last_used_at ?? 0, c.at) })
        continue
      }
      // r2: a swarm conversation sent as a note
      const t = await tx.talk(id)
      if (!t) {
        all = false
        continue
      }
      tx.putTalk({ ...t, uses: (t.uses ?? 0) + 1, last_used_at: Math.max(t.last_used_at ?? 0, c.at) })
    }
    return all ? { ok: true, gen } : { ok: false, gen, why: 'gone' }
  }
  // put
  if (await tx.tomb(c.belief.id)) return { ok: false, gen, why: 'tomb' }
  if (c.turn_at !== undefined && c.by_time && (await tx.genAt()) >= c.turn_at) return { ok: false, gen, why: 'gen' }
  if (c.turn_at !== undefined && forgotten(await tx.tombs(), await tx.salt(), c.belief.statement, c.turn_at)) return { ok: false, gen, why: 'tomb' }
  const stored = await tx.belief(c.belief.id)
  // Host review confirms exactly the displayed words, even when an older writer reused the same timestamp.
  if (c.base_statement !== undefined && (!stored || stored.updated_at !== c.base || stored.statement !== c.base_statement)) return { ok: false, gen, why: stored ? 'newer' : 'gone' }
  if (c.base === null ? stored !== undefined : !stored || stored.updated_at > c.base) return { ok: false, gen, why: stored ? 'newer' : 'gone' }
  // usage is the stored copy's (another tab may have counted uses since); everything else is this write's
  tx.putBelief(stored ? { ...c.belief, uses: Math.max(stored.uses, c.belief.uses), last_used_at: stored.last_used_at ?? c.belief.last_used_at } : c.belief)
  for (const t of c.trace) tx.putTrace(t)
  return { ok: true, gen }
}

/** In memory (tests, or a browser without IndexedDB): the same contract and rules, gone when the page closes. */
export function memoryBackend(): MemoryBackend {
  const beliefs = new Map<string, Belief>()
  const trace = new Map<string, TraceEntry>()
  const tombs = new Map<string, Tombstone>()
  const talks = new Map<string, Talk>()
  let gen = 0
  let genAt = 0
  let salt: string | null = null
  let talkRecall = false
  // commits run one at a time, like IndexedDB readwrite transactions over the same stores
  let chain: Promise<unknown> = Promise.resolve()
  const tx: Tx = {
    gen: async () => gen,
    genAt: async () => genAt,
    setGen: (n, at) => void ((gen = n), (genAt = at)),
    salt: async () => (salt ??= newSalt()),
    belief: async (id) => (beliefs.has(id) ? copy(beliefs.get(id)!) : undefined),
    tomb: async (id) => tombs.has(id),
    tombOf: async (id) => (tombs.has(id) ? copy(tombs.get(id)!) : undefined),
    tombs: async () => copy([...tombs.values()]),
    trace: async () => copy([...trace.values()]),
    beliefs: async () => copy([...beliefs.values()]),
    talks: async () => copy([...talks.values()]),
    setTalkRecall: (on) => void (talkRecall = on),
    talk: async (id) => (talks.has(id) ? copy(talks.get(id)!) : undefined),
    putBelief: (b) => void beliefs.set(b.id, copy(b)),
    delBelief: (id) => void beliefs.delete(id),
    putTomb: (t) => void tombs.set(t.id, copy(t)),
    putTrace: (t) => void trace.set(t.id, copy(t)),
    putTalk: (t) => void talks.set(t.id, copy(t)),
    delTalk: (id) => void talks.delete(id),
    clear: () => (beliefs.clear(), trace.clear(), tombs.clear(), talks.clear()),
  }
  return {
    durable: false,
    async load() {
      await chain
      return { beliefs: copy([...beliefs.values()]), trace: copy([...trace.values()]).sort(byTime), gen, gen_at: genAt, salt: await tx.salt(), tombs: copy([...tombs.values()]), talks: copy([...talks.values()]).sort((a, b) => a.at - b.at), talk_recall: talkRecall === true }
    },
    commit(c, guard) {
      const run = chain.then(async () => {
        checkGuard(guard)
        // A guarded in-memory transaction has the same rollback semantics as IndexedDB on cancellation.
        const before = guard ? { beliefs: copy([...beliefs]), trace: copy([...trace]), tombs: copy([...tombs]), talks: copy([...talks]), gen, genAt, salt, talkRecall } : null
        try {
          const result = await apply(guardedTx(tx, guard), copy(c))
          checkGuard(guard)
          return result
        } catch (error) {
          if (before) {
            beliefs.clear(); for (const [key, value] of before.beliefs) beliefs.set(key, value)
            trace.clear(); for (const [key, value] of before.trace) trace.set(key, value)
            tombs.clear(); for (const [key, value] of before.tombs) tombs.set(key, value)
            talks.clear(); for (const [key, value] of before.talks) talks.set(key, value)
            ;({ gen, genAt, salt, talkRecall } = before)
          }
          throw error
        }
      })
      chain = run.catch(() => undefined)
      return run
    },
    close() {},
  }
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((ok, no) => ((r.onsuccess = () => ok(r.result)), (r.onerror = () => no(r.error))))

/** IndexedDB: database `name`; stores `beliefs`, `trace`, `tombs`, `talks` (keyed by id) and `meta` (the generation). */
export function idbBackend(name: string): MemoryBackend {
  let db: Promise<IDBDatabase> | null = null
  const open = () =>
    (db ??= new Promise<IDBDatabase>((ok, no) => {
      // v3 adds `talks` (personal mind r1); an older database is upgraded in place, nothing in it changes
      const r = indexedDB.open(name, 3)
      r.onupgradeneeded = () => {
        const d = r.result
        if (!d.objectStoreNames.contains('beliefs')) d.createObjectStore('beliefs', { keyPath: 'id' })
        if (!d.objectStoreNames.contains('trace')) d.createObjectStore('trace', { keyPath: 'id' })
        if (!d.objectStoreNames.contains('tombs')) d.createObjectStore('tombs', { keyPath: 'id' })
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' })
        if (!d.objectStoreNames.contains('talks')) d.createObjectStore('talks', { keyPath: 'id' })
      }
      r.onsuccess = () => {
        // another tab upgrading this database: let it, and open again next time
        r.result.onversionchange = () => {
          r.result.close()
          db = null
        }
        ok(r.result)
      }
      r.onerror = () => no(r.error)
      r.onblocked = () => no(new Error('blocked'))
    }))
  const STORES = ['beliefs', 'trace', 'tombs', 'meta', 'talks']
  const genOf = (v: unknown) => (v && typeof (v as { gen?: unknown }).gen === 'number' ? (v as { gen: number }).gen : 0)
  const atOf = (v: unknown) => (v && typeof (v as { at?: unknown }).at === 'number' ? (v as { at: number }).at : 0)
  const saltOf = (v: unknown) => (v && typeof (v as { salt?: unknown }).salt === 'string' && (v as { salt: string }).salt ? (v as { salt: string }).salt : null)
  /** the salt, made once in its own readwrite transaction if this database has none (two tabs: the first one wins) */
  const ensureSalt = async (d: IDBDatabase): Promise<string> => {
    const t = d.transaction(['meta'], 'readwrite')
    const ms = t.objectStore('meta')
    const done = new Promise<void>((ok, no) => ((t.oncomplete = () => ok()), (t.onerror = () => no(t.error)), (t.onabort = () => no(t.error ?? new Error('aborted')))))
    let salt = saltOf(await req(ms.get('salt')))
    if (!salt) {
      salt = newSalt()
      ms.put({ key: 'salt', salt })
    }
    await done
    return salt
  }
  return {
    durable: true,
    async load() {
      const d = await open()
      const tx = d.transaction(STORES, 'readonly')
      const [beliefs, trace, meta, tombs, salted, talks, setting] = await Promise.all([req(tx.objectStore('beliefs').getAll()), req(tx.objectStore('trace').getAll()), req(tx.objectStore('meta').get('gen')), req(tx.objectStore('tombs').getAll()), req(tx.objectStore('meta').get('salt')), req(tx.objectStore('talks').getAll()), req(tx.objectStore('meta').get('talk_recall'))])
      const salt = saltOf(salted) ?? (await ensureSalt(d))
      // r2.3: on only when stored as exactly on (a missing or malformed value is off)
      const talk_recall = !!setting && typeof setting === 'object' && (setting as { on?: unknown }).on === true
      return { beliefs: beliefs as Belief[], trace: (trace as TraceEntry[]).sort(byTime), gen: genOf(meta), gen_at: atOf(meta), salt, tombs: tombs as Tombstone[], talks: (talks as Talk[]).sort((a, b) => a.at - b.at), talk_recall }
    },
    async commit(c, guard) {
      const d = await open()
      checkGuard(guard)
      // a collect is acknowledged to the hive once this completes: it asks for a strict (flushed) commit
      const t = c.op === 'talks' || c.op === 'restore' ? d.transaction(STORES, 'readwrite', { durability: 'strict' }) : d.transaction(STORES, 'readwrite')
      const bs = t.objectStore('beliefs')
      const ts = t.objectStore('trace')
      const tb = t.objectStore('tombs')
      const ms = t.objectStore('meta')
      const tk = t.objectStore('talks')
      const done = new Promise<void>((ok, no) => {
        t.oncomplete = () => ok()
        t.onerror = () => no(t.error)
        t.onabort = () => no(t.error ?? new Error('aborted'))
      })
      const abort = () => { try { t.abort() } catch { /* already committed or aborted */ } }
      guard?.signal.addEventListener('abort', abort, { once: true })
      // every read below continues in a microtask of its request's success event, so the transaction stays active
      // and the whole check-then-write is one transaction (no other tab's write can land in between)
      const tx: Tx = {
        gen: async () => genOf(await req(ms.get('gen'))),
        genAt: async () => atOf(await req(ms.get('gen'))),
        setGen: (n, at) => void ms.put({ key: 'gen', gen: n, at }),
        salt: async () => {
          const have = saltOf(await req(ms.get('salt')))
          if (have) return have
          const salt = newSalt()
          ms.put({ key: 'salt', salt })
          return salt
        },
        belief: async (id) => (await req(bs.get(id))) as Belief | undefined,
        tomb: async (id) => (await req(tb.getKey(id))) !== undefined,
        tombOf: async (id) => (await req(tb.get(id))) as Tombstone | undefined,
        tombs: async () => (await req(tb.getAll())) as Tombstone[],
        trace: async () => (await req(ts.getAll())) as TraceEntry[],
        beliefs: async () => (await req(bs.getAll())) as Belief[],
        talks: async () => (await req(tk.getAll())) as Talk[],
        setTalkRecall: (on) => void ms.put({ key: 'talk_recall', on: on === true }),
        talk: async (id) => (await req(tk.get(id))) as Talk | undefined,
        putBelief: (b) => void bs.put(b),
        delBelief: (id) => void bs.delete(id),
        putTomb: (x) => void tb.put(x),
        putTrace: (x) => void ts.put(x),
        putTalk: (x) => void tk.put(x),
        delTalk: (id) => void tk.delete(id),
        clear: () => (bs.clear(), ts.clear(), tb.clear(), tk.clear()),
      }
      let r: Applied
      try {
        checkGuard(guard)
        r = await apply(guardedTx(tx, guard), c)
        checkGuard(guard)
        await done
        return r
      } catch (e) {
        abort()
        await done.catch(() => undefined)
        throw e
      } finally {
        guard?.signal.removeEventListener('abort', abort)
      }
    },
    close() {
      void db?.then((d) => d.close()).catch(() => undefined)
      db = null
    },
  }
}
