import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Swarm } from '../api/types'
import { releasePersons, signInAs, switchPerson, testPerson } from '../lib/identityEpoch.testkit'
import { useHive } from '../store/store'
import { resolvePrivateHomes } from './privateHomes'
import { NO_VIEWER, visibleSet } from './visibleSet'

/**
 * Hive scale r1.2 (stand-in r1.1 FIX-FIRST): a home read with ANY malformed entry fails closed, never 'resolved'.
 * Plus: an identity change resets the app list (the homes are read again for the new person). INVENTED data only.
 */

beforeEach(() => {
  vi.stubGlobal('window', { location: { search: '' } })
})
afterEach(() => {
  releasePersons()
  vi.unstubAllGlobals()
})

const NOW = '2026-10-01T00:00:00Z'
const ME = 'user:p_me'
const home: Swarm = { id: 's_ledger', name: 'Ledger room', description: '', hue: 10, member_ids: ['a_l1'], created_at: NOW, owner: ME, visibility: 'private' }
const mind = { id: 'a_l1', name: 'Mind a_l1', kind: 'omega', swarm_id: 's_ledger', model: 'm', persona: '', hue: 0, status: 'awake', driver: 'local', budget_usd: 1, spent_usd: 0, connected: true, last_active_at: null, created_at: NOW } as Agent

describe('P1 (r1.1): one malformed home entry fails the whole read closed', () => {
  // the stand-in's four probes, each alongside a valid entry for the home, and alone
  const bad: unknown[] = [{}, null, { swarm_id: 42 }, { swarm_id: '' }, { swarm_id: '   ' }, 'x', []]
  for (const entry of bad) {
    for (const withValid of [false, true]) {
      it(`homes: [${JSON.stringify(entry)}${withValid ? ', {swarm_id: s_other}' : ''}] → failed; the home and its mind are never named`, async () => {
        const homes = withValid ? [{ swarm_id: 's_other' }, entry] : [entry]
        const r = await resolvePrivateHomes({ programHomes: () => Promise.resolve({ homes } as never) }, ['atlas'])
        expect(r.state).toBe('failed')
        expect(r.ids.size).toBe(0)
        for (const map of [true, false]) {
          const v = visibleSet([home], [mind], { ...NO_VIEWER, principal: ME, admin: true, homesState: r.state, privateHomes: r.ids }, { map })
          expect(v.swarms).toEqual([])
          expect(v.agents).toEqual([])
        }
      })
    }
  }
  it('a list of valid entries still resolves', async () => {
    const r = await resolvePrivateHomes({ programHomes: () => Promise.resolve({ homes: [{ swarm_id: 's_ledger' }, { swarm_id: 's_two' }] }) }, ['atlas'])
    expect([r.state, [...r.ids].sort()]).toEqual(['resolved', ['s_ledger', 's_two']])
  })
})

describe('an identity change resets the app list (store clientScoped), so homes are read again', () => {
  it('programs and programsError are null at once after the switch', async () => {
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    useHive.setState({ programs: [{ id: 'atlas' }] as never, programsError: 'x' })
    const done = switchPerson(a, b)
    expect(useHive.getState().programs).toBeNull()
    expect(useHive.getState().programsError).toBeNull()
    await done
  }, 66000)   // followups-r6: measured worst 21876 ms (caps lifted; 1 and 3 workers, load to 9.3), about 3x
})
