import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import { PieceCustody, REFRESH_MS, STALE_MS, type Capture, type CustodyDeps } from './custody'
import type { PieceAck } from './pieceAdapter'

/** J3 r4.3 O3: current-piece custody. INVENTED pieces; deterministic (deferred promises, a fake clock; no sleeps). */

const H = (c: string) => c.repeat(64).slice(0, 64)
const cap = (gen: number, body = `piece-${gen}`): Capture => ({ body, scene_ref: { scene_id: 'sim-poster', revision: gen, digest: `sha256:${H('a')}` }, edit_generation: gen, pending_fields: false })
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

type Ackish = { seq: number; body_sha256: string; raw?: string } | null
/** the adapter's ack in tests: `raw` from the host form (host R3 prefixes `sha256:`) */
const ackOf = (a: Ackish): PieceAck | null => (a ? { ...a, raw: a.raw ?? a.body_sha256.replace(/^sha256:/, '') } : null)
function harness(opts: { hash?: 'deferred' | 'sync'; put?: (seq: number, c: Capture) => Promise<Ackish>; ledger?: () => Promise<Ackish> } = {}) {
  let now = 10_000
  const timers: { at: number; fn: () => void }[] = []
  const hashes: { body: string; d: ReturnType<typeof deferred<string>> }[] = []
  const puts: { seq: number; gen: number; body: string }[] = []
  let asked = 0
  const deps: CustodyDeps = {
    mount: 7,
    requestCapture: () => { asked++ },
    sha256: (body) => {
      if (opts.hash === 'deferred') { const d = deferred<string>(); hashes.push({ body, d }); return d.promise }
      return Promise.resolve(H(body.at(-1)!))
    },
    put: async (seq, c) => { puts.push({ seq, gen: c.edit_generation, body: c.body }); return ackOf(opts.put ? await opts.put(seq, c) : { seq, body_sha256: `sha256:${H(c.body.at(-1)!)}` }) },
    ledgerPiece: async () => ackOf(opts.ledger ? await opts.ledger() : null),
    now: () => now,
    later: (ms, fn) => { const t = { at: now + ms, fn }; timers.push(t); return () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) } },
  }
  const c = new PieceCustody(deps)
  const tick = async (ms: number) => {
    now += ms
    for (const t of [...timers].sort((a, b) => a.at - b.at)) if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn() }
    await flush()
  }
  return { c, hashes, puts, tick, asked: () => asked }
}

describe('PieceCustody: one serialized upload path (Design O3 finding P1 #1)', () => {
  it('gen1 then gen2 offered while hashA is pending, hashes resolved in adverse order: no older write after newer, no same-seq puts', async () => {
    const h = harness({ hash: 'deferred' })
    h.c.offer(cap(1, 'A1'))
    expect(h.c.busy).toBe(true)                // the operation is reserved before the first await
    h.c.offer(cap(2, 'B2'))
    expect(h.hashes.length).toBe(1)            // B waits as the latest pending; it does not start a second operation
    // adverse order: nothing for B exists yet; resolve A's hash only after B was offered
    h.hashes[0].d.resolve(H('1'))
    await flush()
    expect(h.puts).toEqual([])                 // A was superseded while hashing: dropped unsent
    await h.tick(1000)                         // the 1/s throttle releases B
    expect(h.hashes.length).toBe(2)
    h.hashes[1].d.resolve(H('2'))
    await flush()
    expect(h.puts).toEqual([{ seq: 1, gen: 2, body: 'B2' }])
    expect(h.c.acks.map((a) => [a.seq, a.edit_generation])).toEqual([[1, 2]])
  })
  it('an older capture offered after a newer one is never uploaded', async () => {
    const h = harness()
    h.c.offer(cap(5))
    await flush()
    await h.tick(1000)
    h.c.offer(cap(4))
    await h.tick(1000)
    expect(h.puts.map((p) => p.gen)).toEqual([5])
  })
  it('a hash failure releases the operation, keeps the capture and holds; the next capture goes', async () => {
    const h = harness({ hash: 'deferred' })
    h.c.offer(cap(1))
    h.hashes[0].d.reject(new Error('no digest'))
    await flush()
    expect(h.c.busy).toBe(false)
    expect(h.c.state).toBe('held')
    expect(h.puts).toEqual([])
    await h.tick(1000)
    h.c.offer(cap(2))
    expect(h.hashes.length).toBe(2)
    h.hashes[1].d.resolve(H('2'))
    await flush()
    expect(h.puts.map((p) => p.gen)).toEqual([2])
  })
  it('close while hashing: nothing is written afterwards', async () => {
    const h = harness({ hash: 'deferred' })
    h.c.offer(cap(1))
    h.c.close()
    h.hashes[0].d.resolve(H('1'))
    await flush()
    h.c.offer(cap(2))
    await h.tick(5000)
    expect(h.puts).toEqual([])
    expect(h.c.state).toBe('closed')
  })
  it('coalesces a burst to the newest generation at most once a second', async () => {
    const h = harness()
    h.c.offer(cap(1))
    await flush()
    for (let g = 2; g <= 6; g++) h.c.offer(cap(g))
    await h.tick(999)
    expect(h.puts.map((p) => p.gen)).toEqual([1])
    await h.tick(1)
    expect(h.puts.map((p) => [p.seq, p.gen])).toEqual([[1, 1], [2, 6]])
  })
})

describe('PieceCustody: CAS, lost answers and custody', () => {
  it('a lost answer is reconciled by exact seq + sha in the ledger before anything else (acknowledged, not resent)', async () => {
    const h = harness({ put: async () => { throw new ApiError(0, 'network', 'lost') }, ledger: async () => ({ seq: 1, body_sha256: H('1') }) })
    h.c.offer(cap(1))
    await flush()
    expect(h.puts.length).toBe(1)
    expect(h.c.acks.map((a) => a.seq)).toEqual([1])
    await h.tick(3000)
    expect(h.puts.length).toBe(1)
  })
  it('409 stale_piece: retried on the host’s seq with the same (newest) capture', async () => {
    let first = true
    const h = harness({
      put: async (seq, c) => {
        if (first) { first = false; throw new ApiError(409, 'stale_piece', 'stale', { envelope: { seq: 3 }, body: { error: { code: 'stale_piece', seq: 3 } } }) }
        return { seq, body_sha256: H(c.body.at(-1)!) }
      },
      ledger: async () => ({ seq: 3, body_sha256: H('z') }),
    })
    h.c.offer(cap(1))
    await flush()
    await h.tick(1000)
    expect(h.puts.map((p) => [p.seq, p.gen])).toEqual([[1, 1], [4, 1]])
    expect(h.c.latest?.seq).toBe(4)
  })
  it('an unreadable ledger holds: no blind second write', async () => {
    const h = harness({ put: async () => { throw new ApiError(0, 'network', 'lost') }, ledger: async () => { throw new Error('down') } })
    h.c.offer(cap(1))
    await flush()
    h.c.offer(cap(2))
    await h.tick(1000)
    expect(h.puts.length).toBe(1)
    expect(h.c.state).toBe('held')
  })
  it('custodyFor (r1.1): only a FRESH acknowledged upload of this mount that is EXACTLY the observed snapshot', async () => {
    const h = harness()
    h.c.offer(cap(3))
    await flush()
    const r3 = cap(3).scene_ref
    expect(h.c.custodyFor(r3, 3)?.seq).toBe(1)
    expect(h.c.custodyFor(r3, 4)).toBeNull()                                   // another generation is not this snapshot
    expect(h.c.custodyFor({ ...r3, scene_id: 'other-piece' }, 3)).toBeNull()
  })
  it('observed at generation 10, the only acknowledgement is generation 11 with a different snapshot: no custody (never “≥”)', async () => {
    const h = harness()
    const g11 = { ...cap(11, 'undone-11'), scene_ref: { scene_id: 'sim-poster', revision: 11, digest: `sha256:${H('b')}` } }
    h.c.offer(g11)
    await flush()
    expect(h.c.latest?.edit_generation).toBe(11)
    expect(h.c.custodyFor({ scene_id: 'sim-poster', revision: 10, digest: `sha256:${H('a')}` }, 10)).toBeNull()
  })
  it('an exact acknowledgement older than 30 s is not custody until a refresh renews it', async () => {
    const h = harness()
    h.c.offer(cap(3))
    await flush()
    const r3 = cap(3).scene_ref
    await h.tick(STALE_MS)
    expect(h.c.custodyFor(r3, 3)).toBeNull()
    h.c.wantRefresh()
    h.c.offer(cap(3))                                                           // the same art, re-observed
    await flush()
    expect(h.c.custodyFor(r3, 3)?.seq).toBe(2)
  })
  it('an oversized piece holds with its reason and is not cut', async () => {
    const h = harness()
    h.c.offer(cap(1, 'x'.repeat(256 * 1024 + 1)))
    await flush()
    expect(h.puts).toEqual([])
    expect(h.c.heldReason).toMatch(/Nothing was cut/)
  })
})

describe('PieceCustody: E7 freshness refresh (20 s refresh, 30 s stale; fake clock)', () => {
  it('unchanged art is refreshed before 30 s with the SAME bytes and generation under a new seq, once per window', async () => {
    const h = harness()
    h.c.offer(cap(3))
    await flush()
    expect(h.puts.map((p) => [p.seq, p.gen])).toEqual([[1, 3]])
    h.c.offer(cap(3))                                  // a duplicate before the refresh is due: suppressed
    await h.tick(REFRESH_MS - 1)
    expect(h.puts.length).toBe(1)
    expect(h.asked()).toBe(0)
    await h.tick(1)                                    // 20 s: a new stable observation is asked for
    expect(h.asked()).toBe(1)
    h.c.offer(cap(3))                                  // the frame re-observed the same art
    h.c.offer(cap(3))                                  // a second one in the same window: not sent again
    await flush()
    expect(h.puts.map((p) => [p.seq, p.gen, p.body])).toEqual([[1, 3, 'piece-3'], [2, 3, 'piece-3']])
    expect(h.c.freshness()).toBe('fresh')
  })
  it('without a refresh the piece is stale at 30 s', async () => {
    const h = harness()
    h.c.offer(cap(3))
    await flush()
    await h.tick(STALE_MS - 1)
    expect(h.c.freshness()).toBe('fresh')
    await h.tick(1)
    expect(h.c.freshness()).toBe('stale')
  })
  it('a new capture during the refresh supersedes it; the generation is never raised for a refresh', async () => {
    const h = harness({ hash: 'deferred' })
    h.c.offer(cap(3))
    h.hashes[0].d.resolve(H('3'))
    await flush()
    await h.tick(REFRESH_MS)
    h.c.offer(cap(3))                                  // the refresh starts hashing
    h.c.offer(cap(4))                                  // a real edit arrives meanwhile
    h.hashes[1].d.resolve(H('3'))
    await flush()
    await h.tick(1000)
    h.hashes[2].d.resolve(H('4'))
    await flush()
    expect(h.puts.map((p) => [p.seq, p.gen])).toEqual([[1, 3], [2, 4]])
  })
  it('the same generation with different bytes is held as a bug guard (never sent)', async () => {
    const h = harness()
    h.c.offer(cap(3, 'A3'))
    await flush()
    await h.tick(REFRESH_MS)
    h.c.offer(cap(3, 'B3'))
    await flush()
    expect(h.puts.length).toBe(1)
    expect(h.c.state).toBe('held')
  })
})

describe('host R3 alignment: the acknowledged tuple keeps the host’s exact digest', () => {
  it('a `sha256:`-prefixed host digest is matched to the local hash and kept verbatim for the outcome tuple', async () => {
    const h = harness()
    h.c.offer(cap(3))
    await flush()
    expect(h.c.latest?.body_sha256).toBe(`sha256:${H('3')}`)
    expect(h.c.custodyFor(cap(3).scene_ref, 3)?.body_sha256).toBe(`sha256:${H('3')}`)
  })
  it('R3 refusals of a capture (stale_generation, generation_reused, generation_without_change, scene_mismatch) hold, never retry as-is', async () => {
    for (const code of ['stale_generation', 'generation_reused', 'generation_without_change', 'scene_mismatch']) {
      const h = harness({ put: async () => { throw new ApiError(409, code, 'x') } })
      h.c.offer(cap(1))
      await flush()
      await h.tick(5000)
      expect(h.puts.length, code).toBe(1)
      expect(h.c.state, code).toBe('held')
    }
  })
})
