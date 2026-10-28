import { beforeEach, expect, it, vi } from 'vitest'
import type { HiveClient } from '../../api/client'
import { installPower, powerGate, usePower } from './store'

/**
 * db4b3f9 FIX-FIRST (B1): a transition older than one already seen is rejected by the ordering state, and a rejected
 * transition never reaches the gate, never hydrates and never releases held page requests. Deferred synthetic client.
 */

let event!: (e: unknown) => void
let reads = 0
const hooks = { woken: vi.fn(), wentOff: vi.fn() }

function install() {
  reads = 0
  const c = {
    needsAuth: () => false,
    subscribe: (f: typeof event) => ((event = f), () => {}),
    onConnection: () => () => {},
    connect: () => {},
    me: async () => ({ kind: 'sso', role: 'admin' }),
    // the first read answers; every later read stays pending (the refresh is still on its way)
    getPower: () => (++reads === 1 ? Promise.resolve({ state: 'on', since: '2026-10-06T09:00:00Z', by: 'user:a' }) : new Promise(() => {})),
  } as unknown as HiveClient
  installPower(c, hooks)
}
const power = (state: string, since: string | null) => event({ type: 'hive.power', state, since })

beforeEach(async () => {
  hooks.woken.mockClear()
  hooks.wentOff.mockClear()
  install()
  await usePower.getState().load()
})

it('Review probe: an older timestamped event cannot undo the latest observed off', () => {
  power('off', '2026-10-06T09:02:00Z')
  power('on', '2026-10-06T09:01:00Z')
  expect(usePower.getState().gate).toBe('off')
})

it('a rejected older on neither hydrates nor releases held page requests', () => {
  power('off', '2026-10-06T09:02:00Z')
  expect(hooks.wentOff).toHaveBeenCalledTimes(1)
  power('on', '2026-10-06T09:01:00Z')
  expect(powerGate().state).toBe('off')
  expect(hooks.woken).not.toHaveBeenCalled()
})

it('a rejected older off does not turn a newer on off', () => {
  power('on', '2026-10-06T09:05:00Z')
  power('off', '2026-10-06T09:03:00Z')
  expect(usePower.getState().gate).toBe('on')
  expect(powerGate().state).toBe('on')
  expect(hooks.wentOff).not.toHaveBeenCalled()
})

it('a newer event after a rejected one is still admitted', () => {
  power('off', '2026-10-06T09:02:00Z')
  power('on', '2026-10-06T09:01:00Z')
  power('on', '2026-10-06T09:03:00Z')
  expect(usePower.getState().gate).toBe('on')
  expect(hooks.woken).toHaveBeenCalledTimes(1)
})

it('a duplicate event (same state, same time) changes nothing and hydrates once', () => {
  power('off', '2026-10-06T09:02:00Z')
  power('on', '2026-10-06T09:04:00Z')
  power('on', '2026-10-06T09:04:00Z')
  expect(usePower.getState().gate).toBe('on')
  expect(hooks.woken).toHaveBeenCalledTimes(1)
})

it('equal or unreadable timestamps keep the existing policy: the later-seen transition is admitted', () => {
  power('off', '2026-10-06T09:02:00Z')
  power('on', '2026-10-06T09:02:00Z')
  expect(usePower.getState().gate).toBe('on')
  power('off', null)
  expect(usePower.getState().gate).toBe('off')
})
