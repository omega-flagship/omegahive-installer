/**
 * The space and its storage together, as the worker runs them. Operations run one at a time, and storage is the
 * authority (r2, stand-in r1 P1 x2):
 *  - before ANY operation, read or change, the stored generation is checked (one small read); if another tab wrote a
 *    newer one, this tab's space is replaced by the stored record first, so a forget made in another tab is never
 *    served here (recall, belief, export, infer, explain);
 *  - a change is computed on that reconciled space, then written compare-and-set on the generation before it is
 *    answered. If another writer got there in between, the space is reloaded and the SAME operation (the intent: e.g.
 *    forget id, with its words' fingerprints computed afresh on the reloaded space) is applied again and written;
 *  - every change is a transaction (r3, stand-in r2 P1): the operation and its write run in one try; on ANY failure
 *    (the operation throws part-way, the write fails, a retry's reload fails) the space is put back to the last
 *    stored record kept in memory (`snapshot`) and the host is marked stale; a stale host reloads from storage before
 *    its next answer and refuses (throws) until that succeeds, so a mutated, unsaved space is never served or saved;
 *  - after a write, a change notice goes to the other tabs (BroadcastChannel), which reconcile at once.
 */
import { MindCore, type MindCoreOptions } from './core'
import { MUTATING, type Op } from './protocol'
import type { MindRecord, MindStore } from './persist'

const MAX_RETRIES = 5

/** A cross-tab change notice channel (BroadcastChannel in browsers; injectable for tests; null: none). */
export interface Notices {
  post(gen: number): void
  listen(fn: (gen: number) => void): void
  close(): void
}

export function broadcastNotices(key: string): Notices | null {
  if (typeof BroadcastChannel === 'undefined') return null
  const ch = new BroadcastChannel(`omegahive-mind-space:${key}`)
  return {
    post: (gen) => ch.postMessage({ gen }),
    listen: (fn) => {
      ch.onmessage = (e: MessageEvent<{ gen?: unknown }>) => {
        if (typeof e.data?.gen === 'number') fn(e.data.gen)
      }
    },
    close: () => ch.close(),
  }
}

export interface HostOptions extends MindCoreOptions {
  notices?: Notices | null
}

type Snapshot = Pick<MindRecord, 'text' | 'vectors'>

export class MindHost {
  private queue: Promise<unknown> = Promise.resolve()
  /** true after a failure: storage must be reloaded before anything is answered */
  private stale = false
  private constructor(
    private space: MindCore,
    readonly store: MindStore,
    private gen: number,
    private readonly opts: HostOptions,
    /** the last record this host stored or loaded: the in-memory pre-image every change rolls back to */
    private snapshot: Snapshot,
  ) {
    opts.notices?.listen((gen) => {
      if (gen > this.gen) this.enqueue(() => this.reconcile())
    })
  }

  static async open(store: MindStore, opts: HostOptions = {}): Promise<MindHost> {
    const rec = await store.load()
    const core = rec ? MindHost.fromRecord(rec, opts) : MindCore.create(opts)
    return new MindHost(core, store, rec?.gen ?? 0, opts, rec ?? MindHost.snap(core))
  }

  private static snap(core: MindCore): Snapshot {
    return { text: core.export(), vectors: { embedder: core.vectors.embedder.id, entries: core.vectors.dump() } }
  }

  private static fromRecord(rec: Snapshot, opts: MindCoreOptions): MindCore {
    return MindCore.restore(rec.text, { ...opts, vectors: rec.vectors })
  }

  /** true until a failed change has been recovered from storage */
  get isStale(): boolean {
    return this.stale
  }

  /** the space as of the last reconcile (tests read it directly) */
  get core(): MindCore {
    return this.space
  }
  get generation(): number {
    return this.gen
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Storage newer than this space? Then storage's copy replaces it (this tab holds nothing storage lacks). */
  private async reconcile(): Promise<void> {
    if (!this.stale && (await this.store.peekGen()) === this.gen) return
    await this.reload()
  }

  /** Storage's record replaces the space; until this succeeds the host stays stale and answers nothing. */
  private async reload(): Promise<void> {
    this.stale = true
    const rec = await this.store.load()
    const space = rec ? MindHost.fromRecord(rec, this.opts) : MindCore.create(this.opts)
    this.space = space
    this.gen = rec?.gen ?? 0
    this.snapshot = rec ?? MindHost.snap(space)
    this.stale = false
  }

  /** Put the space back to the last stored record, in memory, and require a reload before the next answer. */
  private rollback(): void {
    this.stale = true
    try {
      this.space = MindHost.fromRecord(this.snapshot, this.opts)
    } catch {
      /* stays stale: nothing is answered until storage loads */
    }
  }

  /** Run one operation, in order, on the space as storage has it; a change resolves once written. */
  run(op: Op, args: unknown[]): Promise<{ value: unknown; durable: boolean; gen: number }> {
    return this.enqueue(async () => {
      await this.reconcile() // a stale host reloads here, or throws: nothing is answered from an unsaved space
      if (!MUTATING.has(op)) {
        const fn = this.space[op] as (...a: unknown[]) => unknown
        return { value: fn.apply(this.space, args), durable: false, gen: this.gen }
      }
      try {
        for (let i = 0; i < MAX_RETRIES; i++) {
          const fn = this.space[op] as (...a: unknown[]) => unknown
          const value = fn.apply(this.space, args)
          // lib_mind's refusals change no atom; anything else is written before it is answered
          if ((value as { ok?: boolean })?.ok === false) return { value, durable: false, gen: this.gen }
          const rec = this.record()
          const saved = await this.store.save(rec, this.gen)
          if (saved.ok) {
            this.gen = saved.gen
            this.snapshot = rec
            this.opts.notices?.post(saved.gen)
            return { value, durable: this.store.durable, gen: this.gen }
          }
          // another writer got there first: take storage's copy and apply the same intent to it again
          this.space = MindHost.fromRecord(saved.current, this.opts)
          this.gen = saved.current.gen
          this.snapshot = saved.current
        }
        throw new Error('storage kept changing under this space')
      } catch (e) {
        this.rollback()
        throw e
      }
    })
  }

  private record(): Omit<MindRecord, 'gen'> {
    return {
      v: 1,
      text: this.space.export(),
      watermark: this.space.stats().watermark,
      vectors: { embedder: this.space.vectors.embedder.id, entries: this.space.vectors.dump() },
    }
  }

  close(): void {
    this.opts.notices?.close()
  }
}
