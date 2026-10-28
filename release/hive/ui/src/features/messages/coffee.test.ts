import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SimClient } from '../../api/sim/SimClient'
import type { Room, RoomMessage } from '../../api/types'
import { FEATURES } from '../../features/registry'
import { href, parse } from '../../lib/router'
import { targetFor } from '../../experiences/targets'
import { findFeature } from '../../experiences/construct/features'
import { NAV_FEATURES as STILL_NAV } from '../../experiences/still/nav'
import { NAV_FEATURES as CANVAS_NAV, wayFor } from '../../experiences/canvas/nav'
import { NAV_FEATURES as COSMOS_NAV, targetFor as cosmosTarget } from '../../experiences/cosmos/nav'
import { NAV_FEATURES as FLUX_NAV, targetFor as fluxTarget } from '../../experiences/flux/nav'
import { NAV_FEATURES as CONSTRUCT_NAV } from '../../experiences/construct/nav'
import { chrome as stillChrome } from '../../experiences/still/chrome'
import { chrome as canvasChrome } from '../../experiences/canvas/chrome'
import { chrome as cosmosChrome } from '../../experiences/cosmos/chrome'
import { chrome as fluxChrome } from '../../experiences/flux/chrome'
import { chrome as constructChrome } from '../../experiences/construct/chrome'
import {
  COFFEE_DISCLOSURE, HERE_CAP, coffeeState, coffeeSubtitle, groupBody, heardBy, hereLabel, hereReached, isCoffee, isHere, isNote,
  needsDisclosure, setCoffeeMembership, memberName, noteLabel,
  originLabel, originOf, originRoute, pinFirst, privateBody, roomMatches, saysHere, startGroup, talkPrivately,
} from './coffee'
import { CoffeeListEntry, CoffeePublicNote, HereReached, NoteBody, OriginBackLink } from './CoffeeParts'

const room = (over: Partial<Room>): Room => ({
  id: 'r_1', kind: 'group', name: 'G', topic: '', owner: 'user:operator', visibility: 'private', shared_with: [], swarm_id: null,
  seq: 0, created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z', settings: { minds_follow: false, turn_cap: 3 },
  members: [], me: 'user:operator', ...over,
})
const msg = (over: Partial<RoomMessage>): RoomMessage => ({
  id: 'rm_1', room_id: 'r_c', seq: 1, sender: 'user:p_ada', name: 'Ada', text: 'hello', mentions: [], delivered_to: [],
  created_at: '2026-10-06T00:00:00Z', ...over,
})
const coffee = room({ id: 'r_c', kind: 'coffee', alias: 'coffee', pinned: true, name: 'Coffee Room', members: [
  { member: 'user:operator', role: 'member', name: 'You' }, { member: 'user:p_ada', role: 'member', name: 'Ada' },
  { member: 'agent:a_1', role: 'member', name: 'Vega' }, { member: 'agent:a_2', role: 'member', name: 'Deneb' },
] })
// CSS is read from disk (a ?raw CSS import is emptied by the test transform), as shell/clockModel.test.ts does
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
const coffeeCss = fs.readFileSync(new URL('./coffee.css', import.meta.url), 'utf8')
/** The Coffee Room from a room list (host r2 lists newest first; the UI pins it). */
const coffeeOf = (rooms: Room[]) => rooms.find((r) => r.kind === 'coffee')!
const sim = () => new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 3 })

describe('Coffee Room adapter (Platform contract, CONFIRMED)', () => {
  it('resolves #/messages/coffee by kind when the host returns no alias (host r2, stand-in P1)', () => {
    const hostR2 = room({ id: 'r_x', kind: 'coffee', pinned: true, origin: null })
    expect(roomMatches(hostR2, 'coffee')).toBe(true)
    expect(roomMatches(room({ id: 'r_y', kind: 'channel', name: 'coffee' }), 'coffee')).toBe(false)
  })

  it('knows the room by kind "coffee" or alias "coffee", and a route can name it by alias', () => {
    expect(isCoffee(coffee)).toBe(true)
    expect(isCoffee(room({ kind: 'channel', alias: 'coffee' }))).toBe(true)
    expect(isCoffee(room({ kind: 'channel' }))).toBe(false)
    expect(roomMatches(coffee, 'coffee')).toBe(true)
    expect(roomMatches(coffee, 'r_c')).toBe(true)
    expect(roomMatches(room({}), 'coffee')).toBe(false)
  })

  it('pins the Coffee Room first whatever order the host sends', () => {
    const { pinned, rest } = pinFirst([room({ id: 'a' }), coffee, room({ id: 'b' })])
    expect(pinned.map((r) => r.id)).toEqual(['r_c'])
    expect(rest.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('counts people and minds for "Everyone in the hive"', () => {
    expect(coffeeSubtitle(coffee)).toBe('Everyone in the hive · 2 people and 2 minds')
  })

  it('break-off bodies carry origin { room_id, message_id }', () => {
    const m = msg({ id: 'rm_9', room_id: 'r_c', sender: 'agent:a_1' })
    expect(privateBody(m)).toEqual({ kind: 'dm', members: ['agent:a_1'], origin: { room_id: 'r_c', message_id: 'rm_9' } })
    expect(groupBody(m, ['agent:a_1', 'user:p_ada', 'agent:a_1'], ' Plans ')).toEqual({
      kind: 'group', name: 'Plans', members: ['agent:a_1', 'user:p_ada'], visibility: 'private', origin: { room_id: 'r_c', message_id: 'rm_9' } })
    expect(groupBody(m, ['user:p_ada'], '').name).toBe('From the Coffee Room')
  })

  it('reads @here: the word, the reached minds (never more than 5) and how they are named', () => {
    expect(saysHere('@here anyone?')).toBe(true)
    expect(saysHere('hi @here')).toBe(true)
    expect(saysHere('mail me@here.org')).toBe(false)
    expect(saysHere('@hereford')).toBe(false)
    expect(saysHere('@here-ish')).toBe(true) // the host's own test: (?<![\w@])@here\b
    expect(hereReached(msg({ here_reached: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }))).toHaveLength(HERE_CAP)
    expect(hereReached(msg({}))).toEqual([])
    const name = (m: string) => ({ 'agent:a_1': 'Vega', 'agent:a_2': 'Deneb', 'agent:a_3': 'Mira' })[m] ?? m
    expect(hereLabel(['agent:a_1', 'agent:a_2', 'agent:a_3'], name)).toBe('@here reached Vega, Deneb and Mira (awake)')
    expect(hereLabel([], name)).toMatch(/no minds were awake/)
  })

  it('marks unprompted notes', () => {
    expect(isNote(msg({ note: true }))).toBe(true)
    expect(isNote(msg({}))).toBe(false)
    expect(noteLabel('Vega')).toBe('A thought from Vega')
  })

  it('never names a person by email or principal', () => {
    expect(memberName({ member: 'user:p_ada', name: 'Ada' })).toBe('Ada')
    expect(memberName({ member: 'user:p_x', name: 'x@example.org' })).toBe('Member')
    expect(memberName({ member: 'user:p_x', name: 'user:p_x' })).toBe('Member')
    expect(memberName({ member: 'user:p_x', name: 'p_x' })).toBe('Member')
    expect(memberName({ member: 'user:p_x', name: '' })).toBe('Member')
    expect(memberName({ member: 'agent:a_1', name: 'Vega' })).toBe('Vega')
    expect(memberName({ member: 'agent:a_gone', name: 'agent:a_gone' })).toBe('A mind') // host's fallback for a missing mind
    expect(memberName({ member: 'agent:a_gone', name: '' })).toBe('A mind')
    // followups r4: "You" only for the viewer; the hive-password operator is "the operator" to everyone else (the host
    // names it "You" for every viewer)
    expect(memberName({ member: 'user:p_ada', name: 'Ada' }, 'user:p_ada')).toBe('You')
    expect(memberName({ member: 'user:operator', name: 'You' }, 'user:p_ada')).toBe('the operator')
    expect(memberName({ member: 'user:operator', name: 'You' })).toBe('the operator')
    expect(memberName({ member: 'user:operator', name: 'You' }, 'user:operator')).toBe('You')
    expect(memberName({ member: 'user:p_ada', name: 'Ada' }, 'user:operator')).toBe('Ada')
  })

  it("maps a mind's membership; app modules get no state and no toggle", () => {
    expect(coffeeState({ coffee: 'member' })?.on).toBe(true)
    expect(coffeeState({ coffee: 'opted_out' })?.on).toBe(false)
    expect(coffeeState({ coffee: 'private' })?.why).toBe('Private minds join only if an admin adds them.')
    expect(coffeeState({ coffee: 'not_a_mind' })).toBeNull()
    expect(coffeeState({})).toBeNull()
  })

  it('back-links go to the origin room at the message, and the route round-trips', () => {
    const r = originRoute({ room_id: 'r_c', message_id: 'rm_9' })
    expect(r).toEqual({ name: 'messages', room: 'r_c', message: 'rm_9' })
    expect(parse(href(r))).toEqual(r)
    expect(parse('#/messages/coffee')).toEqual({ name: 'messages', room: 'coffee' })
    expect(originLabel(coffee)).toBe('Started from a message in the Coffee Room')
    expect(originLabel(null)).toBe('Started from a message in another room')
    expect(originOf(room({ origin: { room_id: '', message_id: 'x' } }))).toBeNull()
  })
})

describe('Coffee Room in the simulator (the confirmed contract, end to end)', () => {
  it('lists the Coffee Room pinned with everyone in it; loads it by alias', async () => {
    const c = sim()
    const cr = coffeeOf(await c.rooms())
    expect(cr.pinned).toBe(true)
    const direct = await c.room('coffee')
    expect(direct.id).toBe(cr.id)
    // host r4's view carries alias "coffee" (rooms.py view); the alias-less case is covered on its own above
    expect(direct.alias).toBe('coffee')
    expect(roomMatches(direct, 'coffee')).toBe(true)
    const agents = await c.listAgents()
    const members = new Set(cr.members.map((m) => m.member))
    for (const a of agents) expect(members.has(`agent:${a.id}`)).toBe(a.coffee === 'member')
    expect(agents.some((a) => a.coffee === 'not_a_mind')).toBe(true)
    expect(cr.members.some((m) => m.member === 'user:operator')).toBe(true)
    for (const m of cr.members) expect(m.name).not.toMatch(/@|^user:/)
  })

  it('"Talk privately" opens a new DM with origin; an existing DM opens without a back-link', async () => {
    const c = sim()
    const cr = coffeeOf(await c.rooms())
    const msgs = await c.roomMessages(cr.id)
    const fromPerson = msgs.find((m) => m.sender.startsWith('user:'))!
    const first = await talkPrivately(c, fromPerson)
    expect(first.linked).toBe(true)
    expect(first.room.kind).toBe('dm')
    expect(first.room.origin).toEqual({ room_id: cr.id, message_id: fromPerson.id })
    const vega = msgs.find((m) => m.name === 'Vega')! // the seed already has a DM with Vega
    const again = await talkPrivately(c, vega)
    expect(again.linked).toBe(false)
    expect(again.room.origin ?? null).toBeNull()
  })

  it('"Start a group" creates a private group with the picks and the origin', async () => {
    const c = sim()
    const cr = coffeeOf(await c.rooms())
    const m = (await c.roomMessages(cr.id))[1]
    const picks = cr.members.filter((x) => x.member !== cr.me).slice(0, 3).map((x) => x.member)
    const g = await startGroup(c, m, picks, 'Kelp walk-through')
    expect(g.kind).toBe('group')
    expect(g.visibility).toBe('private')
    expect(g.origin).toEqual({ room_id: cr.id, message_id: m.id })
    expect(g.members.map((x) => x.member).sort()).toEqual([...picks, cr.me!].sort())
    await expect(startGroup(c, m, [], 'x')).rejects.toThrow()
  })

  it('rejects an origin the creator cannot see', async () => {
    const c = sim()
    await expect(c.createRoom({ kind: 'group', name: 'x', members: [], origin: { room_id: 'r_nope', message_id: 'rm_nope' } })).rejects.toThrow(/no such room/) // host r4 wording
  })

  it('@here reaches only awake member minds, at most 5', async () => {
    const c = sim()
    const cr = coffeeOf(await c.rooms())
    const out = await c.postRoomMessage(cr.id, '@here who is around?')
    const agents = await c.listAgents()
    expect(out.here_reached!.length).toBeLessThanOrEqual(5)
    expect(out.here_reached!.length).toBeGreaterThan(0)
    for (const m of out.here_reached!) {
      const a = agents.find((x) => `agent:${x.id}` === m)!
      expect(a.status).toBe('awake')
      expect(a.coffee).toBe('member')
    }
    const plain = await c.postRoomMessage(cr.id, 'just saying hi')
    expect(plain.here_reached).toEqual([]) // host r2: always present, empty unless @here
    expect(isHere(plain)).toBe(false)
    expect(isHere(out)).toBe(true)
    expect(plain.note).toBe(false) // host r2: note is always present
  })

  it('unprompted notes are marked, carry no mentions, and come at most once per mind per hour', async () => {
    const c = sim()
    const cr = coffeeOf(await c.rooms())
    const seeded = (await c.roomMessages(cr.id)).filter((m) => m.note)
    expect(seeded.length).toBeGreaterThan(0)
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const n = c.roomsHost.maybeNote()
      if (!n) break
      expect(n.note).toBe(true)
      expect(n.mentions).toEqual([])
      expect(n.delivered_to).toEqual([])
      expect(seen.has(n.sender)).toBe(false)
      seen.add(n.sender)
    }
    // a mind that posted a note within the hour does not post another
    const recent = seeded.filter((n) => Date.now() - Date.parse(n.created_at) < 3_600_000)
    expect(recent.length).toBeGreaterThan(0)
    for (const n of recent) expect(seen.has(n.sender)).toBe(false)
  })

  it('the room cannot be left, re-kinded or re-visibilitied; an admin may rename it', async () => {
    const c = sim()
    const cr = coffeeOf(await c.rooms())
    await expect(c.removeRoomMember(cr.id, 'user:operator')).rejects.toThrow()
    await expect(c.updateRoom(cr.id, { kind: 'group' })).rejects.toThrow()
    await expect(c.updateRoom(cr.id, { visibility: 'private' })).rejects.toThrow()
    expect((await c.updateRoom(cr.id, { name: 'The Kitchen', topic: 'Pull up a chair' })).name).toBe('The Kitchen')
    c.simMember = true
    await expect(c.updateRoom(cr.id, { name: 'Mine' })).rejects.toThrow(/admin/)
  })

  it('an admin takes a mind out and puts it back; never an app module; members cannot', async () => {
    const c = sim()
    const agents = await c.listAgents()
    const mind = agents.find((a) => a.coffee === 'member')!
    expect((await c.patchAgent(mind.id, { coffee: false })).coffee).toBe('opted_out')
    expect(coffeeOf(await c.rooms()).members.some((m) => m.member === `agent:${mind.id}`)).toBe(false)
    expect((await c.patchAgent(mind.id, { coffee: true })).coffee).toBe('member')
    const mod = agents.find((a) => a.coffee === 'not_a_mind')!
    await expect(c.patchAgent(mod.id, { coffee: true })).rejects.toThrow()
    c.simMember = true
    await expect(c.patchAgent(mind.id, { coffee: false })).rejects.toThrow(/admin/)
  })
})

describe('stand-in FIX-FIRST (host r2 shapes)', () => {
  it('P2: an ordinary message with here_reached: [] is not an @here, and keeps "heard by" for mentions', () => {
    const plain = msg({ text: 'thanks @Vega', here_reached: [], delivered_to: ['agent:a_1'] })
    expect(isHere(plain)).toBe(false)
    expect(heardBy(plain)).toEqual(['agent:a_1'])
    const both = msg({ text: '@here and @Vega', here_reached: ['agent:a_2'], delivered_to: ['agent:a_1', 'agent:a_2'] })
    expect(isHere(both)).toBe(true)
    expect(heardBy(both)).toEqual(['agent:a_1'])
  })

  it('P3: adding a private or shared mind asks first, and sends nothing when declined', async () => {
    const asked: string[] = []
    const sent: unknown[] = []
    const deps = (answer: boolean, swarm: { visibility?: string } | null = null) => ({
      swarm, confirm: async (m: string) => { asked.push(m); return answer }, patch: async (_id: string, body: unknown) => { sent.push(body); return true } })
    expect(await setCoffeeMembership({ id: 'a_1', coffee: 'private' }, true, deps(false))).toBe(false)
    expect(asked).toEqual([COFFEE_DISCLOSURE])
    expect(sent).toEqual([])
    expect(COFFEE_DISCLOSURE).toBe("This mind's name becomes visible to everyone in the hive.")
    // opted_out, but the mind is shared, or its swarm is private: still disclosed
    expect(await setCoffeeMembership({ id: 'a_1', coffee: 'opted_out', visibility: 'shared' }, true, deps(true))).toBe(true)
    expect(await setCoffeeMembership({ id: 'a_1', coffee: 'opted_out', swarm_id: 's_1' }, true, deps(true, { visibility: 'private' }))).toBe(true)
    expect(asked).toHaveLength(3)
    expect(sent).toEqual([{ coffee: true }, { coffee: true }])
    // a public mind goes back in without a question; taking any mind out never asks
    await setCoffeeMembership({ id: 'a_1', coffee: 'opted_out', visibility: 'public' }, true, deps(true, { visibility: 'public' }))
    await setCoffeeMembership({ id: 'a_1', coffee: 'private' }, false, deps(true))
    expect(asked).toHaveLength(3)
    expect(needsDisclosure({ coffee: 'member' })).toBe(false)
  })

  it('P3: the admin control shows the disclosure on a private mind before the switch', () => {
    // CoffeeMembershipControl renders through the store; the words it shows come from these two
    expect(coffeeState({ coffee: 'private' })?.on).toBe(false)
    expect(needsDisclosure({ coffee: 'private' })).toBe(true)
  })

  it('P4: the simulator is host r4-shaped: alias only on the Coffee Room, here_reached and note on every message', async () => {
    const c = sim()
    const rooms = await c.rooms()
    for (const r of rooms) expect('alias' in r).toBe(r.kind === 'coffee')
    const cr = coffeeOf(rooms)
    expect(cr.alias).toBe('coffee')
    for (const m of await c.roomMessages(cr.id)) {
      expect(Array.isArray(m.here_reached)).toBe(true)
      expect(typeof m.note).toBe('boolean')
    }
    // the UI pins it whatever the host order
    expect(pinFirst(rooms).pinned[0].id).toBe(cr.id)
  })
})

describe('Coffee Room UI pieces', () => {
  const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

  it('the pinned entry names the room, says pinned and counts everyone', () => {
    const html = render(createElement(CoffeeListEntry, { room: { ...coffee, unread: 3 }, active: false, onOpen: () => undefined }))
    expect(html).toContain('Coffee Room')
    expect(html).toContain('Pinned')
    expect(html).toContain('Everyone in the hive · 2 people and 2 minds')
    expect(html).toContain('3 unread')
  })

  it('shows the hive-public note', () => {
    expect(render(createElement(CoffeePublicNote))).toContain('Everyone in the hive can read this room')
  })

  it('shows who an @here reached, by name', () => {
    const html = render(createElement(HereReached, { message: msg({ text: '@here anyone?', here_reached: ['agent:a_1', 'agent:a_2'] }), room: coffee }))
    expect(html).toContain('@here reached Vega and Deneb (awake)')
    expect(render(createElement(HereReached, { message: msg({}), room: coffee }))).toBe('')
    // host r2 sends here_reached: [] on every message: no line unless the message was an @here
    expect(render(createElement(HereReached, { message: msg({ here_reached: [] }), room: coffee }))).toBe('')
    expect(render(createElement(HereReached, { message: msg({ here_reached: [], text: '@here anyone?' }), room: coffee }))).toContain('no minds were awake')
  })

  it('draws a note quietly as "a thought from …"', () => {
    const html = render(createElement(NoteBody, { message: msg({ sender: 'agent:a_1', name: 'Vega', note: true, text: 'An idea' }) }))
    expect(html).toContain('A thought from Vega')
    expect(html).toContain('coffee-thought')
  })

  it('a room started from a message links back; others do not', () => {
    const g = room({ origin: { room_id: 'r_c', message_id: 'rm_1' } })
    expect(render(createElement(OriginBackLink, { room: g, rooms: [coffee] }))).toContain('Started from a message in the Coffee Room')
    expect(render(createElement(OriginBackLink, { room: room({}), rooms: [coffee] }))).toBe('')
  })
})

describe('Coffee Room in every look', () => {
  const f = FEATURES.find((x) => x.id === 'talk.coffee')!

  it('is a hive feature whose classic place is the room by alias', () => {
    expect(f.classic).toEqual({ name: 'messages', room: 'coffee' })
    expect(targetFor(f)).toEqual({ kind: 'route', route: { name: 'messages', room: 'coffee' } })
  })

  it("each look's own navigation reaches it", () => {
    for (const nav of [STILL_NAV, CANVAS_NAV, COSMOS_NAV, FLUX_NAV, CONSTRUCT_NAV]) expect(nav).toContain('talk.coffee')
    expect(wayFor(f)).toBe('page')
    expect(cosmosTarget(f)).toEqual({ kind: 'classic', route: { name: 'messages', room: 'coffee' } })
    expect(fluxTarget(f)).toEqual({ kind: 'classic', route: { name: 'messages', room: 'coffee' } })
    expect(findFeature('coffee')?.id).toBe('talk.coffee')
  })

  it("draws its warmth in each look's material (glass, paper, terminal, none) and in light schemes", () => {
    const css = coffeeCss
    const materials = new Set([stillChrome, canvasChrome, cosmosChrome, fluxChrome, constructChrome].map((c) => c.material))
    expect(materials.size).toBeGreaterThan(1)
    expect(css).toContain("data-xc-material='terminal'")
    expect(css).toContain("data-xc-material='paper'")
    expect(css).toContain("data-xc-scheme='light'")
    expect(css).toContain('prefers-reduced-motion')
    expect(css).toContain('(hover: hover)') // actions always visible where nothing hovers (phones)
  })
})
