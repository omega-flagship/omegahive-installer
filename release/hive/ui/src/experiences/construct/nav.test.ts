import { describe, expect, it } from 'vitest'
import { FEATURES } from '../../features/registry'
import { NATIVE } from '../coverage'
import { COMMANDS, complete } from './commands'
import { CONSTRUCT_NATIVE, findFeature, NATIVE_CMD, pageOpensClassic, reachLine } from './features'
import { NAV_FEATURES } from './nav'

describe('construct navigation reaches every hive feature', () => {
  it('NAV_FEATURES is the whole registry', () => {
    expect([...NAV_FEATURES].sort()).toEqual(FEATURES.map((f) => f.id).sort())
  })
  it('page <id> resolves every feature to itself, natively or to a classic page', () => {
    for (const id of NAV_FEATURES) {
      const f = findFeature(id)
      expect(f?.id, id).toBe(id)
      const r = reachLine(f!)
      expect(r.native || !!f!.classic, id).toBe(true)
    }
  })
  it('every native command exists', () => {
    for (const [id, n] of Object.entries(NATIVE_CMD)) expect(COMMANDS.some((c) => c.name === n.cmd.split(' ')[0]), id).toBe(true)
  })
  it('tab completes features for page and open', () => {
    expect(complete('page money.u').cands.map((c) => c.v)).toContain('money.usage')
    expect(complete('page usage').cands.map((c) => c.v)).toContain('money.usage')
    expect(complete('open people').cands.map((c) => c.v)).toContain('people.manage')
  })
  it('start a swarm and create a mind are reachable from the command line', () => {
    expect(NAV_FEATURES).toContain('swarms.launch')
    expect(NAV_FEATURES).toContain('minds.create')
    expect(NATIVE_CMD['swarms.launch'].cmd).toBe('swarm new')
    expect(complete('swarm ').cands.map((c) => c.v)).toContain('new')
    expect(complete('start ').cands.map((c) => c.v)).toContain('swarm')
  })
  it('classic page names still work', () => {
    expect(findFeature('usage')?.id).toBe('money.usage')
    expect(findFeature('new')?.id).toBe('minds.create')
    expect(findFeature('people')?.id).toBe('people.manage')
  })
  it('the coverage line says exactly what is native here', () => {
    expect([...NATIVE.construct].sort()).toEqual([...CONSTRUCT_NATIVE].sort())
  })
  it('page <id> on a read-only or quick listing opens the fuller classic page, never the listing that points back to it (Surface O)', () => {
    for (const id of ['people.manage', 'money.usage', 'decide.history', 'decide.rules', 'minds.create']) {
      const f = findFeature(id)!
      expect(f.classic, id).toBeTruthy()
      expect(pageOpensClassic(f), id).toBe(true)
    }
    // the core loop stays native through page as well
    for (const id of ['minds.see', 'decide.approvals', 'minds.talk']) expect(pageOpensClassic(findFeature(id)!), id).toBe(false)
  })
})
