import { describe, expect, it } from 'vitest'
import { clampTruth, revise, weight } from './truth'
import { cosine, lexicalEmbedder, normalise } from './embed'
import { learn, namesPrivate, readItem, sameStatement } from './beliefs'
import { attention, noteText, recall } from './recall'
import { memoryBackend, type MemoryBackend } from './backend'
import { AskMemoryStore, dbName, LOST_WORDS } from './store'
import { NOTE_ID, type Belief, type MemoryFrame } from './types'

const T0 = Date.parse('2026-10-07T12:00:00Z')
const DAY = 86_400_000

describe('truth: NAL revision (pure)', () => {
  it('w = c / (1 − c); frequency is the w-weighted mean; confidence = w / (w + 1) over the summed weight', () => {
    expect(weight(0.8)).toBeCloseTo(4)
    expect(weight(0.5)).toBeCloseTo(1)
    const same = revise({ frequency: 1, confidence: 0.8 }, { frequency: 1, confidence: 0.8 })
    expect(same.frequency).toBe(1)
    expect(same.confidence).toBeCloseTo(8 / 9, 4)
    const mixed = revise({ frequency: 1, confidence: 0.9 }, { frequency: 0, confidence: 0.5 })
    expect(mixed.frequency).toBeCloseTo(0.9, 4)
    expect(mixed.confidence).toBeCloseTo(10 / 11, 4)
  })
  it('is symmetric, only ever adds confidence, and never reaches 1', () => {
    const a = { frequency: 0.7, confidence: 0.6 }
    const b = { frequency: 0.2, confidence: 0.3 }
    expect(revise(a, b)).toEqual(revise(b, a))
    expect(revise(a, b).confidence).toBeGreaterThan(Math.max(a.confidence, b.confidence))
    let t = { frequency: 1, confidence: 0.9 }
    for (let i = 0; i < 50; i++) t = revise(t, { frequency: 1, confidence: 0.99 })
    expect(t.confidence).toBeLessThanOrEqual(0.99)
  })
  it('clamps what it is given: frequency 0..1, confidence 0.01..0.99, non-finite made safe', () => {
    expect(clampTruth({ frequency: 2, confidence: 1 })).toEqual({ frequency: 1, confidence: 0.99 })
    expect(clampTruth({ frequency: -1, confidence: 0 })).toEqual({ frequency: 0, confidence: 0.01 })
    expect(clampTruth({ frequency: NaN, confidence: NaN })).toEqual({ frequency: 1, confidence: 0.01 })
  })
})

describe('embed: the v1 lexical embedder (hashed words + trigrams, cosine)', () => {
  it('is deterministic, unit length, and ranks lexical neighbours above strangers', () => {
    const a = lexicalEmbedder.embed('Prefers short answers')
    expect(cosine(a, lexicalEmbedder.embed('Prefers short answers'))).toBeCloseTo(1, 5)
    const near = cosine(a, lexicalEmbedder.embed('prefers shorter answers'))
    const far = cosine(a, lexicalEmbedder.embed('the Mac hive in the office'))
    expect(near).toBeGreaterThan(0.6)
    expect(far).toBeLessThan(0.25)
    expect(cosine(lexicalEmbedder.embed(''), a)).toBe(0)
  })
  it('normalises case, spacing and end punctuation', () => {
    expect(normalise('  Prefers   SHORT answers. ')).toBe('prefers short answers')
  })
})

const frame = (over: Partial<MemoryFrame> & { item?: MemoryFrame['item'] }): MemoryFrame & { item: NonNullable<MemoryFrame['item']> } =>
  ({ turn_id: 'turn_1', seq: 3, op: 'remember', digest: 'd', target_id: null, item: { statement: 'Prefers short answers', kind: 'preference', truth: { frequency: 1, confidence: 0.8 } }, ...over }) as never
let ids = 0
const ctx = (now = T0) => ({ now, newId: () => `b_${++ids}`, traceId: () => `t_${++ids}` })
const belief = (over: Partial<Belief> = {}): Belief => ({ id: 'b_x', kind: 'preference', statement: 'Prefers short answers', truth: { frequency: 1, confidence: 0.8 }, uses: 0, last_used_at: null, created_at: T0, updated_at: T0, source_turn: 'turn_0', ...over })

describe('learning: remember merges by NAL revision; revise targets by id', () => {
  it('a new statement becomes a belief, with a remember line naming its turn and seq', () => {
    const r = learn([], frame({}), ctx())
    expect(r.merged).toBe(false)
    expect(r.belief).toMatchObject({ kind: 'preference', statement: 'Prefers short answers', uses: 0, source_turn: 'turn_1' })
    expect(NOTE_ID.test(r.belief.id)).toBe(true)
    expect(r.entry).toMatchObject({ kind: 'remember', turn_id: 'turn_1', seq: 3, belief_id: r.belief.id })
  })
  it('the same kind and a near-identical statement merges (confidence rises); another kind does not', () => {
    const b = belief()
    const r = learn([b], frame({ item: { statement: 'prefers short answers.', kind: 'preference', truth: { frequency: 1, confidence: 0.8 } } }), ctx())
    expect(r.merged).toBe(true)
    expect(r.belief.id).toBe('b_x')
    expect(r.belief.truth.confidence).toBeCloseTo(8 / 9, 4)
    const other = learn([b], frame({ item: { statement: 'Prefers short answers', kind: 'project', truth: { frequency: 1, confidence: 0.8 } } }), ctx())
    expect(other.merged).toBe(false)
  })
  it('revise by id: the same statement is more evidence; a different one replaces it; a correction keeps the kind', () => {
    const b = belief({ id: 'b_hive', kind: 'place', statement: 'Works on the cloud hive' })
    const again = learn([b], frame({ op: 'revise', target_id: 'b_hive', item: { statement: 'Works on the cloud hive', kind: 'place', truth: { frequency: 1, confidence: 0.8 } } }), ctx())
    expect(again.belief.truth.confidence).toBeCloseTo(8 / 9, 4)
    const fix = learn([b], frame({ op: 'revise', target_id: 'b_hive', item: { statement: 'Meant the Mac hive', kind: 'correction', truth: { frequency: 1, confidence: 0.85 } } }), ctx())
    expect(fix.belief).toMatchObject({ id: 'b_hive', kind: 'place', statement: 'Meant the Mac hive', truth: { frequency: 1, confidence: 0.85 } })
    expect(fix.entry.kind).toBe('revise')
    // a target this browser no longer has (forgotten meanwhile) is learned as new
    expect(learn([], frame({ op: 'revise', target_id: 'b_gone' }), ctx()).merged).toBe(false)
  })
  it('reads an item strictly', () => {
    expect(readItem({ statement: 'x', kind: 'preference', truth: { frequency: 1, confidence: 0.5 } })).not.toBeNull()
    for (const bad of [null, [], { statement: '', kind: 'name', truth: { frequency: 1, confidence: 0.5 } }, { statement: 'x', kind: 'goal', truth: { frequency: 1, confidence: 0.5 } }, { statement: 'x', kind: 'name', truth: { frequency: 2, confidence: 0.5 } }, { statement: 'x'.repeat(501), kind: 'name', truth: { frequency: 1, confidence: 0.5 } }, { statement: 'x', kind: 'name' }])
      expect(readItem(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull()
  })
  it('names the private apps however they are written', () => {
    for (const s of ['my Atlas sleep score', 'OmegaTruth labels', 'TRUTH app', '%61tlas notes']) expect(namesPrivate(s), s).toBe(true)
    expect(namesPrivate('Prefers short answers')).toBe(false)
    expect(sameStatement('Call them Jon', 'call them jon!')).toBe(true)
  })
})

describe('recall: similarity and attention, within the host caps', () => {
  it('ranks by similarity to the request, then attention (confidence × recency × use)', () => {
    const bs = [belief({ id: 'b_a', statement: 'Prefers short answers', updated_at: T0 - 60 * DAY }), belief({ id: 'b_b', kind: 'place', statement: 'Works on the Mac hive' })]
    expect(recall(bs, 'which hive is the mac one', { now: T0 }).ids[0]).toBe('b_b')
    expect(recall(bs, 'answer me shortly with short answers', { now: T0 }).ids[0]).toBe('b_a')
    const fresh = belief({ updated_at: T0 })
    expect(attention(fresh, T0)).toBeGreaterThan(attention({ ...fresh, updated_at: T0 - 30 * DAY }, T0))
    expect(attention({ ...fresh, uses: 5 }, T0)).toBeGreaterThan(attention(fresh, T0))
  })
  it('sends at most 20 notes and 8 KB (ids and texts), never a private or mostly-untrue belief', () => {
    const many = Array.from({ length: 40 }, (_, i) => belief({ id: `b_${i}`, statement: `Preference number ${i} ${'x'.repeat(380)}` }))
    const r = recall(many, 'anything', { now: T0 })
    expect(r.notes.length).toBeLessThanOrEqual(20)
    const size = r.notes.reduce((n, x) => n + new TextEncoder().encode(x.id).length + new TextEncoder().encode(x.text).length, 0)
    expect(size).toBeLessThanOrEqual(8192)
    expect(r.notes.length).toBeGreaterThan(10)
    const odd = recall([belief({ id: 'b_p', statement: 'Atlas sleep' }), belief({ id: 'b_f', truth: { frequency: 0.2, confidence: 0.9 } }), belief({ id: 'b_ok', kind: 'name', statement: 'Call them Jon' })], 'hello', { now: T0 })
    expect(odd.notes).toEqual([{ id: 'b_ok', text: noteText({ kind: 'name', statement: 'Call them Jon' }) }])
  })
})

/** A store over an in-memory backend shared by name (a reload is a new store over the same backend). */
function harness() {
  const dbs = new Map<string, MemoryBackend>()
  let now = T0
  const make = () => new AskMemoryStore({ backend: (name) => dbs.get(name) ?? (dbs.set(name, memoryBackend()), dbs.get(name)!), now: () => now, persist: () => undefined, channel: null })
  return { make, dbs, tick: (ms: number) => (now += ms) }
}
const ADA = { principal: 'user:p_ada', hive: 'sim@local' }
const ROWAN = { principal: 'user:p_rowan', hive: 'sim@local' }
const live = (seq: number, statement: string, kind = 'preference', over: Partial<MemoryFrame> = {}): MemoryFrame => ({ turn_id: 'turn_1', seq, op: 'remember', digest: `d${seq}`, target_id: null, item: { statement, kind: kind as never, truth: { frequency: 1, confidence: 0.8 } }, ...over })

describe('the store: per person per hive, persisted at once, lost stubs, forgetting', () => {
  it('keeps a live frame at once and it survives a reload; another person sees none of it', async () => {
    const h = harness()
    const a = h.make()
    a.use(ADA)
    await a.whenReady()
    expect(a.receive(live(2, 'Prefers short answers'), { privatePage: false, since: a.turnMark() }).kept?.statement).toBe('Prefers short answers')
    expect(a.getView().beliefs).toHaveLength(1) // in view before any await
    await a.flushed()
    const reload = h.make()
    reload.use(ADA)
    await reload.whenReady()
    expect(reload.getView()).toMatchObject({ hive: 'learning', beliefs: [{ statement: 'Prefers short answers' }] })
    reload.use(ROWAN)
    await reload.whenReady()
    expect(reload.getView().beliefs).toEqual([])
    expect(reload.notesFor('anything').notes).toEqual([])
    expect(h.dbs.has(dbName(ADA)) && h.dbs.has(dbName(ROWAN)) && dbName(ADA) !== dbName(ROWAN)).toBe(true)
    reload.use(null)
    expect(reload.receive(live(3, 'x'), { privatePage: false, since: reload.turnMark() })).toEqual({ kept: null, why: 'nobody' })
  })
  it('a frame that arrives before the memory has loaded is learned once it has', async () => {
    const h = harness()
    const s = h.make()
    s.use(ADA)
    s.receive(live(2, 'Call them Jon', 'name'), { privatePage: false, since: s.turnMark() })
    await s.whenReady()
    expect(s.getView().beliefs.map((b) => b.statement)).toEqual(['Call them Jon'])
  })
  it('never keeps from a private page, naming a private app, or past 8 from one turn', async () => {
    const s = harness().make()
    s.use(ADA)
    await s.whenReady()
    expect(s.receive(live(2, 'Prefers dark'), { privatePage: true, since: s.turnMark() }).why).toBe('private')
    expect(s.receive(live(3, 'Atlas sleep score is 7'), { privatePage: false, since: s.turnMark() }).why).toBe('private')
    for (let i = 0; i < 9; i++) s.receive(live(10 + i, `Thing number ${i} of many`, 'project'), { privatePage: false, since: s.turnMark() })
    expect(s.getView().beliefs).toHaveLength(8)
    expect(s.receive(live(4, 'bad', 'goal'), { privatePage: false, since: s.turnMark() }).why).toBe('unreadable')
  })
  it('a stub never seen live is one lost line; a stub for a kept frame, or a blanked one, is not', async () => {
    const h = harness()
    const s = h.make()
    s.use(ADA)
    await s.whenReady()
    s.receive(live(2, 'Prefers short answers'), { privatePage: false, since: s.turnMark() })
    await s.flushed()
    expect(await s.stub({ turn_id: 'turn_1', seq: 2, op: 'remember' })).toBe(false)
    expect(await s.stub({ turn_id: 'turn_1', seq: 5, op: '' })).toBe(false)
    expect(await s.stub({ turn_id: 'turn_1', seq: 4, op: 'remember' })).toBe(true)
    expect(await s.stub({ turn_id: 'turn_1', seq: 4, op: 'remember' })).toBe(false)
    expect(s.getView().trace.filter((t) => t.kind === 'lost')).toHaveLength(1)
    await s.flushed()
    // after a reload the kept frame is still matched by its turn and seq (no false "lost")
    const r = h.make()
    r.use(ADA)
    expect(await r.stub({ turn_id: 'turn_1', seq: 2, op: 'remember' })).toBe(false)
    expect(LOST_WORDS).toMatch(/lost while you were away/)
  })
  it('recall sends ids the host accepts and counts their use once admitted; off sends none', async () => {
    const h = harness()
    const s = h.make()
    s.use(ADA)
    await s.whenReady()
    s.receive(live(2, 'Prefers short answers'), { privatePage: false, since: s.turnMark() })
    const { notes, ids } = s.notesFor('short answers please')
    expect(notes).toHaveLength(1)
    expect(notes.every((n) => NOTE_ID.test(n.id))).toBe(true)
    h.tick(1000)
    s.markUsed(ids)
    expect(s.getView().beliefs[0]).toMatchObject({ uses: 1, last_used_at: T0 + 1000 })
    s.sawHive(false)
    expect(s.getView().hive).toBe('off')
    expect(s.notesFor('short').notes).toEqual([])
    s.sawHive(true)
    expect(s.getView().hive).toBe('conductor')
  })
  it('edit is journalled; forget removes it and blanks its words in the journal; forget everything leaves one line', async () => {
    const h = harness()
    const s = h.make()
    s.use(ADA)
    await s.whenReady()
    const b = s.receive(live(2, 'Prefers short answers'), { privatePage: false, since: s.turnMark() }).kept!
    s.receive(live(3, 'Call them Jon', 'name'), { privatePage: false, since: s.turnMark() })
    expect(s.edit(b.id, 'Prefers very short answers')).toBe(true)
    expect(s.getView().trace.at(-1)).toMatchObject({ kind: 'edit', summary: 'Prefers very short answers', belief_id: b.id })
    expect(s.forget(b.id)).toBe(true)
    const v = s.getView()
    expect(v.beliefs.map((x) => x.statement)).toEqual(['Call them Jon'])
    expect(JSON.stringify(v.trace)).not.toMatch(/short answers/)
    expect(v.trace.at(-1)?.kind).toBe('forget')
    s.forgetAll()
    await s.flushed()
    const r = h.make()
    r.use(ADA)
    await r.whenReady()
    expect(r.getView().beliefs).toEqual([])
    expect(r.getView().trace.map((t) => t.kind)).toEqual(['forget_all'])
  })
})

/** Every write so far, and every read again it caused, has settled (uses only `flushed`, so it runs on r1 too). */
async function idle(...stores: AskMemoryStore[]) {
  for (let i = 0; i < 6; i++) {
    for (const s of stores) await s.flushed()
    await new Promise((r) => setTimeout(r, 0))
  }
}
const stored = async (h: ReturnType<typeof harness>, owner = ADA) => h.dbs.get(dbName(owner))!.load()

describe('stand-in r1 P1: forgetting is authoritative across tabs (two stores over one backend)', () => {
  async function twoTabs() {
    const h = harness()
    const a = h.make()
    a.use(ADA)
    await a.whenReady()
    const kept = a.receive(live(2, 'Prefers short answers'), { privatePage: false, since: a.turnMark() }).kept!
    a.receive(live(3, 'Call them Jon', 'name'), { privatePage: false, since: a.turnMark() })
    await a.flushed()
    const b = h.make() // another tab, loaded while the belief was there: its cache keeps it
    b.use(ADA)
    await b.whenReady()
    expect(b.getView().beliefs.map((x) => x.id)).toContain(kept.id)
    return { h, a, b, kept }
  }
  it('a stale tab counting a use never writes forgotten words back', async () => {
    const { h, a, b, kept } = await twoTabs()
    a.forget(kept.id)
    await a.flushed()
    h.tick(1000)
    b.markUsed([kept.id])
    await idle(a, b)
    const snap = await stored(h)
    expect(snap.beliefs.map((x) => x.statement)).toEqual(['Call them Jon'])
    expect(JSON.stringify(snap)).not.toMatch(/short answers/)
    // the stale tab now shows what storage holds
    expect(b.getView().beliefs.map((x) => x.statement)).toEqual(['Call them Jon'])
  })
  it('a stale tab editing a forgotten belief writes nothing back', async () => {
    const { h, a, b, kept } = await twoTabs()
    a.forget(kept.id)
    await a.flushed()
    b.edit(kept.id, 'Prefers very short answers')
    await idle(a, b)
    const snap = await stored(h)
    expect(snap.beliefs.map((x) => x.id)).not.toContain(kept.id)
    expect(JSON.stringify(snap)).not.toMatch(/short answers/)
  })
  it('stand-in r2 P1 (was: expected the resurrection): a stale tab learning forgotten words from a turn begun before the forget is dropped, never retried', async () => {
    const { h, a, b, kept } = await twoTabs()
    const since = markOf(b) // the turn began before the forget
    h.tick(1000)
    a.forget(kept.id)
    await a.flushed()
    h.tick(1000)
    b.receive(live(9, 'prefers short answers.', 'preference', { turn_id: 'turn_2' }), { privatePage: false, since })
    await idle(a, b)
    const snap = await stored(h)
    expect(snap.beliefs.map((x) => x.statement)).toEqual(['Call them Jon'])
    expect(JSON.stringify(snap)).not.toMatch(/short answers/i)
    expect(b.getView().beliefs.map((x) => x.statement)).toEqual(['Call them Jon'])
    expect(JSON.stringify(b.getView().trace)).not.toMatch(/short answers/i)
  })
  it('a use counted in another tab never undoes an edit, and touches only the use count', async () => {
    const { h, a, b, kept } = await twoTabs()
    h.tick(1000)
    a.edit(kept.id, 'Prefers very short answers')
    await a.flushed()
    b.markUsed([kept.id])
    await idle(a, b)
    const snap = await stored(h)
    expect(snap.beliefs.find((x) => x.id === kept.id)).toMatchObject({ statement: 'Prefers very short answers', uses: 1 })
  })
  it('after forget everything in one tab, a stale tab writes nothing of the old memory back', async () => {
    const { h, a, b, kept } = await twoTabs()
    a.forgetAll()
    await a.flushed()
    h.tick(1000)
    b.markUsed([kept.id])
    b.edit(b.getView().beliefs.find((x) => x.kind === 'name')!.id, 'Call them Jonathan')
    await b.stub({ turn_id: 'turn_1', seq: 7, op: 'remember' })
    await idle(a, b)
    const snap = await stored(h)
    expect(snap.beliefs).toEqual([])
    expect(snap.trace.map((t) => t.kind)).toEqual(['forget_all'])
  })
})

/** A backend whose reads can be held: each load reads storage at once, and answers when released. */
function heldBackend(inner: MemoryBackend) {
  const held: (() => void)[] = []
  let hold = false
  const b: MemoryBackend = {
    load: async () => {
      const holding = hold
      const snap = await inner.load()
      if (!holding) return snap
      await new Promise<void>((r) => held.push(r))
      return snap
    },
    commit: (c) => inner.commit(c),
    close: () => inner.close(),
  }
  return { b, holdReads: (on: boolean) => void (hold = on), release: (i = 0) => held.splice(i, 1)[0]?.() }
}

describe('stand-in r1 P2: a read that finishes late never undoes forgetting on screen', () => {
  it('a reload started before a forget, finishing after it, does not bring the belief back', async () => {
    const inner = memoryBackend()
    const held = heldBackend(inner)
    const bus = new Set<(k: string) => void>()
    let now = T0
    const s = new AskMemoryStore({ backend: () => held.b, now: () => now, persist: () => undefined, channel: { post: () => undefined, listen: (fn) => void bus.add(fn) } })
    s.use(ADA)
    await s.whenReady()
    const kept = s.receive(live(2, 'Prefers short answers'), { privatePage: false, since: s.turnMark() }).kept!
    await s.flushed()
    held.holdReads(true)
    for (const fn of bus) fn(dbName(ADA)) // another tab said it changed: a read starts
    await new Promise((r) => setTimeout(r, 0))
    s.forget(kept.id)
    now += 1000
    held.holdReads(false)
    held.release()
    await idle(s)
    expect(s.getView().beliefs).toEqual([])
    expect(s.notesFor('short answers').notes).toEqual([])
  })
  it('the first read of an owner, finishing after switching away and back, is not installed', async () => {
    const inner = memoryBackend()
    const held = heldBackend(inner)
    const make = () => new AskMemoryStore({ backend: () => held.b, now: () => T0, persist: () => undefined, channel: null })
    const first = make()
    first.use(ADA)
    await first.whenReady()
    const kept = first.receive(live(2, 'Prefers short answers'), { privatePage: false, since: first.turnMark() }).kept!
    await first.flushed()
    first.use(null)
    held.holdReads(true)
    const s = make()
    s.use(ADA) // read 0: ADA, holding the belief
    s.use(ROWAN) // read 1 (one backend here: it only stands for "someone else")
    s.use(ADA) // read 2: ADA again
    held.holdReads(false)
    await new Promise((r) => setTimeout(r, 0)) // all three reads are now waiting
    held.release(2) // the newest read answers first
    await s.whenReady()
    s.forget(kept.id)
    await s.flushed()
    held.release(0) // the first read of ADA, from before, answers last
    held.release(0)
    await idle(s)
    expect(s.getView().beliefs).toEqual([])
  })
})

describe('stand-in r1 P2: a refused edit says why', () => {
  it('names the reason an edit is not kept', async () => {
    const s = harness().make()
    s.use(ADA)
    await s.whenReady()
    const b = s.receive(live(2, 'Prefers short answers'), { privatePage: false, since: s.turnMark() }).kept!
    expect(s.checkEdit(b.id, 'my Atlas notes')).toBe('private')
    expect(s.checkEdit(b.id, '   ')).toBe('empty')
    expect(s.checkEdit(b.id, 'Prefers short answers')).toBe('same')
    expect(s.checkEdit('b_nope', 'x')).toBe('gone')
    expect(s.checkEdit(b.id, 'Prefers long answers')).toBeNull()
    expect(s.edit(b.id, 'my Atlas notes')).toBe(false)
  })
})

/** A turn's mark, where the store has them (068435c has none: the frame then carries no mark, as before). */
const markOf = (s: AskMemoryStore) => ('turnMark' in s ? s.turnMark() : null)
const absent = (v: { beliefs: Belief[]; trace: { summary: string }[] }, words: RegExp) => {
  expect(v.beliefs.map((x) => x.statement).filter((x) => words.test(x))).toEqual([])
  expect(v.trace.map((t) => t.summary).filter((x) => words.test(x))).toEqual([])
}

describe('stand-in r2 P1: a forget is never undone by a delayed frame from an earlier turn', () => {
  it('forget one, then a delayed frame from the old turn with the same words: absent from beliefs and journal', async () => {
    const h = harness()
    const s = h.make()
    s.use(ADA)
    await s.whenReady()
    const since = markOf(s) // the person asked
    h.tick(10)
    const kept = s.receive(live(2, 'Prefers short answers'), { privatePage: false, since }).kept!
    await s.flushed()
    h.tick(1000)
    s.forget(kept.id)
    await s.flushed()
    h.tick(1000)
    const late = s.receive(live(5, '  prefers SHORT answers! '), { privatePage: false, since })
    expect(late.kept).toBeNull()
    await idle(s)
    absent(s.getView(), /short answers/i)
    absent(await stored(h), /short answers/i)
    const r = h.make() // and after a reload
    r.use(ADA)
    await r.whenReady()
    absent(r.getView(), /short answers/i)
  })
  it('forget everything, then a delayed frame from the old turn: absent', async () => {
    const h = harness()
    const s = h.make()
    s.use(ADA)
    await s.whenReady()
    const since = markOf(s)
    h.tick(10)
    s.receive(live(2, 'Prefers short answers'), { privatePage: false, since })
    await s.flushed()
    h.tick(1000)
    s.forgetAll()
    await s.flushed()
    h.tick(1000)
    expect(s.receive(live(5, 'Prefers short answers'), { privatePage: false, since }).kept).toBeNull()
    expect(s.receive(live(6, 'Works on the Mac hive', 'place'), { privatePage: false, since }).kept).toBeNull()
    await idle(s)
    expect(s.getView().beliefs).toEqual([])
    const snap = await stored(h)
    expect(snap.beliefs).toEqual([])
    expect(snap.trace.map((t) => t.kind)).toEqual(['forget_all'])
  })
  it('the stand-in reproduction: forget one AND forget everything in one tab, a delayed old-turn frame in another tab: absent', async () => {
    const h = harness()
    const b = h.make()
    b.use(ADA)
    await b.whenReady()
    const since = markOf(b) // the turn was asked in tab b
    h.tick(10)
    const kept = b.receive(live(2, 'Prefers short answers'), { privatePage: false, since }).kept!
    await b.flushed()
    const a2 = h.make() // tab a, loaded with the belief
    a2.use(ADA)
    await a2.whenReady()
    h.tick(1000)
    a2.forget(kept.id)
    await a2.flushed()
    h.tick(1000)
    a2.forgetAll()
    await a2.flushed()
    h.tick(1000)
    b.receive(live(5, 'Prefers short answers'), { privatePage: false, since })
    await idle(a2, b)
    absent(await stored(h), /short answers/i)
    absent(b.getView(), /short answers/i)
  })
  it('forget one in another tab, then a delayed old-turn frame in a tab that already read the tombstone: absent', async () => {
    const h = harness()
    const b = h.make()
    b.use(ADA)
    await b.whenReady()
    const since = markOf(b)
    h.tick(10)
    const kept = b.receive(live(2, 'Prefers short answers'), { privatePage: false, since }).kept!
    await b.flushed()
    const a = h.make()
    a.use(ADA)
    await a.whenReady()
    h.tick(1000)
    a.forget(kept.id)
    await a.flushed()
    b.use(null) // a reload of tab b reads the tombstone (the turn's mark is from before it)
    b.use(ADA)
    await b.whenReady()
    h.tick(1000)
    b.receive(live(5, 'Prefers short answers'), { privatePage: false, since })
    await idle(a, b)
    absent(await stored(h), /short answers/i)
    absent(b.getView(), /short answers/i)
  })
  it('forget everything, then a NEW turn saying the same thing: learned (new evidence)', async () => {
    const h = harness()
    const s = h.make()
    s.use(ADA)
    await s.whenReady()
    const old = markOf(s)
    h.tick(10)
    s.receive(live(2, 'Prefers short answers'), { privatePage: false, since: old })
    await s.flushed()
    h.tick(1000)
    s.forgetAll()
    await s.flushed()
    h.tick(1000)
    const since = markOf(s) // a new turn, asked after forgetting
    h.tick(10)
    expect(s.receive(live(2, 'Prefers short answers', 'preference', { turn_id: 'turn_2' }), { privatePage: false, since }).kept?.statement).toBe('Prefers short answers')
    await idle(s)
    expect((await stored(h)).beliefs.map((x) => x.statement)).toEqual(['Prefers short answers'])
  })
  it('forget one, then a NEW turn saying the same thing: learned (new evidence)', async () => {
    const h = harness()
    const s = h.make()
    s.use(ADA)
    await s.whenReady()
    const kept = s.receive(live(2, 'Prefers short answers'), { privatePage: false, since: markOf(s) }).kept!
    await s.flushed()
    h.tick(1000)
    s.forget(kept.id)
    await s.flushed()
    h.tick(1000)
    const since = markOf(s)
    h.tick(10)
    const again = s.receive(live(2, 'Prefers short answers', 'preference', { turn_id: 'turn_2' }), { privatePage: false, since }).kept
    expect(again?.statement).toBe('Prefers short answers')
    expect(again?.id).not.toBe(kept.id)
    await idle(s)
    expect((await stored(h)).beliefs.map((x) => x.statement)).toEqual(['Prefers short answers'])
  })
  it('a learn that lost to another tab\'s newer edit is learned once more against it; that retry is refused if a forget now applies', async () => {
    // a backend that runs `between` once, after the first refused commit and before the tab hears of it
    const inner = memoryBackend()
    let between: (() => Promise<void>) | null = null
    const wrapped: MemoryBackend = {
      load: () => inner.load(),
      commit: async (c) => {
        const r = await inner.commit(c)
        if (!r.ok && between) {
          const run = between
          between = null
          await run()
        }
        return r
      },
      close: () => undefined,
    }
    let now = T0
    const make = () => new AskMemoryStore({ backend: () => wrapped, now: () => now, persist: () => undefined, channel: null })
    const a = make()
    a.use(ADA)
    await a.whenReady()
    const kept = a.receive(live(2, 'Prefers short answers'), { privatePage: false, since: a.turnMark() }).kept!
    await a.flushed()
    const b = make()
    b.use(ADA)
    await b.whenReady()
    now += 1000
    expect(a.edit(kept.id, 'Prefers short answers!')).toBe(true)
    await a.flushed()
    // the retry: b's learn merged into its stale copy, lost to a's edit, is learned again against the edited one
    now += 1000
    const since = markOf(b)
    now += 10
    b.receive(live(3, 'Prefers short answers', 'preference', { turn_id: 'turn_2' }), { privatePage: false, since })
    await idle(a, b)
    let snap = await inner.load()
    expect(snap.beliefs.map((x) => x.id)).toEqual([kept.id])
    expect(snap.beliefs[0].truth.confidence).toBeCloseTo(8 / 9, 4)
    // and a retry is refused when a forget lands between the refusal and the retry
    const c = make()
    c.use(ADA)
    await c.whenReady()
    const d = make()
    d.use(ADA)
    await d.whenReady()
    now += 1000
    const since2 = markOf(d)
    now += 10
    expect(c.edit(kept.id, 'Prefers short answers.')).toBe(true)
    await c.flushed()
    now += 10
    between = async () => {
      c.forget(kept.id)
      await c.flushed()
    }
    d.receive(live(4, 'Prefers short answers', 'preference', { turn_id: 'turn_3' }), { privatePage: false, since: since2 })
    await idle(c, d)
    snap = await inner.load()
    expect(between).toBeNull() // the forget did land between the refusal and the retry
    absent(snap, /short answers/i)
    absent(d.getView(), /short answers/i)
  })
})

describe('the tombstone keeps a fingerprint of the words, never the words', () => {
  it('sha256 matches the standard vectors', async () => {
    const { sha256, wordsHash } = await import('./hash')
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3')
    expect(wordsHash('salt', '  Prefers SHORT answers. ')).toBe(wordsHash('salt', 'prefers short answers'))
    expect(wordsHash('salt', 'prefers short answers')).not.toBe(wordsHash('other', 'prefers short answers'))
  })
  it('a stored tombstone holds fingerprints only', async () => {
    const h = harness()
    const s = h.make()
    s.use(ADA)
    await s.whenReady()
    const kept = s.receive(live(2, 'Prefers short answers'), { privatePage: false, since: s.turnMark() }).kept!
    s.edit(kept.id, 'Prefers very short answers')
    s.forget(kept.id)
    await s.flushed()
    const snap = await stored(h)
    expect(JSON.stringify(snap)).not.toMatch(/short answers/i)
    const tomb = (snap as { tombs?: { id: string; words?: string[] }[] }).tombs?.find((t) => t.id === kept.id)
    expect(tomb?.words?.length).toBe(2)
    expect(tomb?.words?.every((w) => /^[a-f0-9]{64}$/.test(w))).toBe(true)
  })
})

/** A rejoined turn's host-timed mark, where the store has them (99c60da has none: no mark, the conservative rule). */
const hostOf = (s: AskMemoryStore, at: string) => ('hostMark' in s ? (s.hostMark(at) ?? null) : null)
const iso = (ms: number) => new Date(ms).toISOString()

describe('r3b: tombstone fingerprints are salted per database', () => {
  it('the same words forgotten in two databases give different fingerprints; matching still works within one', async () => {
    const h = harness()
    const tombOf = async (owner: typeof ADA) => {
      const s = h.make()
      s.use(owner)
      await s.whenReady()
      const since = markOf(s)
      h.tick(10)
      const kept = s.receive(live(2, 'Prefers short answers'), { privatePage: false, since }).kept!
      await s.flushed()
      h.tick(1000)
      s.forget(kept.id)
      await s.flushed()
      h.tick(1000)
      // within this database, the old turn's words are still refused
      expect(s.receive(live(5, 'prefers short answers.'), { privatePage: false, since }).kept).toBeNull()
      await idle(s)
      absent(await stored(h, owner), /short answers/i)
      const snap = (await stored(h, owner)) as { salt?: string; tombs?: { words?: string[] }[] }
      return { words: snap.tombs?.[0]?.words ?? [], salt: snap.salt }
    }
    const a = await tombOf(ADA)
    const r = await tombOf(ROWAN)
    expect(a.words).toHaveLength(1)
    expect(r.words).toHaveLength(1)
    expect(a.words[0]).not.toBe(r.words[0])
    expect(a.salt).toMatch(/^[a-f0-9]{32}$/)
    expect(a.salt).not.toBe(r.salt)
  })
  it('the salt is made once per database and kept: a reload reads the same one', async () => {
    const h = harness()
    const s = h.make()
    s.use(ADA)
    await s.whenReady()
    const first = ((await stored(h)) as { salt?: string }).salt
    s.forgetAll()
    await s.flushed()
    const r = h.make()
    r.use(ADA)
    await r.whenReady()
    expect(((await stored(h)) as { salt?: string }).salt).toBe(first)
    expect(first).toBeTruthy()
  })
})

describe('r3b: a turn rejoined after a reload is timed by the host', () => {
  it('start a turn, forget everything, reload (a new store; the turn rejoined), then a delayed frame: absent', async () => {
    const h = harness()
    const s = h.make()
    s.use(ADA)
    await s.whenReady()
    const accepted = iso(T0 + 10) // the host's accepted frame
    h.tick(20)
    s.receive(live(2, 'Prefers short answers', 'preference', { turn_id: 'turn_r' }), { privatePage: false, since: markOf(s) })
    await s.flushed()
    h.tick(1000)
    s.forgetAll()
    await s.flushed()
    h.tick(1000)
    const r = h.make() // the reload: no mark of this page's for the turn
    r.use(ADA)
    await r.whenReady()
    const since = hostOf(r, accepted)
    expect(r.receive(live(5, 'Prefers short answers', 'preference', { turn_id: 'turn_r' }), { privatePage: false, since }).kept).toBeNull()
    expect(r.receive(live(6, 'Works on the Mac hive', 'place', { turn_id: 'turn_r' }), { privatePage: false, since }).kept).toBeNull()
    await idle(r)
    expect(r.getView().beliefs).toEqual([])
    const snap = await stored(h)
    expect(snap.beliefs).toEqual([])
    expect(snap.trace.map((t) => t.kind)).toEqual(['forget_all'])
  })
  it('forget one, reload, then a delayed frame of a rejoined turn that began before it: absent', async () => {
    const h = harness()
    const s = h.make()
    s.use(ADA)
    await s.whenReady()
    const accepted = iso(T0 + 10)
    h.tick(20)
    const kept = s.receive(live(2, 'Prefers short answers', 'preference', { turn_id: 'turn_r' }), { privatePage: false, since: markOf(s) }).kept!
    await s.flushed()
    h.tick(1000)
    s.forget(kept.id)
    await s.flushed()
    h.tick(1000)
    const r = h.make()
    r.use(ADA)
    await r.whenReady()
    expect(r.receive(live(5, 'Prefers short answers', 'preference', { turn_id: 'turn_r' }), { privatePage: false, since: hostOf(r, accepted) }).kept).toBeNull()
    await idle(r)
    absent(await stored(h), /short answers/i)
  })
  it('a rejoined turn the host says began after the forget everything is learned (new evidence)', async () => {
    const h = harness()
    const s = h.make()
    s.use(ADA)
    await s.whenReady()
    s.forgetAll()
    await s.flushed()
    h.tick(10 * 60_000)
    const accepted = iso(T0 + 10 * 60_000)
    h.tick(1000)
    const r = h.make()
    r.use(ADA)
    await r.whenReady()
    expect(r.receive(live(2, 'Prefers short answers', 'preference', { turn_id: 'turn_n' }), { privatePage: false, since: hostOf(r, accepted) }).kept?.statement).toBe('Prefers short answers')
    await idle(r)
    expect((await stored(h)).beliefs.map((x) => x.statement)).toEqual(['Prefers short answers'])
  })
  it('a host time that does not read as a time gives no mark (the conservative rule applies)', () => {
    const s = harness().make()
    expect(s.hostMark('not a time')).toBeUndefined()
    expect(s.hostMark('')).toBeUndefined()
  })
})
