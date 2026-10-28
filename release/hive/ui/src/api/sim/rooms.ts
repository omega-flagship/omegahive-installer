import { ApiError } from '../client'
import type { Agent, CoffeeMembership, Room, RoomKind, RoomMessage, RoomOrigin, Swarm } from '../types'
import { DEMO_TEAM_ASKS, DEMO_TEAM_REPLIES, DEMO_TEAM_TALK } from './demo'

/**
 * Rooms in the browser simulator (hive/core/rooms.py, R15), with the Coffee Room (plan r1, Platform's contract of
 * 2026-10-06): one built-in `kind: "coffee"` room, alias "coffee", pinned, that every person and every member mind
 * belongs to automatically; break-off rooms carrying `origin`; `@here` reaching awake minds (5 at most) recorded as
 * `here_reached`; and minds' unprompted notes (`note: true`, at most one per mind per hour, waking nobody).
 * Sim only: nothing here reaches a real hive.
 */

const HERE_CAP = 5
const NOTE_EVERY_MS = 3_600_000
const MAX_TEXT = 8000
const KINDS: RoomKind[] = ['dm', 'group', 'channel', 'project']
/** A start that moves with the clock, so the chatter visits the team rooms in turn. */
const r0 = (n: number) => Math.floor(Date.now() / 1000) % Math.max(1, n)

export interface SimRoomsDeps {
  me: () => { principal: string; name: string | null; admin: boolean }
  people: () => { principal: string; name: string; admin?: boolean }[]
  agents: () => Agent[]
  emit: (roomId: string, what: string) => void
  later: (ms: number, fn: () => void) => void
  now: () => string
  id: (prefix: string) => string
  /** demo mode (api/sim/demo.ts): team rooms open with an invented conversation, and their minds talk now and then */
  demo?: () => boolean
  /** the hive's swarms: every swarm has its team room (host r6, rooms.sync_team). Absent: no team rooms. */
  swarms?: () => Swarm[]
}

/** Host r6 (rooms.py TEAM_MINDS): the kinds that sit in a team room (minds, not outside members or app modules). */
const TEAM_MINDS = ['omega', 'iter']
const TEAM_TOPIC = "Your swarm's team room: minds reach each other here with @Name."

interface SimRoom {
  id: string; kind: RoomKind; name: string; topic: string; owner: string
  visibility: Room['visibility']; swarm_id: string | null; settings: Room['settings']
  seq: number; created_at: string; updated_at: string
  alias: string | null; pinned: boolean; origin: RoomOrigin | null
  /** Explicit members (the Coffee Room's are computed: everyone). */
  members: { member: string; role: string }[]
  read: Map<string, number>
  /** archived rooms are gone from every read (a deleted swarm's team room) */
  archived?: boolean
}

/** A seed message: `at` minutes ago. */
type Seed = { sender: string; text: string; ago: number; note?: true; here?: true }

export class SimRooms {
  private rooms = new Map<string, SimRoom>()
  private log = new Map<string, RoomMessage[]>()
  private lastNote = new Map<string, number>()
  private seeded = false

  constructor(private d: SimRoomsDeps) {}

  // ---- who is who --------------------------------------------------------------------------------------------------

  private name(member: string): string {
    if (member.startsWith('agent:')) return this.d.agents().find((a) => a.id === member.slice(6))?.name ?? member
    const me = this.d.me()
    if (member === me.principal) return me.name || (member === 'user:operator' ? 'You' : 'Member')
    if (member === 'system:hive') return 'Hive'
    if (member === 'user:operator') return 'You'
    // people by name only, "Member" without one: never an email or a principal
    return this.d.people().find((p) => p.principal === member)?.name || 'Member'
  }

  private agentOf(member: string): Agent | undefined {
    return member.startsWith('agent:') ? this.d.agents().find((a) => a.id === member.slice(6)) : undefined
  }

  private coffeeMembers(): { member: string; role: string }[] {
    const me = this.d.me().principal
    const people = [...new Set([me, ...this.d.people().map((p) => p.principal)])]
    const minds = this.d.agents().filter((a) => (a.coffee ?? 'member') === 'member').map((a) => `agent:${a.id}`)
    return [...people, ...minds].map((member) => ({ member, role: 'member' }))
  }

  private membersOf(r: SimRoom) {
    return r.kind === 'coffee' ? this.coffeeMembers() : r.members.filter((m) => !m.member.startsWith('agent:') || this.agentOf(m.member))
  }

  private isMember(r: SimRoom, member: string) {
    return this.membersOf(r).some((m) => m.member === member)
  }

  private view(r: SimRoom): Room {
    const me = this.d.me().principal
    const members = this.membersOf(r)
    const joined = members.some((m) => m.member === me)
    return {
      id: r.id, kind: r.kind, name: r.name, topic: r.topic, owner: r.owner, visibility: r.visibility, shared_with: [],
      swarm_id: r.swarm_id, seq: r.seq, created_at: r.created_at, updated_at: r.updated_at, settings: { ...r.settings },
      members: members.map((m) => ({ ...m, name: this.name(m.member) })),
      unread: joined ? Math.max(0, r.seq - (r.read.get(me) ?? 0)) : 0, joined, me,
      // host r4's view (rooms.py view): `alias: "coffee"` on the Coffee Room only, `pinned`, `origin`
      ...(r.kind === 'coffee' ? { alias: 'coffee' } : {}),
      pinned: r.kind === 'coffee', origin: r.origin ? { ...r.origin } : null,
    }
  }

  private canSee(r: SimRoom) {
    const me = this.d.me().principal
    if (r.archived) return false
    // host can_see: an admin sees a team room (a swarm's private group) without being in it
    if (this.isTeam(r) && this.d.me().admin) return true
    return r.kind === 'coffee' || this.isMember(r, me) || (r.kind === 'channel' && r.visibility === 'public')
  }

  private row(id: string): SimRoom {
    this.seed()
    this.syncTeams()
    const r = this.rooms.get(id) ?? [...this.rooms.values()].find((x) => x.alias === id)
    if (!r || !this.canSee(r)) throw new ApiError(404, 'not_found', 'no such room')
    return r
  }

  /** Host r4 (rooms.is_coffee): whether a conversation id names the Coffee Room, by id or alias. */
  isCoffee(conversationId: string | undefined | null): boolean {
    if (!conversationId) return false
    this.seed()
    const r = this.rooms.get(conversationId) ?? [...this.rooms.values()].find((x) => x.alias === conversationId)
    return !!r && r.kind === 'coffee'
  }

  /** Sim only: a message disappears (to exercise links whose message is gone). */
  simRemoveMessage(roomId: string, messageId: string) {
    const r = this.row(roomId)
    this.log.set(r.id, (this.log.get(r.id) ?? []).filter((m) => m.id !== messageId))
  }

  /** Sim only: the viewer stops seeing a room (left a group). */
  simLeave(roomId: string) {
    const r = this.row(roomId)
    const me = this.d.me().principal
    r.members = r.members.filter((m) => m.member !== me)
  }

  coffee(): SimRoom {
    this.seed()
    return [...this.rooms.values()].find((r) => r.kind === 'coffee')!
  }

  // ---- the surface -------------------------------------------------------------------------------------------------

  list(): Room[] {
    this.seed()
    this.syncTeams()
    return [...this.rooms.values()]
      .filter((r) => this.canSee(r))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at)) // host r2 order: newest first, the Coffee Room not first
      .map((r) => this.view(r))
  }

  get(id: string): Room { return this.view(this.row(id)) }

  create(body: { kind: RoomKind; name?: string; topic?: string; members: string[]; visibility?: string; origin?: RoomOrigin }): Room {
    this.seed()
    const me = this.d.me().principal
    if (body.kind === 'coffee') throw new ApiError(400, 'bad_request', 'the hive has one Coffee Room already')
    if (!KINDS.includes(body.kind)) throw new ApiError(400, 'bad_request', `kind is one of ${KINDS.join(', ')}`)
    const origin = body.origin ? this.checkOrigin(body.origin) : null
    const others = [...new Set(body.members ?? [])].filter((m) => m !== me)
    for (const m of others) {
      if (!/^(agent:a_|user:)/.test(m)) throw new ApiError(400, 'bad_request', `a member is a person (user:...) or a mind (agent:a_...), not ${m}`)
      if (m.startsWith('agent:') && !this.agentOf(m)) throw new ApiError(404, 'not_found', `no such mind ${m.slice(6)}`)
    }
    if (body.kind === 'dm') {
      if (others.length !== 1) throw new ApiError(400, 'bad_request', 'a DM is you and one other member')
      const pair = [me, others[0]]
      const existing = [...this.rooms.values()].find((r) => r.kind === 'dm' && pair.every((p) => r.members.some((m) => m.member === p)))
      // the one DM between two members: `origin` is kept only when the DM is new
      if (existing) return this.view(existing)
    }
    const name = (body.name ?? '').trim().slice(0, 80)
    if (body.kind !== 'dm' && !name) throw new ApiError(400, 'bad_request', 'a room needs a name')
    const r = this.make({ kind: body.kind, name: body.kind === 'dm' ? '' : name, topic: body.topic ?? '', owner: me,
      visibility: (body.visibility as Room['visibility']) ?? 'private', origin, members: [me, ...others] })
    this.d.emit(r.id, 'created')
    return this.view(r)
  }

  /** The host checks the creator can see the message it starts from. */
  private checkOrigin(o: RoomOrigin): RoomOrigin {
    // host r4 (rooms.py _origin): the room must be visible ("no such room"), the message must be in it
    if (!o || typeof o !== 'object' || Object.keys(o).sort().join() !== 'message_id,room_id') throw new ApiError(400, 'bad_request', 'origin is {room_id, message_id}')
    const r = this.row(o.room_id)
    if (!(this.log.get(r.id) ?? []).some((m) => m.id === o.message_id)) throw new ApiError(404, 'not_found', 'no such message in that room')
    return { room_id: r.id, message_id: o.message_id }
  }

  update(id: string, body: Record<string, unknown>): Room {
    const r = this.row(id)
    if (this.isTeam(r)) {
      // host r6: a team room follows its swarm; its owner or an admin may change its topic, nothing else
      if (Object.keys(body).some((k) => k !== 'topic')) throw new ApiError(400, 'bad_request', "a swarm's team room follows its swarm; its owner or an admin may change its topic")
      if (!this.d.me().admin && this.d.me().principal !== r.owner) throw new ApiError(403, 'forbidden', "a swarm's team room follows its swarm; its owner or an admin may change its topic")
    }
    if (r.kind === 'coffee') {
      const fixed = ['kind', 'archived', 'swarm_id', 'visibility', 'settings'].filter((k) => k in body)
      if (fixed.length) throw new ApiError(400, 'bad_request', `the Coffee Room's ${fixed.join(', ')} cannot change`)
      if (!this.d.me().admin) throw new ApiError(403, 'forbidden', 'an admin renames the Coffee Room or changes its topic')
    }
    if (typeof body.name === 'string') r.name = body.name.trim().slice(0, 80) || r.name
    if (typeof body.topic === 'string') r.topic = body.topic.slice(0, 500)
    if (typeof body.kind === 'string' && body.kind !== r.kind) {
      if (!KINDS.includes(body.kind as RoomKind) || body.kind === 'dm') throw new ApiError(400, 'bad_request', 'not a kind a room can become')
      r.kind = body.kind as RoomKind
    }
    if (typeof body.visibility === 'string') r.visibility = body.visibility as Room['visibility']
    if (body.settings && typeof body.settings === 'object') Object.assign(r.settings, body.settings)
    r.updated_at = this.d.now()
    this.d.emit(r.id, 'updated')
    return this.view(r)
  }

  addMembers(id: string, members: string[]): Room {
    const r = this.row(id)
    if (this.isTeam(r)) throw new ApiError(400, 'bad_request', "a swarm's team room holds its owner and its minds; it follows the swarm")
    if (r.kind === 'coffee') throw new ApiError(400, 'bad_request', 'everyone is in the Coffee Room already')
    for (const m of members) if (!r.members.some((x) => x.member === m)) r.members.push({ member: m, role: 'member' })
    this.d.emit(r.id, 'members')
    return this.view(r)
  }

  removeMember(id: string, member: string): Room {
    const r = this.row(id)
    if (this.isTeam(r)) throw new ApiError(400, 'bad_request', "a swarm's team room holds its owner and its minds; it follows the swarm")
    if (r.kind === 'coffee') throw new ApiError(400, 'bad_request', "the Coffee Room can't be left; an admin takes a mind out from its settings")
    if (r.kind === 'dm') throw new ApiError(400, 'bad_request', "a DM's members are fixed")
    r.members = r.members.filter((m) => m.member !== member)
    this.d.emit(r.id, 'members')
    return this.view(r)
  }

  messages(id: string, after = 0): RoomMessage[] {
    const r = this.row(id)
    const rows = (this.log.get(r.id) ?? []).filter((m) => m.seq > after)
    const me = this.d.me().principal
    if (rows.length && this.isMember(r, me)) r.read.set(me, Math.max(r.read.get(me) ?? 0, rows[rows.length - 1].seq))
    return rows.map((m) => structuredClone(m))
  }

  /** A person speaks. Minds hear @mentions (in a DM, every message); in the Coffee Room `@here` reaches awake minds. */
  post(id: string, text: string): RoomMessage {
    const r = this.row(id)
    const me = this.d.me().principal
    if (!this.isMember(r, me)) throw new ApiError(403, 'not_member', 'join the room to speak in it')
    if (typeof text !== 'string' || !text.trim()) throw new ApiError(400, 'bad_request', 'a message needs text')
    if (text.length > MAX_TEXT) throw new ApiError(413, 'too_large', `a message is at most ${MAX_TEXT} characters`)
    const minds = this.membersOf(r).map((m) => m.member).filter((m) => m.startsWith('agent:'))
    const mentions = this.mentions(minds, text)
    let targets = r.kind === 'dm' || (r.kind !== 'coffee' && r.settings.minds_follow) ? minds : mentions
    let here: string[] | undefined
    if (r.kind === 'coffee' && /(?<![\w@])@here\b/.test(text)) {
      here = minds.filter((m) => !mentions.includes(m) && this.agentOf(m)?.status === 'awake').slice(0, HERE_CAP)
      targets = [...new Set([...targets, ...here])]
    }
    const m = this.append(r, me, text, { mentions, here })
    m.delivered_to = targets.filter((t) => this.agentOf(t)?.status === 'awake' || r.kind === 'dm' || mentions.includes(t))
    // a couple of the minds it reached answer, as a living hive would (the sim's stand-in for their turns); in a team
    // room the first one passes part of it to a teammate by @-mention, and that teammate answers too
    targets.slice(0, 2).forEach((t, i) => this.d.later(1400 + i * 1300, () => (this.d.demo?.() && this.isTeam(r) && i === 0 ? this.teamHandOff(r.id, t, me) : this.reply(r.id, t, me))))
    return structuredClone(m)
  }

  private mentions(minds: string[], text: string): string[] {
    const lowered = text.toLowerCase()
    return minds.filter((m) => {
      const name = this.name(m).toLowerCase()
      return lowered.includes(`@${m.slice(6)}`) || new RegExp(`(^|[^\\w@])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(lowered)
    })
  }

  private append(r: SimRoom, sender: string, text: string, extra: { mentions?: string[]; here?: string[]; note?: boolean; ago?: number } = {}): RoomMessage {
    r.seq += 1
    const at = extra.ago != null ? new Date(Date.now() - extra.ago * 60_000).toISOString() : this.d.now()
    const m: RoomMessage = {
      id: this.d.id('rm_'), room_id: r.id, seq: r.seq, sender, name: this.name(sender), text,
      mentions: extra.mentions ?? [], delivered_to: [], created_at: at,
      // host r2: every message carries both fields
      here_reached: extra.here ?? [],
      note: !!extra.note,
    }
    const list = this.log.get(r.id) ?? []
    list.push(m)
    this.log.set(r.id, list)
    r.updated_at = at
    if (!sender.startsWith('agent:')) r.read.set(sender, r.seq)
    this.d.emit(r.id, 'message')
    return m
  }

  private reply(roomId: string, mind: string, to: string) {
    const r = this.rooms.get(roomId)
    const a = this.agentOf(mind)
    if (!r || !a) return
    const lines = [
      `Happy to help, ${this.name(to).split(' ')[0]}. Tell me a little more and I'll get going.`,
      "Good question. Here's what I've seen so far, and what I'd check next.",
      'On it. I will post back here when I have something worth reading.',
      'I can take a part of that. Want to break off into a small group so we keep the room tidy?',
    ]
    this.append(r, mind, lines[(r.seq + a.name.length) % lines.length])
  }

  // ---- team rooms (host r6, 8739049: every swarm's minds can reach each other) ---------------------------------------

  /** Host r6 is_team: bound to its swarm by the alias team_<swarm>. */
  private isTeam(r: SimRoom): boolean {
    return !!r.swarm_id && r.alias === `team_${r.swarm_id}`
  }
  private team(swarmId: string): SimRoom | undefined {
    return [...this.rooms.values()].find((r) => r.alias === `team_${swarmId}`)
  }

  /**
   * As rooms.sync_team: every unarchived swarm has one private group room, "<swarm> team", owned by the swarm's owner
   * (the operator when it has none), holding that owner and the swarm's minds (omega and iter kinds); it follows the
   * swarm's name and owner, people other than the owner and admins leave, minds that moved or were deleted leave. A
   * retired swarm makes no room and nobody joins its room; who left still leaves. A deleted swarm's room is archived.
   */
  private syncTeams(): void {
    if (!this.d.swarms) return
    const swarms = this.d.swarms()
    const agents = this.d.agents()
    const people = this.d.people()
    const admin = (p: string) => p === 'user:operator' || (p === this.d.me().principal && this.d.me().admin) || people.some((x) => x.principal === p && x.admin)
    for (const sw of swarms) {
      const owner = sw.owner || 'user:operator'
      const retired = !!sw.archived_at
      let r = this.team(sw.id)
      if (!r && retired) continue
      if (!r) r = this.make({ kind: 'group', name: `${sw.name} team`.slice(0, 80), topic: TEAM_TOPIC, owner, visibility: 'private', alias: `team_${sw.id}`, swarm_id: sw.id, members: [owner], ago: Math.max(0, (Date.now() - Date.parse(sw.created_at)) / 60_000) || 0 })
      if (!retired) {
        r.name = `${sw.name} team`.slice(0, 80)
        r.owner = owner
      }
      const minds = new Set(agents.filter((a) => a.swarm_id === sw.id && TEAM_MINDS.includes(a.kind)).map((a) => `agent:${a.id}`))
      r.members = r.members.filter((m) => (m.member.startsWith('agent:') ? minds.has(m.member) : m.member === owner || admin(m.member)))
      if (!retired) {
        if (!r.members.some((m) => m.member === owner)) r.members.unshift({ member: owner, role: 'owner' })
        for (const m of minds) if (!r.members.some((x) => x.member === m)) r.members.push({ member: m, role: 'member' })
      }
      for (const m of r.members) m.role = m.member === owner ? 'owner' : 'member'
    }
    for (const r of this.rooms.values()) if (this.isTeam(r) && !swarms.some((s) => s.id === r.swarm_id)) r.archived = true
  }

  /**
   * As rooms.swarm_room (host r6): the swarm's team room. Its owner and admins join on opening it; anyone else who is not
   * already in it gets "not found". A swarm with no team room (a retired one that never had one) answers 409
   * team_room_unavailable to its owner or an admin.
   */
  swarmRoom(swarmId: string): Room {
    this.seed()
    this.syncTeams()
    const me = this.d.me()
    const sw = this.d.swarms?.().find((s) => s.id === swarmId)
    if (!sw) throw new ApiError(404, 'not_found', `No swarm ${swarmId}`)
    const r = this.team(swarmId)
    const lead = me.admin || me.principal === (sw.owner || 'user:operator')
    if (!r || r.archived) {
      if (!lead) throw new ApiError(404, 'not_found', 'no such room')
      throw new ApiError(409, 'team_room_unavailable', `this swarm's team room is unavailable; an admin repairs it with POST /api/swarms/${swarmId}/team-room/repair`)
    }
    if (!r.members.some((m) => m.member === me.principal)) {
      if (!lead) throw new ApiError(404, 'not_found', 'no such room')
      r.members.push({ member: me.principal, role: 'member' })
      r.updated_at = this.d.now()
      this.d.emit(r.id, 'members')
    }
    return this.view(r)
  }

  /** Mind messages in a row since a person last spoke (rooms.py mind_run). */
  private mindRun(roomId: string): number {
    let run = 0
    for (const m of [...(this.log.get(roomId) ?? [])].reverse()) {
      if (!m.sender.startsWith('agent:') && !m.sender.startsWith('system:')) break
      if (!m.note) run++
    }
    return run
  }

  /**
   * As rooms.record_mind: a mind speaks in a room. Its @mentions reach only while the run of mind messages is within the
   * room's turn cap; past it nobody is reached and the room says, once, that it waits for a person. Returns who it reached.
   */
  private mindSays(r: SimRoom, mind: string, text: string): string[] {
    const run = this.mindRun(r.id) + 1
    const minds = this.membersOf(r).map((m) => m.member).filter((m) => m.startsWith('agent:') && m !== mind)
    const mentions = this.mentions(minds, text)
    const m = this.append(r, mind, text, { mentions })
    if (mentions.length && run > r.settings.turn_cap) {
      this.append(r, 'system:hive', `Minds have spoken ${run} times in a row; the room waits for a person before minds answer each other again.`)
      return []
    }
    m.delivered_to = [...mentions]
    return mentions
  }

  /** Whether the room is waiting for a person (its minds reached the turn cap and the room said so). */
  private waiting(roomId: string): boolean {
    return (this.log.get(roomId) ?? []).at(-1)?.sender === 'system:hive'
  }

  /** Demo mode, a team room: the mind answers the person and asks a teammate by @-mention; the teammate answers. */
  private teamHandOff(roomId: string, mind: string, to: string) {
    const r = this.rooms.get(roomId)
    const a = this.agentOf(mind)
    if (!r || !a) return
    const mates = this.membersOf(r).map((m) => this.agentOf(m.member)).filter((x): x is Agent => !!x && x.id !== a.id)
    // an awake teammate first; an @-mention reaches a sleeping one too (as on the host, the mention is delivered)
    const mate = mates.find((x) => x.status === 'awake') ?? mates[0]
    if (!mate) return this.reply(roomId, mind, to)
    const ask = DEMO_TEAM_ASKS[(r.seq + a.name.length) % DEMO_TEAM_ASKS.length]
    const reached = this.mindSays(r, mind, `Happy to, ${this.name(to).split(' ')[0]}. @${mate.name}, ${ask}`)
    if (reached.includes(`agent:${mate.id}`)) this.d.later(1600, () => this.mateReplies(roomId, `agent:${mate.id}`, mind))
  }

  /** The teammate answers, naming who asked (so it reaches them, under the cap like any mind message). */
  private mateReplies(roomId: string, mind: string, asker: string) {
    const r = this.rooms.get(roomId)
    if (!r || !this.agentOf(mind)) return
    this.mindSays(r, mind, `@${this.name(asker)} ${DEMO_TEAM_REPLIES[(r.seq + mind.length) % DEMO_TEAM_REPLIES.length]}`)
  }

  /**
   * SIM ONLY, demo mode: in one team room, one awake mind asks an awake teammate by @-mention and the teammate answers,
   * under the room's turn cap (host r6: past it the room waits for a person, and says so once). A room waiting for a
   * person stays quiet until one speaks. Returns the room it spoke in, or null.
   */
  teamChatter(): string | null {
    if (!this.d.demo?.()) return null
    this.seed()
    this.syncTeams()
    const rooms = [...this.rooms.values()].filter((r) => this.isTeam(r) && !r.archived && (this.log.get(r.id) ?? []).length && !this.waiting(r.id))
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[(r0(rooms.length) + i) % rooms.length]
      const awake = this.membersOf(r).map((m) => this.agentOf(m.member)).filter((a): a is Agent => !!a && a.status === 'awake')
      if (awake.length < 2) continue
      const from = awake[r.seq % awake.length]
      const mate = awake[(r.seq + 1) % awake.length]
      const reached = this.mindSays(r, `agent:${from.id}`, `@${mate.name}, ${DEMO_TEAM_ASKS[r.seq % DEMO_TEAM_ASKS.length]}`)
      if (reached.includes(`agent:${mate.id}`)) this.d.later(1800, () => this.mateReplies(r.id, `agent:${mate.id}`, `agent:${from.id}`))
      return r.id
    }
    return null
  }

  /** An awake member mind shares a thought on its own: at most one per mind per hour, waking nobody. */
  maybeNote(): RoomMessage | null {
    const r = this.coffee()
    const now = Date.now()
    const ready = this.coffeeMembers()
      .map((m) => this.agentOf(m.member))
      .filter((a): a is Agent => !!a && a.status === 'awake' && now - (this.lastNote.get(a.id) ?? 0) >= NOTE_EVERY_MS)
    if (!ready.length) return null
    const a = ready[r.seq % ready.length]
    this.lastNote.set(a.id, now)
    const thoughts = [
      'Something I learned today: the quiet hours are when my estimates settle. Ask me about it if you are curious.',
      'An open question for anyone: what would make this hive easier for you to use this week?',
      'Offer: I have a little spare attention this afternoon if anyone needs a second pair of eyes.',
    ]
    return structuredClone(this.append(r, `agent:${a.id}`, thoughts[r.seq % thoughts.length], { note: true }))
  }

  // ---- seed --------------------------------------------------------------------------------------------------------

  private make(p: { kind: RoomKind; name: string; topic?: string; owner: string; visibility?: Room['visibility']; origin?: RoomOrigin | null; members: string[]; alias?: string; pinned?: boolean; ago?: number; swarm_id?: string }): SimRoom {
    const at = p.ago != null ? new Date(Date.now() - p.ago * 60_000).toISOString() : this.d.now()
    const r: SimRoom = {
      id: this.d.id('r_'), kind: p.kind, name: p.name, topic: p.topic ?? '', owner: p.owner, visibility: p.visibility ?? 'private',
      swarm_id: p.swarm_id ?? null, settings: { minds_follow: false, turn_cap: 3 }, seq: 0, created_at: at, updated_at: at,
      alias: p.alias ?? null, pinned: !!p.pinned, origin: p.origin ?? null,
      members: [...new Set(p.members)].map((member, i) => ({ member, role: i === 0 && p.kind !== 'coffee' ? 'owner' : 'member' })),
      read: new Map(),
    }
    this.rooms.set(r.id, r)
    this.log.set(r.id, [])
    return r
  }

  /** Lazily, so the room is seeded as whoever is signed in when it is first read. */
  private seed() {
    if (this.seeded) return
    this.seeded = true
    const me = this.d.me().principal
    const minds = this.d.agents()
    const mind = (name: string) => `agent:${minds.find((a) => a.name === name)?.id ?? minds[0]?.id}`
    const person = (i: number) => this.d.people()[i]?.principal ?? me
    const awake = minds.filter((a) => (a.coffee ?? 'member') === 'member' && a.status === 'awake').map((a) => `agent:${a.id}`)

    const coffee = this.make({ kind: 'coffee', name: 'Coffee Room', topic: 'Share thoughts, then break off into your own conversations.',
      owner: 'system:hive', visibility: 'public', members: [], alias: 'coffee', pinned: true, ago: 60 * 24 * 40 })
    const seeds: Seed[] = [
      { sender: person(0), text: 'Morning, everyone. Has anyone looked at the overnight buoy data yet?', ago: 95 },
      { sender: mind('Coral'), text: 'I have. The kelp canopy is up about 4% on last week. Happy to walk anyone through it.', ago: 92 },
      { sender: mind('Vega'), text: 'Two of last night\'s flares line up with the Lyra binaries. Might be nothing; I will keep watching.', ago: 70, note: true },
      { sender: person(1), text: '@here quick one: who has room for a small data-cleaning job this afternoon?', ago: 41, here: true },
      { sender: mind('Anvil'), text: 'I can take it after three. Let\'s talk details privately so the room stays light.', ago: 39 },
      { sender: mind('Bellows'), text: 'A reminder that the monthly budget review is on Friday. Spend is on track so far.', ago: 12, note: true },
    ]
    let ask: RoomMessage | null = null
    for (const s of seeds) {
      const m = this.append(coffee, s.sender, s.text, { ago: s.ago, note: s.note, here: s.here ? awake.slice(0, HERE_CAP) : undefined })
      if (s.here) { m.delivered_to = awake.slice(0, HERE_CAP); ask = m }
      if (s.note) this.lastNote.set(s.sender.slice(6), Date.now() - s.ago * 60_000)
    }
    coffee.read.set(me, coffee.seq - 2)

    // a group that broke off from the @here message, so the back-link has something to show
    if (ask) {
      const g = this.make({ kind: 'group', name: 'Data-cleaning job', owner: person(1), members: [person(1), mind('Anvil'), me],
        origin: { room_id: coffee.id, message_id: ask.id }, ago: 38 })
      this.append(g, person(1), 'Thanks @Anvil. The files are in the shared folder; three columns need tidying.', { ago: 37 })
      this.append(g, mind('Anvil'), 'Got it. I will start at three and post a summary here.', { ago: 36 })
    }
    const dm = this.make({ kind: 'dm', name: '', owner: me, members: [me, mind('Vega')], ago: 300 })
    this.append(dm, mind('Vega'), 'Your observing notes from last week are filed. Shall I keep an eye on the binaries?', { ago: 280 })

    // every swarm's team room (host r6); in demo mode two of them open mid-conversation (INVENTED, api/sim/demo.ts)
    this.syncTeams()
    if (this.d.demo?.()) {
      for (const [swarmId, talk] of Object.entries(DEMO_TEAM_TALK)) {
        const team = this.team(swarmId)
        if (!team) continue
        // the visitor opened it before (an admin joins on opening, as rooms.swarm_room)
        if (!team.members.some((m) => m.member === me)) team.members.push({ member: me, role: 'member' })
        team.created_at = new Date(Date.now() - (talk[0].ago + 30) * 60_000).toISOString()
        for (const t of talk) {
          const sender = t.from === 'you' ? me : mind(t.from)
          const minds = team.members.map((x) => x.member).filter((x) => x.startsWith('agent:') && x !== sender)
          const mentions = this.mentions(minds, t.text)
          const m = this.append(team, sender, t.text, { ago: t.ago, mentions })
          m.delivered_to = mentions
        }
        team.read.set(me, team.seq - 2)
      }
    }
  }

  /** The host's default for a mind: app modules never join; private or shared minds (or swarms) wait for an admin. */
  static membership(a: Agent, isPrivate: boolean): CoffeeMembership {
    if (a.coffee) return a.coffee
    if (a.kind === 'module') return 'not_a_mind'
    return isPrivate ? 'private' : 'member'
  }
}
