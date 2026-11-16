import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import { memoryBackend, type MemoryBackend } from '../../lib/askMemory/backend'
import { AskMemoryStore } from '../../lib/askMemory/store'
import type { EpochBinding } from '../../lib/identityEpoch'
import { collectInbox } from './inbox'

/**
 * Personal mind r1: the swarm-talk collect is READ → WRITE (storage transaction completes) → ACK exactly what was
 * settled, bound to the identity it started under. Invented people and conversations only; in-memory storage.
 */

const T0 = Date.parse('2026-10-08T12:00:00Z')
const STALE = Symbol('stale')

/** A hand-driven identity epoch (lib/identityEpoch's contract): `change()` moves it and runs the clear hooks. */
function epochKit() {
  let epoch = 0
  const hooks: (() => void)[] = []
  const bind = (): EpochBinding => {
    const at = epoch
    const current = () => epoch === at
    return { epoch: at, current, commit: <R,>(w: () => R) => (current() ? w() : (STALE as never)) }
  }
  return {
    bind,
    onIdentityChange: (fn: () => void) => (hooks.push(fn), () => undefined),
    change: () => {
      epoch++
      for (const h of hooks) h()
    },
  }
}

/** Storage whose commits wait for `release()` and say when they start and complete, in `log`. */
function gated(log: string[]) {
  const inner = memoryBackend()
  let open: () => void = () => undefined
  let gate = new Promise<void>((r) => (open = r))
  let fail = false
  const b: MemoryBackend = {
    // stands in for IndexedDB: a completed commit survives the page (r1.1 P1)
    durable: true,
    load: () => inner.load(),
    close() {},
    async commit(c) {
      log.push(`write:${c.op}`)
      await gate
      if (fail) {
        log.push(`write-failed:${c.op}`)
        throw new Error('storage refused')
      }
      const r = await inner.commit(c)
      log.push(`written:${c.op}`)
      return r
    },
  }
  return {
    b,
    inner,
    release: () => open(),
    hold: () => (gate = new Promise<void>((r) => (open = r))),
    failNext: () => (fail = true),
  }
}

const item = (id: string, words: string, minutesAgo = 10) => ({ id, turn_id: `turn_${id}`, created_at: new Date(T0 - minutesAgo * 60_000).toISOString(), words, answer: `Invented answer to: ${words}`, truncated: false })

/** A host's held copies (personal_inbox), recording every read and ack in `log`. */
function host(log: string[], items: ReturnType<typeof item>[], opts: { status?: number; dropped?: number; expired?: number; junkFirst?: number } = {}) {
  let held = [...items]
  return {
    held: () => held,
    client: {
      async myMindInbox(after: string | null, limit: number) {
        log.push(`read${after ? `:${after}` : ''}`)
        if (opts.status) throw new ApiError(opts.status, opts.status === 403 ? 'person_required' : 'not_found', 'no')
        const from = after ? held.findIndex((x) => x.id === after) + 1 : 0
        // junkFirst: a first page of N malformed items (all left out by the page) that still says where to go on
        if (!after && opts.junkFirst) return { items: Array.from({ length: opts.junkFirst }, (_, i) => ({ id: `bad id ${i}` })), next: 'pi_junk_end', dropped: opts.dropped ?? 0, expired: opts.expired ?? 0 }
        const page = held.slice(after === 'pi_junk_end' ? 0 : from, (after === 'pi_junk_end' ? 0 : from) + limit + 1)
        return { items: page.slice(0, limit), next: page.length > limit ? page[limit - 1].id : null, dropped: opts.dropped ?? 0, expired: opts.expired ?? 0 }
      },
      async myMindInboxAck(ids: string[]) {
        log.push(`ack:${ids.join(',')}`)
        held = held.filter((x) => !ids.includes(x.id))
        return { deleted: ids.length }
      },
    },
  }
}

function setup(items: ReturnType<typeof item>[], opts: { status?: number; dropped?: number; expired?: number; junkFirst?: number } = {}) {
  const log: string[] = []
  const id = epochKit()
  const g = gated(log)
  const memory = new AskMemoryStore({ backend: () => g.b, now: () => T0, persist: () => undefined, channel: null, bind: id.bind, onIdentityChange: id.onIdentityChange })
  memory.use({ principal: 'user:p_inv_ada', hive: 'sim@test' })
  const h = host(log, items, opts)
  const run = () => collectInbox({ client: h.client, memory, bind: id.bind })
  return { log, id, g, memory, h, run }
}
const ticks = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe('swarm talk: read → durable write → ack', () => {
  it('acknowledges only after the storage transaction completed, and only what it settled', async () => {
    const s = setup([item('pi_a1', 'When is the first frost due?'), item('pi_a2', 'Reconcile the March invoices.')])
    await s.memory.whenReady()
    const done = s.run()
    await ticks()
    // the write has started and is held open: nothing is acknowledged yet
    expect(s.log).toEqual(['read', 'write:talks'])
    s.g.release()
    const r = await done
    expect(r).toEqual({ state: 'done', kept: 2, dropped: 0, expired: 0 })
    expect(s.log).toEqual(['read', 'write:talks', 'written:talks', 'ack:pi_a1,pi_a2'])
    expect(s.memory.getView().talks.map((t) => t.words)).toEqual(['When is the first frost due?', 'Reconcile the March invoices.'])
    expect(s.h.held()).toEqual([])
  })

  it('a write that fails acknowledges nothing: the hive keeps every copy', async () => {
    const s = setup([item('pi_b1', 'Pick October’s book.')])
    await s.memory.whenReady()
    s.g.failNext()
    s.g.release()
    const r = await s.run()
    expect(r.state).toBe('failed')
    expect(s.log.some((l) => l.startsWith('ack'))).toBe(false)
    expect(s.h.held().map((x) => x.id)).toEqual(['pi_b1'])
  })

  it('a copy forgotten here is settled and acknowledged, but never kept again', async () => {
    const s = setup([item('pi_c1', 'Invented talk to forget')])
    await s.memory.whenReady()
    s.g.release()
    await s.run()
    expect(s.memory.forgetTalk('pi_c1')).toBe(true)
    await s.memory.flushed()
    // the hive delivers the same copy again (its ack was lost): settled as forgotten, acknowledged, not kept
    const again = host(s.log, [item('pi_c1', 'Invented talk to forget')])
    s.log.length = 0
    const r = await collectInbox({ client: again.client, memory: s.memory, bind: s.id.bind })
    expect(r).toEqual({ state: 'done', kept: 1, dropped: 0, expired: 0 })
    expect(s.log).toEqual(['read', 'write:talks', 'written:talks', 'ack:pi_c1'])
    expect(s.memory.getView().talks).toEqual([])
  })

  it('a copy delivered twice is kept once', async () => {
    const s = setup([item('pi_d1', 'Invented repeated talk')])
    await s.memory.whenReady()
    s.g.release()
    await s.run()
    const again = host(s.log, [item('pi_d1', 'Invented repeated talk')])
    await collectInbox({ client: again.client, memory: s.memory, bind: s.id.bind })
    expect(s.memory.getView().talks).toHaveLength(1)
  })

  it('pages through, acknowledging each page after its own write', async () => {
    const many = Array.from({ length: 60 }, (_, i) => item(`pi_p${String(i).padStart(2, '0')}`, `Invented talk ${i}`, 120 - i))
    const s = setup(many)
    await s.memory.whenReady()
    s.g.release()
    const r = await s.run()
    expect(r).toEqual({ state: 'done', kept: 60, dropped: 0, expired: 0 })
    const order = s.log.filter((l) => l.startsWith('written') || l.startsWith('ack')).map((l) => l.split(':')[0])
    expect(order).toEqual(['written', 'ack', 'written', 'ack'])
    expect(s.memory.getView().talks).toHaveLength(60)
    expect(s.h.held()).toEqual([])
  })

  it('a host without the inbox (404) or an account without a mind (403) is absent: no write, no ack', async () => {
    for (const status of [404, 403]) {
      const s = setup([item('pi_e1', 'x')], { status })
      await s.memory.whenReady()
      expect(await s.run()).toEqual({ state: 'absent' })
      expect(s.log).toEqual(['read'])
    }
  })

  it('a malformed item is left out and never acknowledged', async () => {
    const s = setup([item('pi_f1', 'Invented fine talk'), { ...item('pi_f2', 'bad'), created_at: 'not a time' }])
    await s.memory.whenReady()
    s.g.release()
    await s.run()
    expect(s.log).toContain('ack:pi_f1')
    expect(s.h.held().map((x) => x.id)).toEqual(['pi_f2'])
  })
})

describe('swarm talk: bound to the identity it started under', () => {
  it('an identity change after the read: nothing is written and nothing acknowledged', async () => {
    const s = setup([item('pi_g1', 'Invented talk for A')])
    await s.memory.whenReady()
    s.g.release()
    const done = s.run()
    // the read is answered; the person changes before the page writes
    await Promise.resolve()
    s.id.change()
    expect(await done).toEqual({ state: 'stale' })
    expect(s.log.filter((l) => l.startsWith('write') || l.startsWith('ack'))).toEqual([])
    expect(s.h.held().map((x) => x.id)).toEqual(['pi_g1'])
    const stored = await s.g.inner.load()
    expect(stored.talks).toEqual([])
  })

  it('an identity change while the write is in flight: the copies are not acknowledged', async () => {
    const s = setup([item('pi_h1', 'Invented talk for A')])
    await s.memory.whenReady()
    const done = s.run()
    await ticks()
    expect(s.log).toEqual(['read', 'write:talks'])
    s.id.change()
    s.g.release()
    expect(await done).toEqual({ state: 'stale' })
    expect(s.log.some((l) => l.startsWith('ack'))).toBe(false)
    expect(s.h.held().map((x) => x.id)).toEqual(['pi_h1'])
    // and the memory now shows nobody's talks
    expect(s.memory.getView().talks).toEqual([])
  })

  it('r1.1 P1: memory that would not survive the page (the in-memory fallback) reads nothing and acknowledges nothing', async () => {
    const log: string[] = []
    const id = epochKit()
    const memory = new AskMemoryStore({ backend: () => memoryBackend(), now: () => T0, persist: () => undefined, channel: null, bind: id.bind, onIdentityChange: id.onIdentityChange })
    memory.use({ principal: 'user:p_inv_ada', hive: 'sim@test' })
    await memory.whenReady()
    const h = host(log, [item('pi_v1', 'Invented talk kept only on the hive')])
    expect(await memory.keepsDurably()).toBe(false)
    expect(await collectInbox({ client: h.client, memory, bind: id.bind })).toEqual({ state: 'volatile' })
    expect(log).toEqual([])
    expect(h.held().map((x) => x.id)).toEqual(['pi_v1'])
    // and the store itself refuses to settle anything there
    expect(await memory.rememberTalks([{ id: 'pi_v1', turn_id: 't', at: T0 - 1000, words: 'x', answer: 'y', truncated: false }])).toBeNull()
  })

  it('r1.1 P1: a durable backend waits for the browser’s answer to the persist request before settling', async () => {
    const log: string[] = []
    const id = epochKit()
    const g = gated(log)
    let answer: (v: boolean) => void = () => undefined
    const asked = new Promise<boolean>((r) => (answer = r))
    const memory = new AskMemoryStore({ backend: () => g.b, now: () => T0, persist: () => asked, channel: null, bind: id.bind, onIdentityChange: id.onIdentityChange })
    memory.use({ principal: 'user:p_inv_ada', hive: 'sim@test' })
    await memory.whenReady()
    g.release()
    const h = host(log, [item('pi_w1', 'Invented talk')])
    const done = collectInbox({ client: h.client, memory, bind: id.bind })
    await ticks()
    expect(log).toEqual([])
    answer(false)
    expect(await done).toEqual({ state: 'done', kept: 1, dropped: 0, expired: 0 })
    expect(log).toEqual(['read', 'write:talks', 'written:talks', 'ack:pi_w1'])
  })

  it('nobody signed in: nothing is read', async () => {
    const log: string[] = []
    const id = epochKit()
    const memory = new AskMemoryStore({ backend: () => memoryBackend(), now: () => T0, persist: () => undefined, channel: null, bind: id.bind, onIdentityChange: id.onIdentityChange })
    const h = host(log, [item('pi_i1', 'x')])
    expect(await collectInbox({ client: h.client, memory, bind: id.bind })).toEqual({ state: 'nobody' })
    expect(log).toEqual([])
  })
})

describe('Kimi r1 P1: nothing lost silently, and the collect reads to the end', () => {
  it('carries the host’s dropped and expired counts', async () => {
    const s = setup([item('pi_k1', 'Invented talk')], { dropped: 1, expired: 3 })
    await s.memory.whenReady()
    s.g.release()
    expect(await s.run()).toEqual({ state: 'done', kept: 1, dropped: 1, expired: 3 })
  })
  it('a page whose items were all left out does not stop the collect while the host says there is more', async () => {
    const s = setup([item('pi_k2', 'Invented talk after a bad page')], { junkFirst: 50 })
    await s.memory.whenReady()
    s.g.release()
    expect(await s.run()).toEqual({ state: 'done', kept: 1, dropped: 0, expired: 0 })
    expect(s.log).toEqual(['read', 'read:pi_junk_end', 'write:talks', 'written:talks', 'ack:pi_k2'])
  })
})

describe('Kimi r1 P1: a forgotten conversation stays forgotten under a new id', () => {
  it('the same words delivered again under another id are settled, never kept', async () => {
    const s = setup([item('pi_m1', 'Invented question to forget', 30)])
    await s.memory.whenReady()
    s.g.release()
    await s.run()
    expect(s.memory.forgetTalk('pi_m1')).toBe(true)
    await s.memory.flushed()
    const again = host(s.log, [{ ...item('pi_m1_again', 'Invented question to forget', 30) }])
    s.log.length = 0
    expect(await collectInbox({ client: again.client, memory: s.memory, bind: s.id.bind })).toEqual({ state: 'done', kept: 1, dropped: 0, expired: 0 })
    expect(s.log).toEqual(['read', 'write:talks', 'written:talks', 'ack:pi_m1_again'])
    expect(s.memory.getView().talks).toEqual([])
  })
})
