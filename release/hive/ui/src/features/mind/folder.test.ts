import { describe, expect, it } from 'vitest'
import type { EpochBinding } from '../../lib/identityEpoch'
import { FOLDER_FILE, FOLDER_TEMP, FolderLink, MapHandles, readFolder, saveViaPicker, StaleWrite, writeAtomic, type DirLike, type FileHandleLike } from './folder'
import { AskMemoryStore } from '../../lib/askMemory/store'
import { memoryBackend } from '../../lib/askMemory/backend'
import type { RestorePlan } from '../../lib/askMemory/file'

/**
 * M2, the linked folder, with File System Access MOCKED (an in-memory directory): the handle is kept per person, the
 * file is written whole to a temporary name and renamed over the real one, permission is asked again only on a click,
 * and nothing is written once the person or identity changed. Invented data only.
 */

class MemDir implements DirLike {
  files = new Map<string, string>()
  log: string[] = []
  permission: 'granted' | 'prompt' | 'denied' = 'granted'
  canMove = true
  failWrite = false
  /** r2.1: hold one stage open until `release()` (create, write, close or rename) */
  pauseAt: 'create' | 'write' | 'close' | 'move' | null = null
  /** r2.2: reading the file fails with this error name (the file exists) */
  readFails: string | null = null
  private gate: Promise<void> | null = null
  release: () => void = () => undefined
  private async hold(stage: 'create' | 'write' | 'close' | 'move') {
    if (this.pauseAt !== stage) return
    this.log.push(`paused at ${stage}`)
    this.gate ??= new Promise<void>((r) => (this.release = r))
    await this.gate
  }
  constructor(readonly name: string) {}
  async queryPermission() {
    return this.permission
  }
  async requestPermission() {
    this.log.push('ask')
    this.permission = 'granted'
    return this.permission
  }
  async getFileHandle(name: string, o?: { create?: boolean }): Promise<FileHandleLike> {
    if (!this.files.has(name)) {
      if (!o?.create) throw new DOMException('not found', 'NotFoundError')
      this.files.set(name, '')
    }
    const handle: FileHandleLike = {
      getFile: async () => {
        if (this.readFails) throw new DOMException('cannot read', this.readFails)
        return { text: async () => this.files.get(name) ?? '' }
      },
      createWritable: async () => {
        await this.hold('create')
        let buf = ''
        return {
          write: async (d: string) => {
            await this.hold('write')
            if (this.failWrite) throw new Error('disk full')
            this.log.push(`writing ${name}`)
            buf += d
          },
          close: async () => {
            await this.hold('close')
            this.files.set(name, buf)
            this.log.push(`wrote ${name}`)
          },
          abort: async () => void this.log.push(`aborted ${name}`),
        }
      },
      ...(this.canMove
        ? {
            move: async (_d: DirLike, to: string) => {
              await this.hold('move')
              this.files.set(to, this.files.get(name) ?? '')
              this.files.delete(name)
              this.log.push(`renamed ${name} → ${to}`)
            },
          }
        : {}),
    }
    return handle
  }
  async removeEntry(name: string) {
    this.files.delete(name)
    this.log.push(`removed ${name}`)
  }
}

function epochKit() {
  let epoch = 0
  const bind = (): EpochBinding => {
    const at = epoch
    const current = () => epoch === at
    return { epoch: at, current, commit: <R,>(w: () => R) => (current() ? w() : (Symbol('stale') as never)) }
  }
  return { bind, change: () => void epoch++ }
}

const ADA = { principal: 'user:p_inv_ada', hive: 'sim@test' }
const TOMAS = { principal: 'user:p_inv_tomas', hive: 'sim@test' }
let n = 0
const EMPTY_PLAN: RestorePlan = { add: [], update: [], addTalks: [], forgetBeliefs: [], forgetTalks: [], tombs: [], watermark: null, skipped: { forgotten: 0, known: 0, older: 0, private: 0 } }
/**
 * A memory with something in it. Its preview of a folder file says "nothing new" for what it wrote itself, and "new
 * notes" for a file holding `"earlier"` (a saved memory this browser lacks).
 */
const memory = {
  exportFile: async () => ({ file: { entries: [{ type: 'talk', id: 'pi_x' }], tombstones: [], forgot_all_at: 0 } as never, text: `{"format":"omegahive-mind-memory","n":${++n}}` }),
  previewRestore: async (raw: string) => ({ ok: true as const, file: {} as never, token: {} as never, plan: raw.includes('earlier') ? { ...EMPTY_PLAN, add: [{} as never] } : EMPTY_PLAN }),
}

function setup(dir = new MemDir('Mind backups')) {
  const id = epochKit()
  const handles = new MapHandles()
  const link = new FolderLink({ pick: async () => dir, handles, now: () => 1, bind: id.bind, memory })
  return { dir, id, handles, link }
}

describe('writing atomically', () => {
  it('writes the whole file to a temporary name, then renames it over the real one', async () => {
    const d = new MemDir('x')
    d.files.set(FOLDER_FILE, 'old')
    expect(await writeAtomic(d, 'new')).toBe('renamed')
    expect(d.files.get(FOLDER_FILE)).toBe('new')
    expect(d.files.has(FOLDER_TEMP)).toBe(false)
    expect(d.log).toEqual([`writing ${FOLDER_TEMP}`, `wrote ${FOLDER_TEMP}`, `renamed ${FOLDER_TEMP} → ${FOLDER_FILE}`])
  })
  it('without a rename, it commits the real file through the browser’s own swap and drops the temporary one', async () => {
    const d = new MemDir('x')
    d.canMove = false
    expect(await writeAtomic(d, 'new')).toBe('swapped')
    expect(d.files.get(FOLDER_FILE)).toBe('new')
    expect(d.files.has(FOLDER_TEMP)).toBe(false)
  })
  it('a failed write leaves the real file as it was', async () => {
    const d = new MemDir('x')
    d.files.set(FOLDER_FILE, 'old')
    d.failWrite = true
    await expect(writeAtomic(d, 'new')).rejects.toThrow()
    expect(d.files.get(FOLDER_FILE)).toBe('old')
    expect(d.log).toContain(`aborted ${FOLDER_TEMP}`)
  })
})

describe('the linked folder', () => {
  it('link keeps the handle for this person and writes the file at once', async () => {
    const s = setup()
    await s.link.attach(ADA)
    expect(s.link.state.linked).toBeNull()
    expect(await s.link.link()).toBe(true)
    expect(s.link.state.linked).toBe('Mind backups')
    expect(await readFolder(s.dir)).toMatch(/omegahive-mind-memory/)
    // a later visit (a new page) finds it again, for this person only
    const again = new FolderLink({ pick: async () => s.dir, handles: s.handles, now: () => 2, bind: s.id.bind, memory })
    await again.attach(ADA)
    expect(again.state.linked).toBe('Mind backups')
    await again.attach(TOMAS)
    expect(again.state.linked).toBeNull()
  })

  it('a later visit without permission writes nothing until the person allows it', async () => {
    const s = setup()
    await s.link.attach(ADA)
    await s.link.link()
    s.dir.permission = 'prompt'
    const before = s.dir.files.get(FOLDER_FILE)
    const later = new FolderLink({ pick: async () => s.dir, handles: s.handles, now: () => 3, bind: s.id.bind, memory })
    await later.attach(ADA)
    expect(later.state.permission).toBe('prompt')
    expect(await later.mirror()).toBe(false)
    expect(s.dir.files.get(FOLDER_FILE)).toBe(before)
    expect(await later.read()).toBeNull()
    expect(await later.allow()).toBe(true)
    expect(s.dir.log).toContain('ask')
    expect(s.dir.files.get(FOLDER_FILE)).not.toBe(before)
  })

  it('nothing is written once the identity changed', async () => {
    const s = setup()
    await s.link.attach(ADA)
    await s.link.link()
    const before = s.dir.files.get(FOLDER_FILE)
    const slow = { ...memory, exportFile: async () => (s.id.change(), memory.exportFile()) }
    const l2 = new FolderLink({ pick: async () => s.dir, handles: s.handles, now: () => 4, bind: s.id.bind, memory: slow })
    await l2.attach(ADA)
    expect(await l2.mirror()).toBe(false)
    expect(s.dir.files.get(FOLDER_FILE)).toBe(before)
  })

  it('an empty memory here never overwrites a saved one in the folder: it waits for a restore', async () => {
    const dir = new MemDir('Old backups')
    dir.files.set(FOLDER_FILE, '{"format":"omegahive-mind-memory","saved":"earlier"}')
    const id = epochKit()
    const empty = { ...memory, exportFile: async () => ({ file: { entries: [], tombstones: [], forgot_all_at: 0 } as never, text: '{"empty":true}' }) }
    const l = new FolderLink({ pick: async () => dir, handles: new MapHandles(), now: () => 1, bind: id.bind, memory: empty })
    await l.attach(ADA)
    expect(await l.link()).toBe(false)
    expect(l.state.guarded).toBe('newer')
    expect(dir.files.get(FOLDER_FILE)).toMatch(/earlier/)
    expect(await l.read()).toMatch(/earlier/)
  })

  it('unlink forgets the folder', async () => {
    const s = setup()
    await s.link.attach(ADA)
    await s.link.link()
    await s.link.unlink()
    expect(s.link.state.linked).toBeNull()
    expect(await s.handles.get([...(s.handles as unknown as { m: Map<string, DirLike> }).m.keys()][0] ?? 'none')).toBeUndefined()
  })

  it('a browser without the folder picker offers none (M1 only)', async () => {
    const l = new FolderLink({ pick: null, handles: new MapHandles(), now: () => 1, bind: epochKit().bind, memory })
    await l.attach(ADA)
    expect(l.state.supported).toBe(false)
    expect(await l.link()).toBe(false)
  })
})

const T0 = Date.parse('2026-10-09T12:00:00Z')
/** One browser's real memory for Ada (in-memory storage standing in for IndexedDB), its own salt. */
async function browserMemory(principal = ADA.principal) {
  const m = new AskMemoryStore({ backend: () => ({ ...memoryBackend(), durable: true }), now: () => T0, persist: () => undefined, channel: null })
  m.use({ principal, hive: ADA.hive })
  await m.whenReady()
  return m
}
const talkOf = (id: string, words: string) => ({ id, turn_id: `t_${id}`, at: T0 - 3_600_000, words, answer: `Invented answer: ${words}`, truncated: false })

describe('r2.1 P1: saved history is never written over before a restore (the stand-in’s sequence)', () => {
  it('a wiped browser links the folder, collects one conversation, and the mirror still never writes over the saved file', async () => {
    // the saved history: Ada's earlier browser, two conversations, in the folder
    const earlier = await browserMemory()
    await earlier.rememberTalks([talkOf('pi_old1', 'Invented old question one'), talkOf('pi_old2', 'Invented old question two')])
    const saved = (await earlier.exportFile())!.text
    const dir = new MemDir('Mind backups')
    dir.files.set(FOLDER_FILE, saved)
    // a wiped browser (cleared site data): empty memory, a new salt
    const wiped = await browserMemory()
    const id = epochKit()
    const l = new FolderLink({ pick: async () => dir, handles: new MapHandles(), now: () => 1, bind: id.bind, memory: wiped })
    await l.attach(ADA)
    expect(await l.link()).toBe(false)
    expect(l.state.guarded).toBe('newer')
    // the automatic collect adds one new conversation here: the export is no longer empty
    await wiped.rememberTalks([talkOf('pi_new', 'Invented new question')])
    expect(await l.mirror()).toBe(false)
    expect(dir.files.get(FOLDER_FILE)).toBe(saved)
    // the consented restore: merged here, the protection lifts, and the folder then holds everything
    const p = await wiped.previewRestore(dir.files.get(FOLDER_FILE)!)
    if (!p || !p.ok) throw new Error('refused')
    await wiped.restore(p.file, p.token)
    expect(await l.restored()).toBe(true)
    expect(l.state.guarded).toBeNull()
    const now = dir.files.get(FOLDER_FILE)!
    expect(now).toMatch(/pi_old1/)
    expect(now).toMatch(/pi_old2/)
    expect(now).toMatch(/pi_new/)
  })

  it('on a later visit with the handle kept, a folder holding more is protected before anything is written', async () => {
    const earlier = await browserMemory()
    await earlier.rememberTalks([talkOf('pi_old1', 'Invented old question one')])
    const dir = new MemDir('Mind backups')
    const handles = new MapHandles()
    const id = epochKit()
    // linked earlier, from the earlier browser
    const first = new FolderLink({ pick: async () => dir, handles, now: () => 1, bind: id.bind, memory: earlier })
    await first.attach(ADA)
    expect(await first.link()).toBe(true)
    const saved = dir.files.get(FOLDER_FILE)
    // the same handle, now in a wiped browser
    const wiped = await browserMemory()
    await wiped.rememberTalks([talkOf('pi_new', 'Invented new question')])
    const later = new FolderLink({ pick: async () => dir, handles, now: () => 2, bind: id.bind, memory: wiped })
    await later.attach(ADA)
    expect(later.state.guarded).toBe('newer')
    expect(await later.mirror()).toBe(false)
    expect(dir.files.get(FOLDER_FILE)).toBe(saved)
  })

  it('only the person’s explicit replace writes over it', async () => {
    const dir = new MemDir('Mind backups')
    dir.files.set(FOLDER_FILE, '{"format":"omegahive-mind-memory","saved":"earlier"}')
    const l = new FolderLink({ pick: async () => dir, handles: new MapHandles(), now: () => 1, bind: epochKit().bind, memory })
    await l.attach(ADA)
    await l.link()
    expect(l.state.guarded).toBe('newer')
    expect(await l.mirror()).toBe(false)
    expect(await l.replaceFolderCopy()).toBe(true)
    expect(dir.files.get(FOLDER_FILE)).not.toMatch(/earlier/)
    expect(l.state.guarded).toBeNull()
  })

  it('the protection is latched: it holds even when the folder later no longer differs, until the person decides', async () => {
    const dir = new MemDir('Mind backups')
    dir.files.set(FOLDER_FILE, '{"format":"omegahive-mind-memory","saved":"earlier"}')
    const l = new FolderLink({ pick: async () => dir, handles: new MapHandles(), now: () => 1, bind: epochKit().bind, memory })
    await l.attach(ADA)
    await l.link()
    expect(l.state.guarded).toBe('newer')
    // the folder's file goes away (another device, the person's own file manager): still nothing written unasked
    dir.files.delete(FOLDER_FILE)
    expect(await l.mirror()).toBe(false)
    expect(dir.files.has(FOLDER_FILE)).toBe(false)
    expect(l.state.guarded).toBe('newer')
  })

  it('a file that is not this person’s readable memory is never written over unasked', async () => {
    const dir = new MemDir('Mind backups')
    dir.files.set(FOLDER_FILE, 'something else entirely')
    const wiped = await browserMemory()
    await wiped.rememberTalks([talkOf('pi_new', 'Invented new question')])
    const l = new FolderLink({ pick: async () => dir, handles: new MapHandles(), now: () => 1, bind: epochKit().bind, memory: wiped })
    await l.attach(ADA)
    expect(await l.link()).toBe(false)
    expect(l.state.guarded).toBe('unreadable')
    expect(dir.files.get(FOLDER_FILE)).toBe('something else entirely')
  })
})

describe('r2.1 P1: an identity change cancels a write at every stage', () => {
  // a rename is one atomic step: what matters is the check just before it, which the 'close' case proves (the temporary
  // file is closed while the identity changes, and it is then never renamed over the real one)
  for (const stage of ['create', 'write', 'close'] as const) {
    it(`paused at ${stage}, the identity changes: nothing reaches the real file, nothing is renamed`, async () => {
      const s = setup()
      await s.link.attach(ADA)
      await s.link.link()
      const before = s.dir.files.get(FOLDER_FILE)
      s.dir.pauseAt = stage
      s.dir.log.length = 0
      const done = s.link.replaceFolderCopy()
      for (let i = 0; i < 50 && !s.dir.log.includes(`paused at ${stage}`); i++) await Promise.resolve()
      expect(s.dir.log).toContain(`paused at ${stage}`)
      s.id.change()
      s.dir.release()
      expect(await done).toBe(false)
      expect(s.dir.files.get(FOLDER_FILE)).toBe(before)
      expect(s.dir.log.some((l) => l.startsWith('renamed'))).toBe(false)
      if (stage === 'write') expect(s.dir.log).toContain(`aborted ${FOLDER_TEMP}`)
      // checked before every stage: once the identity moved, not even the temporary file is written to
      if (stage === 'create') expect(s.dir.log.some((l) => l.startsWith('writing') || l.startsWith('wrote'))).toBe(false)
    })
  }
})

describe('r2.1 P1: the save picker writes nothing for a person who is no longer signed in', () => {
  it('the picker returns after an identity change: nothing is written', async () => {
    const id = epochKit()
    const binding = id.bind()
    const d = new MemDir('Downloads')
    const handle = await d.getFileHandle('omegahive-mind-memory.json', { create: true })
    const pick = async () => (id.change(), Object.assign(handle, { name: 'omegahive-mind-memory.json' }))
    await expect(saveViaPicker(pick, 'x.json', 'Ada’s memory', () => binding.current())).rejects.toBeInstanceOf(StaleWrite)
    expect(d.files.get('omegahive-mind-memory.json')).toBe('')
    expect(d.log.some((l) => l.startsWith('wrote'))).toBe(false)
  })
  it('the identity changes while the write is open: it is aborted, nothing committed', async () => {
    const id = epochKit()
    const binding = id.bind()
    const d = new MemDir('Downloads')
    d.pauseAt = 'write'
    const handle = await d.getFileHandle('m.json', { create: true })
    const run = saveViaPicker(async () => Object.assign(handle, { name: 'm.json' }), 'm.json', 'Ada’s memory', () => binding.current())
    for (let i = 0; i < 50 && !d.log.includes('paused at write'); i++) await Promise.resolve()
    id.change()
    d.release()
    await expect(run).rejects.toBeInstanceOf(StaleWrite)
    expect(d.files.get('m.json')).toBe('')
    expect(d.log).toContain('aborted m.json')
  })
})

describe('r2.2 P1: only a confirmed absence counts as no saved file', () => {
  for (const name of ['NotReadableError', 'NotAllowedError', 'SecurityError', 'TypeError']) {
    it(`an existing file that cannot be read (${name}) is protected: the mirror never writes, the bytes stay`, async () => {
      const dir = new MemDir('Mind backups')
      const saved = '{"format":"omegahive-mind-memory","saved":"earlier, but unreadable now"}'
      dir.files.set(FOLDER_FILE, saved)
      dir.readFails = name
      const l = new FolderLink({ pick: async () => dir, handles: new MapHandles(), now: () => 1, bind: epochKit().bind, memory })
      await l.attach(ADA)
      expect(await l.link()).toBe(false)
      expect(l.state.guarded).toBe('unreadable')
      expect(await l.mirror()).toBe(false)
      expect(dir.files.get(FOLDER_FILE)).toBe(saved)
      expect(dir.log.some((x) => x.startsWith('writing') || x.startsWith('wrote') || x.startsWith('renamed'))).toBe(false)
    })
  }
  it('a confirmed absence (NotFoundError) lets the first write through', async () => {
    const dir = new MemDir('Mind backups')
    const l = new FolderLink({ pick: async () => dir, handles: new MapHandles(), now: () => 1, bind: epochKit().bind, memory })
    await l.attach(ADA)
    expect(await l.link()).toBe(true)
    expect(l.state.guarded).toBeNull()
    expect(dir.files.get(FOLDER_FILE)).toMatch(/omegahive-mind-memory/)
  })
  it('a name the browser will not open as a file (TypeMismatchError: a folder of that name) is protected too', async () => {
    const dir = new MemDir('Mind backups')
    dir.files.set(FOLDER_FILE, 'kept')
    const real = dir.getFileHandle.bind(dir)
    dir.getFileHandle = async (n: string, o?: { create?: boolean }) => {
      if (n === FOLDER_FILE && !o?.create) throw new DOMException('a directory', 'TypeMismatchError')
      return real(n, o)
    }
    const l = new FolderLink({ pick: async () => dir, handles: new MapHandles(), now: () => 1, bind: epochKit().bind, memory })
    await l.attach(ADA)
    expect(await l.link()).toBe(false)
    expect(l.state.guarded).toBe('unreadable')
    expect(dir.files.get(FOLDER_FILE)).toBe('kept')
  })
  it('the three outcomes', async () => {
    const { readFolderFile } = await import('./folder')
    const d = new MemDir('x')
    expect(await readFolderFile(d)).toEqual({ kind: 'absent' })
    d.files.set(FOLDER_FILE, 'abc')
    expect(await readFolderFile(d)).toEqual({ kind: 'read', text: 'abc' })
    d.readFails = 'NotReadableError'
    expect(await readFolderFile(d)).toEqual({ kind: 'unreadable' })
  })
})
