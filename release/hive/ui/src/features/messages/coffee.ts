import type { CoffeeMembership, Room, RoomMember, RoomMessage, RoomOrigin } from '../../api/types'

/**
 * The Coffee Room, as the UI reads it: the one place in the whole UI that knows the host contract (plan r1,
 * PLATFORM_COFFEE_ROOM_PLAN_20261006.md; contract sent by Platform 2026-10-06, CONFIRMED). Every page and
 * every look asks this module, so a change in the contract is one edit here (and the sim, api/sim/rooms.ts).
 *
 * - The room:      `kind: "coffee"`, `alias: "coffee"`, `pinned: true`; one per hive; never deleted, archived, renamed
 *                  or re-kinded, so the UI offers none of those for it.
 * - Break-off:     POST /api/rooms takes `origin: { room_id, message_id }`; the room view returns `origin`.
 * - @here:         a message view's `here_reached` lists the awake minds it reached, at most 5.
 * - Notes:         a message view's `note: true` marks a mind's unprompted note (no mentions, wakes nobody).
 * - Membership:    automatic; a mind's view carries `coffee: "member" | "opted_out" | "private" | "not_a_mind"`; an
 *                  admin toggles it with PATCH /api/agents/{id} `{ coffee: true | false }` (never for `not_a_mind`).
 * - GET /api/rooms/coffee loads the room by alias. `origin` on a DM is kept only when the DM is new.
 * - People are named by name only ("Member" without one), never by email or principal.
 * - The room can't be copied, left, re-kinded, re-visibilitied or hand-managed; an admin may rename it and set its topic.
 * - Not in the contract: a per-message "continued privately / in a group" marker. The origin message never shows one.
 */

export const COFFEE_KIND = 'coffee'
export const COFFEE_ALIAS = 'coffee'
/** `@here` reaches at most this many awake minds per message (host-enforced; the UI only says so). */
export const HERE_CAP = 5
export const COFFEE_NAME = 'Coffee Room'
export const COFFEE_TAGLINE = 'Everyone in the hive'
/** The visible note in the room, and what minds are told in their room prompt. */
export const COFFEE_PUBLIC_NOTE = 'Everyone in the hive can read this room. Keep private things for a private conversation.'
export const HERE_HINT = `@here reaches up to ${HERE_CAP} awake minds, the most recently active. Asleep minds catch up when they wake.`
/** While @here is typed: never a count (the host picks the ${HERE_CAP} most recently active awake minds when it sends). */
export const HERE_TYPING = `@here will reach up to ${HERE_CAP} awake minds, the most recently active; the message shows who it reached.`

export const isCoffee = (r: Pick<Room, 'kind'> & { alias?: string | null }): boolean => r.kind === COFFEE_KIND || r.alias === COFFEE_ALIAS

/** Whether a route's room id names this room: its id, or `#/messages/coffee` for the Coffee Room. Host r2's room view
 *  carries no `alias`, so the Coffee Room is resolved by `kind`; a returned alias (host r3) is an optional extra. */
export const roomMatches = (r: Room, id: string | undefined): boolean =>
  !!id && (r.id === id || (id === COFFEE_ALIAS && isCoffee(r)) || (!!r.alias && r.alias === id))

/** The Coffee Room first (pinned), then everything else newest first (the host's `ORDER BY updated_at DESC`, kept
 *  explicitly so no regrouping can lose it; ties keep the host's order). */
export function pinFirst(rooms: Room[]): { pinned: Room[]; rest: Room[] } {
  // only the Coffee Room is pinned (host r4 sets `pinned` for it alone); any other room stays in its kind's section,
  // so a room the host marks pinned can never fall out of the list
  const pinned = rooms.filter((r) => isCoffee(r))
  const rest = rooms.filter((r) => !pinned.includes(r))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.updated_at.localeCompare(a.r.updated_at) || a.i - b.i)
    .map((x) => x.r)
  return { pinned, rest }
}

/** The kinds the Messages list draws in sections, in order, below the pinned Coffee Room. */
export const SECTION_KINDS: readonly string[] = ['session', 'dm', 'group', 'channel', 'project']

/** The Messages list as drawn, from exactly what the client returned: the Coffee Room pinned, then one section per kind.
 *  Every room lands somewhere: a kind the UI does not know yet gets its own section after the known ones, so the list
 *  can never fetch a room and silently drop it (the live UI before the Coffee Room drew only the kinds it listed). */
export function roomSections(rooms: Room[]): { pinned: Room[]; sections: { kind: string; items: Room[] }[] } {
  const { pinned, rest } = pinFirst(rooms)
  const kinds = [...SECTION_KINDS, ...new Set(rest.map((r) => String(r.kind)).filter((k) => !SECTION_KINDS.includes(k)))]
  const sections = kinds.map((kind) => ({ kind, items: rest.filter((r) => r.kind === kind) })).filter((x) => x.items.length > 0)
  return { pinned, sections }
}

/** The list as shown: when the open room came only from the direct fetch (GET /api/rooms/{id or alias}) and the list
 *  does not carry it, it joins the list, so the pinned entry and the open room are one record (Kimi r2 #4). */
export function withDirect(rooms: Room[] | null, direct: Room | null): Room[] | null {
  if (!rooms || !direct || rooms.some((r) => r.id === direct.id)) return rooms
  return [direct, ...rooms]
}

/** What a back-link (or any `?m=` link) found. The host refuses an origin it can't show (message gone, room not visible),
 *  so the UI never assumes the link resolves: 'missing-room' when the room can't be read, 'missing-message' when the
 *  room is there but the message isn't (removed, or older than what loads), 'found' when it can be shown. */
export type LinkState = 'none' | 'loading' | 'found' | 'missing-message' | 'missing-room'
export function linkState(p: { message?: string; roomFailed: boolean; loaded: boolean; messageIds: string[] }): LinkState {
  if (p.roomFailed) return p.message ? 'missing-room' : 'none'
  if (!p.message) return 'none'
  if (!p.loaded) return 'loading'
  return p.messageIds.includes(p.message) ? 'found' : 'missing-message'
}
export const LINK_MISSING: Record<'missing-message' | 'missing-room', string> = {
  'missing-message': "That message isn't available. It may have been removed, or it is further back than this room shows.",
  'missing-room': "That message isn't available: its conversation can't be opened from here.",
}

export const isMind = (member: string): boolean => member.startsWith('agent:')

export function memberCounts(room: Pick<Room, 'members'>): { people: number; minds: number; total: number } {
  const minds = room.members.filter((m) => isMind(m.member)).length
  return { people: room.members.length - minds, minds, total: room.members.length }
}

/** "Everyone in the hive · 6 people and 12 minds". */
export function coffeeSubtitle(room: Pick<Room, 'members'>): string {
  const c = memberCounts(room)
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  return `${COFFEE_TAGLINE} · ${n(c.people, 'person', 'people')} and ${n(c.minds, 'mind', 'minds')}`
}

// ---- breaking off -----------------------------------------------------------------------------------------------

export type CreateRoomBody = { kind: 'dm' | 'group'; name?: string; members: string[]; visibility?: string; origin: RoomOrigin }

export const originOfMessage = (m: Pick<RoomMessage, 'room_id' | 'id'>): RoomOrigin => ({ room_id: m.room_id, message_id: m.id })

/** "Talk privately": the DM with the sender, carrying where it started. */
export const privateBody = (m: Pick<RoomMessage, 'room_id' | 'id' | 'sender'>): CreateRoomBody => ({ kind: 'dm', members: [m.sender], origin: originOfMessage(m) })

/** "Start a group": invite-only, with the people and minds picked from the room. */
export function groupBody(m: Pick<RoomMessage, 'room_id' | 'id'>, members: string[], name: string): CreateRoomBody {
  return { kind: 'group', name: name.trim() || 'From the Coffee Room', members: [...new Set(members)], visibility: 'private', origin: originOfMessage(m) }
}

/** A starting name for a break-off group: who said it and a few words of what they said. */
export function suggestGroupName(m: Pick<RoomMessage, 'name' | 'text'>): string {
  const words = m.text.replace(/@\S+/g, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ')
  return (words ? `${words}${m.text.trim().split(/\s+/).length > 5 ? '…' : ''}` : `With ${m.name}`).slice(0, 80)
}

/** Who can be picked for a group: every member but me. Sender first, then minds and people by name. */
export function groupCandidates(room: Pick<Room, 'members' | 'me'>, sender?: string): RoomMember[] {
  return room.members
    .filter((m) => m.member !== room.me)
    .sort((a, b) => Number(b.member === sender) - Number(a.member === sender) || a.name.localeCompare(b.name))
}

type CreatesRooms = { createRoom?(body: CreateRoomBody): Promise<Room> }

/** "Talk privately": opens (or creates) the DM. `linked` is false when the DM already existed: the host keeps `origin`
 *  only on a new DM, so that hop shows no back-link. */
export async function talkPrivately(client: CreatesRooms, m: Pick<RoomMessage, 'room_id' | 'id' | 'sender'>): Promise<{ room: Room; linked: boolean }> {
  if (!client.createRoom) throw new Error('This hive does not offer rooms')
  const room = await client.createRoom(privateBody(m))
  return { room, linked: originOf(room)?.message_id === m.id && originOf(room)?.room_id === m.room_id }
}

/** "Start a group" from a message. */
export async function startGroup(client: CreatesRooms, m: Pick<RoomMessage, 'room_id' | 'id'>, members: string[], name: string): Promise<Room> {
  if (!client.createRoom) throw new Error('This hive does not offer rooms')
  if (!members.length) throw new Error('Pick at least one person or mind')
  return client.createRoom(groupBody(m, members, name))
}

/** Where a back-link goes: the origin room, at the message. */
export const originRoute = (o: RoomOrigin) => ({ name: 'messages' as const, room: o.room_id, message: o.message_id })

export const originOf = (r: Pick<Room, 'origin'>): RoomOrigin | null => (r.origin && r.origin.room_id && r.origin.message_id ? r.origin : null)

/** The back-link's words, naming the room it came from when we know it. */
export function originLabel(from: Pick<Room, 'kind' | 'name'> & { alias?: string | null } | null | undefined): string {
  if (!from) return 'Started from a message in another room'
  return `Started from a message in ${isCoffee(from) ? `the ${COFFEE_NAME}` : from.name || 'a conversation'}`
}

// ---- @here and notes --------------------------------------------------------------------------------------------

/** The text says @here (on its own, not inside a word or an email address). */
export const saysHere = (text: string): boolean => /(?<![\w@])@here\b/.test(text) // host r2's own test (rooms.py post)

/** Whether a message used @here: only its text says so. Host r2 sends `here_reached` on every message, usually `[]`,
 *  so the field's presence (or emptiness) means nothing on its own. */
export const isHere = (m: Pick<RoomMessage, 'text'>): boolean => saysHere(m.text)

/** "heard by" for the sender: who the message was delivered to, less the minds the @here line already names, so
 *  explicit @mentions keep their delivery feedback. */
export const heardBy = (m: Pick<RoomMessage, 'text' | 'delivered_to' | 'here_reached'>): string[] => {
  const viaHere = isHere(m) ? new Set(hereReached(m)) : new Set<string>()
  return m.delivered_to.filter((d) => !viaHere.has(d))
}

/** The minds an @here reached (never more than the cap, whatever arrives). */
export const hereReached = (m: Pick<RoomMessage, 'here_reached'>): string[] => (m.here_reached ?? []).slice(0, HERE_CAP)

/** "Reached Vega, Deneb and Mira (awake)" / "No awake minds to reach". */
export function hereLabel(reached: string[], nameOf: (member: string) => string): string {
  if (!reached.length) return '@here reached no one: no minds were awake'
  const names = reached.map(nameOf)
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `@here reached ${list} (awake)`
}

export const isNote = (m: Pick<RoomMessage, 'note'>): boolean => m.note === true

/** "A thought from Vega". */
export const noteLabel = (name: string): string => `A thought from ${name}`

// ---- a mind's membership ----------------------------------------------------------------------------------------

export const COFFEE_STATE: Record<Exclude<CoffeeMembership, 'not_a_mind'>, { label: string; on: boolean; why: string }> = {
  member: { label: 'In the Coffee Room', on: true, why: 'Everyone in the hive can talk with it there; it wakes only when @mentioned or reached by @here.' },
  opted_out: { label: 'Not in the Coffee Room', on: false, why: 'An admin took it out. Put it back any time.' },
  private: { label: 'Not in the Coffee Room', on: false, why: 'Private minds join only if an admin adds them.' },
}

/** What to show for a mind: null when the hive does not say, or for an app module (never a member, no toggle). */
export const coffeeState = (a: { coffee?: CoffeeMembership }): (typeof COFFEE_STATE)[keyof typeof COFFEE_STATE] | null =>
  a.coffee && a.coffee !== 'not_a_mind' ? COFFEE_STATE[a.coffee] : null

/** Before an admin adds a private or shared mind (or one in a private or shared swarm), whatever its status says. */
export const COFFEE_DISCLOSURE = "This mind's name becomes visible to everyone in the hive."

type MindLike = { coffee?: CoffeeMembership; visibility?: string | null; swarm_id?: string | null }
export function needsDisclosure(a: MindLike, swarm?: { visibility?: string | null } | null): boolean {
  if (a.coffee === 'private') return true
  return (a.visibility ?? 'public') !== 'public' || (!!a.swarm_id && !!swarm && (swarm.visibility ?? 'public') !== 'public')
}

/** The admin switch: putting a private mind in asks first (the disclosure); nothing is sent unless confirmed. */
export async function setCoffeeMembership(
  a: MindLike & { id: string }, on: boolean,
  deps: { swarm?: { visibility?: string | null } | null; confirm: (message: string, label: string) => Promise<boolean>; patch: (id: string, body: { coffee: boolean }) => Promise<boolean> },
): Promise<boolean> {
  if (on && needsDisclosure(a, deps.swarm) && !(await deps.confirm(COFFEE_DISCLOSURE, 'Add to the Coffee Room'))) return false
  return deps.patch(a.id, { coffee: on })
}

// ---- names ------------------------------------------------------------------------------------------------------

/** A member's name for the Coffee Room, names only (host r2): minds by name, "A mind" without one; people by name,
 *  "Member" without one; never an email, an id or a principal, whatever arrives. "You" only for the viewer (`me`, the
 *  room's own principal); the hive-password operator is "the operator" to everyone else, whatever the host calls it
 *  (the host names it "You" for every viewer, hive/core/rooms.py) (followups r4). */
export function memberName(m: { member: string; name?: string | null }, me?: string | null): string {
  const name = (m.name ?? '').trim()
  if (isMind(m.member)) return !name || name === m.member || name === m.member.slice(6) || /^(user|agent|system):/.test(name) ? 'A mind' : name
  if (me && m.member === me) return 'You'
  if (m.member === 'user:operator') return name && name !== m.member && name !== 'You' ? name : 'the operator'
  if (!name || name.includes('@') || name === m.member || name === m.member.slice(5) || /^(user|agent|system):/.test(name)) return 'Member'
  return name
}
