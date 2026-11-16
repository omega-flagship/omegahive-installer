/**
 * Where the space is kept between visits: IndexedDB holds the exported MeTTa text, a generation number, the forget
 * watermark and the vectors, all in ONE record written in one transaction. The rules from the personal-mind review
 * (PLATFORM_SURFACE_PERSONAL_MIND_r1_STANDIN_VERDICT):
 *  - durability is an explicit capability: only IndexedDB is `durable`, and a write counts only once its transaction
 *    has completed. The in-memory store (no IndexedDB: private windows, blocked storage) is never durable, so nothing
 *    that would delete another copy (an acknowledgement to the hive) may rely on it;
 *  - the forget watermark lives in the text and in the record, written atomically with the generation;
 *  - storage is the authority: every operation first checks the stored generation (`peekGen`, one small read) and
 *    a tab behind it reloads the stored record before answering; a writer that loses the compare-and-set reloads and
 *    applies its operation again (host.ts), so no tab can drop or miss another's forgetting. MindCore.import (a file
 *    from elsewhere) is the union merge: every tombstone, the later watermark.
 */
import type { EntryType } from './vectors'

export const DB_NAME = 'omegahive-mind-space'
export const STORE = 'spaces'
/** each space's generation alone, written in the same transaction as its record, so a check is one small read */
export const GENS = 'gens'

export interface MindRecord {
  v: 1
  /** MindCore.export() */
  text: string
  /** +1 on every committed write */
  gen: number
  /** the forget-everything watermark in `text` (-1: none) */
  watermark: number
  vectors: { embedder: string; entries: [string, EntryType, Float32Array][] }
}

export type SaveResult = { ok: true; gen: number } | { ok: false; current: MindRecord }

export interface MindStore {
  /** true only for storage that survives the page closing (IndexedDB) */
  readonly durable: boolean
  readonly kind: 'indexeddb' | 'memory'
  load(): Promise<MindRecord | null>
  /** the stored generation only (0: nothing stored): cheap, checked before every operation */
  peekGen(): Promise<number>
  /** compare-and-set: writes `rec` as generation expectGen + 1 only if the stored generation is still expectGen */
  save(rec: Omit<MindRecord, 'gen'>, expectGen: number): Promise<SaveResult>
  /** remove this space's record (forget everything also writes a record; this is for tests and reset) */
  drop(): Promise<void>
}

export function memoryStore(): MindStore {
  let rec: MindRecord | null = null
  return {
    durable: false,
    kind: 'memory',
    async load() {
      return rec
    },
    async peekGen() {
      return rec?.gen ?? 0
    },
    async save(r, expectGen) {
      const gen = rec?.gen ?? 0
      if (gen !== expectGen) return { ok: false, current: rec! }
      rec = { ...r, gen: gen + 1 }
      return { ok: true, gen: gen + 1 }
    },
    async drop() {
      rec = null
    },
  }
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(DB_NAME, 2)
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE)
      if (!r.result.objectStoreNames.contains(GENS)) r.result.createObjectStore(GENS)
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    r.onblocked = () => reject(new Error('indexeddb blocked'))
  })
}

/** One space (`key`: the person and hive it belongs to) in IndexedDB. */
export async function idbStore(key: string, factory: IDBFactory = indexedDB): Promise<MindStore> {
  const db = await openDb(factory)
  return {
    durable: true,
    kind: 'indexeddb',
    async load() {
      const tx = db.transaction(STORE, 'readonly')
      return ((await req(tx.objectStore(STORE).get(key))) as MindRecord | undefined) ?? null
    },
    async peekGen() {
      const tx = db.transaction(GENS, 'readonly')
      return ((await req(tx.objectStore(GENS).get(key))) as number | undefined) ?? 0
    },
    save(r, expectGen) {
      return new Promise<SaveResult>((resolve, reject) => {
        const tx = db.transaction([STORE, GENS], 'readwrite')
        const store = tx.objectStore(STORE)
        let result: SaveResult | null = null
        const get = store.get(key)
        get.onsuccess = () => {
          const cur = get.result as MindRecord | undefined
          const gen = cur?.gen ?? 0
          if (gen !== expectGen) {
            result = { ok: false, current: cur! }
            return // nothing written; the transaction completes empty
          }
          store.put({ ...r, gen: gen + 1 } satisfies MindRecord, key)
          tx.objectStore(GENS).put(gen + 1, key)
          result = { ok: true, gen: gen + 1 }
        }
        // durable only once the transaction has committed
        tx.oncomplete = () => resolve(result!)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error ?? new Error('aborted'))
      })
    },
    async drop() {
      const tx = db.transaction([STORE, GENS], 'readwrite')
      tx.objectStore(GENS).delete(key)
      await req(tx.objectStore(STORE).delete(key))
    },
  }
}

/** IndexedDB when this browser has it, else memory (never durable). */
export async function openStore(key: string): Promise<MindStore> {
  try {
    if (typeof indexedDB !== 'undefined') return await idbStore(key)
  } catch {
    /* blocked or unavailable: fall through */
  }
  return memoryStore()
}
