import { describe, expect, it } from 'vitest'
import { SimClient } from '../../api/sim/SimClient'
import { DEMO_REFUSE } from '../../api/sim/demo'
import type { Agent, Swarm } from '../../api/types'
import { appRouting, appUsable, coordinatorAwake, pickProgramSwarm, privateSwarm, sleepingCoordinator } from './pickSwarm'

/** Demo audit P1 #2/#3: an app opens where it works, with an awake coordinator; never on the swarm that sorts first. */

const sw = (id: string, name: string, coordinator_id: string | null, extra: Partial<Swarm> = {}): Swarm => ({ id, name, description: '', hue: 0, member_ids: [], created_at: '', coordinator_id, ...extra })
const ag = (id: string, swarm_id: string, status: Agent['status']) => ({ id, name: id, swarm_id, status }) as Agent

const swarms: Record<string, Swarm> = {
  s_a: sw('s_a', 'Aardvark', 'm_a'),   // sorts first, coordinator asleep
  s_b: sw('s_b', 'Badger', 'm_b'),
  s_c: sw('s_c', 'Coot', 'm_c'),
  s_old: sw('s_old', 'Aaaa retired', 'm_o', { archived_at: '2026-01-01' }),
}
const agents: Record<string, Agent> = {
  m_a: ag('m_a', 's_a', 'asleep'),
  m_b: ag('m_b', 's_b', 'awake'),
  m_c: ag('m_c', 's_c', 'awake'),
  m_c2: ag('m_c2', 's_c', 'awake'),
  m_o: ag('m_o', 's_old', 'awake'),
}
const ALL = new Set(['s_a', 's_b', 's_c', 's_old'])

describe('pickProgramSwarm', () => {
  it('a host without homes: never the alphabetically first; an awake coordinator, then the most awake minds', () => {
    expect(pickProgramSwarm({ swarms, agents, homes: null, usable: ALL, remembered: null, defaultSwarm: null })).toBe('s_c')
  })
  it('a host without homes: the remembered swarm, then the person’s default swarm, win when usable', () => {
    expect(pickProgramSwarm({ swarms, agents, homes: null, usable: ALL, remembered: 's_b', defaultSwarm: 's_a' })).toBe('s_b')
    expect(pickProgramSwarm({ swarms, agents, homes: null, usable: ALL, remembered: 'gone', defaultSwarm: 's_a' })).toBe('s_a')
    expect(pickProgramSwarm({ swarms, agents, homes: null, usable: ALL, remembered: 's_old', defaultSwarm: null })).toBe('s_c')   // archived is not in use
  })
  it('homes known: remembered or default only when a home, else the first home with an awake coordinator', () => {
    const homes = [{ swarm_id: 's_a' }, { swarm_id: 's_b' }]
    expect(pickProgramSwarm({ swarms, agents, homes, usable: ALL, remembered: null, defaultSwarm: null })).toBe('s_b')
    expect(pickProgramSwarm({ swarms, agents, homes, usable: ALL, remembered: 's_c', defaultSwarm: 's_a' })).toBe('s_a')
    expect(pickProgramSwarm({ swarms, agents, homes, usable: ALL, remembered: 's_a', defaultSwarm: 's_b' })).toBe('s_a')
    expect(pickProgramSwarm({ swarms, agents, homes: [{ swarm_id: 's_a' }], usable: ALL, remembered: null, defaultSwarm: null })).toBe('s_a')   // only home: the page says its coordinator sleeps
    expect(pickProgramSwarm({ swarms, agents, homes: [], usable: ALL, remembered: 's_b', defaultSwarm: null })).toBeNull()
  })
  it('names a coordinator that is not awake', () => {
    expect(sleepingCoordinator(swarms.s_a, agents)?.id).toBe('m_a')
    expect(sleepingCoordinator(swarms.s_b, agents)).toBeNull()
    expect(coordinatorAwake(swarms.s_b, agents)).toBe(true)
  })
})

/**
 * Stand-in r1 P1: the automatic fallback took any swarm present and not archived, so it could open an app in a private
 * swarm or one the person cannot use. INVENTED swarms: a private-app swarm and a read-visible but use-denied one, each
 * with the awake coordinator and the most awake minds, so they would win on liveliness alone.
 */
describe('pickProgramSwarm never chooses a private or unusable swarm by itself', () => {
  const lively = (id: string, name: string, extra: Partial<Swarm> = {}) => sw(id, name, `${id}_c`, extra)
  const s2: Record<string, Swarm> = {
    ...swarms,
    s_atl: lively('s_atl', 'Atlas twin'),                                   // names a private app
    s_hid: lively('s_hid', 'Quiet room', { visibility: 'private' }),        // kept private
    s_den: lively('s_den', 'Busy but not yours'),                           // read-visible, use denied
  }
  const a2: Record<string, Agent> = { ...agents }
  for (const id of ['s_atl', 's_hid', 's_den']) for (const n of ['c', 'x', 'y', 'z']) a2[`${id}_${n}`] = ag(`${id}_${n}`, id, 'awake')
  const usable = new Set(['s_a', 's_b', 's_c', 's_atl', 's_hid'])   // s_den: the host does not list it as usable
  const bad = ['s_atl', 's_hid', 's_den']

  it('homes null: the lively private and use-denied swarms lose to a usable one', () => {
    const pick = pickProgramSwarm({ swarms: s2, agents: a2, homes: null, usable, remembered: null, defaultSwarm: null })
    expect(pick).toBe('s_c')
    expect(privateSwarm(s2.s_atl) && privateSwarm(s2.s_hid) && !privateSwarm(s2.s_c)).toBe(true)
  })
  it('homes known: a private or use-denied first home is skipped; with only those, nothing is chosen', () => {
    expect(pickProgramSwarm({ swarms: s2, agents: a2, homes: [{ swarm_id: 's_atl' }, { swarm_id: 's_den' }, { swarm_id: 's_hid' }, { swarm_id: 's_a' }], usable, remembered: null, defaultSwarm: null })).toBe('s_a')
    expect(pickProgramSwarm({ swarms: s2, agents: a2, homes: bad.map((swarm_id) => ({ swarm_id })), usable, remembered: null, defaultSwarm: null })).toBeNull()
  })
  it('homes null with only private or use-denied swarms: nothing is chosen', () => {
    const only = { s_atl: s2.s_atl, s_hid: s2.s_hid, s_den: s2.s_den }
    expect(pickProgramSwarm({ swarms: only, agents: a2, homes: null, usable, remembered: null, defaultSwarm: null })).toBeNull()
  })
  it('a remembered or default swarm the person cannot use is not honoured', () => {
    for (const homes of [null, bad.map((swarm_id) => ({ swarm_id }))]) {
      expect(pickProgramSwarm({ swarms: s2, agents: a2, homes, usable, remembered: 's_den', defaultSwarm: 's_den' })).not.toBe('s_den')
    }
  })
  it('a remembered or default private swarm is not opened by itself, even when the person may use it (stand-in r2 P1)', () => {
    expect(pickProgramSwarm({ swarms: s2, agents: a2, homes: null, usable, remembered: 's_hid', defaultSwarm: null })).toBe('s_c')
    expect(pickProgramSwarm({ swarms: s2, agents: a2, homes: null, usable, remembered: 's_atl', defaultSwarm: 's_hid' })).toBe('s_c')
    expect(pickProgramSwarm({ swarms: s2, agents: a2, homes: [{ swarm_id: 's_atl' }], usable, remembered: null, defaultSwarm: 's_atl' })).toBeNull()
    expect(pickProgramSwarm({ swarms: s2, agents: a2, homes: [{ swarm_id: 's_hid' }, { swarm_id: 's_b' }], usable, remembered: 's_hid', defaultSwarm: 's_hid' })).toBe('s_b')
  })
  it('a usable, non-private remembered or default choice is still honoured', () => {
    expect(pickProgramSwarm({ swarms: s2, agents: a2, homes: null, usable, remembered: 's_a', defaultSwarm: 's_b' })).toBe('s_a')
    expect(pickProgramSwarm({ swarms: s2, agents: a2, homes: null, usable, remembered: 's_hid', defaultSwarm: 's_b' })).toBe('s_b')
  })
  it('without the host’s list of usable swarms nothing is chosen (fails closed)', () => {
    expect(pickProgramSwarm({ swarms: s2, agents: a2, homes: null, usable: null, remembered: 's_b', defaultSwarm: 's_b' })).toBeNull()
    expect(pickProgramSwarm({ swarms: s2, agents: a2, homes: [{ swarm_id: 's_b' }], usable: null, remembered: null, defaultSwarm: null })).toBeNull()
  })
})

describe('the demo simulator says where its apps work (invented homes)', () => {
  for (const app of ['omegadesign', 'commons-explorer', 'omega-tools']) {
    it(`${app} opens on a swarm with an awake coordinator and shared beliefs, not Driftwood`, async () => {
      const sim = new SimClient({ seed: 7, latency: false, autoStart: false, demo: true, persona: 'person', refuse: DEMO_REFUSE })
      const [list, minds, homes] = await Promise.all([sim.listSwarms(), sim.listAgents(), sim.programHomes(app)])
      const byId = Object.fromEntries(list.map((s) => [s.id, s]))
      const agentsById = Object.fromEntries(minds.map((a) => [a.id, a]))
      expect(homes.homes.length).toBeGreaterThan(0)
      const usable = appUsable(homes.homes)
      const pick = pickProgramSwarm({ swarms: byId, agents: agentsById, homes: homes.homes, usable, remembered: null, defaultSwarm: null })
      expect(pick).not.toBe('s_drift')
      expect(coordinatorAwake(byId[pick!], agentsById)).toBe(true)
      expect((await sim.listBeliefs(pick!)).length).toBeGreaterThan(0)
    })
  }
  it('records where a view last succeeded, as the host does', async () => {
    const sim = new SimClient({ seed: 7, latency: false, autoStart: false })
    expect((await sim.programHomes('commons-explorer')).homes.map((h) => h.swarm_id)).toEqual(['s_lyra', 's_kelp'])
    await sim.programView('commons-explorer', { swarm_id: 's_forge' })
    expect((await sim.programHomes('commons-explorer')).homes).toContainEqual({ swarm_id: 's_forge', why: 'opened here before' })
  })
})

/**
 * r2.2 (Root on live 6e937bd): Tools' home Arena has no coordinator, so it is not in the Ask's `eligible` list, and the
 * page said "no usable swarm" though Arena worked. App routing uses only the host's homes (already limited to swarms
 * the person sees). INVENTED swarms.
 */
describe('appRouting: the host’s homes decide, not the Ask’s eligible list', () => {
  const arena = sw('s_arena', 'Arena', null)                        // no coordinator: never Ask-eligible
  const lyra = sw('s_lyra', 'Lyra', 'm_v')
  const atlas = sw('s_atl', 'Atlas twin', 'm_t')                       // private (names a private app)
  const gone = sw('s_gone', 'Gone', null, { archived_at: '2026-01-01' })
  const S: Record<string, Swarm> = { s_arena: arena, s_lyra: lyra, s_atl: atlas, s_gone: gone }
  const A: Record<string, Agent> = { m_v: ag('m_v', 's_lyra', 'awake'), m_t: ag('m_t', 's_atl', 'awake') }
  const known = (...ids: string[]) => ({ kind: 'known' as const, homes: ids.map((swarm_id) => ({ swarm_id, why: 'the app is set up here' })) })

  it('a home outside the Ask-eligible set (no coordinator) still opens', () => {
    expect(appRouting({ swarms: S, agents: A, homesState: known('s_arena'), remembered: null, defaultSwarm: null }).pick).toBe('s_arena')
  })
  it('a private home never opens by itself, even awake, remembered or default; a usable one does', () => {
    expect(appRouting({ swarms: S, agents: A, homesState: known('s_atl', 's_arena'), remembered: 's_atl', defaultSwarm: 's_atl' }).pick).toBe('s_arena')
    const only = appRouting({ swarms: S, agents: A, homesState: known('s_atl'), remembered: null, defaultSwarm: null })
    expect(only.pick).toBeNull()
    expect(only.choices).toEqual([])   // the chooser never offers it by name
  })
  it('a home the host did not return is never chosen, even remembered', () => {
    expect(appRouting({ swarms: S, agents: A, homesState: known('s_arena'), remembered: 's_lyra', defaultSwarm: 's_lyra' }).pick).toBe('s_arena')
  })
  it('no homes route: nothing opens by itself; the chooser lists the person’s non-private, non-archived swarms', () => {
    const r = appRouting({ swarms: S, agents: A, homesState: { kind: 'absent' }, remembered: 's_lyra', defaultSwarm: 's_lyra' })
    expect(r.pick).toBeNull()
    expect(r.choices.map((s) => s.id)).toEqual(['s_arena', 's_lyra'])
  })
  it('pending or failed: no pick and no choices (the page waits, or says it could not check)', () => {
    for (const kind of ['pending', 'failed'] as const) expect(appRouting({ swarms: S, agents: A, homesState: { kind }, remembered: 's_lyra', defaultSwarm: null })).toEqual({ pick: undefined, choices: [] })
  })
})
