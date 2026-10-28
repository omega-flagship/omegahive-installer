import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PlainText } from '../../ui/Belief'
import type { Person } from '../../api/client'
import type { Room, RoomKind, RoomMessage, WorkSession } from '../../api/types'
import { SessionView } from './SessionView'
import { askThreadTitle } from './sessionTitle'
import { useAskStore } from '../../store/ask'
import { BreakOff, CoffeeListEntry, CoffeeMark, CoffeePublicNote, HereHint, HereReached, NoteBody, OriginBackLink, StartGroup, useFocusMessage } from './CoffeeParts'
import { COFFEE_NAME, LINK_MISSING, coffeeSubtitle, heardBy, linkState, withDirect, isCoffee, isNote, memberName, roomMatches, roomSections } from './coffee'
import { useMe } from '../../lib/useAdmin'
import { cx } from '../../lib/cx'
import { shown } from '../../lib/displayName'
import { useEscape, useIsDesktop } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { hiveBus, useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import type { IconName } from '../../ui/iconPaths'
import { Page } from '../../ui/Page'
import { Button, EmptyState, ErrorState, IconButton, Segmented, Switch } from '../../ui/primitives'
import { useModalContainment } from '../../ui/useModalContainment'
import { plural } from '../../lib/plural'
import { guardComposing } from '../../features/ask/keys'

/** R15 Messages: DMs, groups, channels and projects with minds and people, one room model underneath.
 *  A room can change kind (keeping its history), become a swarm, or be a swarm's own room. */

const KIND_LABEL: Record<RoomKind, string> = { coffee: 'Coffee Room', session: 'Sessions', dm: 'Direct', group: 'Groups', channel: 'Channels', project: 'Projects' }
const KIND_ICON: Record<RoomKind, IconName> = { coffee: 'coffee', session: 'terminal', dm: 'chat', group: 'people', channel: 'wave', project: 'target' }
const kindLabel = (k: string): string => KIND_LABEL[k as RoomKind] ?? k
const kindIcon = (k: string): IconName => KIND_ICON[k as RoomKind] ?? 'chat'

function roomTitle(r: Room): string {
  if (isCoffee(r)) return r.name || COFFEE_NAME
  if (r.kind !== 'dm') return shown(r.name)
  const others = r.members.filter((m) => m.member !== r.me)
  return others.map((m) => shown(memberName(m, r.me))).join(', ') || 'Direct message'
}

function time(iso: string): string {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function MessagesPage({ room: roomId, message: focusId }: { room?: string; message?: string }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const desktop = useIsDesktop()
  const [rooms, setRooms] = useState<Room[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)

  const supported = !!client?.rooms
  const [sessions, setSessions] = useState<WorkSession[]>([])
  // j0-fixes r1 item 6: an Ask thread's row names its mind, first words and time (sessionTitle.ts); the first words
  // only when this page holds that thread (the Ask's own), nothing fetched or guessed for the others
  const askThread = useAskStore((s) => s.thread?.id ?? null)
  const askFirst = useAskStore((s) => {
    const first = s.log.find((e) => e.kind === 'turn')
    return first?.kind === 'turn' ? s.turns[first.op]?.you ?? null : null
  })
  const askRow = useCallback((r: Room) => {
    const se = sessions.find((x) => x.room_id === r.id)
    return askThreadTitle(r, se, se && se.id === askThread ? askFirst : null)
  }, [sessions, askThread, askFirst])
  const load = useCallback(() => {
    if (!client?.rooms) return
    client.rooms().then((r) => { setRooms(r); setError(null) }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
    void client.sessions?.().then(setSessions).catch(() => undefined)
  }, [client])
  useEffect(() => { load() }, [load])
  useEffect(() => hiveBus.on((e) => { if (e.type === 'room') load() }), [load])

  // a room the list does not carry (or not yet), e.g. #/messages/coffee: loaded directly (GET /api/rooms/{id or alias}),
  // refreshed on the same room events as the list and shown in the list too, so the pinned entry and the open room are
  // one record. A room the host refuses is said plainly, never a blank pane (Kimi r2 #1, #4).
  const [direct, setDirect] = useState<{ id: string; room: Room | null; failed: boolean } | null>(null)
  const inList = rooms?.find((r) => roomMatches(r, roomId)) ?? null
  const [tick, setTick] = useState(0)
  useEffect(() => hiveBus.on((e) => { if (e.type === 'room') setTick((n) => n + 1) }), [])
  useEffect(() => {
    if (!roomId || inList || !rooms || !client?.room) return
    let live = true
    client.room(roomId)
      .then((r) => { if (live) setDirect({ id: roomId, room: r, failed: false }) })
      .catch(() => { if (live) setDirect({ id: roomId, room: null, failed: true }) })
    return () => { live = false }
  }, [client, roomId, inList, rooms, tick])
  const directRoom = direct && direct.id === roomId && direct.room && roomMatches(direct.room, roomId) ? direct.room : null
  const roomFailed = !inList && !!direct && direct.id === roomId && direct.failed
  const shownRooms = withDirect(rooms, directRoom)
  const room = inList ?? directRoom
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (shownRooms ?? []).filter((r) => !q || `${askRow(r)?.title ?? roomTitle(r)} ${r.topic}`.toLowerCase().includes(q))
  }, [shownRooms, query, askRow])
  const { pinned, sections } = roomSections(filtered)

  const list = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-1 pb-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations"
          aria-label="Search conversations"
          className="min-h-10 min-w-0 flex-1 rounded-xl border border-line bg-black/25 px-3 text-[13.5px] text-ink outline-none focus:border-line-2"
        />
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)} className="min-h-10 px-3 text-[13px]">
          New
        </Button>
      </div>
      <div className="thin-scroll min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {pinned.length > 0 && (
          <section aria-label="Pinned">
            <ul className="space-y-1">
              {pinned.map((r) => (
                <li key={r.id}>
                  {isCoffee(r) ? (
                    <CoffeeListEntry room={r} active={!!room && room.id === r.id} onOpen={() => navigate({ name: 'messages', room: r.id })} />
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        )}
        {sections.map(({ kind, items }) => {
          return (
            <section key={kind} aria-label={kindLabel(kind)}>
              <h3 className="px-2 pb-1 text-[11.5px] font-medium tracking-wide text-ink-3 uppercase">{kindLabel(kind)}</h3>
              <ul className="space-y-0.5">
                {items.map((r) => (
                  <li key={r.id}>
                    <button
                      onClick={() => navigate({ name: 'messages', room: r.id })}
                      aria-current={r.id === room?.id ? 'page' : undefined}
                      className={cx(
                        'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors',
                        r.id === room?.id ? 'bg-white/[0.08] text-ink' : 'text-ink-2 hover:bg-white/[0.05]',
                      )}
                    >
                      <Icon name={kindIcon(r.kind)} size={16} className="shrink-0 text-ink-3" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium">{askRow(r)?.title ?? roomTitle(r)}</span>
                        <span className="block truncate text-[11.5px] text-ink-4">
                          {askRow(r)?.ended ? 'ended · ' : ''}
                          {r.joined === false ? 'Not joined · ' : ''}
                          {r.swarm_id ? 'Swarm room · ' : ''}
                          {r.members.length} member{r.members.length === 1 ? '' : 's'}
                        </span>
                      </span>
                      {!!r.unread && (
                        <span className="rounded-full bg-accent-2/20 px-1.5 text-[11px] font-semibold text-accent-2">{r.unread}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
        {rooms && !filtered.length && (
          <p className="px-2 text-[13px] text-ink-4">{query ? 'Nothing matches.' : 'No conversations yet. Start one with New.'}</p>
        )}
        {!rooms && !error && <p className="px-2 text-[13px] text-ink-4">Loading…</p>}
      </div>
    </div>
  )

  return (
    <Page title="Messages" eyebrow="Talk with minds and people" label="Messages">
      <div className="flex h-full min-h-0 gap-4 px-3 pb-3 md:px-6 md:pb-5">
        {!supported ? (
          <div className="flex-1">
            <EmptyState icon="ban" title="Not available here" body="This hive does not offer messages yet." />
          </div>
        ) : error ? (
          <div className="flex-1">
            <ErrorState title="Could not load conversations" body={error} onRetry={load} />
          </div>
        ) : desktop ? (
          <>
            <aside className="w-72 shrink-0">{list}</aside>
            <div className="min-w-0 flex-1 rounded-2xl border border-line bg-white/[0.02]">
              {room ? (
                <RoomBody room={room} rooms={shownRooms ?? []} focus={focusId} sessions={sessions} onChanged={load} />
              ) : roomFailed ? (
                <Unavailable focus={focusId} />
              ) : (
                <EmptyState icon="chat" title="Pick a conversation" body="Or start a new DM, group or channel with New. Minds only hear messages that @mention them, so talking costs nothing until you ask one." />
              )}
            </div>
          </>
        ) : room ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <button onClick={() => navigate({ name: 'messages' })} className="mb-2 flex items-center gap-1 self-start text-[13px] text-ink-3 hover:text-ink">
              <Icon name="back" size={14} /> All conversations
            </button>
            <div className="min-h-0 flex-1 rounded-2xl border border-line bg-white/[0.02]">
              <RoomBody room={room} rooms={shownRooms ?? []} focus={focusId} sessions={sessions} onChanged={load} />
            </div>
          </div>
        ) : roomFailed ? (
          <div className="min-h-0 flex-1"><Unavailable focus={focusId} /></div>
        ) : (
          <div className="min-h-0 flex-1">{list}</div>
        )}
      </div>
      {creating && (
        <NewRoom
          onClose={() => setCreating(false)}
          onCreated={(id, kind) => {
            setCreating(false)
            load()
            navigate({ name: 'messages', room: id })
            toast({ tone: 'success', title: kind === 'dm' ? 'Conversation opened' : `${KIND_LABEL[kind].replace(/s$/, '')} started` })
          }}
        />
      )}
    </Page>
  )
}

/** A linked room the host won't show (gone, or not visible to this person). */
function Unavailable({ focus }: { focus?: string }) {
  const state = linkState({ message: focus, roomFailed: true, loaded: true, messageIds: [] })
  return (
    <div role="status">
      <EmptyState icon="ban" title={state === 'missing-room' ? "That message isn't available" : "That conversation isn't available"}
        body={state === 'missing-room' ? LINK_MISSING['missing-room'] : 'It may have been removed, or you are not in it.'} />
    </div>
  )
}

function RoomBody({ room, rooms, focus, sessions, onChanged }: { room: Room; rooms: Room[]; focus?: string; sessions: WorkSession[]; onChanged: () => void }) {
  if (room.kind === 'session') {
    const session = sessions.find((x) => x.room_id === room.id)
    return session ? <SessionView key={room.id} sessionId={session.id} roomId={room.id} /> : <p className="p-6 text-[13px] text-ink-4">Loading the session…</p>
  }
  return <Conversation key={room.id} room={room} rooms={rooms} focus={focus} onChanged={onChanged} />
}

function Conversation({ room, rooms, focus, onChanged }: { room: Room; rooms: Room[]; focus?: string; onChanged: () => void }) {
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const toast = useHive((s) => s.toast)
  const [messages, setMessages] = useState<RoomMessage[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [panel, setPanel] = useState<null | 'members' | 'settings'>(null)
  const [grouping, setGrouping] = useState<RoomMessage | null>(null)
  const { admin } = useMe()
  const coffee = isCoffee(room)
  const [loaded, setLoaded] = useState(false)
  useFocusMessage(focus, loaded && messages.some((m) => m.id === focus))
  const link = linkState({ message: focus, roomFailed: false, loaded, messageIds: messages.map((m) => m.id) })
  const scroller = useRef<HTMLDivElement>(null)
  const last = messages.length ? messages[messages.length - 1].seq : 0

  const fetchNew = useCallback(
    (after: number) => {
      if (!client?.roomMessages) return
      void client.roomMessages(room.id, after).then((rows) => {
        setLoaded(true)
        if (rows.length) setMessages((ms) => [...ms, ...rows.filter((r) => !ms.some((m) => m.id === r.id))])
      }).catch(() => undefined)
    },
    [client, room.id],
  )
  useEffect(() => { fetchNew(0) }, [fetchNew])
  const lastRef = useRef(0)
  useEffect(() => { lastRef.current = last }, [last])
  useEffect(() => hiveBus.on((e) => { if (e.type === 'room' && e.room_id === room.id) fetchNew(lastRef.current) }), [room.id, fetchNew])
  // a linked message keeps the reader where it is; otherwise the newest is in view
  useEffect(() => { if (!focus) scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [messages.length, focus])

  // @mention suggestions: members whose name starts with what follows the last @
  const at = /@([\w.-]*)$/.exec(text)
  const suggestions = at ? room.members.filter((m) => m.member !== room.me && shown(memberName(m)).toLowerCase().startsWith(at[1].toLowerCase())).slice(0, 6) : []
  const pick = (m: { member: string; name: string }) => setText((t) => t.replace(/@([\w.-]*)$/, `@${memberName(m).replace(/\s+/g, '')} `))

  const send = async () => {
    const body = text.trim()
    if (!body || !client?.postRoomMessage) return
    setSending(true)
    try {
      const m = await client.postRoomMessage(room.id, body)
      setText('')
      setMessages((ms) => (ms.some((x) => x.id === m.id) ? ms : [...ms, m]))
    } catch (e) {
      toast({ tone: 'error', title: 'Message not sent', body: e instanceof Error ? e.message : String(e) })
    } finally {
      setSending(false)
    }
  }

  const minds = room.members.filter((m) => m.member.startsWith('agent:'))
  const hint = room.kind === 'dm' && minds.length
    ? `${shown(minds[0].name)} hears every message here.`
    : room.settings.minds_follow
      ? 'Every mind here hears every message (minds follow is on).'
      : minds.length
        ? 'Minds hear only messages that @mention them.'
        : ''

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        {coffee ? <CoffeeMark size={16} /> : <Icon name={kindIcon(room.kind)} size={18} className="text-ink-3" />}
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-[16px] font-semibold">{roomTitle(room)}</h2>
          <p className="truncate text-[12px] text-ink-3">
            {coffee ? coffeeSubtitle(room) : <>{room.kind === 'dm' ? 'Direct message' : kindLabel(room.kind).replace(/s$/, '')} · {plural(room.members.length, 'member')}</>}
            {room.topic ? ` · ${room.topic}` : ''}
          </p>
        </div>
        {room.swarm_id && (
          <Button variant="ghost" icon="swarms" onClick={() => navigate({ name: 'swarm', id: room.swarm_id! })} className="min-h-9 px-2.5 text-[12.5px]">
            Swarm
          </Button>
        )}
        <IconButton icon="people" label="Members" onClick={() => setPanel(panel === 'members' ? null : 'members')} active={panel === 'members'} />
        {(!coffee || admin) && (
          <IconButton icon="rules" label="Room settings" onClick={() => setPanel(panel === 'settings' ? null : 'settings')} active={panel === 'settings'} />
        )}
      </header>
      {coffee && <CoffeePublicNote />}
      {link === 'missing-message' && (
        <p role="status" className="mx-4 mt-3 rounded-xl border border-line px-3 py-2 text-[12.5px] text-ink-2">{LINK_MISSING['missing-message']}</p>
      )}
      <OriginBackLink room={room} rooms={rooms} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scroller} className="thin-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-live="polite" data-tour="room-messages">
            {!messages.length && <p className="pt-6 text-center text-[13px] text-ink-4">No messages yet. {hint}</p>}
            {messages.map((m) => {
              const mine = m.sender === room.me
              const agent = m.sender.startsWith('agent:') ? agents[m.sender.slice(6)] : undefined
              const note = coffee && isNote(m)
              return (
                <div key={m.id} id={`msg-${m.id}`} tabIndex={-1}
                  className={cx('coffee-msg group/msg flex flex-col rounded-2xl outline-none', mine ? 'items-end' : 'items-start')}>
                  {note ? (
                    <><NoteBody message={m} /><span className="mt-0.5 text-[11px] text-ink-4">{time(m.created_at)}</span></>
                  ) : (<>
                  <div className="mb-0.5 flex items-baseline gap-2 text-[11.5px] text-ink-3">
                    {!mine && <span className="font-medium" style={agent ? { color: `hsl(${agent.hue} 90% 72%)` } : undefined}>{shown(coffee ? memberName({ member: m.sender, name: m.name }, room.me) : m.name)}</span>}
                    <span>{time(m.created_at)}</span>
                  </div>
                  <p
                    className={cx(
                      'max-w-[85%] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap',
                      mine ? 'bg-accent/25 text-ink' : 'border border-line bg-white/[0.04] text-ink',
                    )}
                  >
                    <PlainText text={m.text} />
                  </p>
                  {mine && (coffee ? heardBy(m) : m.delivered_to).length > 0 && (
                    <span className="mt-0.5 text-[11px] text-ink-4">
                      heard by {(coffee ? heardBy(m) : m.delivered_to).map((d) => shown(memberName({ member: d, name: room.members.find((x) => x.member === d)?.name }, room.me))).join(', ')}
                    </span>
                  )}
                  <HereReached message={m} room={room} />
                  </>)}
                  {coffee && <BreakOff message={m} room={room} onGroup={setGrouping} />}
                </div>
              )
            })}
          </div>
          <div className="relative border-t border-line p-3">
            {suggestions.length > 0 && (
              <ul className="glass-strong absolute bottom-full left-3 mb-1 w-64 rounded-xl !bg-[#0b0b22]/[0.97] p-1" role="listbox" aria-label="Mention">
                {suggestions.map((m) => (
                  <li key={m.member}>
                    <button onClick={() => pick(m)} className="w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink-2 hover:bg-white/[0.06] hover:text-ink">
                      @{shown(m.name)} <span className="text-ink-4">{m.member.startsWith('agent:') ? 'mind' : 'person'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {room.joined === false ? (
              <Button
                variant="primary"
                className="w-full"
                onClick={async () => {
                  if (!client?.addRoomMembers || !room.me) return
                  try { await client.addRoomMembers(room.id, [room.me]); onChanged() } catch (e) { toast({ tone: 'error', title: 'Could not join', body: String(e) }) }
                }}
              >
                Join this channel
              </Button>
            ) : (
              <div className="flex items-end gap-2">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    // an IME's confirming Enter belongs to the input method (features/ask/keys; r2.4 sweep)
                    if (guardComposing(e)) return
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
                  }}
                  rows={1}
                  placeholder={room.kind === 'dm' ? `Message ${roomTitle(room)}…` : coffee ? 'Say something to everyone…' : 'Message the room… (@ to mention)'}
                  aria-label="Message"
                  className="max-h-40 min-h-11 min-w-0 flex-1 resize-none rounded-xl border border-line bg-black/25 px-3 py-2.5 text-[14px] text-ink outline-none focus:border-line-2"
                />
                <IconButton icon="send" label="Send" onClick={() => void send()} disabled={sending || !text.trim()} className="bg-accent/30" />
              </div>
            )}
            {coffee ? <HereHint room={room} text={text} /> : hint && room.joined !== false && <p className="mt-1.5 text-[11.5px] text-ink-4">{hint}</p>}
          </div>
        </div>
        {panel && (
          <aside className="thin-scroll w-72 shrink-0 overflow-y-auto border-l border-line p-4 max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-10 max-md:w-[85%] max-md:!bg-[#0b0b22]/[0.98]">
            {panel === 'members' ? <Members room={room} onChanged={onChanged} /> : coffee ? <CoffeeSettings room={room} onChanged={onChanged} /> : <Settings room={room} onChanged={onChanged} />}
          </aside>
        )}
      </div>
      {grouping && <StartGroup message={grouping} room={room} onClose={() => setGrouping(null)} />}
    </div>
  )
}

function Members({ room, onChanged }: { room: Room; onChanged: () => void }) {
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const toast = useHive((s) => s.toast)
  const [adding, setAdding] = useState('')
  const coffee = isCoffee(room)
  const fixed = room.kind === 'dm' || coffee
  const candidates = Object.values(agents).filter((a) => !room.members.some((m) => m.member === `agent:${a.id}`))
  const run = async (fn: () => Promise<unknown>, what: string) => {
    try { await fn(); onChanged() } catch (e) { toast({ tone: 'error', title: `Could not ${what}`, body: e instanceof Error ? e.message : String(e) }) }
  }
  return (
    <div className="space-y-3">
      <h3 className="eyebrow">Members</h3>
      <ul className="space-y-1">
        {room.members.map((m) => (
          <li key={m.member} className="flex items-center gap-2 text-[13px]">
            <Icon name={m.member.startsWith('agent:') ? 'mind' : 'user'} size={14} className="text-ink-3" />
            <span className="min-w-0 flex-1 truncate">{shown(coffee ? memberName(m) : m.name)}{m.member === room.me ? ' (you)' : ''}</span>
            {m.role === 'owner' && <span className="text-[11px] text-ink-4">owner</span>}
            {!fixed && m.role !== 'owner' && (
              <button className="text-[11.5px] text-ink-4 hover:text-bad" onClick={() => void run(() => client!.removeRoomMember!(room.id, m.member), 'remove them')}>
                {m.member === room.me ? 'Leave' : 'Remove'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {!fixed && candidates.length > 0 && (
        <div className="flex gap-2">
          <select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Add a mind"
            className="min-h-9 min-w-0 flex-1 rounded-xl border border-line bg-black/25 px-2 text-[13px] text-ink">
            <option value="">Add a mind…</option>
            {candidates.map((a) => <option key={a.id} value={a.id} className="bg-[#0b0b22]">{shown(a.name)}</option>)}
          </select>
          <Button variant="subtle" disabled={!adding} className="min-h-9 px-3 text-[12.5px]"
            onClick={() => void run(async () => { await client!.addRoomMembers!(room.id, [`agent:${adding}`]); setAdding('') }, 'add the mind')}>
            Add
          </Button>
        </div>
      )}
      {fixed && <p className="text-[12px] text-ink-4">{coffee ? 'Everyone in the hive is here automatically: every person, and every mind unless an admin took it out or it is private. An admin changes a mind\'s place from its settings.' : 'A DM is fixed to its two members. Turn it into a group in Settings to add more.'}</p>}
    </div>
  )
}

function Settings({ room, onChanged }: { room: Room; onChanged: () => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [name, setName] = useState(room.kind === 'dm' ? '' : room.name)
  const [move, setMove] = useState<string[]>([])
  const minds = room.members.filter((m) => m.member.startsWith('agent:'))
  const patch = async (body: Record<string, unknown>, what: string) => {
    try { await client!.updateRoom!(room.id, body); onChanged(); toast({ tone: 'success', title: what }) }
    catch (e) { toast({ tone: 'error', title: 'Not changed', body: e instanceof Error ? e.message : String(e) }) }
  }
  const kinds: { value: Exclude<RoomKind, 'dm'>; label: string }[] = [
    { value: 'group', label: 'Group' }, { value: 'channel', label: 'Channel' }, { value: 'project', label: 'Project' },
  ]
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="eyebrow">{room.kind === 'dm' ? 'Turn into a room' : 'Kind'}</h3>
        {room.kind === 'dm' ? (
          <>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name the room" aria-label="Room name"
              className="min-h-9 w-full rounded-xl border border-line bg-black/25 px-3 text-[13px] text-ink" />
            <Button variant="subtle" disabled={!name.trim()} className="min-h-9 w-full text-[12.5px]"
              onClick={() => void patch({ kind: 'group', name: name.trim() }, 'Now a group; history kept')}>Make it a group</Button>
          </>
        ) : (
          <Segmented<Exclude<RoomKind, 'dm'>> label="Room kind" value={room.kind as Exclude<RoomKind, 'dm'>} options={kinds} dense
            onChange={(k) => void patch({ kind: k }, `Now a ${k}; history kept`)} />
        )}
        <p className="text-[11.5px] text-ink-4">Changing kind keeps every member and the whole history. Channels can be found and joined by whoever may see them.</p>
      </section>
      {room.kind !== 'dm' && (
        <section className="space-y-2">
          <h3 className="eyebrow">Minds</h3>
          <Switch checked={room.settings.minds_follow} label="Every mind hears every message"
            onChange={(v) => void patch({ settings: { minds_follow: v } }, v ? 'Minds now follow every message' : 'Minds now hear only @mentions')} />
          <p className="text-[11.5px] text-ink-4">{room.settings.minds_follow ? 'On: each message can wake every mind here, and each one may cost a model call.' : 'Off: minds hear only messages that @mention them. Cheapest.'} Minds may answer each other at most {room.settings.turn_cap} times in a row before the room waits for a person.</p>
          <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
            Mind turns in a row
            <select value={room.settings.turn_cap} onChange={(e) => void patch({ settings: { turn_cap: Number(e.target.value) } }, 'Turn limit changed')}
              className="min-h-8 rounded-lg border border-line bg-black/25 px-2 text-ink">
              {[0, 1, 2, 3, 5, 8].map((n) => <option key={n} value={n} className="bg-[#0b0b22]">{n}</option>)}
            </select>
          </label>
        </section>
      )}
      {room.kind !== 'dm' && (
        <section className="space-y-2">
          <h3 className="eyebrow">Who can find it</h3>
          <select value={room.visibility} onChange={(e) => void patch({ visibility: e.target.value }, 'Visibility changed')} aria-label="Visibility"
            className="min-h-9 w-full rounded-xl border border-line bg-black/25 px-2 text-[13px] text-ink">
            <option value="private" className="bg-[#0b0b22]">Members only</option>
            <option value="shared" className="bg-[#0b0b22]">Shared with chosen people</option>
            <option value="public" className="bg-[#0b0b22]">Everyone in this hive</option>
          </select>
        </section>
      )}
      <section className="space-y-2">
        <h3 className="eyebrow">Swarm</h3>
        {room.swarm_id ? (
          <>
            <p className="text-[12.5px] text-ink-2">This room is a swarm's room.</p>
            <Button variant="subtle" icon="swarms" className="min-h-9 w-full text-[12.5px]" onClick={() => navigate({ name: 'swarm', id: room.swarm_id! })}>Open the swarm</Button>
            <Button variant="ghost" className="min-h-9 w-full text-[12.5px]" onClick={() => void patch({ swarm_id: null, kind: 'group' }, 'Now its own group; the swarm stays')}>Go on as a group</Button>
          </>
        ) : room.kind !== 'dm' ? (
          <>
            <p className="text-[12px] text-ink-3">Make a swarm from this room. The room stays as the swarm's room. Optionally move minds in.</p>
            {minds.map((m) => (
              <label key={m.member} className="flex items-center gap-2 text-[12.5px] text-ink-2">
                <input type="checkbox" checked={move.includes(m.member.slice(6))}
                  onChange={(e) => setMove((xs) => (e.target.checked ? [...xs, m.member.slice(6)] : xs.filter((x) => x !== m.member.slice(6))))} />
                Move {shown(m.name)} into it
              </label>
            ))}
            <Button variant="primary" icon="swarms" className="min-h-9 w-full text-[12.5px]"
              onClick={async () => {
                try {
                  const out = await client!.roomBecomeSwarm!(room.id, move)
                  onChanged()
                  toast({ tone: 'success', title: `${shown(out.swarm.name)} is now a swarm` })
                } catch (e) { toast({ tone: 'error', title: 'Not made into a swarm', body: e instanceof Error ? e.message : String(e) }) }
              }}>Make it a swarm</Button>
          </>
        ) : (
          <p className="text-[12px] text-ink-4">Turn the DM into a group first.</p>
        )}
      </section>
    </div>
  )
}

/** The Coffee Room's settings: an admin may rename it and set its topic. Nothing else about it changes. */
function CoffeeSettings({ room, onChanged }: { room: Room; onChanged: () => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const { admin } = useMe()
  const [name, setName] = useState(room.name)
  const [topic, setTopic] = useState(room.topic)
  if (!admin) return <p className="text-[12.5px] text-ink-3">The Coffee Room is the hive's own room. An admin may rename it or change its topic.</p>
  const save = async () => {
    try { await client!.updateRoom!(room.id, { name: name.trim(), topic: topic.trim() }); onChanged(); toast({ tone: 'success', title: 'Coffee Room updated' }) }
    catch (e) { toast({ tone: 'error', title: 'Not changed', body: e instanceof Error ? e.message : String(e) }) }
  }
  return (
    <div className="space-y-3">
      <h3 className="eyebrow">Coffee Room</h3>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Coffee Room name"
        className="min-h-9 w-full rounded-xl border border-line bg-black/25 px-3 text-[13px] text-ink" />
      <textarea value={topic} onChange={(e) => setTopic(e.target.value)} rows={3} placeholder="Topic" aria-label="Coffee Room topic"
        className="w-full rounded-xl border border-line bg-black/25 px-3 py-2 text-[13px] text-ink" />
      <Button variant="subtle" disabled={!name.trim() || (name === room.name && topic === room.topic)} className="min-h-9 w-full text-[12.5px]" onClick={() => void save()}>Save</Button>
      <p className="text-[11.5px] text-ink-4">It is the hive's own room: it can't be deleted, left, copied or made into another kind of room, and everyone in the hive can read it.</p>
    </div>
  )
}

export function NewRoom({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string, kind: RoomKind) => void }) {
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const toast = useHive((s) => s.toast)
  const [kind, setKind] = useState<RoomKind>('dm')
  const [name, setName] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [visibility, setVisibility] = useState('public')
  const [detail, setDetail] = useState('')
  const [budget, setBudget] = useState('2')
  const box = useRef<HTMLDivElement>(null)
  useEscape(onClose)
  useModalContainment(box)
  useEffect(() => { void client?.listPeople?.().then((r) => setPeople(r.people)).catch(() => undefined) }, [client])
  const options = [
    ...Object.values(agents).filter((a) => kind !== 'session' || a.swarm_id).map((a) => ({ id: `agent:${a.id}`, label: shown(a.name), sub: 'mind' })),
    ...(kind === 'session' ? [] : people.map((p) => ({ id: `user:${p.id}`, label: p.name || p.email, sub: 'person' }))),
  ]
  const single = kind === 'dm' || kind === 'session'
  const toggle = (id: string) => setChosen((xs) => (single ? [id] : xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]))
  const budgetOk = Number(budget) > 0 && Number(budget) <= 100
  const ready = kind === 'dm' ? chosen.length === 1 : kind === 'session' ? chosen.length === 1 && !!name.trim() && budgetOk : !!name.trim()
  const create = async () => {
    try {
      if (kind === 'session') {
        const se = await client!.createSession!({ mind: chosen[0].slice(6), title: name.trim(), detail: detail.trim(), budget_usd: Number(budget) })
        onCreated(se.room_id, 'session')
        return
      }
      const r = await client!.createRoom!({ kind, name: name.trim() || undefined, members: chosen, visibility: kind === 'channel' ? visibility : 'private' })
      onCreated(r.id, r.kind)
    } catch (e) { toast({ tone: 'error', title: 'Not created', body: e instanceof Error ? e.message : String(e) }) }
  }
  return (
    <div ref={box} className="xc-dress xc-backdrop fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 md:items-center md:p-6" role="dialog" aria-modal="true" aria-label="New conversation" onClick={onClose}>
      <div className="xc-frame xc-flush-b glass-strong w-full max-w-lg space-y-4 rounded-t-3xl sheet-solid-98 p-5 md:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center">
          <h2 className="flex-1 font-display text-[18px] font-semibold">New conversation</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        <Segmented<RoomKind> label="Kind" value={kind} dense onChange={(k) => { setKind(k); setChosen([]) }}
          options={[{ value: 'session', label: 'Session' }, { value: 'dm', label: 'Direct' }, { value: 'group', label: 'Group' }, { value: 'channel', label: 'Channel' }, { value: 'project', label: 'Project' }]} />
        <p className="text-[12px] text-ink-3">
          {kind === 'session' ? 'A focused piece of work with one mind: a task, a spend cap, and its steps and approvals as it works.' : kind === 'dm' ? 'One to one with a mind or a person.' : kind === 'group' ? 'Invite-only, for the people and minds you pick.' : kind === 'channel' ? 'A topic room others can find and join.' : 'A group with work attached; it can become a swarm later.'}
        </p>
        {kind !== 'dm' && (
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'session' ? 'What is this session for?' : 'Name'} aria-label="Name"
            className="min-h-10 w-full rounded-xl border border-line bg-black/25 px-3 text-[14px] text-ink" />
        )}
        {kind === 'session' && (
          <>
            <textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={3} placeholder="Details for the mind (optional)" aria-label="Details"
              className="w-full rounded-xl border border-line bg-black/25 px-3 py-2 text-[13.5px] text-ink" />
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              Spend cap $
              <input value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" aria-label="Spend cap in dollars"
                className="min-h-9 w-24 rounded-lg border border-line bg-black/25 px-2 text-ink" />
              <span className="text-[11.5px] text-ink-4">hard limit while the session runs</span>
            </label>
          </>
        )}
        {kind === 'channel' && (
          <select value={visibility} onChange={(e) => setVisibility(e.target.value)} aria-label="Who can find it"
            className="min-h-10 w-full rounded-xl border border-line bg-black/25 px-2 text-[13px] text-ink">
            <option value="public" className="bg-[#0b0b22]">Everyone in this hive can find and join</option>
            <option value="private" className="bg-[#0b0b22]">Members only</option>
          </select>
        )}
        <div>
          <h3 className="eyebrow pb-1.5">{kind === 'session' ? 'Which mind' : kind === 'dm' ? 'With' : 'Invite'}</h3>
          <ul className="thin-scroll max-h-56 space-y-0.5 overflow-y-auto">
            {options.map((o) => (
              <li key={o.id}>
                <button onClick={() => toggle(o.id)} aria-pressed={chosen.includes(o.id)}
                  className={cx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]', chosen.includes(o.id) ? 'bg-accent/20 text-ink' : 'text-ink-2 hover:bg-white/[0.05]')}>
                  <Icon name={o.sub === 'mind' ? 'mind' : 'user'} size={14} className="text-ink-3" />
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  <span className="text-[11px] text-ink-4">{o.sub}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void create()}>{kind === 'dm' ? 'Open' : kind === 'session' ? 'Start' : 'Create'}</Button>
        </div>
      </div>
    </div>
  )
}
