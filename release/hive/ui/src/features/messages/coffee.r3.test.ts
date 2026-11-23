// Purpose: verify Coffee Room controls and linked conversations with invented data.
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { SimClient } from '../../api/sim/SimClient'
import type { Agent, Room } from '../../api/types'
import { Switch } from '../../ui/primitives'
import {
  COFFEE_DISCLOSURE, HERE_CAP, HERE_HINT, HERE_TYPING, LINK_MISSING, linkState, pinFirst, roomMatches, talkPrivately, withDirect,
} from './coffee'
import { CoffeeMembershipView, CoffeeMindsOutsideView, CoffeeOwnerRequest } from './CoffeeParts'

// Coffee UI r3: stand-in coffeeui2 (P1–P3) and Kimi r2 (#1–#4) against host r4 (platform 1c6f47c, release 004176c).
// INVENTED data, simulator only.

const sim = () => new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 3 })
const coffeeOf = (rooms: Room[]) => rooms.find((r) => r.kind === 'coffee')!
const room = (over: Partial<Room>): Room => ({
  id: 'r_1', kind: 'group', name: 'G', topic: '', owner: 'user:operator', visibility: 'private', shared_with: [], swarm_id: null,
  seq: 0, created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z', settings: { minds_follow: false, turn_cap: 3 },
  members: [], me: 'user:operator', ...over,
})

describe('stand-in r2 P1: the simulator is host r4-exact (alias present); the alias-less case resolves by kind', () => {
  it('the host’s view: the Coffee Room carries alias "coffee", a mind’s DM c_<mind>, a swarm’s room team_<swarm>, others none', async () => {
    const rooms = await sim().rooms()
    expect(coffeeOf(rooms).alias).toBe('coffee')
    for (const r of rooms.filter((x) => x.kind !== 'coffee')) {
      const mind = r.kind === 'dm' ? r.members.find((m) => m.member.startsWith('agent:'))?.member.slice(6) : undefined
      expect(r.alias, r.name || r.id).toBe(r.swarm_id ? `team_${r.swarm_id}` : mind ? `c_${mind}` : undefined)
    }
  })
  it('compatibility: a Coffee Room view without alias (host r2) still resolves #/messages/coffee by kind', () => {
    const { alias: _drop, ...noAlias } = room({ id: 'r_c', kind: 'coffee', alias: 'coffee', pinned: true })
    void _drop
    expect(roomMatches(noAlias as Room, 'coffee')).toBe(true)
  })
})

describe('stand-in r2 P2: classic messages into the Coffee Room are refused, as host r4 refuses them', () => {
  const refused = { status: 400, code: 'bad_request', message: 'speak in the Coffee Room through the room, not a direct message' }
  const setup = async () => {
    const c = sim()
    const cr = coffeeOf(await c.rooms())
    const mind = (await c.listAgents()).find((a) => a.coffee === 'member')!
    return { c, cr, mind }
  }
  it('refuses conversation_id "coffee" (the alias) with the host\'s 400', async () => {
    const { c, mind } = await setup()
    await expect(c.sendMessage(mind.id, { text: 'hi', conversation_id: 'coffee' })).rejects.toMatchObject(refused)
  })
  it("refuses the Coffee Room's id with the host's 400", async () => {
    const { c, cr, mind } = await setup()
    await expect(c.sendMessage(mind.id, { text: 'hi', conversation_id: cr.id })).rejects.toMatchObject(refused)
  })
  it('a classic message elsewhere still goes through, and nothing refused reached the room', async () => {
    const { c, cr, mind } = await setup()
    const before = (await c.roomMessages(cr.id)).length
    await c.sendMessage(mind.id, { text: 'hi', conversation_id: 'coffee' }).catch(() => undefined)
    await expect(c.sendMessage(mind.id, { text: 'hi', conversation_id: 'c_main' })).resolves.toBeTruthy()
    expect((await c.roomMessages(cr.id)).length).toBe(before)
  })
})

/** Every element in a rendered tree (function components other than the root are not expanded; Switch stays a leaf). */
function elements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out))
  else if (isValidElement(node)) {
    out.push(node)
    elements((node.props as { children?: ReactNode }).children, out)
  }
  return out
}
const text = (node: ReactNode): string => elements(node).map((e) => {
  const c = (e.props as { children?: unknown }).children
  return Array.isArray(c) ? c.filter((x) => typeof x === 'string').join('') : typeof c === 'string' ? c : ''
}).join(' ')

describe("stand-in r2 P3: the control's real switch (CoffeeMembershipView, as CoffeeMembershipControl mounts it)", () => {
  const priv = { id: 'a_p', name: 'Quill', hue: 200, coffee: 'private', swarm_id: null, visibility: 'private' } as unknown as Agent
  // no owner is recorded on these minds, so they are the hive owner's (user:operator); `owner` says whether that's the viewer
  const run = (agent: Agent, owner: boolean, answer: boolean) => {
    const calls = { confirm: [] as string[], patch: [] as unknown[], done: [] as boolean[] }
    const tree = CoffeeMembershipView({
      agent, principal: owner ? 'user:operator' : 'user:u_observer', swarm: null,
      confirm: async (m) => { calls.confirm.push(m); return answer },
      patch: async (_id, body) => { calls.patch.push(body); return true },
      done: (on) => calls.done.push(on),
    })
    const sw = elements(tree).find((e) => e.type === Switch) as ReactElement<{ checked: boolean; onChange: (v: boolean) => Promise<void> | void }> | undefined
    return { tree, sw, calls }
  }

  it('cancelling the disclosure sends nothing', async () => {
    const { sw, calls, tree } = run(priv, true, false)
    expect(sw).toBeDefined()
    expect(text(tree)).toContain(COFFEE_DISCLOSURE)
    await sw!.props.onChange(true)
    expect(calls.confirm).toEqual([COFFEE_DISCLOSURE])
    expect(calls.patch).toEqual([])
    expect(calls.done).toEqual([])
  })

  it('confirming sends PATCH {coffee: true}', async () => {
    const { sw, calls } = run(priv, true, true)
    await sw!.props.onChange(true)
    expect(calls.patch).toEqual([{ coffee: true }])
    expect(calls.done).toEqual([true])
  })

  it('an opted_out shared mind also asks first; taking a member out never asks', async () => {
    const shared = { ...priv, coffee: 'opted_out', visibility: 'shared' } as Agent
    const a = run(shared, true, false)
    await a.sw!.props.onChange(true)
    expect(a.calls.confirm).toHaveLength(1)
    expect(a.calls.patch).toEqual([])
    const member = { ...priv, coffee: 'member', visibility: 'public' } as Agent
    const b = run(member, true, false)
    await b.sw!.props.onChange(false)
    expect(b.calls.confirm).toEqual([])
    expect(b.calls.patch).toEqual([{ coffee: false }])
  })

  it('anyone but the owner sees the state and Ask its owner, but no switch and no disclosure; app modules show nothing', () => {
    const { sw, tree } = run(priv, false, true)
    expect(sw).toBeUndefined()
    expect(text(tree)).toContain('Not in the Coffee Room')
    expect(text(tree)).not.toContain(COFFEE_DISCLOSURE)
    expect(elements(tree).filter((e) => e.type === CoffeeOwnerRequest)).toHaveLength(1)
    expect(run({ ...priv, coffee: 'not_a_mind' } as Agent, true, true).tree).toBeNull()
  })
})

// Round 1: a tester's minds were all private, so the Coffee Room held none and nothing said why. Under the room's
// members, everyone now sees the minds not in it: the owner with the switch that puts each in (asking first for a
// private one), anyone else with Ask its owner.
describe('the Coffee Room’s Members list the minds not in it, with the owner’s switch for each', () => {
  const priv = { id: 'a_p', name: 'Invented Juniper', hue: 200, coffee: 'private', swarm_id: null, visibility: 'private' } as unknown as Agent
  const out = { ...priv, id: 'a_o', name: 'Lyra', coffee: 'opted_out', visibility: 'public' } as Agent
  const run = (outside: Agent[], owner: boolean, answer: boolean) => {
    const calls = { confirm: [] as string[], patch: [] as unknown[], done: [] as string[] }
    const tree = CoffeeMindsOutsideView({
      outside, principal: owner ? 'user:operator' : 'user:u_observer', swarmOf: () => null,
      confirm: async (m) => { calls.confirm.push(m); return answer },
      patch: async (id, body) => { calls.patch.push([id, body]); return true },
      done: (a) => calls.done.push(a.id),
    })
    const switches = elements(tree).filter((e) => e.type === Switch) as ReactElement<{ label: string; checked: boolean; onChange: (v: boolean) => Promise<void> | void }>[]
    return { tree, switches, calls }
  }

  it('the owner gets one switch per mind; a private mind joins only after the disclosure is confirmed', async () => {
    const { switches, calls, tree } = run([priv, out], true, true)
    expect(text(tree)).toContain('Minds not in the Coffee Room')
    expect(switches.map((s) => [s.props.label, s.props.checked])).toEqual([['Put Invented Juniper in the Coffee Room', false], ['Put Lyra in the Coffee Room', false]])
    await switches[0].props.onChange(true)
    expect(calls.confirm).toEqual([COFFEE_DISCLOSURE])
    expect(calls.patch).toEqual([['a_p', { coffee: true }]])
    expect(calls.done).toEqual(['a_p'])
  })

  it('cancelling the disclosure sends nothing', async () => {
    const { switches, calls } = run([priv], true, false)
    await switches[0].props.onChange(true)
    expect(calls.patch).toEqual([])
    expect(calls.done).toEqual([])
  })

  it('anyone else, an admin included, sees the minds and why with Ask its owner, but no switch; with every mind in the room there is no list', () => {
    const { switches, tree } = run([priv], false, true)
    expect(switches).toEqual([])
    expect(text(tree)).toContain('Private minds join only if their owner chooses to add them.')
    expect(elements(tree).filter((e) => e.type === CoffeeOwnerRequest)).toHaveLength(1)
    expect(run([], true, true).tree).toBeNull()
  })
})

describe('the simulator keeps the host’s rule: only a mind’s owner moves it in or out of the Coffee Room', () => {
  it('an admin who does not own the mind is refused owner_only, and the owner is not', async () => {
    const c = sim()
    const mind = (await c.listAgents()).find((a) => a.coffee === 'member' && !a.owner)!   // a seeded public mind, the hive owner's
    c.simSignInAs('person')                                                            // an admin who doesn't own it
    await expect(c.patchAgent(mind.id, { coffee: false })).rejects.toMatchObject({ status: 403, code: 'owner_only' })
    c.simSignInAs('operator')
    expect((await c.patchAgent(mind.id, { coffee: false })).coffee).toBe('opted_out')
  })
})

describe('Kimi r2 #1: a back-link never assumes its message resolves', () => {
  it('the host refuses an origin whose message is gone, or whose room the creator cannot see', async () => {
    const c = sim()
    const cr = coffeeOf(await c.rooms())
    const m = (await c.roomMessages(cr.id)).find((x) => x.sender.startsWith('user:'))!
    c.roomsHost.simRemoveMessage(cr.id, m.id)
    await expect(talkPrivately(c, m)).rejects.toThrow(/no such message in that room/)
    const g = (await c.rooms()).find((r) => r.kind === 'group')!
    const gm = (await c.roomMessages(g.id))[0]
    c.roomsHost.simLeave(g.id)
    await expect(c.createRoom({ kind: 'group', name: 'x', members: [], origin: { room_id: g.id, message_id: gm.id } })).rejects.toThrow(/no such room/)
  })

  it('a link to a removed message, or to a room no longer visible, is said honestly', async () => {
    const c = sim()
    const g = (await c.rooms()).find((r) => r.kind === 'group' && r.origin)!
    const o = g.origin!
    // the message is gone: the room loads, the message does not
    c.roomsHost.simRemoveMessage(o.room_id, o.message_id)
    const ids = (await c.roomMessages(o.room_id)).map((m) => m.id)
    expect(linkState({ message: o.message_id, roomFailed: false, loaded: true, messageIds: ids })).toBe('missing-message')
    // the room can't be read: the direct fetch fails
    c.roomsHost.simLeave(g.id)
    await expect(c.room(g.id)).rejects.toThrow(/no such room/)
    expect(linkState({ message: 'rm_x', roomFailed: true, loaded: false, messageIds: [] })).toBe('missing-room')
    expect(LINK_MISSING['missing-message']).toMatch(/That message isn't available/)
    expect(LINK_MISSING['missing-room']).toMatch(/That message isn't available/)
    // a link that resolves, and states with no link
    expect(linkState({ message: 'a', roomFailed: false, loaded: true, messageIds: ['a'] })).toBe('found')
    expect(linkState({ message: 'a', roomFailed: false, loaded: false, messageIds: [] })).toBe('loading')
    expect(linkState({ roomFailed: false, loaded: true, messageIds: [] })).toBe('none')
  })
})

describe("Kimi r2 #2: pinFirst keeps the host's newest-first order for unpinned rooms", () => {
  it('sorts the rest newest first whatever order arrives; ties keep the host order', () => {
    const at = (d: number) => `2026-10-0${d}T00:00:00Z`
    const input = [room({ id: 'old', updated_at: at(1) }), room({ id: 'c', kind: 'coffee', pinned: true, updated_at: at(2) }),
      room({ id: 'new', updated_at: at(5) }), room({ id: 'mid', updated_at: at(3) }), room({ id: 'mid2', updated_at: at(3) })]
    const { pinned, rest } = pinFirst(input)
    expect(pinned.map((r) => r.id)).toEqual(['c'])
    expect(rest.map((r) => r.id)).toEqual(['new', 'mid', 'mid2', 'old'])
  })
})

describe('Kimi r2 #3: the @here hint never promises a count', () => {
  it('says "up to 5" and "most recently active", with no number of awake minds', () => {
    for (const t of [HERE_HINT, HERE_TYPING]) {
      expect(t).toContain(`up to ${HERE_CAP} awake minds`)
      expect(t).toContain('most recently active')
      expect(t).not.toMatch(/will reach \d+ awake mind|\d+ are awake/)
    }
  })
})

describe('Kimi r2 #4: a directly fetched room joins the list, so the pinned entry and the open room agree', () => {
  it('adds the direct room when the list lacks it, and never duplicates it', () => {
    const direct = room({ id: 'r_c', kind: 'coffee', pinned: true, unread: 4 })
    const list = [room({ id: 'a' })]
    expect(withDirect(list, direct)!.map((r) => r.id)).toEqual(['r_c', 'a'])
    expect(pinFirst(withDirect(list, direct)!).pinned[0].unread).toBe(4)
    expect(withDirect([direct, ...list], { ...direct, unread: 9 })!.filter((r) => r.id === 'r_c')).toHaveLength(1)
    expect(withDirect(null, direct)).toBeNull()
    expect(withDirect(list, null)).toBe(list)
  })
})
