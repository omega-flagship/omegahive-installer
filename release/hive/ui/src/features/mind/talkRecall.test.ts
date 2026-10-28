import { describe, expect, it } from 'vitest'
import { memoryBackend } from '../../lib/askMemory/backend'
import { recall, talkSendable, TALK_MIN_SIMILARITY, type Forgets } from '../../lib/askMemory/recall'
import { AskMemoryStore } from '../../lib/askMemory/store'
import { wordsHash } from '../../lib/askMemory/hash'
import type { Talk } from '../../lib/askMemory/types'

/**
 * r2 (Quinn: "it should be used when talking to me - it should get to know me"): the person's swarm conversations are
 * recalled with their Ask turns, under the same caps and every forget. Invented conversations only.
 */

const T0 = Date.parse('2026-10-09T12:00:00Z')
const SALT = 'ab'.repeat(16)
const talk = (id: string, words: string, answer: string, minutesAgo = 60): Talk => ({ id, turn_id: `t_${id}`, at: T0 - minutesAgo * 60_000, words, answer, truncated: false, kept_at: T0 - minutesAgo * 60_000 + 1000 })
const FROST = talk('pi_frost', 'When is the first frost due at the garden?', 'Around 24 October on the usual dates; the Garden swarm will cover the seedlings the week before.')
const none: Forgets = { tombs: [], salt: SALT, genAt: 0 }

describe('swarm talk feeds recall', () => {
  it('is recalled for a related question, and not for an unrelated one', () => {
    const related = recall([], 'is the garden frost coming soon', { now: T0, talks: [FROST], forgets: none })
    expect(related.ids).toEqual(['pi_frost'])
    expect(related.notes[0].text).toMatch(/^conversation: you asked “When is the first frost due at the garden\?”; the answer was “Around 24 October/)
    expect(recall([], 'book a table for dinner', { now: T0, talks: [FROST], forgets: none }).ids).toEqual([])
    expect(recall([], 'what is the bakery invoice total for March', { now: T0, talks: [FROST], forgets: none }).ids).toEqual([])
    expect(TALK_MIN_SIMILARITY).toBeGreaterThan(0.3)
  })

  it('a conversation naming a private app is never sent', () => {
    const priv = talk('pi_priv', 'When is the first frost due at the garden?', 'Atlas says around 24 October.')
    expect(talkSendable(priv, none)).toBe(false)
    expect(recall([], 'when is the first frost due at the garden', { now: T0, talks: [priv], forgets: none }).ids).toEqual([])
  })

  it('never sent unchecked: without the forgets, no conversation goes', () => {
    expect(recall([], 'is the garden frost coming soon', { now: T0, talks: [FROST] }).ids).toEqual([])
  })

  it('forgotten everything since it was held (the watermark): never sent', () => {
    expect(recall([], 'is the garden frost coming soon', { now: T0, talks: [FROST], forgets: { ...none, genAt: FROST.at } }).ids).toEqual([])
  })

  it('its words forgotten (a forget marker, under any id): never sent', () => {
    const tomb = { id: 'pi_other', at: T0, words: [wordsHash(SALT, FROST.words)] }
    expect(recall([], 'is the garden frost coming soon', { now: T0, talks: [FROST], forgets: { ...none, tombs: [tomb] } }).ids).toEqual([])
  })

  it('shares the caps with the notes (20 notes, 8 KB in all)', () => {
    const many = Array.from({ length: 40 }, (_, i) => talk(`pi_m${i}`, `When is the first frost due at the garden, part ${i}?`, `Around 24 October; the Garden swarm will cover the seedlings, note ${i}. ${'x'.repeat(200)}`))
    const r = recall([], 'is the garden frost coming soon', { now: T0, talks: many, forgets: none })
    expect(r.notes.length).toBeLessThanOrEqual(20)
    expect(new TextEncoder().encode(r.notes.map((n) => n.id + n.text).join('')).length).toBeLessThanOrEqual(8 * 1024)
  })
})

describe('the store: recalled, forgotten, and used N times', () => {
  async function store() {
    const s = new AskMemoryStore({ backend: () => ({ ...memoryBackend(), durable: true }), now: () => T0, persist: () => undefined, channel: null })
    s.use({ principal: 'user:p_inv_ada', hive: 'sim@test' })
    await s.whenReady()
    s.hiveCaps({ conductor: true, memory: true })
    await s.rememberTalks([{ id: FROST.id, turn_id: FROST.turn_id, at: FROST.at, words: FROST.words, answer: FROST.answer, truncated: false }])
    // r2.3: the person turned "Use my swarm talk in answers" on (these tests are r2's behaviour, with it on)
    expect(s.setTalkRecall(true)).toBe(true)
    return s
  }

  it('a collected conversation goes with a related question; sending it counts a use, kept in storage', async () => {
    const s = await store()
    const r = s.notesFor('is the garden frost coming soon')
    expect(r.ids).toEqual(['pi_frost'])
    s.markUsed(r.ids)
    expect(s.getView().talks[0].uses).toBe(1)
    await s.flushed()
    const again = new AskMemoryStore({ backend: () => s['backend']!, now: () => T0, persist: () => undefined, channel: null })
    again.use({ principal: 'user:p_inv_ada', hive: 'sim@test' })
    await again.whenReady()
    expect(again.getView().talks[0].uses).toBe(1)
  })

  it('a forgotten conversation is never sent again', async () => {
    const s = await store()
    expect(s.forgetTalk('pi_frost')).toBe(true)
    expect(s.notesFor('is the garden frost coming soon').ids).toEqual([])
    await s.flushed()
    // and delivered again under another id, it is not kept, so not sent
    await s.rememberTalks([{ id: 'pi_frost_again', turn_id: 't2', at: FROST.at, words: FROST.words, answer: FROST.answer, truncated: false }])
    expect(s.notesFor('is the garden frost coming soon').ids).toEqual([])
  })

  it('memory off on this hive: nothing is recalled, conversations included', async () => {
    const s = await store()
    s.hiveCaps({ conductor: true, memory: false })
    expect(s.notesFor('is the garden frost coming soon').ids).toEqual([])
  })

  it('after forget everything, nothing old is sent', async () => {
    const s = await store()
    s.forgetAll()
    await s.flushed()
    expect(s.notesFor('is the garden frost coming soon').ids).toEqual([])
  })
})

describe('r2.3: "Use my swarm talk in answers" is the person’s own setting, off by default', () => {
  const OWNER = { principal: 'user:p_inv_ada', hive: 'sim@test' }
  function epochKit() {
    let epoch = 0
    const hooks: (() => void)[] = []
    const bind = () => {
      const at = epoch
      const current = () => epoch === at
      return { epoch: at, current, commit: <R,>(w: () => R) => (current() ? w() : (Symbol('stale') as never)) }
    }
    return { bind, onIdentityChange: (fn: () => void) => (hooks.push(fn), () => undefined), change: () => (epoch++, hooks.forEach((h) => h())) }
  }
  async function fresh(backends = new Map<string, ReturnType<typeof memoryBackend>>(), id = epochKit()) {
    const s = new AskMemoryStore({ backend: (n) => backends.get(n) ?? (backends.set(n, { ...memoryBackend(), durable: true }), backends.get(n)!), now: () => T0, persist: () => undefined, channel: null, bind: id.bind, onIdentityChange: id.onIdentityChange })
    s.use(OWNER)
    await s.whenReady()
    return { s, backends, id }
  }
  const collect = (s: AskMemoryStore) => s.rememberTalks([{ id: FROST.id, turn_id: FROST.turn_id, at: FROST.at, words: FROST.words, answer: FROST.answer, truncated: false }])

  it('off by default: the conversation is collected and kept, but never recalled', async () => {
    const { s } = await fresh()
    expect(s.getView().talkRecall).toBe(false)
    await collect(s)
    expect(s.getView().talks.map((t) => t.id)).toEqual(['pi_frost'])
    expect(s.notesFor('is the garden frost coming soon').ids).toEqual([])
  })

  it('read on every turn: on, it goes; turned off before the next turn, that turn has no swarm-talk text', async () => {
    const { s } = await fresh()
    await collect(s)
    s.setTalkRecall(true)
    expect(s.notesFor('is the garden frost coming soon').ids).toEqual(['pi_frost'])
    s.setTalkRecall(false)
    const next = s.notesFor('is the garden frost coming soon')
    expect(next.ids).toEqual([])
    expect(next.notes.some((n) => n.text.startsWith('conversation:'))).toBe(false)
  })

  it('survives a reload for the same person', async () => {
    const { s, backends, id } = await fresh()
    s.setTalkRecall(true)
    await s.flushed()
    const { s: again } = await fresh(backends, id)
    expect(again.getView().talkRecall).toBe(true)
  })

  it('an identity change resets it to off (a new person, or nobody)', async () => {
    const { s, id } = await fresh()
    await collect(s)
    s.setTalkRecall(true)
    await s.flushed()
    id.change()
    expect(s.getView().talkRecall).toBe(false)
    s.use({ principal: 'user:p_inv_tomas', hive: 'sim@test' })
    await s.whenReady()
    expect(s.getView().talkRecall).toBe(false)
    expect(s.notesFor('is the garden frost coming soon').ids).toEqual([])
  })

  it('wiped storage, or a missing or malformed value, is off', async () => {
    const odd = { ...memoryBackend(), durable: true }
    const load = odd.load.bind(odd)
    odd.load = async () => ({ ...(await load()), talk_recall: 'yes' as unknown as boolean })
    const s = new AskMemoryStore({ backend: () => odd, now: () => T0, persist: () => undefined, channel: null })
    s.use(OWNER)
    await s.whenReady()
    expect(s.getView().talkRecall).toBe(false)
    const { s: wiped } = await fresh()
    expect(wiped.getView().talkRecall).toBe(false)
  })

  it('a setting changed for a person no longer signed in is not written', async () => {
    const { s, id, backends } = await fresh()
    id.change()
    expect(s.setTalkRecall(true)).toBe(false)
    await s.flushed()
    const { s: again } = await fresh(backends, epochKit())
    expect(again.getView().talkRecall).toBe(false)
  })
})
