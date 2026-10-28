import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import { MountLease, type MountDeps } from './mount'

/** J3 r4.3 O3 / host plan r1.2 E3: the mount adapter. Fake clock; INVENTED tokens. */
function harness(over: Partial<MountDeps> = {}) {
  let now = 1_000_000
  let wallShift = 0
  const timers: { at: number; fn: () => void }[] = []
  const lost: string[] = []
  const calls: string[] = []
  const deps: MountDeps = {
    receiver_generation: 42, stream_id: 'as_aaaaaaaaaaaaaaaaaaaaaaaa', mount_id: 'm_42',
    mount: async (b) => { calls.push(`mount:${b.expected_epoch}`); return { mount_epoch: 3, mount_token: `mt_${'b'.repeat(24)}`, lease_expires_at: new Date(now + 60_000).toISOString() } },
    heartbeat: async () => { calls.push('beat'); return { lease_expires_at: new Date(now + 60_000).toISOString() } },
    unmount: async (b) => { calls.push(`unmount:${b.mount_token.slice(0, 3)}`); return {} },
    now: () => now,
    wall: () => now + wallShift,
    later: (ms, fn) => { const t = { at: now + ms, fn }; timers.push(t); return () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) } },
    lost: (r) => lost.push(r),
    ...over,
  }
  const tick = async (ms: number) => { now += ms; for (const t of [...timers].sort((a, b) => a.at - b.at)) if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn() } for (let i = 0; i < 10; i++) await Promise.resolve() }
  return { m: new MountLease(deps), lost, calls, tick, jumpWall: (ms: number) => { wallShift += ms } }
}

describe('MountLease (E3)', () => {
  it('a won CAS gives fields for every write; the token is not an enumerable property', async () => {
    const h = harness()
    expect(await h.m.acquire(2)).toBe(true)
    expect(h.calls).toEqual(['mount:2'])
    expect(h.m.fields()).toEqual({ mount_token: `mt_${'b'.repeat(24)}`, mount_epoch: 3, receiver_generation: 42 })
    expect(JSON.stringify(h.m)).not.toMatch(/mt_/)
  })
  it('a lost CAS (409 mount_conflict) is lost synchronously: no fields, no retry', async () => {
    const h = harness({ mount: async () => { throw new ApiError(409, 'mount_conflict', 'x') } })
    expect(await h.m.acquire(null)).toBe(false)
    expect(h.lost).toEqual(['replaced'])
    expect(h.m.fields()).toBeNull()
    expect(await h.m.acquire(null)).toBe(false)   // never re-acquired from a local counter
  })
  it('an answer that does not name the win is not a win', async () => {
    const h = harness({ mount: async () => ({ mount_epoch: 3 }) })
    expect(await h.m.acquire(null)).toBe(false)
    expect(h.lost).toEqual(['unknown'])
  })
  it('heartbeats renew the lease; without them it expires at 60 s and is lost', async () => {
    const h = harness({ heartbeat: async () => { throw new ApiError(0, 'network', 'down') } })
    await h.m.acquire(null)
    await h.tick(59_000)
    expect(h.m.current()).toBe(true)
    await h.tick(1_000)
    expect(h.m.current()).toBe(false)
    expect(h.lost).toEqual(['expired'])
  })
  it('a stale_mount refusal on any write loses it; release revokes once and is final', async () => {
    const h = harness()
    await h.m.acquire(null)
    h.m.noteRefusal(new ApiError(409, 'stale_mount', 'x'))
    expect(h.lost).toEqual(['replaced'])
    const h2 = harness()
    await h2.m.acquire(null)
    await h2.m.release((fn) => fn())
    expect(h2.calls).toEqual(['mount:null', 'unmount:mt_'])
    expect(h2.m.fields()).toBeNull()
  })
})

describe('r1.3: monotonic lease (Kimi K3) and host R3 attempt readback', () => {
  it('an independent wall-clock jump (±1 h) neither expires nor extends the lease; only monotonic time does', async () => {
    const h = harness()
    await h.m.acquire(null)
    h.jumpWall(3_600_000)
    await h.tick(1_000)
    expect(h.m.current()).toBe(true)
    h.jumpWall(-7_200_000)
    await h.tick(1_000)
    expect(h.m.current()).toBe(true)
    await h.tick(58_000)                                // 60 s of monotonic time, no heartbeat answer counted
    expect(h.m.current()).toBe(false)
  })
  it('the mount body carries the attempt id (host R3 exact key set)', async () => {
    const bodies: Record<string, unknown>[] = []
    const h = harness({ mount: async (b) => { bodies.push(b); return { mount_epoch: 1, mount_token: `mt_${'c'.repeat(24)}`, lease_expires_at: new Date(1_060_000).toISOString() } } })
    await h.m.acquire(null)
    expect(Object.keys(bodies[0]).sort()).toEqual(['attempt_id', 'expected_epoch', 'mount_id', 'receiver_generation', 'stream_id'])
    expect(bodies[0].attempt_id).toMatch(/^[A-Za-z0-9_.:-]{8,80}$/)
  })
  it('a lost mount answer is read back by its attempt id: a recorded current win is a win, anything else is lost', async () => {
    const lostAnswer = async () => { throw new ApiError(0, 'network', 'lost') }
    const won = harness({ mount: lostAnswer, readback: async () => ({ lease_expires_at: new Date(1_060_000).toISOString(), attempt: { outcome: 'mounted', mount_epoch: 4, mount_token: `mt_${'d'.repeat(24)}` } }) })
    expect(await won.m.acquire(3)).toBe(true)
    expect(won.m.fields()?.mount_epoch).toBe(4)
    const notWon = harness({ mount: lostAnswer, readback: async () => ({ attempt: { outcome: 'mount_conflict', mount_epoch: 5 } }) })
    expect(await notWon.m.acquire(3)).toBe(false)
    expect(notWon.lost).toEqual(['unknown'])
  })
})
