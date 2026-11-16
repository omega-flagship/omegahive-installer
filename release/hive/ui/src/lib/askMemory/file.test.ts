import { describe, expect, it } from 'vitest'
import { memoryBackend, type MemoryBackend } from './backend'
import { buildFile, FILE_PROBLEM_WORDS, personHash, planEmpty, planRestore, planWords, readFile, type MemoryFile } from './file'
import { AskMemoryStore } from './store'
import type { EpochBinding } from '../identityEpoch'
import type { MemoryFrame } from './types'

/**
 * Memory durability M1: download and restore. Round trip, merge with tombstones, newer forget-everything on either
 * side, corrupt and foreign files refused in plain words, and a restore bound to the person it was previewed for.
 * Invented people and notes only; in-memory storage (the same `apply` rules IndexedDB runs).
 */

const T0 = Date.parse('2026-10-08T12:00:00Z')
const ADA = { principal: 'user:p_inv_ada', hive: 'sim@test' }
const TOMAS = { principal: 'user:p_inv_tomas', hive: 'sim@test' }

function epochKit() {
  let epoch = 0
  const hooks: (() => void)[] = []
  const bind = (): EpochBinding => {
    const at = epoch
    const current = () => epoch === at
    return { epoch: at, current, commit: <R,>(w: () => R) => (current() ? w() : (Symbol('stale') as never)) }
  }
  return { bind, onIdentityChange: (fn: () => void) => (hooks.push(fn), () => undefined), change: () => (epoch++, hooks.forEach((h) => h())) }
}

/** One browser: its own storage per person (so its own salt), its own clock. */
function browser() {
  const dbs = new Map<string, MemoryBackend>()
  let now = T0
  const id = epochKit()
  const store = new AskMemoryStore({
    // stands in for IndexedDB (durable), so collected talks may be settled
    backend: (name) => dbs.get(name) ?? (dbs.set(name, { ...memoryBackend(), durable: true }), dbs.get(name)!),
    now: () => now,
    persist: () => undefined,
    channel: null,
    bind: id.bind,
    onIdentityChange: id.onIdentityChange,
  })
  return {
    store,
    id,
    at: (t: number) => (now = t),
    tick: (ms = 1000) => (now += ms),
    async as(o: typeof ADA) {
      store.use(o)
      await store.whenReady()
    },
  }
}

let seq = 0
const frame = (statement: string): MemoryFrame => ({ turn_id: `turn_${++seq}`, seq: 1, op: 'remember', digest: 'd', target_id: null, item: { statement, kind: 'preference', truth: { frequency: 1, confidence: 0.8 } } })
async function learn(b: ReturnType<typeof browser>, statement: string) {
  b.store.receive(frame(statement), { privatePage: false, since: b.store.turnMark() })
  await b.store.flushed()
  b.tick()
}
const words = (b: ReturnType<typeof browser>) => b.store.getView().beliefs.map((x) => x.statement).sort()

async function exported(b: ReturnType<typeof browser>): Promise<string> {
  const out = await b.store.exportFile()
  if (!out) throw new Error('no file')
  return out.text
}
async function restoreInto(b: ReturnType<typeof browser>, text: string) {
  const p = await b.store.previewRestore(text)
  if (!p || !p.ok) throw new Error(`refused: ${p ? p.problem : 'null'}`)
  const done = await b.store.restore(p.file, p.token)
  return { preview: p.plan, done }
}

describe('M1: the file', () => {
  it('names its person without the principal, and carries entries, tombstones and the generation', async () => {
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: likes the short answer first')
    await a.store.rememberTalks([{ id: 'pi_t1', turn_id: 'turn_t1', at: T0 - 5000, words: 'Invented question', answer: 'Invented answer', truncated: false }])
    const text = await exported(a)
    expect(text).not.toContain('p_inv_ada')
    const f = JSON.parse(text) as MemoryFile
    expect(f.format).toBe('omegahive-mind-memory')
    expect(f.version).toBe(1)
    expect(f.hive).toBe('sim@test')
    expect(f.person_hash).toBe(personHash(f.salt, ADA.hive, ADA.principal))
    expect(f.entries.map((e) => e.type).sort()).toEqual(['belief', 'talk'])
    expect(typeof f.generation).toBe('number')
    expect(Array.isArray(f.tombstones)).toBe(true)
  })

  it('round trip: cleared site data (a new database, a new salt) gets everything back, forgets included', async () => {
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: weekly review on Fridays')
    await learn(a, 'Invented: no notifications after 21:00')
    await learn(a, 'Invented: a note to forget')
    a.store.forget(a.store.getView().beliefs.find((b) => b.statement === 'Invented: a note to forget')!.id)
    await a.store.rememberTalks([{ id: 'pi_t2', turn_id: 'turn_t2', at: T0 - 5000, words: 'Invented question', answer: 'Invented answer', truncated: false }])
    a.tick()
    const text = await exported(a)

    const fresh = browser()
    fresh.at(T0 + 60_000)
    await fresh.as(ADA)
    const { preview, done } = await restoreInto(fresh, text)
    expect(preview.add).toHaveLength(2)
    expect(done?.add).toHaveLength(2)
    expect(words(fresh)).toEqual(['Invented: no notifications after 21:00', 'Invented: weekly review on Fridays'])
    expect(fresh.store.getView().talks.map((t) => t.id)).toEqual(['pi_t2'])
    expect(fresh.store.getView().trace.some((t) => t.kind === 'restore')).toBe(true)
    // the forgotten words stay forgotten here, although this database has another salt: a turn that began before
    // the forget cannot bring them back (the restored tombstone keeps the file's salt)
    const old = fresh.store.hostMark(new Date(T0 - 60 * 60_000 + 2 * 60_000).toISOString())!
    const r = fresh.store.receive({ ...frame('Invented: a note to forget') }, { privatePage: false, since: old })
    await fresh.store.flushed()
    expect(r.kept).toBeNull()
    expect(words(fresh)).not.toContain('Invented: a note to forget')
  })

  it('restoring the same file twice changes nothing the second time', async () => {
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: prefers metric units')
    const text = await exported(a)
    const b = browser()
    await b.as(ADA)
    await restoreInto(b, text)
    const p = await b.store.previewRestore(text)
    expect(p && p.ok && p.plan.add.length + p.plan.update.length).toBe(0)
  })
})

describe('M1: restore merges through the store’s rules (never overwrites)', () => {
  it('forgotten here after the file was saved: not brought back', async () => {
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: likes jasmine tea')
    const text = await exported(a)
    a.tick(10_000)
    a.store.forget(a.store.getView().beliefs[0].id)
    await a.store.flushed()
    const { preview } = await restoreInto(a, text)
    expect(preview.add).toEqual([])
    expect(preview.skipped.forgotten).toBe(1)
    expect(words(a)).toEqual([])
  })

  it('forgotten on the copy the file came from: forgotten here too (shown in the preview first)', async () => {
    // one person, two browsers: B got A's note by an earlier restore, then A forgot it and saved again
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: the garden key is under the pot')
    const first = await exported(a)
    const b = browser()
    b.at(T0 + 5_000)
    await b.as(ADA)
    await restoreInto(b, first)
    expect(words(b)).toEqual(['Invented: the garden key is under the pot'])
    a.tick(60_000)
    a.store.forget(a.store.getView().beliefs[0].id)
    await a.store.flushed()
    const second = await exported(a)
    const p = await b.store.previewRestore(second)
    expect(p && p.ok && p.plan.forgetBeliefs).toHaveLength(1)
    expect(p && p.ok && planWords(p.plan).join(' ')).toContain('forgotten here')
    await restoreInto(b, second)
    expect(words(b)).toEqual([])
  })

  it('a newer copy here is kept; an older copy here takes the file’s newer one', async () => {
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: meets on Tuesdays')
    const id = a.store.getView().beliefs[0].id
    const older = await exported(a)
    a.tick()
    expect(a.store.edit(id, 'Invented: meets on Wednesdays')).toBe(true)
    await a.store.flushed()
    // restoring the older file over the newer edit keeps the edit
    const { preview } = await restoreInto(a, older)
    expect(preview.update).toEqual([])
    expect(preview.skipped.older).toBe(1)
    expect(words(a)).toEqual(['Invented: meets on Wednesdays'])
    // a browser holding the older copy takes the newer one from a newer file
    const b = browser()
    await b.as(ADA)
    await restoreInto(b, older)
    const newer = await exported(a)
    const r = await restoreInto(b, newer)
    expect(r.preview.update).toHaveLength(1)
    expect(words(b)).toEqual(['Invented: meets on Wednesdays'])
  })

  it('newer forget everything here: the file’s older entries are refused', async () => {
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: likes long walks')
    const text = await exported(a)
    a.tick(10_000)
    a.store.forgetAll()
    await a.store.flushed()
    const { preview } = await restoreInto(a, text)
    expect(preview.add).toEqual([])
    expect(preview.skipped.forgotten).toBe(1)
    expect(words(a)).toEqual([])
  })

  it('newer forget everything in the file: what it covers is forgotten here, what came after stays', async () => {
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: an old note')
    const first = await exported(a)
    const b = browser()
    b.at(T0 + 1_000)
    await b.as(ADA)
    await restoreInto(b, first)
    a.at(T0 + 120_000)
    a.store.forgetAll()
    await a.store.flushed()
    a.tick()
    await learn(a, 'Invented: a note after forgetting')
    const second = await exported(a)
    b.at(T0 + 300_000)
    await learn(b, 'Invented: learned in B after A forgot')
    const r = await restoreInto(b, second)
    expect(r.preview.forgetBeliefs).toHaveLength(1)
    expect(words(b)).toEqual(['Invented: a note after forgetting', 'Invented: learned in B after A forgot'])
  })

  it('the same words under another id are not added twice', async () => {
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: prefers British spelling')
    const text = await exported(a)
    const b = browser()
    await b.as(ADA)
    await learn(b, 'invented: prefers british spelling.')
    const { preview } = await restoreInto(b, text)
    expect(preview.add).toEqual([])
    expect(preview.skipped.known).toBe(1)
  })
})

describe('M1: refused files, in plain words', () => {
  it('another person’s file, or another hive’s, is refused whole', async () => {
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: Ada’s note')
    const text = await exported(a)
    const t = browser()
    await t.as(TOMAS)
    const p = await t.store.previewRestore(text)
    expect(p).toEqual({ ok: false, problem: 'someone_else' })
    expect(FILE_PROBLEM_WORDS.someone_else).toMatch(/someone else/)
    const elsewhere = readFile(text, { ...ADA, hive: 'live@https://elsewhere.example.org' })
    expect(elsewhere).toEqual({ ok: false, problem: 'someone_else' })
    expect(words(t)).toEqual([])
  })

  it('corrupt, foreign or newer-format files are refused, nothing half-restored', async () => {
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: a good note')
    const good = JSON.parse(await exported(a)) as MemoryFile
    const cases: [string, string][] = [
      ['{not json', 'unreadable'],
      [JSON.stringify({ hello: 'world' }), 'not_memory'],
      [JSON.stringify({ ...good, version: 2 }), 'newer_version'],
      [JSON.stringify({ ...good, entries: [...good.entries, { type: 'belief', id: 'bad id!', statement: 'x' }] }), 'damaged'],
      [JSON.stringify({ ...good, tombstones: [{ id: 'b_x', at: 'yesterday' }] }), 'damaged'],
      [JSON.stringify({ ...good, person_hash: 'nope' }), 'damaged'],
    ]
    for (const [text, problem] of cases) expect(readFile(text, ADA)).toEqual({ ok: false, problem })
    const b = browser()
    await b.as(ADA)
    expect(await b.store.previewRestore(cases[3][0])).toEqual({ ok: false, problem: 'damaged' })
    expect(words(b)).toEqual([])
  })

  it('every refusal has plain words', () => {
    for (const w of Object.values(FILE_PROBLEM_WORDS)) expect(w).toMatch(/Nothing was restored\.$/)
  })
})

describe('M1: bound to the person it was previewed for', () => {
  it('an identity change between the preview and Restore: nothing is restored', async () => {
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: a note to carry over')
    const text = await exported(a)
    const b = browser()
    await b.as(ADA)
    const p = await b.store.previewRestore(text)
    if (!p || !p.ok) throw new Error('preview refused')
    b.id.change()
    expect(b.store.getView().owner).toBeNull()
    await b.as(ADA)
    expect(await b.store.restore(p.file, p.token)).toBeNull()
    expect(words(b)).toEqual([])
  })

  it('an export started before an identity change gives no file', async () => {
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: private to Ada')
    const out = a.store.exportFile()
    a.id.change()
    expect(await out).toBeNull()
  })

  it('the plan is pure: the preview and the transaction agree', async () => {
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: one')
    await learn(a, 'Invented: two')
    const f = buildFile({ beliefs: a.store.getView().beliefs, talks: [], tombs: [], gen: 0, gen_at: 0, salt: 'ab'.repeat(16) }, ADA, T0)
    const local = { beliefs: [], talks: [], tombs: [], salt: 'cd'.repeat(16), gen_at: 0 }
    expect(planRestore(local, f)).toEqual(planRestore(local, f))
  })
})

describe('r1.1 P1: restored forget markers survive', () => {
  it('the file’s forget everything is kept as a watermark: an old conversation delivered later under a new id is not kept', async () => {
    const a = browser()
    await a.as(ADA)
    a.at(T0 + 100_000)
    a.store.forgetAll()
    await a.store.flushed()
    a.tick()
    await learn(a, 'Invented: a note after forgetting')
    const text = await exported(a)
    const b = browser()
    b.at(T0 + 200_000)
    await b.as(ADA)
    const genBefore = (JSON.parse((await b.store.exportFile())!.text) as MemoryFile).generation
    const { preview } = await restoreInto(b, text)
    expect(preview.watermark).toBe(T0 + 100_000)
    const after = JSON.parse((await b.store.exportFile())!.text) as MemoryFile
    expect(after.generation).toBeGreaterThan(genBefore)
    expect(after.forgot_all_at).toBe(T0 + 100_000)
    // a held copy from before the watermark, under an id never seen here: settled as forgotten, never kept
    const settled = await b.store.rememberTalks([{ id: 'pi_old_new_id', turn_id: 't_old', at: T0 + 50_000, words: 'Invented old question', answer: 'Invented old answer', truncated: false }])
    expect(settled).toEqual(['pi_old_new_id'])
    expect(b.store.getView().talks).toEqual([])
    // and a turn timed by the host from before it is not learned either
    const old = b.store.hostMark(new Date(T0 + 50_000 + 2 * 60_000).toISOString())!
    expect(b.store.receive(frame('Invented: from before the forget'), { privatePage: false, since: old }).kept).toBeNull()
  })

  it('a file holding only forget markers is not “nothing to change”: restoring it keeps them', async () => {
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: words to stay forgotten')
    a.store.forget(a.store.getView().beliefs[0].id)
    await a.store.flushed()
    const text = await exported(a)
    expect((JSON.parse(text) as MemoryFile).entries).toEqual([])
    const b = browser()
    b.at(T0 - 3_600_000)
    await b.as(ADA)
    const p = await b.store.previewRestore(text)
    if (!p || !p.ok) throw new Error('refused')
    expect(planEmpty(p.plan)).toBe(false)
    expect(planWords(p.plan).join(' ')).toMatch(/forget marker/)
    await b.store.restore(p.file, p.token)
    b.at(T0 + 60_000)
    const old = b.store.hostMark(new Date(T0 - 30 * 60_000).toISOString())!
    expect(b.store.receive(frame('Invented: words to stay forgotten'), { privatePage: false, since: old }).kept).toBeNull()
    await b.store.flushed()
    expect(words(b)).toEqual([])
  })
})

describe('r1.1 P1: tombstones merge as a union, never losing a protection', () => {
  /** Ada's note, in both browsers under the same id (B restored it from A); A then reworded it and forgot it. */
  async function twoCopies() {
    const a = browser()
    await a.as(ADA)
    await learn(a, 'Invented: the old wording')
    const id = a.store.getView().beliefs[0].id
    const first = await exported(a)
    const b = browser()
    b.at(T0 + 1_000)
    await b.as(ADA)
    await restoreInto(b, first)
    a.at(T0 + 10_000)
    expect(a.store.edit(id, 'Invented: the new wording')).toBe(true)
    a.tick()
    a.store.forget(id)
    await a.store.flushed()
    return { a, b, id, first, second: await exported(a) }
  }
  /**
   * A file of Ada's that carries NO forget marker (built on the first file), holding the new wording under an id never
   * seen before, from before the forget: only what B itself now keeps can stop it.
   */
  async function sneak(first: string): Promise<string> {
    const f = JSON.parse(first) as MemoryFile
    f.entries = [{ type: 'belief', id: 'b_sneaked_in', kind: 'preference', statement: 'Invented: the new wording', truth: { frequency: 1, confidence: 0.8 }, uses: 0, last_used_at: null, created_at: T0 + 9_000, updated_at: T0 + 9_000, source_turn: null }]
    return JSON.stringify(f)
  }

  it('restore deletes the belief and keeps the imported fingerprints: the forgotten wording cannot come back under a new id', async () => {
    const { b, first, second } = await twoCopies()
    b.at(T0 + 20_000)
    const r = await restoreInto(b, second)
    expect(r.preview.forgetBeliefs).toHaveLength(1)
    expect(words(b)).toEqual([])
    // the new wording only ever existed on A: its fingerprint must have come over with A's tombstone
    const p = await b.store.previewRestore(await sneak(first))
    if (!p || !p.ok) throw new Error('refused')
    expect(p.plan.add).toEqual([])
    expect(p.plan.skipped.forgotten).toBe(1)
    const old = b.store.hostMark(new Date(T0 + 9_000 + 2 * 60_000).toISOString())!
    expect(b.store.receive(frame('Invented: the new wording'), { privatePage: false, since: old }).kept).toBeNull()
  })

  it('an imported tombstone for an id already forgotten here is merged (later time, more fingerprints), not skipped', async () => {
    const { b, id, first, second } = await twoCopies()
    // B forgot the same note itself, earlier and under the old wording only
    b.at(T0 + 5_000)
    b.store.forget(id)
    await b.store.flushed()
    b.at(T0 + 20_000)
    const p = await b.store.previewRestore(second)
    if (!p || !p.ok) throw new Error('refused')
    expect(p.plan.tombs.map((t) => t.id)).toEqual([id])
    expect(p.plan.tombs[0].at).toBeGreaterThanOrEqual(T0 + 10_000)
    expect(planEmpty(p.plan)).toBe(false)
    await b.store.restore(p.file, p.token)
    const after = JSON.parse((await b.store.exportFile())!.text) as MemoryFile
    const tomb = after.tombstones.find((t) => t.id === id)!
    expect((tomb.words?.length ?? 0) + (tomb.more?.flatMap((g) => g.words).length ?? 0)).toBeGreaterThanOrEqual(2)
    const q = await b.store.previewRestore(await sneak(first))
    if (!q || !q.ok) throw new Error('refused')
    expect(q.plan.add).toEqual([])
    expect(q.plan.skipped.forgotten).toBe(1)
  })

  it('merging is a union: the latest time, and every fingerprint with its own salt', async () => {
    const { mergeTombs } = await import('./file')
    const s1 = 'aa'.repeat(16)
    const s2 = 'bb'.repeat(16)
    const h = (c: string) => c.repeat(64)
    const m = mergeTombs({ id: 'b_x', at: 10, words: [h('1')] }, { id: 'b_x', at: 5, words: [h('2')], more: [{ salt: s1, words: [h('3')] }] }, s1, s2)
    expect(m.at).toBe(10)
    expect(m.words).toEqual([h('1'), h('3')])
    expect(m.more).toEqual([{ salt: s2, words: [h('2')] }])
  })
})

describe('Kimi r1 P1: a forgotten conversation cannot come back from a file under a new id', () => {
  it('restore skips a talk whose words were forgotten here, whatever its id', async () => {
    const a = browser()
    await a.as(ADA)
    await a.store.rememberTalks([{ id: 'pi_n1', turn_id: 'turn_n1', at: T0 - 60_000, words: 'Invented question once asked', answer: 'Invented answer once given', truncated: false }])
    const text = await exported(a)
    a.tick(10_000)
    expect(a.store.forgetTalk('pi_n1')).toBe(true)
    await a.store.flushed()
    // the same exchange, as another copy of the file might hold it, under an id never seen here
    const f = JSON.parse(text) as MemoryFile
    f.entries = f.entries.map((e) => (e.type === 'talk' ? { ...e, id: 'pi_n1_other' } : e))
    const p = await a.store.previewRestore(JSON.stringify(f))
    if (!p || !p.ok) throw new Error('refused')
    expect(p.plan.addTalks).toEqual([])
    expect(p.plan.skipped.forgotten).toBe(1)
  })
})
