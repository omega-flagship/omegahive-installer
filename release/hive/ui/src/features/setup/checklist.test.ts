import { describe, expect, it } from 'vitest'
import type { KeyInfo, ProviderStatus, Swarm } from '../../api/types'
import { dismissKey, doneCount, isDismissed, setDismissed, setupSteps } from './checklist'

const prov = (connected: boolean): ProviderStatus => ({ name: 'p', label: 'Prov', local: false, needs_key: true, connected, source: null, key_hint: '', key_env: '', base_url: '', models: [] })
const key = (def: boolean): KeyInfo => ({ id: 'k', provider: 'p', provider_label: 'Prov', label: 'main', owner: 'user:operator', hint: '…1234', default: def, created_at: null, spent_usd: 0, minds: [] })
const swarm = (archived = false): Swarm => ({ id: 's', name: 'S', description: '', hue: 1, member_ids: [], created_at: '', archived_at: archived ? 'x' : null })

describe('first-run checklist (audit row 49)', () => {
  it('ticks each step from the hive’s own state', () => {
    const s = setupSteps({ admin: true, providers: [prov(true)], keys: [key(true)], budgets: [{ id: 'b', scope: 'hive', period: 'month', limit_usd: 50, spent_usd: 0, note: '', origin: 'rule' }], swarms: [swarm()], people: { people: 1, invites: 0 } })
    expect(s.map((x) => [x.id, x.state])).toEqual([['provider', 'done'], ['payer', 'done'], ['limit', 'done'], ['swarm', 'done'], ['invite', 'done']])
    expect(doneCount(s)).toBe(5)
  })
  it('an empty hive is all to do; an archived swarm does not count', () => {
    const s = setupSteps({ admin: true, providers: [prov(false)], keys: [key(false)], budgets: [], swarms: [swarm(true)], people: { people: 0, invites: 0 } })
    expect(s.every((x) => x.state === 'todo')).toBe(true)
  })
  it('never ticks on a guess: unreadable state is unknown', () => {
    const s = setupSteps({ admin: true, swarms: [] })
    expect(s.filter((x) => x.state === 'unknown').map((x) => x.id)).toEqual(['provider', 'payer', 'limit', 'invite'])
  })
  it('"Invite someone" is an admin step only', () => {
    expect(setupSteps({ admin: false, swarms: [] }).map((x) => x.id)).not.toContain('invite')
  })
  it('dismissal is per person', () => {
    const m = new Map<string, string>()
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
    setDismissed('user:p_ada', true, store)
    expect(isDismissed('user:p_ada', store)).toBe(true)
    expect(isDismissed('user:p_bo', store)).toBe(false)
    expect(m.has(dismissKey('user:p_ada'))).toBe(true)
    setDismissed('user:p_ada', false, store)
    expect(isDismissed('user:p_ada', store)).toBe(false)
  })
})

describe('storage blocked (demo walk: the page did not start)', () => {
  it('reading and writing the dismissal never throws when the browser refuses its storage', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError: storage disabled') } })
    try {
      expect(isDismissed('user:p_ada')).toBe(false)
      expect(() => setDismissed('user:p_ada', true)).not.toThrow()
    } finally {
      if (desc) Object.defineProperty(globalThis, 'localStorage', desc)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })
})
