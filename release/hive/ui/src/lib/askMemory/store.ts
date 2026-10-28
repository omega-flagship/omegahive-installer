/**
 * The Ask's memory for one signed-in person on one hive, in this browser. It switches when the person or the hive
 * changes (store/ask binds it), learns from live memory frames the moment they arrive (before anything is drawn),
 * notes a stub it never saw live as lost, and recalls a few notes for each Ask turn. Its contents are never logged
 * and never sent anywhere but the turn's own `memory_notes`.
 */
import { useSyncExternalStore } from 'react'
import type { EpochBinding, Stale } from '../identityEpoch'
import { forgotten, idbBackend, memoryBackend, talkOk, type Applied, type Commit, type MemoryBackend, type MemoryCommitGuard, type Refusal, type Snapshot, type Tombstone } from './backend'
import { buildFile, readFile, planRestore, type FileProblem, type MemoryFile, type RestorePlan } from './file'
import { wordsHash } from './hash'
import { cleanStatement, learn, namesPrivate, readItem } from './beliefs'
import { lexicalEmbedder, type Embedder } from './embed'
import { localRecaller, type Recaller } from './recall'
import { FRAMES_PER_TURN, type Belief, type MemoryFrame, type MemoryKind, type Note, type Talk, type TraceEntry } from './types'

/** What this browser knows about the hive's memory: unknown yet, the hive's conductor answers (it may send frames), it has sent some, or it cannot (memory is off). */
export type HiveMemory = 'unknown' | 'conductor' | 'learning' | 'off'

/** The host's own Ask switches (GET /api/me/ask `capabilities`, core/ask.py capabilities()). */
export interface HiveCapabilities {
  conductor: boolean
  memory: boolean
}

export interface MemoryOwner {
  principal: string
  /** the hive, as this page reaches it (live or sim, and the page's origin) */
  hive: string
}

export interface MemoryView {
  /** null: nobody is signed in (or who it is is not known), so nothing is kept */
  owner: MemoryOwner | null
  ready: boolean
  beliefs: Belief[]
  trace: TraceEntry[]
  /** the person's swarm conversations, collected from the hive's held copies (oldest first) */
  talks: Talk[]
  /** r1.1: the forget markers and the forget-everything watermark, as one comparable string (the backup nudge's) */
  forgets: string
  /**
   * r2.3: the person's own "Use my swarm talk in answers" (off unless they turned it on, in this memory). Read by
   * recall on every turn; a new identity, wiped storage or a missing value is off.
   */
  talkRecall: boolean
  hive: HiveMemory
  /** what the host said about its switches (null: not said yet, or an older host that does not say) */
  capabilities: HiveCapabilities | null
  /** a write to this browser's storage failed: what is shown may not survive a reload */
  writeFailed: boolean
}

export interface Received {
  kept: Belief | null
  /** why nothing was kept (forgotten: the person forgot these words, or everything, after the turn began) */
  why?: 'private' | 'cap' | 'unreadable' | 'nobody' | 'forgotten' | 'unplaced'
}

/**
 * When a turn began, as this memory saw it (`turnMark`, taken when the person asks): its frames are refused if the
 * person forgot their words, or everything, after that (stand-in r2 P1). A turn rejoined after a reload has no mark of
 * this page's: it is timed by the host (`hostMark`, the turn's `accepted` frame), and refused if it began at or before
 * the latest forget everything or a matching tombstone (r3b). A frame whose turn has neither is never learned (r3c:
 * nothing falls back to the current or loaded generation); store/ask holds a frame until its turn's start is known.
 */
export interface TurnMark {
  /** the binding generation of `use` it was taken under */
  readonly owner: number
  /** the forget-everything generation then (null: the memory had not loaded yet, or timed by the host: then it is timed) */
  readonly gen: number | null
  /** this browser's time then (or the host's, less HOST_CLOCK_MARGIN) */
  readonly at: number
  /** timed by the host: compared with the time of the latest forget everything, not its generation */
  readonly host?: true
}

/** How far the host's clock is allowed to run ahead of this browser's: a host-timed turn is taken to begin this much earlier. */
export const HOST_CLOCK_MARGIN = 2 * 60_000

export const LOST_WORDS = 'One memory from that turn was lost while you were away.'

const EMPTY: MemoryView = { owner: null, ready: true, beliefs: [], trace: [], talks: [], forgets: '', talkRecall: false, hive: 'unknown', capabilities: null, writeFailed: false }

/** Learned before: a remember or revise is in this browser's journal. */
const learnedIn = (trace: TraceEntry[]) => trace.some((t) => t.kind === 'remember' || t.kind === 'revise')
/**
 * The hive's memory state. The host's switches decide it once known (memory off: 'off', whatever the journal says);
 * before that, the journal (learned here before) or 'unknown'.
 */
export function hiveState(caps: HiveCapabilities | null, learned: boolean, now: HiveMemory = 'unknown'): HiveMemory {
  if (caps) return !caps.memory ? 'off' : learned || now === 'learning' ? 'learning' : 'conductor'
  return learned ? 'learning' : now
}
/** The forget markers (ids and times) and the forget-everything time, as one string: it changes whenever a forget does. */
export const forgetsOf = (tombs: readonly Tombstone[], genAt: number): string => `${genAt}|${tombs.map((t) => `${t.id}@${t.at}`).sort().join(',')}`
const rand = () => Math.random().toString(36).slice(2, 10)

/** The database for one person on one hive. */
export const dbName = (o: MemoryOwner): string => `omegahive-ask-memory:${encodeURIComponent(o.hive)}:${encodeURIComponent(o.principal)}`

/** The hive as this page reaches it: the client's mode and the page's origin (the hive serves this page). */
export function hiveKey(mode: 'live' | 'sim' | string): string {
  const origin = typeof location !== 'undefined' ? location.origin : 'local'
  return `${mode}@${origin}`
}

export interface StoreDeps {
  backend: (name: string) => MemoryBackend
  now: () => number
  embedder: Embedder
  /**
   * asked once per browser: keep this site's storage through storage pressure. Resolves (to whether the browser
   * granted it) once the browser has answered; a durable acknowledgement waits for that answer (r1.1 P1).
   */
  persist: () => Promise<boolean> | void
  /** tells other tabs of the same person that the memory changed (they read it again) */
  channel: { post: (key: string) => void; listen: (fn: (key: string) => void) => void } | null
  /** r2: how notes are chosen for a turn (default: this browser's own ranking; later the MeTTa memory core's) */
  recaller: Recaller
  /** the identity epoch (lib/identityEpoch): every async continuation is bound to the identity it started under */
  bind: () => EpochBinding
  /** a synchronous clear on every identity change (lib/identityEpoch), before anyone sees the new identity */
  onIdentityChange: ((fn: () => void) => () => void) | null
}

/** The identity epoch's two hooks (lib/identityEpoch's bindEpoch and onIdentityChange). */
export interface IdentityHooks {
  bind: () => EpochBinding
  onIdentityChange: (fn: () => void) => () => void
}

/**
 * Until the page connects the identity epoch (main.tsx, `connectIdentity`), a binding that never goes stale: the
 * store's own owner generation still guards every write. lib/identityEpoch is not imported here (it brings the
 * confirm UI with it); the page's composition root wires it, and tests wire it where identity is involved.
 */
const UNBOUND: EpochBinding = { epoch: 0, current: () => true, commit: <R>(write: () => R): R | Stale => write() }

const inMemory = new Map<string, MemoryBackend>()
function defaultDeps(): StoreDeps {
  const hasIdb = typeof window !== 'undefined' && typeof indexedDB !== 'undefined'
  let bc: BroadcastChannel | null = null
  try {
    bc = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('omegahive-ask-memory') : null
  } catch {
    bc = null
  }
  return {
    // without IndexedDB (tests, or a browser that refuses it): memory for this page's life, one per person
    backend: (name) => (hasIdb ? idbBackend(name) : (inMemory.get(name) ?? inMemory.set(name, memoryBackend()).get(name)!)),
    now: () => Date.now(),
    embedder: lexicalEmbedder,
    recaller: localRecaller,
    persist: () => {
      try {
        if (localStorage.getItem('omegahive-ask-memory-persist') === '1') return navigator.storage?.persisted?.().catch(() => false) ?? Promise.resolve(false)
        localStorage.setItem('omegahive-ask-memory-persist', '1')
        return navigator.storage?.persist?.().catch(() => false) ?? Promise.resolve(false)
      } catch {
        /* storage unavailable: nothing to ask */
        return Promise.resolve(false)
      }
    },
    channel: bc ? { post: (key) => bc!.postMessage(key), listen: (fn) => bc!.addEventListener('message', (e) => typeof e.data === 'string' && fn(e.data)) } : null,
    bind: () => UNBOUND,
    onIdentityChange: null,
  }
}

/**
 * What "forget everything" was asked about: this store's owner as it was when the button was pressed (the binding
 * generation of `use`, and the identity epoch). `forgetAll(token)` does nothing unless both are still current.
 */
export interface ForgetAllToken {
  readonly owner: number
  readonly binding: EpochBinding
}

/** Why an edit is not kept (null: it is). */
export type EditProblem = 'empty' | 'same' | 'private' | 'gone'

/** P8 host-only opening revision. None of this object or its words may enter an app frame. */
export interface MemoryReviewToken {
  readonly owner: number
  readonly backend: MemoryBackend
  readonly gen: number
  readonly base: (id: string) => number | undefined
}
export interface MemoryReviewSnapshot { token: MemoryReviewToken; beliefs: Belief[] }
export type MemoryReviewResult = { kind: 'done' }
  | { kind: 'stale'; snapshot: MemoryReviewSnapshot | null }
  | { kind: 'refused'; reason: 'unavailable' | EditProblem }

export class AskMemoryStore {
  private deps: StoreDeps
  private view: MemoryView = EMPTY
  private listeners = new Set<() => void>()
  private backend: MemoryBackend | null = null
  private key: string | null = null
  /** the binding generation: raised by every `use`, so nothing started for an earlier owner (or this one, earlier) lands */
  private owner = 0
  /** the identity epoch `use` was called under */
  private binding: EpochBinding | null = null
  /** raised by every local change: a read started before one is never installed after it */
  private mut = 0
  /** the stored forget-everything generation as this tab knows it (every write carries it) */
  private gen = 0
  /** the stored tombstones as this tab knows them (fingerprints only): forgotten words are refused before drawing */
  private tombs: Tombstone[] = []
  /** when the latest forget everything was (this browser's clock; 0: never), as this tab knows it */
  private genAt = 0
  /** this database's fingerprint salt (null until loaded): never sent, never logged */
  private salt: string | null = null
  private loaded: Promise<void> = Promise.resolve()
  /** the browser's answer to the persist request for this owner (r1.1 P1) */
  private persisting: Promise<unknown> = Promise.resolve()
  /** this owner's storage was read in a completed transaction */
  private readOk = false
  private queue: Promise<void> = Promise.resolve()
  /** frames that arrived before the person's memory had loaded: learned, in order, once it has */
  private early: { frame: MemoryFrame; privatePage: boolean; since: TurnMark | null }[] = []
  /** live frames handled this page's life, kept or not (`turn#seq`): a stub for one of them is not lost */
  private seen = new Set<string>()
  private perTurn = new Map<string, number>()
  private vectors = new Map<string, { text: string; vec: Float32Array }>()
  private seq = 0
  private reviewTokens = new WeakSet<MemoryReviewToken>()

  constructor(deps: Partial<StoreDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps }
    this.deps.channel?.listen((key) => {
      if (key === this.key) void this.reload()
    })
    this.offIdentity = this.deps.onIdentityChange?.(() => this.use(null)) ?? null
  }

  private offIdentity: (() => void) | null = null
  /**
   * Bind this memory to the identity epoch (lib/identityEpoch): every later `use`, read and write is bound to the
   * identity it started under, and an identity change empties this memory at once (store/ask then binds the new
   * person's, if any). The current owner, if any, is dropped (it was bound to no epoch).
   */
  connectIdentity(hooks: IdentityHooks): void {
    this.offIdentity?.()
    this.deps = { ...this.deps, bind: hooks.bind, onIdentityChange: hooks.onIdentityChange }
    this.offIdentity = hooks.onIdentityChange(() => this.use(null))
    this.use(null)
  }

  // ---------------------------------------------------------------- reading

  getView = (): MemoryView => this.view
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private set(p: Partial<MemoryView>) {
    this.view = { ...this.view, ...p }
    for (const l of this.listeners) l()
  }
  /** Settles once the current person's memory has loaded (tests, and the lost check). */
  whenReady(): Promise<void> {
    return this.loaded
  }

  /**
   * The write guard for anything that resumes after an await: the same owner (`use` generation and database) and the
   * same identity, checked synchronously in the same tick as the write (lib/identityEpoch `commit`).
   */
  private still(owner: number): boolean {
    return this.owner === owner && !!this.key && !!this.binding && this.binding.current()
  }
  private guarded(owner: number, write: () => void): void {
    const b = this.binding
    if (!b || this.owner !== owner || !this.key) return
    b.commit(() => {
      // re-read in the same tick: commit ran synchronously, nothing could have moved in between
      if (this.owner === owner) write()
    })
  }

  // ---------------------------------------------------------------- whose memory

  /** Switch to this person's memory on this hive (null: nobody; nothing is kept or sent). */
  use(owner: MemoryOwner | null): void {
    const key = owner ? dbName(owner) : null
    // the same database under a newer identity epoch is still a new binding (nothing from before carries over)
    if (key === this.key && (!key || this.binding?.current())) return
    this.backend?.close()
    this.backend = null
    this.key = key
    const at = ++this.owner
    this.binding = this.deps.bind()
    this.mut++
    this.gen = 0
    this.tombs = []
    this.genAt = 0
    this.salt = null
    this.early = []
    this.seen.clear()
    this.perTurn.clear()
    this.vectors.clear()
    this.queue = Promise.resolve()
    if (!owner || !key) {
      this.view = EMPTY
      this.set({})
      this.loaded = Promise.resolve()
      return
    }
    this.view = { ...EMPTY, owner, ready: false }
    this.set({})
    this.readOk = false
    this.persisting = Promise.resolve(this.deps.persist()).catch(() => false)
    const backend = this.deps.backend(key)
    this.backend = backend
    const mut = this.mut
    this.loaded = backend
      .load()
      .then(
        (snap) =>
          this.guarded(at, () => {
            // a change made here before the first read landed (forget everything): that read is older than the view
            if (this.mut !== mut) {
              this.set({ ready: true })
              void this.reload()
              return
            }
            this.gen = snap.gen
            this.tombs = snap.tombs
            this.genAt = snap.gen_at
            this.salt = snap.salt
            this.readOk = true
            // the host's switches may have arrived before this read: they still decide
            this.set({ talkRecall: snap.talk_recall === true, forgets: forgetsOf(snap.tombs, snap.gen_at), beliefs: snap.beliefs, trace: snap.trace, talks: snap.talks, ready: true, hive: hiveState(this.view.capabilities, learnedIn(snap.trace), this.view.capabilities ? this.view.hive : 'unknown') })
          }),
        () => this.guarded(at, () => this.set({ ready: true, writeFailed: true })),
      )
      .then(() => {
        if (!this.still(at)) return
        const early = this.early
        this.early = []
        for (const e of early) this.receive(e.frame, { privatePage: e.privatePage, since: e.since })
      })
  }

  /**
   * Read storage again (another tab changed it, or a write here was refused). Read only after this tab's own writes
   * so far, and installed only if nothing changed here meanwhile (else read again), for the same owner and identity.
   */
  private async reload(): Promise<void> {
    const at = this.owner
    for (let tries = 0; tries < 5; tries++) {
      const backend = this.backend
      if (!backend || !this.still(at)) return
      await this.queue
      const mut = this.mut
      let snap: Snapshot
      try {
        snap = await backend.load()
      } catch {
        return // keep what is shown
      }
      if (!this.still(at)) return
      if (this.mut !== mut) continue // a change here landed while reading: what was read is older than the view
      this.guarded(at, () => {
        this.gen = snap.gen
        this.tombs = snap.tombs
        this.genAt = Math.max(this.genAt, snap.gen_at)
        this.salt = snap.salt
        for (const id of this.vectors.keys()) if (!snap.beliefs.some((b) => b.id === id)) this.vectors.delete(id)
        this.set({ talkRecall: snap.talk_recall === true, forgets: forgetsOf(snap.tombs, this.genAt), beliefs: snap.beliefs, trace: snap.trace, talks: snap.talks, ...(learnedIn(snap.trace) && this.view.hive !== 'off' ? { hive: 'learning' as const } : {}) })
      })
      return
    }
  }

  /**
   * One change, written in order after this tab's earlier ones. A refused write (another tab forgot it, or changed it
   * since) reloads what storage holds, then `refused` is told why (it may try once more, but only past a newer edit). Writes that only add (learning,
   * uses, journal) are dropped once the identity moved; forgetting is always written, to the database of the person
   * who asked for it (deleting is never the wrong person's write: the database is the owner's own).
   */
  private commit(c: Commit, refused?: (why: Refusal | undefined) => void) {
    const backend = this.backend
    const key = this.key
    const at = this.owner
    if (!backend || !key) return
    this.mut++
    const always = c.op === 'forget' || c.op === 'forget_all'
    this.queue = this.queue
      .then(async () => {
        if (!always && !this.still(at)) return
        const r = await backend.commit(c)
        this.deps.channel?.post(key)
        if (r.ok) {
          this.guarded(at, () => void (this.gen = Math.max(this.gen, r.gen)))
          return
        }
        // refused: storage is authoritative; read it again after this write, then (maybe) try once more
        void this.reload().then(() => {
          if (refused && this.still(at)) refused(r.why)
        })
      })
      .catch(() => this.guarded(at, () => this.set({ writeFailed: true })))
  }

  /** Settles once every write so far has been tried (tests). */
  flushed(): Promise<void> {
    return this.queue
  }

  private traceId = () => `t_${this.deps.now().toString(36)}_${(++this.seq).toString(36)}_${rand()}`
  private beliefId = () => `b_${this.deps.now().toString(36)}${rand()}`

  // ---------------------------------------------------------------- the hive

  /**
   * What the host says about its switches (GET or PUT /api/me/ask `capabilities`), for the person and identity this
   * memory is bound to now: the caller reads them under that binding and passes them only while it still holds (the
   * Ask store's snapshot). Null (an older host that does not say) leaves the state to the replies. Nobody signed in:
   * nothing is kept.
   */
  hiveCaps(caps: HiveCapabilities | null): void {
    if (!this.key || !this.binding?.current()) return
    const capabilities = caps ? { conductor: caps.conductor, memory: caps.conductor && caps.memory } : null
    const hive = capabilities ? hiveState(capabilities, learnedIn(this.view.trace), this.view.hive) : this.view.hive
    if (hive === this.view.hive && JSON.stringify(capabilities) === JSON.stringify(this.view.capabilities)) return
    this.set({ capabilities, hive })
  }

  /**
   * What a turn's acceptance said: the conductor answers it (memory may follow), or it does not. That is one turn's
   * metadata (an idempotent replay answers the turn as it was admitted), never the hive's switches now: once
   * GET /api/me/ask has said them, they are the authority and are never changed here (r2 P2). Returns true when the
   * acceptance disagrees with them, so the caller reads the switches again. Before they are known, the replies decide
   * as before.
   */
  sawHive(conductor: boolean): boolean {
    const caps = this.view.capabilities
    if (caps) return caps.conductor !== conductor
    const next: HiveMemory = !conductor ? 'off' : this.view.hive === 'learning' ? 'learning' : 'conductor'
    if (next !== this.view.hive) this.set({ hive: next })
    return false
  }

  // ---------------------------------------------------------------- learning

  /**
   * A live memory frame, the moment it arrives. Learned and written at once (before the thread draws it). Never kept
   * from a private app's page or naming one, past 8 from one turn, or when nobody is signed in.
   */
  receive(frame: MemoryFrame, opts: { privatePage: boolean; since: TurnMark | null }): Received {
    if (!this.key) return { kept: null, why: 'nobody' }
    const at = `${frame.turn_id}#${frame.seq}`
    if (!this.view.ready) {
      this.seen.add(at)
      this.early.push({ frame, privatePage: opts.privatePage, since: opts.since })
      return { kept: null }
    }
    if (this.view.trace.some((t) => t.turn_id === frame.turn_id && t.seq === frame.seq)) {
      this.seen.add(at)
      return { kept: this.view.beliefs.find((b) => b.id === this.view.trace.find((t) => t.turn_id === frame.turn_id && t.seq === frame.seq)?.belief_id) ?? null }
    }
    this.seen.add(at)
    const item = readItem(frame.item)
    if (!item) return { kept: null, why: 'unreadable' }
    if (opts.privatePage || namesPrivate(item.statement)) return { kept: null, why: 'private' }
    const n = this.perTurn.get(frame.turn_id) ?? 0
    if (n >= FRAMES_PER_TURN) return { kept: null, why: 'cap' }
    // when its turn began is not known: never learned (r3c), nothing falls back to a generation
    if (!opts.since) return { kept: null, why: 'unplaced' }
    this.perTurn.set(frame.turn_id, n + 1)
    const kept = this.learnNow({ ...frame, item }, this.since(opts.since), true)
    return kept ? { kept } : { kept: null, why: 'forgotten' }
  }

  /** When everything learned from now on began: taken when the person asks, and handed back with the turn's frames. */
  turnMark(): TurnMark {
    return { owner: this.owner, gen: this.view.ready ? this.gen : null, at: this.deps.now() }
  }

  /**
   * A rejoined turn's mark from the host's own time for its start (the `accepted` frame's `at`): undefined when there
   * is none, or it does not read as a time (its frames are then not learned).
   */
  hostMark(startedAt: string | null | undefined): TurnMark | undefined {
    const t = startedAt ? Date.parse(startedAt) : NaN
    if (!Number.isFinite(t)) return undefined
    return { owner: this.owner, gen: null, at: t - HOST_CLOCK_MARGIN, host: true }
  }

  /**
   * A turn's mark as this owner's: by its generation when it was taken under this owner, loaded; otherwise (host-timed,
   * taken before the memory loaded, or under an earlier binding) by its time against the latest forget everything.
   */
  private since(m: TurnMark): { gen: number; at: number; byTime: boolean } {
    if (!m.host && m.owner === this.owner && m.gen !== null) return { gen: m.gen, at: m.at, byTime: false }
    return { gen: this.gen, at: m.at, byTime: true }
  }

  /**
   * Learn one frame against the beliefs as shown, and write it (null: not kept). Never kept if the person forgot its
   * words, or everything, after its turn began (stand-in r2 P1): checked here against what this tab knows, and again by
   * storage in the same transaction as the write. A write storage refuses because of a forget (a tombstone, a newer
   * forget everything, or the belief it merged into is gone) is DROPPED. Only a write that lost to a newer stored copy
   * (another tab's edit or learning) is learned once more, against what storage then holds, with the same turn's
   * mark: so that retry is refused too if a forget now applies.
   */
  private learnNow(frame: MemoryFrame & { item: NonNullable<MemoryFrame['item']> }, since: { gen: number; at: number; byTime: boolean }, retry: boolean): Belief | null {
    if (since.gen < this.gen || (since.byTime && this.genAt >= since.at)) return null
    if (this.salt !== null && forgotten(this.tombs, this.salt, frame.item.statement, since.at)) return null
    const { belief, entry, merged } = learn(this.view.beliefs, frame, { now: this.deps.now(), newId: this.beliefId, traceId: this.traceId, embedder: this.deps.embedder })
    const base = merged ? (this.view.beliefs.find((b) => b.id === belief.id)?.updated_at ?? null) : null
    const beliefs = [...this.view.beliefs.filter((b) => b.id !== belief.id), belief]
    // learned here: 'learning', unless the host's switches say memory is off (they stay the authority; r2 P2)
    this.set({ beliefs, trace: [...this.view.trace, entry], hive: hiveState(this.view.capabilities, true, this.view.hive) })
    this.commit({ op: 'put', gen: since.gen, belief, base, trace: [entry], turn_at: since.at, ...(since.byTime ? { by_time: true } : {}) }, retry ? (why) => void (why === 'newer' && this.learnNow(frame, since, false)) : undefined)
    return belief
  }

  /**
   * The stored copy of a memory frame (a recovery read after a reconnect): its item never reaches the page again. If
   * this browser never had the live frame, the journal says one memory was lost. True when it was lost.
   */
  async stub(frame: Pick<MemoryFrame, 'turn_id' | 'seq' | 'op'>): Promise<boolean> {
    if (!frame.op) return false // blanked by a thread deletion: nothing to say
    const owner = this.owner
    if (!this.key) return false
    await this.loaded
    let lost = false
    this.guarded(owner, () => {
      const at = `${frame.turn_id}#${frame.seq}`
      if (this.seen.has(at) || this.view.trace.some((t) => t.turn_id === frame.turn_id && t.seq === frame.seq)) return
      this.seen.add(at)
      const entry: TraceEntry = { id: this.traceId(), at: this.deps.now(), turn_id: frame.turn_id, seq: frame.seq, kind: 'lost', summary: '', belief_id: null }
      this.set({ trace: [...this.view.trace, entry] })
      this.commit({ op: 'note', gen: this.gen, trace: [entry] })
      lost = true
    })
    return lost
  }

  // ---------------------------------------------------------------- recall

  private vec(id: string, text: string): Float32Array {
    const v = this.vectors.get(id)
    if (v && v.text === text) return v.vec
    const vec = this.deps.embedder.embed(text)
    this.vectors.set(id, { text, vec })
    return vec
  }

  /** The notes for a turn asking `request`: the best few within the host's caps (none when nobody, or memory is off). */
  notesFor(request: string): { notes: Note[]; ids: string[] } {
    if (!this.key || !this.view.ready || (!this.view.beliefs.length && !this.view.talks.length)) return { notes: [], ids: [] }
    // the host's switches decide once known (memory off: nothing is recalled, whatever frames arrived); before that,
    // a hive seen to be off (r2 P2)
    const caps = this.view.capabilities
    if (caps ? !caps.memory : this.view.hive === 'off') return { notes: [], ids: [] }
    // r2: the swarm talk is a second source, under the same caps and every forget (watermark, markers, private names).
    // r2.3: only while the person's own setting is on, read NOW, on this turn (never cached); anything else is off
    const talkRecall = this.view.talkRecall === true
    return this.deps.recaller.recall(this.view.beliefs, request, {
      now: this.deps.now(),
      embedder: this.deps.embedder,
      vectors: (id, text) => this.vec(id, text),
      talks: talkRecall ? this.view.talks : [],
      forgets: { tombs: this.tombs, salt: this.salt, genAt: this.genAt },
    })
  }

  /** The turn carrying these notes was admitted: each was used once more (only its use count and time are written). */
  markUsed(ids: string[]): void {
    if (!ids.length || !this.key) return
    const now = this.deps.now()
    const want = new Set(ids)
    const used: string[] = []
    const beliefs = this.view.beliefs.map((b) => {
      if (!want.has(b.id)) return b
      used.push(b.id)
      return { ...b, uses: b.uses + 1, last_used_at: now }
    })
    // r2: a swarm conversation sent as a note counts its use too (the page says "used N times")
    const talks = this.view.talks.map((t) => {
      if (!want.has(t.id)) return t
      used.push(t.id)
      return { ...t, uses: (t.uses ?? 0) + 1, last_used_at: now }
    })
    if (!used.length) return
    this.set({ beliefs, talks })
    this.commit({ op: 'use', gen: this.gen, ids: used, at: now })
  }

  // ---------------------------------------------------------------- the person's own changes

  /** A fresh storage snapshot, after earlier writes, for the host overlay only. No ranking or inference. */
  async openReview(guard: MemoryCommitGuard): Promise<MemoryReviewSnapshot | null> {
    const at = this.owner, backend = this.backend
    if (!backend || !this.key || !this.still(at) || guard.signal.aborted || !guard.current()) return null
    await this.queue
    if (!this.still(at) || guard.signal.aborted || !guard.current()) return null
    try {
      const snapshot = await backend.load()
      if (!this.still(at) || this.backend !== backend || guard.signal.aborted || !guard.current()) return null
      const versions = new Map(snapshot.beliefs.map((b) => [b.id, b.updated_at]))
      const token: MemoryReviewToken = Object.freeze({ owner: at, backend, gen: snapshot.gen, base: (id: string) => versions.get(id) })
      this.reviewTokens.add(token)
      return { token, beliefs: snapshot.beliefs }
    } catch { return null }
  }

  private reviewCurrent(token: MemoryReviewToken, guard: MemoryCommitGuard): boolean {
    return this.reviewTokens.has(token) && token.backend === this.backend && this.still(token.owner)
      && !guard.signal.aborted && guard.current()
  }

  /** Await the actual base-CAS/forget transaction; an optimistic edit boolean cannot qualify a host confirm. */
  private async changeReview(snapshot: MemoryReviewSnapshot, id: string, words: string | null, guard: MemoryCommitGuard): Promise<MemoryReviewResult> {
    const { token } = snapshot
    if (!this.reviewCurrent(token, guard)) return { kind: 'refused', reason: 'unavailable' }
    const old = snapshot.beliefs.find((b) => b.id === id)
    if (!old || token.base(id) === undefined) return { kind: 'refused', reason: 'gone' }
    const text = words === null ? null : cleanStatement(words)
    if (text !== null && !text) return { kind: 'refused', reason: 'empty' }
    if (text !== null && namesPrivate(text)) return { kind: 'refused', reason: 'private' }
    if (text === old.statement) return { kind: 'refused', reason: 'same' }
    const current = () => this.reviewCurrent(token, guard)
    const run = this.queue.then(async () => {
      if (!current()) throw new Error('stale memory review')
      const now = this.deps.now()
      const trace: TraceEntry = { id: this.traceId(), at: now, turn_id: null,
        kind: text === null ? 'forget' : 'edit', summary: text ?? '', belief_id: id }
      const change: Commit = text === null
        ? { op: 'forget', gen: token.gen, id, base: token.base(id)!, base_statement: old.statement, at: now, trace: [trace], said: [old.statement] }
        : { op: 'put', gen: token.gen, base: token.base(id)!, base_statement: old.statement, trace: [trace],
          belief: { ...old, statement: text, source_turn: null, updated_at: Math.max(now, old.updated_at + 1) } }
      // The original truth value is retained byte-for-byte. P8 performs storage bookkeeping only.
      return token.backend.commit(change, { current, signal: guard.signal })
    })
    this.queue = run.then(() => undefined, () => undefined)
    try {
      const result = await run
      if (!current()) return { kind: 'refused', reason: 'unavailable' }
      if (this.key) this.deps.channel?.post(this.key)
      if (!result.ok) return { kind: 'stale', snapshot: await this.openReview(guard) }
      this.mut++
      await this.reload()
      return current() ? { kind: 'done' } : { kind: 'refused', reason: 'unavailable' }
    } catch { return { kind: 'refused', reason: 'unavailable' } }
  }

  fixReview(snapshot: MemoryReviewSnapshot, id: string, text: string, guard: MemoryCommitGuard): Promise<MemoryReviewResult> {
    return this.changeReview(snapshot, id, text, guard)
  }
  forgetReview(snapshot: MemoryReviewSnapshot, id: string, guard: MemoryCommitGuard): Promise<MemoryReviewResult> {
    return this.changeReview(snapshot, id, null, guard)
  }
  async exportReview(snapshot: MemoryReviewSnapshot, guard: MemoryCommitGuard): Promise<{ file: MemoryFile; text: string } | null> {
    if (!this.reviewCurrent(snapshot.token, guard)) return null
    const file = await this.exportFile()
    return this.reviewCurrent(snapshot.token, guard) ? file : null
  }

  /** Why these words would not be kept as this belief (null: they would). */
  checkEdit(id: string, statement: string): EditProblem | null {
    const b = this.view.beliefs.find((x) => x.id === id)
    if (!b) return 'gone'
    const words = cleanStatement(statement)
    if (!words) return 'empty'
    if (namesPrivate(words)) return 'private'
    if (words === b.statement) return 'same'
    return null
  }

  edit(id: string, statement: string): boolean {
    if (this.checkEdit(id, statement)) return false
    const b = this.view.beliefs.find((x) => x.id === id)!
    const words = cleanStatement(statement)
    const now = this.deps.now()
    const nb: Belief = { ...b, statement: words, updated_at: Math.max(now, b.updated_at) }
    const entry: TraceEntry = { id: this.traceId(), at: now, turn_id: null, kind: 'edit', summary: words, belief_id: id }
    this.set({ beliefs: this.view.beliefs.map((x) => (x.id === id ? nb : x)), trace: [...this.view.trace, entry] })
    this.commit({ op: 'put', gen: this.gen, belief: nb, base: b.updated_at, trace: [entry] })
    return true
  }

  /** Forget one belief; the journal keeps that something was forgotten, but not its words. */
  forget(id: string): boolean {
    const b = this.view.beliefs.find((x) => x.id === id)
    if (!b) return false
    const now = this.deps.now()
    const said = this.view.trace.filter((t) => t.belief_id === id && t.summary)
    // the words it was kept under: storage keeps them as salted fingerprints only, refused from any turn begun before now
    const words = [...new Set([b.statement, ...said.map((t) => t.summary)])]
    const blanked = said.map((t) => ({ ...t, summary: '' }))
    const entry: TraceEntry = { id: this.traceId(), at: now, turn_id: null, kind: 'forget', summary: '', belief_id: id }
    const byId = new Map(blanked.map((t) => [t.id, t]))
    this.vectors.delete(id)
    const salt = this.salt
    if (salt !== null) this.tombs = [...this.tombs.filter((t) => t.id !== id), { id, at: now, words: words.map((w) => wordsHash(salt, w)) }]
    this.set({ forgets: forgetsOf(this.tombs, this.genAt), beliefs: this.view.beliefs.filter((x) => x.id !== id), trace: [...this.view.trace.map((t) => byId.get(t.id) ?? t), entry] })
    this.commit({ op: 'forget', gen: this.gen, id, at: now, trace: [entry], said: words })
    return true
  }

  /** What "forget everything" is about to be asked for: this owner, now (see ForgetAllToken). */
  forgetAllToken(): ForgetAllToken {
    return { owner: this.owner, binding: this.deps.bind() }
  }

  /**
   * Forget everything: every belief and every journal line; one line says it happened. With a token, only if the
   * owner and identity it was taken under are still the current ones (true when done).
   */
  forgetAll(token?: ForgetAllToken): boolean {
    if (!this.key) return false
    if (token && (token.owner !== this.owner || !token.binding.current() || !this.binding?.current())) return false
    const now = this.deps.now()
    const entry: TraceEntry = { id: this.traceId(), at: now, turn_id: null, kind: 'forget_all', summary: '', belief_id: null }
    this.vectors.clear()
    this.tombs = []
    this.gen += 1
    this.genAt = Math.max(this.genAt, now)
    this.set({ beliefs: [], trace: [entry], talks: [], forgets: forgetsOf([], this.genAt) })
    this.commit({ op: 'forget_all', gen: this.gen, at: now, trace: [entry] })
    return true
  }

  // ---------------------------------------------------------------- the personal mind (r1)

  /**
   * One commit, written in order after this tab's earlier ones, whose result the caller awaits (a collect, a restore).
   * Nothing is written once the owner or identity moved (checked before the write); null when nothing was written, or
   * storage failed (then the view says so).
   */
  private commitNow(c: Commit): Promise<Applied | null> {
    const backend = this.backend
    const key = this.key
    const at = this.owner
    if (!backend || !key) return Promise.resolve(null)
    this.mut++
    const run = this.queue.then(async (): Promise<Applied | null> => {
      if (!this.still(at)) return null
      try {
        const r = await backend.commit(c)
        this.deps.channel?.post(key)
        return r
      } catch {
        this.guarded(at, () => this.set({ writeFailed: true }))
        return null
      }
    })
    this.queue = run.then(() => undefined)
    return run
  }

  /**
   * Keep the person's swarm conversations the hive held for them (GET /api/me/mind/inbox items, already read). Resolves
   * to the held copies that are SETTLED in storage (written, here already, or forgotten so deliberately not kept), once
   * the storage transaction has completed: only those may be acknowledged to the hive. Null: nothing may be
   * acknowledged (nobody, another person or identity now, or storage refused). Never learned from a private app.
   */
  async rememberTalks(items: readonly Omit<Talk, 'kept_at'>[]): Promise<string[] | null> {
    const at = this.owner
    if (!this.key) return null
    // r1.1 P1: never settle (so never let the hive delete) unless what is written here survives the page closing
    if (!(await this.keepsDurably())) return null
    if (!this.still(at)) return null
    const now = this.deps.now()
    const talks = items.map((t) => ({ ...t, kept_at: now })).filter(talkOk)
    if (!talks.length) return []
    const r = await this.commitNow({ op: 'talks', talks })
    if (!r?.ok || !this.still(at)) return null
    await this.reload()
    return r.settled ?? []
  }

  /**
   * Whether this person's memory is kept durably here (r1.1 P1): IndexedDB (never the in-memory fallback), the
   * browser has answered the persist request, and storage was read in a completed transaction. Each collect's own
   * write must then complete too before anything is acknowledged.
   */
  async keepsDurably(): Promise<boolean> {
    const at = this.owner
    if (!this.key || !this.backend?.durable) return false
    await this.loaded
    await this.persisting
    return this.still(at) && this.readOk && !!this.backend?.durable && !this.view.writeFailed
  }

  /**
   * r2.3: the person's "Use my swarm talk in answers". Shown at once (the next turn reads it); written to this person's
   * memory under the owner and identity it was set under (a write for an owner no longer current is dropped).
   */
  setTalkRecall(on: boolean): boolean {
    if (!this.key || !this.view.ready || !this.binding?.current()) return false
    this.set({ talkRecall: on === true })
    this.commit({ op: 'setting', talk_recall: on === true })
    return true
  }

  /** Forget one swarm conversation (its id is tombstoned: a copy delivered again is never kept). */
  forgetTalk(id: string): boolean {
    const t = this.view.talks.find((x) => x.id === id)
    if (!this.key || !t) return false
    const now = this.deps.now()
    // its words are kept as fingerprints only (as for a belief), so the same exchange under another id stays forgotten
    const salt = this.salt
    if (salt !== null) this.tombs = [...this.tombs.filter((x) => x.id !== id), { id, at: now, words: [wordsHash(salt, t.words), wordsHash(salt, t.answer)] }]
    this.set({ talks: this.view.talks.filter((x) => x.id !== id), forgets: forgetsOf(this.tombs, this.genAt) })
    this.commit({ op: 'forget_talk', id, at: now, said: [t.words, t.answer] })
    return true
  }

  /**
   * The person's memory as one file (lib/askMemory/file), read from storage after this tab's writes so far. Null when
   * nobody is signed in, the identity moved meanwhile, or storage could not be read.
   */
  async exportFile(): Promise<{ file: MemoryFile; text: string } | null> {
    const at = this.owner
    const backend = this.backend
    const owner = this.view.owner
    if (!backend || !owner || !this.key) return null
    await this.queue
    let snap: Snapshot
    try {
      snap = await backend.load()
    } catch {
      return null
    }
    if (!this.still(at) || this.view.owner !== owner) return null
    const file = buildFile(snap, owner, this.deps.now())
    return { file, text: JSON.stringify(file, null, 1) }
  }

  /**
   * Read a file the person chose and plan its restore against what storage holds now (the preview). The token binds
   * the later `restore` to this owner and identity. Null when nobody is signed in or the identity moved meanwhile.
   */
  async previewRestore(raw: string): Promise<{ ok: true; file: MemoryFile; plan: RestorePlan; token: ForgetAllToken } | { ok: false; problem: FileProblem } | null> {
    const at = this.owner
    const backend = this.backend
    const owner = this.view.owner
    if (!backend || !owner || !this.key) return null
    const token = this.forgetAllToken()
    const read = readFile(raw, owner)
    if (!read.ok) return read
    await this.queue
    let snap: Snapshot
    try {
      snap = await backend.load()
    } catch {
      return null
    }
    if (!this.still(at) || token.owner !== this.owner || !token.binding.current()) return null
    return { ok: true, file: read.file, plan: planRestore({ beliefs: snap.beliefs, talks: snap.talks, tombs: snap.tombs, salt: snap.salt, gen_at: snap.gen_at }, read.file), token }
  }

  /**
   * Restore from the file previewed under `token`: merged in one storage transaction by the same plan, against what
   * storage holds then. Nothing happens unless the owner and identity the preview was made under are still current.
   * Resolves to what it did, or null when nothing was done.
   */
  async restore(file: MemoryFile, token: ForgetAllToken): Promise<RestorePlan | null> {
    if (!this.key || token.owner !== this.owner || !token.binding.current() || !this.binding?.current()) return null
    const at = this.owner
    const entry: TraceEntry = { id: this.traceId(), at: this.deps.now(), turn_id: null, kind: 'restore', summary: '', belief_id: null }
    const r = await this.commitNow({ op: 'restore', file, trace: [entry] })
    if (!r?.ok || !r.plan || !this.still(at)) return null
    await this.reload()
    return r.plan
  }
}

/** This browser's Ask memory (one per page). */
export const askMemory = new AskMemoryStore()

export function useAskMemory(): MemoryView {
  return useSyncExternalStore(askMemory.subscribe, askMemory.getView, askMemory.getView)
}

export const KIND_TITLES: Record<MemoryKind, string> = { name: 'Names', preference: 'Preferences', place: 'Places', person: 'People', project: 'Projects', correction: 'Corrections' }
