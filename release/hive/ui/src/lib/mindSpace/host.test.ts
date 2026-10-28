// Storage rules (personal-mind review): durability is explicit, the forget watermark and tombstones are written with
// the generation, and a writer that finds a newer generation merges it (a union) before writing.
import { describe, expect, it } from 'vitest'
import { MindHost } from './host'
import { memoryStore, type MindRecord, type MindStore } from './persist'
import { lexicalEmbedder } from '../askMemory/embed'

const opts = (self: string) => ({ self, salt: `salt-${self}`, now: () => 1000 })

/** Two hosts (two tabs) on one shared record, durable like IndexedDB (compare-and-set on the generation). */
function sharedStore(): () => MindStore {
  let rec: MindRecord | null = null
  return () => ({
    durable: true,
    kind: 'indexeddb',
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
  })
}

describe('MindHost storage', () => {
  it('memory storage is never durable', async () => {
    const h = await MindHost.open(memoryStore(), opts('m-a'))
    const r = await h.run('addBelief', ['b1', 'fact', 'one', { f: 1, c: 0.5 }])
    expect(r).toMatchObject({ durable: false, gen: 1 })
  })

  it('a durable store answers durable once written; reads and refusals write nothing', async () => {
    const open = sharedStore()
    const h = await MindHost.open(open(), opts('m-a'))
    expect(await h.run('addBelief', ['b1', 'fact', 'one', { f: 1, c: 0.5 }])).toMatchObject({ durable: true, gen: 1 })
    expect(await h.run('recall', ['one', 3])).toMatchObject({ durable: false, gen: 1 })
    expect(await h.run('addBelief', ['b1', 'fact', 'two', { f: 1, c: 0.5 }])).toMatchObject({ durable: false, gen: 1 })
    const again = await MindHost.open(open(), opts('m-z'))
    expect(again.core.belief('b1')!.statement).toBe('one')
    expect(again.core.vectors.has('b1')).toBe(true)
  })

  it('the watermark and tombstones are written with the generation and come back on load', async () => {
    const open = sharedStore()
    const store = open()
    const h = await MindHost.open(store, opts('m-a'))
    await h.run('addBelief', ['b1', 'fact', 'one', { f: 1, c: 0.5 }, { at: 10 }])
    await h.run('forget', ['b1', { at: 20 }])
    await h.run('forgetAll', [{ at: 30 }])
    const rec = (await store.load())!
    expect(rec.gen).toBe(3)
    expect(rec.watermark).toBe(30)
    expect(rec.text).toMatch(/\(ForgetAll 30\)/)
    expect(rec.text).toMatch(/\(Forgotten "b1" "[0-9a-f]{64}" 20\)/)
    const back = await MindHost.open(open(), opts('m-b'))
    expect(back.core.addBelief('b2', 'fact', 'one', { f: 1, c: 0.5 }, { at: 15 })).toEqual({ ok: false, refused: 'forgotten' })
  })

  it('two tabs: the later writer starts from the other\'s write (tombstones win) instead of overwriting it', async () => {
    const open = sharedStore()
    const a = await MindHost.open(open(), opts('m-a'))
    const b = await MindHost.open(open(), opts('m-b'))
    await a.run('addBelief', ['b1', 'fact', 'secret', { f: 1, c: 0.5 }, { at: 10 }])
    // b opened before a wrote; it holds the words too, then a forgets them
    await b.run('addBelief', ['b2', 'fact', 'secret', { f: 1, c: 0.5 }, { at: 10 }])
    await a.run('forget', ['b1', { at: 20 }])
    // b writes again: it must merge a's tombstone first, which purges its own copy of the words
    const r = await b.run('remember', ['x1', 'exchange', 'hello', { f: 1, c: 0.9 }, { at: 25 }])
    expect(r.durable).toBe(true)
    expect(b.core.belief('b2')).toBeNull()
    expect(b.core.belief('b1')).toBeNull()
    const final = await MindHost.open(open(), opts('m-c'))
    expect(final.core.stats()).toMatchObject({ beliefs: 0, memories: 1, tombstones: 1 })
  })

  // ---- r2: storage is the authority (stand-in r1 P1 x2) -------------------------------------------------------

  const words = 'my bank is the blue one'
  const stv = { f: 1, c: 0.5 }
  const P = (from: string, to: string, belief?: string) => ({ link: 'Inheritance' as const, from, to, ...(belief ? { belief } : { stv }) })

  it('r2 P1: after tab A forgets, tab B (already open) never serves it, by any read', async () => {
    const open = sharedStore()
    const a = await MindHost.open(open(), opts('m-a'))
    await a.run('addBelief', ['b1', 'fact', words, stv, { at: 10, turn: 't1' }])
    await a.run('remember', ['x1', 'exchange', 'told you about the blue bank', { f: 1, c: 0.9 }, { at: 10, turn: 't1' }])
    const b = await MindHost.open(open(), opts('m-b'))
    expect(((await b.run('recall', ['blue bank', 5])).value as { items: unknown[] }).items).toHaveLength(2)
    await a.run('forget', ['b1', { at: 20 }])
    // B has made no change since; every read must reflect A's forget
    expect((await b.run('belief', ['b1'])).value).toBeNull()
    const rec = (await b.run('recall', ['my bank is the blue one', 5])).value as { items: { id: string }[] }
    expect(rec.items.map((i) => i.id)).not.toContain('b1')
    expect((await b.run('export', [])).value as string).not.toContain(words)
    expect((await b.run('infer', [P('A', 'B', 'b1'), P('B', 'C')])).value).toMatchObject({ ok: false, refused: 'unknown' })
    expect(((await b.run('explain', ['b1'])).value as { held: boolean }).held).toBe(false)
    expect(b.generation).toBe(a.generation)
  })

  it('r2 P1: the same for forget everything', async () => {
    const open = sharedStore()
    const a = await MindHost.open(open(), opts('m-a'))
    await a.run('addBelief', ['b1', 'fact', words, stv, { at: 10 }])
    await a.run('remember', ['x1', 'exchange', 'hello there', { f: 1, c: 0.9 }, { at: 10 }])
    const b = await MindHost.open(open(), opts('m-b'))
    expect((await b.run('belief', ['b1'])).value).not.toBeNull()
    await a.run('forgetAll', [{ at: 30 }])
    expect((await b.run('belief', ['b1'])).value).toBeNull()
    expect(((await b.run('recall', ['hello blue bank', 5])).value as { items: unknown[] }).items).toEqual([])
    const text = (await b.run('export', [])).value as string
    expect(text).not.toContain(words)
    expect(text).not.toContain('hello there')
    expect(text).toContain('(ForgetAll 30)')
    expect((await b.run('stats', [])).value).toMatchObject({ beliefs: 0, memories: 0, watermark: 30 })
  })

  it("r2 P1: a forget from a stale tab reconciles first, so the words' copies under other ids go too", async () => {
    // the stand-in's sequence: B opens before A stores b1 and an alias with the same words; B forgets b1
    const open = sharedStore()
    const b = await MindHost.open(open(), opts('m-b'))
    const a = await MindHost.open(open(), opts('m-a'))
    await a.run('addBelief', ['b1', 'fact', words, stv, { at: 10 }])
    await a.run('addBelief', ['alias', 'fact', 'My bank is the blue one.', stv, { at: 11 }])
    const r = await b.run('forget', ['b1', { at: 20 }])
    expect(r.value).toMatchObject({ ok: true, alsoForgot: ['alias'] })
    const final = await MindHost.open(open(), opts('m-c'))
    expect(final.core.belief('b1')).toBeNull()
    expect(final.core.belief('alias')).toBeNull()
    expect(final.core.export()).toMatch(/\(Forgotten "b1" "[0-9a-f]{64}" 20\)/)
    expect((await a.run('belief', ['alias'])).value).toBeNull()
  })

  it('r2 P1: if another write lands between the check and the write, the forget is applied again with its fingerprints', async () => {
    const open = sharedStore()
    const a = await MindHost.open(open(), opts('m-a'))
    await a.run('addBelief', ['b1', 'fact', words, stv, { at: 10 }])
    const inner = open()
    let raced = false
    const racing: MindStore = {
      ...inner,
      async save(rec, gen) {
        if (!raced) {
          raced = true // A writes the alias after B's check, before B's write
          await a.run('addBelief', ['alias', 'fact', words.toUpperCase(), stv, { at: 11 }])
        }
        return inner.save(rec, gen)
      },
    }
    const b = await MindHost.open(racing, opts('m-b'))
    const r = await b.run('forget', ['b1', { at: 20 }])
    expect(raced).toBe(true)
    expect(r.value).toMatchObject({ ok: true, alsoForgot: ['alias'] })
    const final = await MindHost.open(open(), opts('m-c'))
    expect(final.core.stats()).toMatchObject({ beliefs: 0, tombstones: 1 })
  })

  it('r2: a change notice makes an open tab reconcile without waiting for its next operation', async () => {
    const open = sharedStore()
    const listeners: ((gen: number) => void)[] = []
    const bus = () => ({ post: (g: number) => listeners.forEach((l) => l(g)), listen: (f: (g: number) => void) => void listeners.push(f), close() {} })
    const a = await MindHost.open(open(), { ...opts('m-a'), notices: bus() })
    await a.run('addBelief', ['b1', 'fact', words, stv, { at: 10 }])
    const b = await MindHost.open(open(), { ...opts('m-b'), notices: bus() })
    await a.run('forget', ['b1', { at: 20 }])
    await new Promise((r) => setTimeout(r, 0))
    await b.run('stats', [])
    expect(b.generation).toBe(2)
    expect(b.core.belief('b1')).toBeNull()
  })

  it("r2: a write that fails leaves the tab on storage's copy, not its unsaved change", async () => {
    const open = sharedStore()
    const inner = open()
    const failing: MindStore = { ...inner, save: async () => { throw new Error('disk full') } }
    const h = await MindHost.open(failing, opts('m-a'))
    await expect(h.run('addBelief', ['b1', 'fact', words, stv])).rejects.toThrow('disk full')
    expect(h.core.belief('b1')).toBeNull()
  })

  // ---- r3: every change is a transaction (stand-in r2 P1) ---------------------------------------------------

  /** lexical v1, except that it throws on words containing BOOM (a failure after the atoms have changed) */
  const boomEmbedder = { id: lexicalEmbedder.id, embed: (t: string) => { if (t.includes('BOOM')) throw new Error('embed failed'); return lexicalEmbedder.embed(t) } }

  it('r3 P1: an operation that throws after changing atoms leaves the space as stored', async () => {
    const open = sharedStore()
    const store = open()
    const h = await MindHost.open(store, { ...opts('m-a'), embedder: boomEmbedder })
    await h.run('addBelief', ['b1', 'fact', 'kept words', stv, { at: 10 }])
    const before = h.core.export()
    // mind-learn! adds the atoms in MeTTa, then the vector embedding throws
    await expect(h.run('addBelief', ['b2', 'fact', 'BOOM words', stv, { at: 11 }])).rejects.toThrow('embed failed')
    expect(h.core.belief('b2')).toBeNull()
    expect(h.core.export()).toBe(before)
    expect(h.isStale).toBe(true)
    // the next operation reloads from storage first, then answers
    expect((await h.run('belief', ['b2'])).value).toBeNull()
    expect(h.isStale).toBe(false)
    expect((await store.load())!.gen).toBe(1)
    expect((await h.run('stats', [])).value).toMatchObject({ beliefs: 1 })
  })

  it('r3 P1: a failed write whose recovery load also fails never serves or commits the unsaved change', async () => {
    const open = sharedStore()
    const inner = open()
    let broken = false
    const flaky: MindStore = {
      ...inner,
      async save(r, g) {
        if (broken) throw new Error('disk full')
        return inner.save(r, g)
      },
      async load() {
        if (broken) throw new Error('storage unreadable')
        return inner.load()
      },
    }
    const h = await MindHost.open(flaky, opts('m-a'))
    await h.run('addBelief', ['b1', 'fact', 'kept words', stv, { at: 10 }])
    broken = true
    await expect(h.run('addBelief', ['b2', 'fact', 'unsaved words', stv, { at: 11 }])).rejects.toThrow('disk full')
    // rolled back in memory, and stale: reads refuse while storage cannot be loaded (peekGen still answers 1)
    expect(h.core.belief('b2')).toBeNull()
    await expect(h.run('recall', ['unsaved words', 5])).rejects.toThrow('storage unreadable')
    await expect(h.run('export', [])).rejects.toThrow('storage unreadable')
    // a later change cannot commit it either
    await expect(h.run('addBelief', ['b3', 'fact', 'more', stv, { at: 12 }])).rejects.toThrow('storage unreadable')
    broken = false
    const text = (await h.run('export', [])).value as string
    expect(text).toContain('kept words')
    expect(text).not.toContain('unsaved words')
    expect((await inner.load())!.text).not.toContain('unsaved words')
  })
})
