import { describe, expect, it } from 'vitest'
import type { Agent, HiveEvent } from '../types'
import { SimPower } from './power'

/** The sim's power host against the pin (293fe18): invented minds only. */
function host(statuses: Record<string, Agent['status']>, archived: string[] = []) {
  const agents = new Map(Object.entries(statuses).map(([id, status]) => [id, { id, name: id.toUpperCase(), status } as Agent]))
  const events: HiveEvent[] = []
  let t = 0
  const p = new SimPower({
    agents: () => [...agents.values()],
    agent: (id) => agents.get(id),
    archived: (a) => archived.includes(a.id),
    moved: () => false,
    stop: (a) => void (a.status = 'stopped'),
    wake: (a) => void (a.status = 'awake'),
    emit: (e) => void events.push(e),
    now: () => `2026-10-05T23:${String(10 + t++).padStart(2, '0')}:00Z`,
  })
  return { p, agents, events }
}
const admin = { admin: true, principal: 'user:operator' }

describe('sim power (host semantics)', () => {
  it('off snapshots the awake minds, stops all, names a failure as still running; on wakes exactly the snapshot', () => {
    const { p, agents, events } = host({ a: 'awake', b: 'asleep', c: 'stopped', d: 'awake' })
    p.failStop.add('d')
    const off = p.set({ state: 'off', operation_id: 'op1' }, admin) as { stopped: number; failed: { id: string }[] }
    expect(off).toMatchObject({ state: 'off', stopped: 2, failed: [{ id: 'd' }] })
    expect(agents.get('d')!.status).toBe('awake')
    expect(p.view(true)).toMatchObject({ state: 'off', by: 'user:operator', minds_in_snapshot: 3 })
    expect(p.view(false)).not.toHaveProperty('minds_in_snapshot')
    expect(events.at(-1)).toMatchObject({ type: 'hive.power', state: 'off' })
    agents.delete('b')
    const on = p.set({ state: 'on', operation_id: 'op2' }, admin)
    expect(on).toMatchObject({ state: 'on', woken: ['a'], skipped: [{ id: 'b', reason: 'deleted' }, { id: 'd', reason: 'awake' }], failed: [] })
    expect(agents.get('c')!.status).toBe('stopped') // stopped on purpose before Off: never in the snapshot
    expect(p.view(false)).toMatchObject({ state: 'on', by: 'user:operator' })
  })

  it('idempotent on operation_id; the same id with the other state is 409; members are refused', () => {
    const { p, events } = host({ a: 'awake' })
    const first = p.set({ state: 'off', operation_id: 'op' }, admin)
    expect(p.set({ state: 'off', operation_id: 'op' }, admin)).toEqual(first)
    expect(events).toHaveLength(1) // never on a replay
    expect(() => p.set({ state: 'on', operation_id: 'op' }, admin)).toThrow(/operation op was a power off/)
    expect(() => p.set({ state: 'on', operation_id: 'x' }, { admin: false, principal: 'user:p' })).toThrow(/admin/)
    expect(() => p.set({ state: 'on', operation_id: 'x'.repeat(129) }, admin)).toThrow(/128/)
  })

  it('on with nothing pending wakes nothing, and the event still arrives', () => {
    const { p, events } = host({ a: 'stopped' })
    expect(p.set({ state: 'on', operation_id: 'o' }, admin)).toMatchObject({ woken: [], skipped: [], failed: [] })
    expect(events.at(-1)).toMatchObject({ type: 'hive.power', state: 'on' })
  })

  it('Stop all records the snapshot, so Wake all restores it; archived swarms and failures are reported', () => {
    const { p, agents } = host({ a: 'awake', b: 'awake', c: 'awake' }, ['c'])
    p.record(p.wakeable().map((a) => a.id), 'user:operator', 'stopped')
    for (const a of agents.values()) a.status = 'stopped'
    expect(p.view(true)).toMatchObject({ state: 'on', minds_in_snapshot: 2 })
    p.failWake.add('b')
    expect(p.set({ state: 'on', operation_id: 'w' }, admin)).toMatchObject({ woken: ['a'], failed: [{ id: 'b' }] })
    expect(p.view(true)).toMatchObject({ minds_in_snapshot: 0 })
  })

  it('a second off adds to the pending snapshot and never replaces it', () => {
    const { p, agents } = host({ a: 'awake', b: 'stopped' })
    p.set({ state: 'off', operation_id: 'o1' }, admin)
    agents.get('b')!.status = 'awake'
    p.set({ state: 'off', operation_id: 'o2' }, admin)
    expect(p.view(true)).toMatchObject({ minds_in_snapshot: 2 }) // a kept, b added
  })
})
