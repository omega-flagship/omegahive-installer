/**
 * Memory durability M2: a linked folder (File System Access, Chromium). The person picks a folder once; its handle is
 * kept in IndexedDB (per person and hive); after each change to what their mind remembers, the same versioned file
 * as M1 (lib/askMemory/file) is written there, debounced, atomically: written whole to a temporary name, then renamed
 * over the real one. If this browser's memory comes back empty while a folder is linked, the page offers "Restore from
 * your folder" (through M1's preview and merge). Browsers without the API keep M1 only.
 *
 * Every write is bound to the person and identity it started under (lib/identityEpoch). Nothing here is sent anywhere:
 * the file goes to the person's own disk. Permission is asked again only on the person's own click.
 */
import { useSyncExternalStore } from 'react'
import { askMemory, dbName, sha256, type AskMemoryStore, type MemoryOwner } from '../../lib/askMemory'
import { bindEpoch, onIdentityChange, type EpochBinding } from '../../lib/identityEpoch'
import { markSaved, memoryMark } from './durability'
import { planEmpty } from '../../lib/askMemory'
import { forgetsOf } from '../../lib/askMemory'

export const FOLDER_FILE = 'omegahive-mind-memory.json'
export const FOLDER_TEMP = `${FOLDER_FILE}.tmp`
export const MIRROR_DEBOUNCE_MS = 2500

type Perm = 'granted' | 'denied' | 'prompt'
export interface WritableLike {
  write(data: string): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}
export interface FileHandleLike {
  getFile(): Promise<{ text(): Promise<string> }>
  createWritable(): Promise<WritableLike>
  move?(dir: DirLike, name: string): Promise<void>
}
export interface DirLike {
  readonly name: string
  queryPermission?(o: { mode: 'readwrite' }): Promise<Perm>
  requestPermission?(o: { mode: 'readwrite' }): Promise<Perm>
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FileHandleLike>
  removeEntry?(name: string): Promise<void>
}
/** Where the folder's handle is kept between visits (IndexedDB in the browser; a Map in tests). */
export interface HandleStore {
  get(key: string): Promise<DirLike | undefined>
  set(key: string, dir: DirLike): Promise<void>
  del(key: string): Promise<void>
}

export interface FolderDeps {
  /** the browser's folder picker (null: not offered here; M1 only) */
  pick: (() => Promise<DirLike>) | null
  handles: HandleStore
  now: () => number
  /** the identity epoch (lib/identityEpoch bindEpoch): every write after an await is bound to it */
  bind: () => EpochBinding
  /** the person's memory (lib/askMemory): what is written is its export; the folder's file is compared by its preview */
  memory: Pick<AskMemoryStore, 'exportFile' | 'previewRestore'>
}

/** Thrown when the identity a write started under is no longer current: nothing more is written, nothing renamed. */
export class StaleWrite extends Error {
  constructor() {
    super('stale')
    this.name = 'StaleWrite'
  }
}

/**
 * One file written whole, with the identity checked before EVERY stage (r2.1 P1): before the writable is opened,
 * before the write, before the close that commits it. A stage that finds the identity moved aborts the writable
 * (nothing it held is committed) and throws StaleWrite. A failure aborts it too.
 */
export async function writeWhole(file: FileHandleLike, text: string, alive: () => boolean): Promise<void> {
  if (!alive()) throw new StaleWrite()
  const w = await file.createWritable()
  try {
    if (!alive()) throw new StaleWrite()
    await w.write(text)
    if (!alive()) throw new StaleWrite()
    await w.close()
  } catch (e) {
    await w.abort?.().catch(() => undefined)
    throw e
  }
}

/**
 * Write the file atomically: whole to a temporary name, then renamed over the real one. `alive` is checked before
 * every stage (open, write, close, rename): once it fails nothing more is written and nothing is renamed.
 */
export async function writeAtomic(dir: DirLike, text: string, alive: () => boolean = () => true): Promise<'renamed' | 'swapped'> {
  if (!alive()) throw new StaleWrite()
  const tmp = await dir.getFileHandle(FOLDER_TEMP, { create: true })
  await writeWhole(tmp, text, alive)
  if (!alive()) throw new StaleWrite()
  if (typeof tmp.move === 'function') {
    try {
      await tmp.move(dir, FOLDER_FILE)
      return 'renamed'
    } catch {
      /* this browser will not rename over an existing file: below */
    }
  }
  // no rename over the old file here: the browser's own writable is committed whole on close (it writes a swap file
  // and swaps it in), so the real file is never half-written; the temporary one is then removed
  if (!alive()) throw new StaleWrite()
  const fin = await dir.getFileHandle(FOLDER_FILE, { create: true })
  await writeWhole(fin, text, alive)
  await dir.removeEntry?.(FOLDER_TEMP).catch(() => undefined)
  return 'swapped'
}

/** The browser's save picker (Chromium). */
export type SavePicker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileHandleLike & { name: string }>

/**
 * M1 "Download" through the save picker (r2.1 P1): the picker may stay open while the identity changes; when it
 * returns, nothing is written unless the identity it was opened under is still current, and every stage is checked
 * again. Resolves to the file's name once the browser accepted the write.
 */
export async function saveViaPicker(pick: SavePicker, suggestedName: string, text: string, alive: () => boolean): Promise<string> {
  const h = await pick({ suggestedName, types: [{ description: 'Mind memory', accept: { 'application/json': ['.json'] } }] })
  await writeWhole(h, text, alive)
  return h.name
}

/** The file in the folder, or null when there is none. */
/**
 * What reading the folder's file found (r2.2 P1): `absent` ONLY when the browser confirms there is no such file
 * (NotFoundError); `unreadable` when it may exist but could not be read (permission, a directory of that name, a
 * damaged file, any other error): the folder may hold more, so nothing may be written over it; `read` with its text.
 */
export type FolderRead = { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'read'; text: string }
const notFound = (e: unknown) => (e as { name?: unknown } | null)?.name === 'NotFoundError'

export async function readFolderFile(dir: DirLike): Promise<FolderRead> {
  let f: FileHandleLike
  try {
    f = await dir.getFileHandle(FOLDER_FILE)
  } catch (e) {
    return notFound(e) ? { kind: 'absent' } : { kind: 'unreadable' }
  }
  try {
    return { kind: 'read', text: await (await f.getFile()).text() }
  } catch (e) {
    // the handle was found; a file gone between the two steps is confirmed absent, anything else is unreadable
    return notFound(e) ? { kind: 'absent' } : { kind: 'unreadable' }
  }
}

/** The file in the folder, or null when there is none or it cannot be read (for "Restore from your folder"). */
export async function readFolder(dir: DirLike): Promise<string | null> {
  const r = await readFolderFile(dir)
  return r.kind === 'read' ? r.text : null
}

/** IndexedDB for the folder handles (handles are structured-cloneable in Chromium). */
export function idbHandles(): HandleStore {
  const open = () =>
    new Promise<IDBDatabase>((ok, no) => {
      const r = indexedDB.open('omegahive-mind-folder', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('links')
      r.onsuccess = () => ok(r.result)
      r.onerror = () => no(r.error)
    })
  const run = async <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const d = await open()
    try {
      return await new Promise<T>((ok, no) => {
        const t = d.transaction('links', mode)
        const r = f(t.objectStore('links'))
        t.oncomplete = () => ok(r.result as T)
        t.onerror = () => no(t.error)
      })
    } finally {
      d.close()
    }
  }
  return {
    get: (k) => run<DirLike | undefined>('readonly', (s) => s.get(k)),
    set: (k, dir) => run<void>('readwrite', (s) => s.put(dir, k)),
    del: (k) => run<void>('readwrite', (s) => s.delete(k)),
  }
}

export function browserDeps(): FolderDeps {
  const w = typeof window !== 'undefined' ? (window as unknown as { showDirectoryPicker?: (o: unknown) => Promise<DirLike> }) : {}
  const ok = typeof w.showDirectoryPicker === 'function' && typeof indexedDB !== 'undefined'
  return { pick: ok ? () => w.showDirectoryPicker!({ id: 'omegahive-mind-memory', mode: 'readwrite' }) : null, handles: ok ? idbHandles() : new MapHandles(), now: () => Date.now(), bind: bindEpoch, memory: askMemory }
}

export class MapHandles implements HandleStore {
  private m = new Map<string, DirLike>()
  async get(k: string) {
    return this.m.get(k)
  }
  async set(k: string, d: DirLike) {
    this.m.set(k, d)
  }
  async del(k: string) {
    this.m.delete(k)
  }
}

const keyOf = (o: MemoryOwner) => sha256(`mind-folder-key:v1\n${dbName(o)}`).slice(0, 32)

export interface FolderState {
  /** this browser offers folder linking */
  supported: boolean
  /** the linked folder's name (null: none) */
  linked: string | null
  /** whether the page may write there now ('prompt': the person must allow it again, by a click) */
  permission: Perm | null
  /** when the file was last written there (null: not in this page's life) */
  wroteAt: number | null
  /**
   * r2.1 P1, overwrite protection (latched): the folder's file holds something this browser does not (notes,
   * conversations, forget markers or a forget everything; or it cannot be read as this person's memory). While it is
   * set the mirror never writes; it clears only on a consented restore from the folder (after which nothing there is
   * missing here) or on the person's explicit, confirmed "Replace the folder's copy with this browser's".
   */
  guarded: 'newer' | 'unreadable' | null
  error: string | null
}
const EMPTY: FolderState = { supported: false, linked: null, permission: null, wroteAt: null, error: null, guarded: null }

/**
 * One person's linked folder, bound to the identity epoch. `attach(owner)` reads the kept handle; `link()` picks one
 * (a click); `mirror()` writes the current memory there (debounced by the caller); `allow()` asks permission again.
 */
export class FolderLink {
  private deps: FolderDeps
  private dir: DirLike | null = null
  private owner: MemoryOwner | null = null
  private gen = 0
  private listeners = new Set<() => void>()
  state: FolderState = EMPTY
  constructor(deps: FolderDeps) {
    this.deps = deps
    this.state = { ...EMPTY, supported: !!deps.pick }
  }
  subscribe = (fn: () => void) => (this.listeners.add(fn), () => void this.listeners.delete(fn))
  private set(p: Partial<FolderState>) {
    this.state = { ...this.state, ...p }
    for (const l of this.listeners) l()
  }

  /** The person whose folder this is now (null: nobody): forgets the previous person's handle at once. */
  async attach(owner: MemoryOwner | null): Promise<void> {
    const at = ++this.gen
    this.owner = owner
    this.dir = null
    this.set({ ...EMPTY, supported: !!this.deps.pick })
    if (!owner || !this.deps.pick) return
    const binding = this.deps.bind()
    const dir = await this.deps.handles.get(keyOf(owner)).catch(() => undefined)
    if (at !== this.gen || !binding.current() || !dir) return
    this.dir = dir
    const permission = (await dir.queryPermission?.({ mode: 'readwrite' }).catch(() => 'prompt' as Perm)) ?? 'granted'
    if (at !== this.gen || !binding.current()) return
    this.set({ linked: dir.name, permission })
    // on every visit: a folder holding what this browser does not is protected from being written over
    if (permission === 'granted') {
      const more = await this.folderHasMore(dir, () => at === this.gen && binding.current())
      if (more && more !== 'none') this.set({ guarded: more })
    }
  }

  /** Pick a folder (the person's click) and write the file there now. */
  async link(): Promise<boolean> {
    const owner = this.owner
    if (!owner || !this.deps.pick) return false
    const at = this.gen
    const binding = this.deps.bind()
    let dir: DirLike
    try {
      dir = await this.deps.pick()
    } catch {
      return false // the person closed the picker
    }
    if (at !== this.gen || !binding.current()) return false
    await this.deps.handles.set(keyOf(owner), dir)
    if (at !== this.gen || !binding.current()) return false
    this.dir = dir
    this.set({ linked: dir.name, permission: 'granted', error: null, guarded: null })
    // mirror() compares first: a folder holding what this browser does not is latched, never written over
    return this.mirror()
  }

  async unlink(): Promise<void> {
    if (!this.owner) return
    await this.deps.handles.del(keyOf(this.owner)).catch(() => undefined)
    this.dir = null
    this.set({ linked: null, permission: null, wroteAt: null, error: null })
  }

  /** Ask for permission again (must follow the person's click). */
  async allow(): Promise<boolean> {
    const dir = this.dir
    if (!dir) return false
    const at = this.gen
    const p = (await dir.requestPermission?.({ mode: 'readwrite' }).catch(() => 'denied' as Perm)) ?? 'granted'
    if (at !== this.gen) return false
    this.set({ permission: p })
    return p === 'granted' ? this.mirror() : false
  }

  /** Write the person's memory to the folder now (when linked and allowed). True when the browser accepted the write. */
  /**
   * Does the folder's file hold anything this browser does not? (r2.1 P1) Compared through the same restore plan a
   * restore would run: anything it would add, update, forget, or keep as a marker or watermark means yes. A file that
   * is not this person's readable memory also means yes (it is never written over unasked). Null: the identity moved.
   */
  private async folderHasMore(dir: DirLike, alive: () => boolean): Promise<FolderState['guarded'] | 'none' | null> {
    const read = await readFolderFile(dir)
    if (!alive()) return null
    // only a confirmed absence (or an empty file) lets the mirror write; a file it could not read is protected
    if (read.kind === 'unreadable') return 'unreadable'
    if (read.kind === 'absent' || !read.text.trim()) return 'none'
    const p = await this.deps.memory.previewRestore(read.text)
    if (!alive() || p === null) return null
    if (!p.ok) return 'unreadable'
    return planEmpty(p.plan) ? 'none' : 'newer'
  }

  /**
   * Write the person's memory to the folder now (when linked, allowed and not overwrite-protected). True when the
   * browser accepted the write. `replace`: the person confirmed replacing the folder's copy (skips the protection).
   */
  async mirror(replace = false): Promise<boolean> {
    const dir = this.dir
    const owner = this.owner
    if (!dir || !owner || this.state.permission !== 'granted') return false
    if (this.state.guarded && !replace) return false
    const at = this.gen
    const binding = this.deps.bind()
    const alive = () => at === this.gen && binding.current()
    if (!replace) {
      // every write first checks that the folder holds nothing this browser does not; if it does, the latch is set
      const more = await this.folderHasMore(dir, alive)
      if (more === null) return false
      if (more !== 'none') {
        this.set({ guarded: more })
        return false
      }
    }
    const out = await this.deps.memory.exportFile()
    if (!out || !alive()) return false
    try {
      await writeAtomic(dir, out.text, alive)
    } catch (e) {
      if (!(e instanceof StaleWrite) && alive()) this.set({ error: 'The folder could not be written just now; your memory is still in this browser.' })
      return false
    }
    if (!alive()) return false
    // written and closed: the browser accepted it, so this is saved
    markSaved(owner, memoryMark({ beliefs: out.file.entries.flatMap((e) => (e.type === 'belief' ? [e] : [])), talks: out.file.entries.flatMap((e) => (e.type === 'talk' ? [e] : [])), forgets: forgetsOf(out.file.tombstones, out.file.forgot_all_at) }))
    this.set({ wroteAt: this.deps.now(), error: null, guarded: null })
    return true
  }

  /**
   * After a consented restore from the folder: compare again; the protection clears only when the folder now holds
   * nothing this browser does not, and then the folder is written (so it holds everything).
   */
  async restored(): Promise<boolean> {
    const dir = this.dir
    if (!dir || this.state.permission !== 'granted') return false
    const at = this.gen
    const binding = this.deps.bind()
    const alive = () => at === this.gen && binding.current()
    const more = await this.folderHasMore(dir, alive)
    if (more === null) return false
    if (more !== 'none') {
      this.set({ guarded: more })
      return false
    }
    this.set({ guarded: null })
    return this.mirror()
  }

  /** The person's explicit, confirmed decision: replace the folder's copy with this browser's (clears the protection). */
  async replaceFolderCopy(): Promise<boolean> {
    return this.mirror(true)
  }

  /** The file in the linked folder, for "Restore from your folder" (null: none, or not allowed). */
  async read(): Promise<string | null> {
    const dir = this.dir
    if (!dir || this.state.permission !== 'granted') return null
    const at = this.gen
    const text = await readFolder(dir)
    return at === this.gen ? text : null
  }
}

/** This page's linked folder. */
export const folderLink = new FolderLink(browserDeps())
onIdentityChange(() => void folderLink.attach(null))

export function useFolder(): FolderState {
  return useSyncExternalStore(folderLink.subscribe, () => folderLink.state, () => folderLink.state)
}

/**
 * Mirror the person's memory into their linked folder after each change, debounced; only when what is remembered (or
 * forgotten) actually changed since the last write. Returns a stop function.
 */
export function startMirror(delay = MIRROR_DEBOUNCE_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let last = ''
  const tick = () => {
    const v = askMemory.getView()
    if (!v.owner || !v.ready || !folderLink.state.linked || folderLink.state.permission !== 'granted') return
    const mark = memoryMark(v)
    if (mark === last) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void folderLink.mirror().then((ok) => {
        if (ok) last = mark
      })
    }, delay)
  }
  const offMem = askMemory.subscribe(tick)
  const offFolder = folderLink.subscribe(tick)
  return () => {
    offMem()
    offFolder()
    if (timer) clearTimeout(timer)
  }
}
