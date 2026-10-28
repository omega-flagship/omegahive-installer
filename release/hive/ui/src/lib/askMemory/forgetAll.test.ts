import { describe, expect, it } from 'vitest'
import { memoryBackend, type MemoryBackend } from './backend'
import { AskMemoryStore } from './store'
import type { EpochBinding } from '../identityEpoch'
import type { MemoryFrame } from './types'

/**
 * r2.4 (Kimi follow-up): what survives "Forget everything". The commit runs `tx.clear()` (backend.ts, the `forget_all`
 * branch of `apply`), which empties beliefs, the WHOLE trace journal, tombstones and talks, in both backends (the
 * in-memory `clear` and IndexedDB's, which clears the same four stores), then writes the one forget_all line, whose
 * summary is empty. `meta` keeps only the generation and its time (the watermark), the salt and the person's
 * swarm-talk setting. So no remembered words survive anywhere in storage: proved here on the shared `apply`.
 * Invented data only.
 */

const T0 = Date.parse('2026-10-09T12:00:00Z')
const OWNER = { principal: 'user:p_inv_ada', hive: 'sim@test' }
let seq = 0
const frame = (statement: string): MemoryFrame => ({ turn_id: `turn_${++seq}`, seq: 1, op: 'remember', digest: 'd', target_id: null, item: { statement, kind: 'preference', truth: { frequency: 1, confidence: 0.8 } } })

describe('r2.4: nothing readable survives forget everything', () => {
  it('beliefs, every journal summary, conversations and markers are gone; one empty forget_all line remains', async () => {
    const db = { ...memoryBackend(), durable: true }
    const s = new AskMemoryStore({ backend: () => db, now: () => T0, persist: () => undefined, channel: null })
    s.use(OWNER)
    await s.whenReady()
    for (const w of ['Invented: likes the short answer first', 'Invented: weekly review on Fridays', 'Invented: a third note']) {
      s.receive(frame(w), { privatePage: false, since: s.turnMark() })
      await s.flushed()
    }
    const id = s.getView().beliefs.find((b) => b.statement.includes('weekly'))!.id
    expect(s.edit(id, 'Invented: weekly review on Thursdays')).toBe(true)
    s.forget(s.getView().beliefs.find((b) => b.statement.includes('third'))!.id)
    await s.rememberTalks([{ id: 'pi_t1', turn_id: 't1', at: T0 - 60_000, words: 'Invented question about frost', answer: 'Invented answer about seedlings', truncated: false }])
    s.setTalkRecall(true)
    await s.flushed()
    const before = JSON.stringify(await db.load())
    expect(before).toMatch(/short answer|Thursdays|frost/)

    expect(s.forgetAll()).toBe(true)
    await s.flushed()
    const snap = await db.load()
    expect(snap.beliefs).toEqual([])
    expect(snap.talks).toEqual([])
    expect(snap.tombs).toEqual([])
    expect(snap.trace.map((t) => [t.kind, t.summary])).toEqual([['forget_all', '']])
    const after = JSON.stringify(snap)
    for (const w of ['short answer', 'Fridays', 'Thursdays', 'third note', 'frost', 'seedlings', 'Invented']) expect(after).not.toContain(w)
    // what meta keeps: the watermark, and the person's own setting (a choice, not a memory)
    expect(snap.gen_at).toBe(T0)
    expect(snap.talk_recall).toBe(true)
    // and the page shows the same
    expect(s.getView().trace.map((t) => [t.kind, t.summary])).toEqual([['forget_all', '']])
  })
})

/** Storage whose commits wait for `release()`, recording which settings reach it. */
function held() {
  const inner = memoryBackend()
  let open: () => void = () => undefined
  const gate = new Promise<void>((r) => (open = r))
  const reached: string[] = []
  const b: MemoryBackend = {
    durable: true,
    load: () => inner.load(),
    close() {},
    async commit(c) {
      await gate
      if (c.op === 'setting') reached.push(`setting:${c.talk_recall}`)
      return inner.commit(c)
    },
  }
  return { b, inner, release: () => open(), reached }
}

describe('r2.4 (stand-in): an identity change while a talk_recall write is in flight', () => {
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

  it('the setter has started, its write is queued behind another, the identity changes: nothing reaches the old or the new person’s store', async () => {
    const id = epochKit()
    const ada = held()
    const tomas = held()
    const s = new AskMemoryStore({ backend: (n) => (n.includes('tomas') ? tomas.b : ada.b), now: () => T0, persist: () => undefined, channel: null, bind: id.bind, onIdentityChange: id.onIdentityChange })
    s.use(OWNER)
    await s.whenReady()
    // an earlier write of Ada's is still in flight, so the setting's write waits behind it
    s.receive(frame('Invented: an earlier note'), { privatePage: false, since: s.turnMark() })
    expect(s.setTalkRecall(true)).toBe(true)
    expect(s.getView().talkRecall).toBe(true)
    // between the setter starting and its commit: the person changes
    id.change()
    expect(s.getView().talkRecall).toBe(false)
    s.use({ principal: 'user:p_inv_tomas', hive: 'sim@test' })
    tomas.release()
    await s.whenReady()
    ada.release()
    await s.flushed()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(ada.reached).toEqual([])
    expect(tomas.reached).toEqual([])
    expect((await ada.inner.load()).talk_recall).toBe(false)
    expect((await tomas.inner.load()).talk_recall).toBe(false)
    expect(s.getView().talkRecall).toBe(false)
  })

  it('with nothing queued ahead of it, a change in the same tick as the setter still stops the write', async () => {
    const id = epochKit()
    const ada = held()
    const s = new AskMemoryStore({ backend: () => ada.b, now: () => T0, persist: () => undefined, channel: null, bind: id.bind, onIdentityChange: id.onIdentityChange })
    s.use(OWNER)
    await s.whenReady()
    ada.release()
    expect(s.setTalkRecall(true)).toBe(true)
    id.change() // before the queued write's turn comes (a microtask later)
    await s.flushed()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(ada.reached).toEqual([])
    expect((await ada.inner.load()).talk_recall).toBe(false)
  })
})
