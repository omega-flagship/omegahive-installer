import { describe, expect, it, vi } from 'vitest'
import { SimClient } from './SimClient'
import { SimAsk } from './ask'
import { DEMO_CLEANUP_OWED, DEMO_MEMORY_NOTES, DEMO_REFUSE, isDemoMode } from './demo'
import type { AskEvent } from '../ask'
import type { Agent, Goal, Swarm } from '../types'

// Backstop (sim-commons r2.1): this file runs the sim's real MeTTa commons (a first seed per process, or live
// publishes); its slowest test took 1857 ms in a full default-worker run under load 26, so 3x that. The default seed is
// cached per process (SimClient seed cache), so this only matters under heavy load.
vi.setConfig({ testTimeout: 60000 }) // ~3x the worst case measured under load (followups-r5)

/** Surface demo D2: plain demo mode's defaults, all INVENTED and all in the browser. */

const demoSim = () => new SimClient({ seed: 7, latency: false, autoStart: false, demo: true, persona: 'person', refuse: DEMO_REFUSE })

describe('demo mode: who visits and what is there', () => {
  it('is the demo build or ?sim=1, nothing else', () => {
    expect(isDemoMode('?sim=1', 'development')).toBe(true)
    expect(isDemoMode('', 'demo')).toBe(true)
    expect(isDemoMode('?sim=0', 'development')).toBe(false)
    expect(isDemoMode('', 'development')).toBe(false)
    expect(isDemoMode('?sim=1&x=2', 'production')).toBe(true)
  })

  it('Ada visits by default; the operator only when asked', async () => {
    expect((await demoSim().me()).principal).toBe('user:p_ada')
    expect((await demoSim().me()).person?.name).toBe('Ada Brightwater')
    expect((await new SimClient({ seed: 7, latency: false, autoStart: false, demo: true, persona: 'operator' }).me()).principal).toBe('user:operator')
  })

  it('a sim that is not demo mode is unchanged: the operator, no extra swarms', async () => {
    const sim = new SimClient({ seed: 7, latency: false, autoStart: false })
    expect((await sim.me()).principal).toBe('user:operator')
    expect(sim.demo).toBe(false)
    expect(sim.swarms.has('s_drift')).toBe(false)
  })

  it('swarm delete: Driftwood deletes cleanly (no history, nothing running); Saltmarsh is archived with a mind left and cleanup owed', async () => {
    const sim = demoSim()
    const drift = sim.swarms.get('s_drift')!
    expect(drift.archived_at ?? null).toBeNull()
    expect(drift.member_ids).toEqual(['a_drft13', 'a_drft14'])
    expect(drift.member_ids.every((id) => sim.agents.get(id)!.status === 'asleep')).toBe(true)
    expect([...sim.goals.values()].some((g) => g.swarm_id === 's_drift')).toBe(false)
    const salt = sim.swarms.get('s_salt')!
    expect(salt.archived_at).toBeTruthy()
    expect(salt.member_ids).toEqual(['a_salt16'])
    expect(sim.agents.has('a_salt15')).toBe(false) // already deleted; only its cleanup is owed
    expect(Object.fromEntries(sim.demoCleanupOwed)).toEqual(DEMO_CLEANUP_OWED)
    // reachable: Driftwood in the swarms list, Saltmarsh among the archived
    expect((await sim.listSwarms()).map((s) => s.id)).toContain('s_drift')
    expect((await sim.listSwarms({ archived: true })).map((s) => s.id)).toContain('s_salt')
  })

  it('swarm delete hookup: "Finish the delete" on Saltmarsh finishes its owed cleanup first, then deletes Rush', async () => {
    const sim = demoSim()
    const r = await sim.deleteSwarmWithMinds('s_salt', 'Saltmarsh')
    expect(r.error).toBeUndefined()
    expect(r.deleted_minds).toEqual(['a_salt15', 'a_salt16'])
    expect(sim.agents.has('a_salt16')).toBe(false)
    // finished once: nothing is owed after
    expect(r.cleanup_pending).toBeUndefined()
  })

  it('one app is refused in one swarm (Omega Tools in Kelp), and only there', () => {
    expect(DEMO_REFUSE).toEqual(['omega-tools@s_kelp'])
    const sim = demoSim()
    expect(() => sim.programsHost.view('omega-tools', 's_kelp')).toThrow(expect.objectContaining({ code: 'program_refused' }))
    expect(() => sim.programsHost.view('omega-tools', 's_lyra')).not.toThrow(expect.objectContaining({ code: 'program_refused' }))
  })
})

// ---------------------------------------------------------------- the Ask

const agents = [
  { id: 'a_vega01', name: 'Vega', status: 'awake', swarm_id: 's_lyra' },
  { id: 'a_coral5', name: 'Coral', status: 'awake', swarm_id: 's_kelp' },
] as unknown as Agent[]
const swarms = [
  { id: 's_lyra', name: 'Lyra', coordinator_id: 'a_vega01' },
  { id: 's_kelp', name: 'Kelp Commons', coordinator_id: 'a_coral5' },
] as unknown as Swarm[]
function host(principal = 'user:p_ada') {
  const events: AskEvent[] = []
  const queue: [number, () => void][] = []
  let clock = 0
  const h = new SimAsk({ emit: (e) => events.push(e), later: (ms, fn) => queue.push([clock + ms, fn]), agents: () => agents, swarms: () => swarms, goals: () => [] as Goal[], principal: () => principal })
  const flush = () => {
    while (queue.length) {
      queue.sort((a, b) => a[0] - b[0])
      const [at, fn] = queue.shift()!
      clock = at
      fn()
    }
  }
  return { h, events, flush }
}
const body = (text: string, extra: Record<string, unknown> = {}) => ({ operation_id: `ask:t:${Math.random().toString(36).slice(2, 10)}`, text, via: 'typed' as const, context: { route: 'hive', experience: 'classic' }, ...extra })
const acts = (events: AskEvent[]) => events.filter((e) => e.phase === 'act').map((e) => (e as unknown as { act: { kind: string } }).act)

describe('demo mode: the Ask conductor', () => {
  it('"drive the page for me": navigate, point, open, fill and highlight, one at a time, then the answer and done', () => {
    const { h, events, flush } = host()
    h.ask(body('Drive the page for me'))
    flush()
    expect(acts(events).map((a) => a.kind)).toEqual(['navigate', 'point', 'open', 'fill', 'highlight'])
    expect(acts(events)[0]).toMatchObject({ route: '#/swarms' })
    expect(acts(events)[3]).toMatchObject({ field: 'palette.search', text: 'Kelp' })
    const order = events.map((e) => e.phase)
    expect(order.lastIndexOf('act')).toBeLessThan(order.indexOf('done'))
    expect(order.at(-1)).toBe('done')
  })

  it('taking over part way ends the turn: done {taken_over}, and no act after it', () => {
    const { h, events } = host()
    const b = body('drive the page for me')
    h.ask(b)
    expect(h.takeover(b.operation_id)).toMatchObject({ state: 'taken_over' })
    expect(events.at(-1)).toMatchObject({ phase: 'done', outcome: 'cancelled', taken_over: true })
    expect(h.turn(b.operation_id).reason).toBe('takeover')
  })

  it('"open tools in Kelp" moves into the named swarm’s Omega Tools (refused there in demo mode)', () => {
    const { h, events, flush } = host()
    h.ask(body('open tools in Kelp'))
    flush()
    expect(acts(events)).toEqual([expect.objectContaining({ kind: 'navigate', label: 'Omega Tools', route: expect.stringContaining('s_kelp') })])
    expect(events.find((e) => e.phase === 'answer' && !(e as { delta?: boolean }).delta)).toMatchObject({ text: 'I tried to open Omega Tools in Kelp Commons.' })
  })

  it('memory: the first answer teaches the invented notes once a session; never with memory off', () => {
    const { h, events, flush } = host()
    h.demoNotes(DEMO_MEMORY_NOTES)
    h.ask(body('hello'))
    flush()
    const taught = events.filter((e) => e.phase === 'memory') as unknown as { op: string; item: { statement: string; kind: string } }[]
    expect(taught.map((m) => [m.op, m.item.kind, m.item.statement])).toEqual(DEMO_MEMORY_NOTES.map((n) => ['remember', n.kind, n.statement]))
    events.length = 0
    h.ask(body('hello again'))
    flush()
    expect(events.filter((e) => e.phase === 'memory')).toEqual([])

    const off = host()
    off.h.demoNotes(DEMO_MEMORY_NOTES)
    off.h.setFlags({ conductor: true, memory: false })
    off.h.ask(body('hello'))
    off.flush()
    expect(off.events.filter((e) => e.phase === 'memory')).toEqual([])
  })

  it('a browser that already sent notes is not taught them again', () => {
    const { h, events, flush } = host()
    h.demoNotes(DEMO_MEMORY_NOTES)
    h.ask(body('hello', { memory_notes: [{ id: 'n1', text: 'Call them Ada' }] }))
    flush()
    expect(events.filter((e) => e.phase === 'memory')).toEqual([])
  })
})

// ---------------------------------------------------------------- team rooms

describe('team rooms, as the host (r6, 8739049) makes them', () => {
  it('every swarm has a private "<swarm> team" group: its owner and its minds (not modules), bound to the swarm', async () => {
    const sim = new SimClient({ seed: 7, latency: false, autoStart: false })
    const teams = (await sim.rooms()).filter((r) => r.swarm_id)
    expect(teams.map((r) => r.swarm_id).sort()).toEqual(['s_forge', 's_kelp', 's_lyra'])
    const kelp = teams.find((r) => r.swarm_id === 's_kelp')!
    expect(kelp).toMatchObject({ kind: 'group', name: 'Kelp Commons team', visibility: 'private', owner: 'user:operator', topic: "Your swarm's team room: minds reach each other here with @Name." })
    expect(kelp.alias).toBeUndefined() // the host's view names an alias for the Coffee Room only
    const members = kelp.members.map((m) => m.member)
    expect(members).toEqual(expect.arrayContaining(['user:operator', 'agent:a_coral5', 'agent:a_nori06', 'agent:a_sedg07']))
    expect(members).not.toContain('agent:a_wrak08') // an app module never sits in a team room
    expect(await sim.roomMessages(kelp.id)).toEqual([]) // outside demo mode nobody has spoken yet
  })

  it('the swarm\u2019s Chat opens its team room; an admin joins on opening; a member who is not in it gets "not found"', async () => {
    const sim = demoSim() // Ada, an admin
    const kelp = await sim.swarmRoom('s_kelp')
    expect(kelp).toMatchObject({ kind: 'group', name: 'Kelp Commons team', swarm_id: 's_kelp', joined: true })
    expect((await sim.swarmRoom('s_kelp')).id).toBe(kelp.id)
    sim.simSignInAs('member') // Rowan, a member
    await expect(sim.swarmRoom('s_kelp')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('it follows its swarm: no member edits; a mind that leaves the swarm leaves the room', async () => {
    const sim = demoSim()
    const room = await sim.swarmRoom('s_lyra')
    await expect(sim.addRoomMembers(room.id, ['user:p_tomas'])).rejects.toMatchObject({ code: 'bad_request' })
    await expect(sim.updateRoom(room.id, { name: 'x' })).rejects.toMatchObject({ code: 'bad_request' })
    expect((await sim.updateRoom(room.id, { topic: 'Tonight: the binaries' })).topic).toBe('Tonight: the binaries')
    sim.agents.get('a_deneb2')!.swarm_id = 's_kelp'
    expect((await sim.room(room.id)).members.map((m) => m.member)).not.toContain('agent:a_deneb2')
  })
})

describe('demo mode: team rooms that talk', () => {
  it('Lyra and Forge open mid-conversation, with minds @-mentioning each other', async () => {
    const sim = demoSim()
    for (const id of ['s_lyra', 's_forge']) {
      const r = await sim.swarmRoom(id)
      const log = await sim.roomMessages(r.id)
      const mindToMind = log.filter((m) => m.sender.startsWith('agent:') && m.mentions.some((x) => x.startsWith('agent:') && x !== m.sender))
      expect(mindToMind.length).toBeGreaterThanOrEqual(2)
      expect(log.some((m) => m.sender === 'user:p_ada')).toBe(true)
    }
  })

  it('a person @-mentions a mind: it answers and asks a teammate, who answers too', async () => {
    const sim = demoSim()
    const room = await sim.swarmRoom('s_lyra')
    const before = (await sim.roomMessages(room.id)).length
    const queue: (() => void)[] = []
    ;(sim.roomsHost as unknown as { d: { later: (ms: number, fn: () => void) => void } }).d.later = (_ms, fn) => queue.push(fn)
    await sim.postRoomMessage(room.id, '@Vega can you summarise tonight\u2019s plan?')
    while (queue.length) queue.shift()!()
    const after = (await sim.roomMessages(room.id)).slice(before)
    expect(after.map((m) => m.name)).toEqual(['Ada Brightwater', 'Vega', expect.any(String)])
    expect(after[1].mentions).toEqual([expect.stringMatching(/^agent:/)])
    expect(after[2].sender).toBe(after[1].mentions[0])
  })

  it('chatter: minds answer each other until the turn cap; then the room waits for a person, and a person\u2019s word lets them go on', async () => {
    const sim = demoSim()
    const room = await sim.swarmRoom('s_lyra')
    const queue: (() => void)[] = []
    ;(sim.roomsHost as unknown as { d: { later: (ms: number, fn: () => void) => void } }).d.later = (_ms, fn) => queue.push(fn)
    const tick = () => {
      sim.roomsHost.teamChatter()
      while (queue.length) queue.shift()!()
    }
    for (let i = 0; i < 6; i++) tick()
    const log = await sim.roomMessages(room.id)
    expect(log.at(-1)).toMatchObject({ sender: 'system:hive', text: expect.stringContaining('the room waits for a person') })
    expect(log.filter((m) => m.sender === 'system:hive')).toHaveLength(1) // said once
    const quiet = log.length
    tick()
    expect((await sim.roomMessages(room.id)).length).toBe(quiet) // waits
    await sim.postRoomMessage(room.id, 'Carry on, team.')
    tick()
    expect((await sim.roomMessages(room.id)).length).toBeGreaterThan(quiet + 1)
  })

  it('not in demo mode: no chatter', () => {
    expect(new SimClient({ seed: 7, latency: false, autoStart: false }).roomsHost.teamChatter()).toBeNull()
  })
})
