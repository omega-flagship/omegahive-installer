import { useEffect, useMemo, useRef, useState } from 'react'
import { PlainText } from '../../ui/Belief'
import { plainText } from '../../lib/beliefSentence'
import type { Agent, Room, RoomMessage } from '../../api/types'
import { cx } from '../../lib/cx'
import { shown } from '../../lib/displayName'
import { useEscape } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { useMe } from '../../lib/useAdmin'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button, IconButton, Switch } from '../../ui/primitives'
import { useModalContainment } from '../../ui/useModalContainment'
import { askConfirm, ConfirmHost } from '../../ui/confirm'
import './coffee.css'
import {
  COFFEE_NAME, COFFEE_PUBLIC_NOTE, HERE_HINT, HERE_TYPING, coffeeState, coffeeSubtitle, groupCandidates, hereLabel, hereReached,
  COFFEE_DISCLOSURE, isCoffee, isHere, isMind, memberName, needsDisclosure, setCoffeeMembership, noteLabel, originLabel, originOf, originRoute, saysHere, startGroup, suggestGroupName, talkPrivately,
} from './coffee'

/**
 * The Coffee Room's pieces, shared by every look. Classic renders them on its Messages page; Still, Canvas, Cosmos, Flux
 * and Construct reach the same page from their own navigation (features/registry.ts `talk.coffee`) and it wears their
 * chrome (experiences/chrome.ts), so the warm accent below is drawn from the look's own accent where one is set.
 * Everything contract-shaped comes from ./coffee.
 */

/** The coffee mark: a cup with a little steam (still under reduced motion). */
export function CoffeeMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <span className={cx('coffee-mark inline-flex shrink-0 items-center justify-center rounded-xl', className)} style={{ width: size + 14, height: size + 14 }} aria-hidden="true">
      <Icon name="coffee" size={size} />
    </span>
  )
}

/** The pinned entry at the top of the room list. */
export function CoffeeListEntry({ room, active, onOpen }: { room: Room; active: boolean; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      aria-current={active ? 'page' : undefined}
      aria-label={`${room.name || COFFEE_NAME}, pinned. ${coffeeSubtitle(room)}.${room.unread ? ` ${room.unread} unread.` : ''}`}
      className={cx('coffee-entry flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition-colors', active ? 'coffee-entry-active' : '')}
    >
      <CoffeeMark />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
          <span className="truncate">{room.name || COFFEE_NAME}</span>
          <span className="coffee-pin rounded-full px-1.5 text-[10.5px] font-medium tracking-wide uppercase">Pinned</span>
        </span>
        <span className="block truncate text-[11.5px] text-ink-3">{coffeeSubtitle(room)}</span>
      </span>
      {!!room.unread && <span className="coffee-count rounded-full px-1.5 text-[11px] font-semibold">{room.unread}</span>}
    </button>
  )
}

/** The note at the top of the room: everyone in the hive can read it. */
export function CoffeePublicNote() {
  return (
    <p role="note" className="coffee-note mx-4 mt-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-[12.5px] leading-snug text-ink-2">
      <Icon name="people" size={15} className="mt-px shrink-0" />
      <span>{COFFEE_PUBLIC_NOTE}</span>
    </p>
  )
}

/** The line under the composer. It never promises a count: the host picks up to 5 of the most recently active awake
 *  minds when the message is sent, and the message then says exactly who it reached (Kimi r2 #3). */
export function HereHint({ text }: { room?: Room; text: string }) {
  const typing = saysHere(text)
  return (
    <p className={cx('mt-1.5 text-[11.5px]', typing ? 'text-ink-2' : 'text-ink-4')} aria-live={typing ? 'polite' : undefined}>
      {typing ? HERE_TYPING : `Minds hear only messages that @mention them. ${HERE_HINT}`}
    </p>
  )
}

/** Under an @here message: the awake minds it reached. */
export function HereReached({ message, room }: { message: RoomMessage; room: Room }) {
  if (!isCoffee(room) || !isHere(message)) return null
  const nameOf = (member: string) => memberName({ member, name: room.members.find((x) => x.member === member)?.name }, room.me)
  return <span className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-4"><Icon name="wave" size={11} />{hereLabel(hereReached(message), nameOf)}</span>
}

/** "Talk privately" and "Start a group" on a message in the Coffee Room. Shown on hover and focus; always on touch. */
export function BreakOff({ message, room, onGroup }: { message: RoomMessage; room: Room; onGroup: (m: RoomMessage) => void }) {
  const talk = useTalkPrivately()
  const mine = message.sender === room.me
  const speaker = !message.sender.startsWith('system:')
  if (!speaker) return null
  const who = memberName({ member: message.sender, name: message.name }, room.me)
  return (
    <span className="coffee-actions mt-1 flex flex-wrap gap-1" role="group" aria-label={`Break off from ${who}'s message`}>
      {!mine && (
        <button className="coffee-action inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[11.5px]" onClick={() => void talk(message, who)}>
          <Icon name="chat" size={12} /> Talk privately<span className="sr-only"> with {who}</span>
        </button>
      )}
      <button className="coffee-action inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[11.5px]" onClick={() => onGroup(message)}>
        <Icon name="people" size={12} /> Start a group<span className="sr-only"> from this message</span>
      </button>
    </span>
  )
}

/** Opens the DM with the sender, carrying the message it started from (kept by the host only when the DM is new). */
export function useTalkPrivately() {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  return async (m: RoomMessage, who: string) => {
    if (!client?.createRoom) return
    try {
      const { room: r, linked: fresh } = await talkPrivately(client, m)
      navigate({ name: 'messages', room: r.id })
      toast({ tone: 'success', title: fresh ? `Talking privately with ${who}` : `Your conversation with ${who}`, body: fresh ? 'It links back to the message in the Coffee Room.' : undefined })
    } catch (e) {
      toast({ tone: 'error', title: 'Could not open a private conversation', body: e instanceof Error ? e.message : String(e) })
    }
  }
}

/** "Start a group": pick people and minds from the room, name it, create it with the message as its origin. */
export function StartGroup({ message, room, onClose }: { message: RoomMessage; room: Room; onClose: () => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const box = useRef<HTMLDivElement>(null)
  const who = memberName({ member: message.sender, name: message.name }, room.me)
  const [name, setName] = useState(() => suggestGroupName({ name: who, text: message.text }))
  const [chosen, setChosen] = useState<string[]>(() => (message.sender !== room.me && !message.sender.startsWith('system:') ? [message.sender] : []))
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  useEscape(onClose)
  useModalContainment(box)
  const all = useMemo(() => groupCandidates(room, message.sender), [room, message.sender])
  const q = query.trim().toLowerCase()
  const options = all.filter((m) => !q || memberName(m).toLowerCase().includes(q))
  const toggle = (id: string) => setChosen((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]))
  const create = async () => {
    if (!client?.createRoom || !chosen.length) return
    setBusy(true)
    try {
      const r = await startGroup(client, message, chosen, name)
      onClose()
      navigate({ name: 'messages', room: r.id })
      toast({ tone: 'success', title: 'Group started', body: 'It links back to the message in the Coffee Room.' })
    } catch (e) {
      toast({ tone: 'error', title: 'Group not started', body: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div ref={box} className="xc-dress xc-backdrop fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 md:items-center md:p-6" role="dialog" aria-modal="true" aria-labelledby="coffee-group-h" onClick={onClose}>
      <div className="xc-frame xc-flush-b glass-strong w-full max-w-lg space-y-4 rounded-t-3xl sheet-solid-98 p-5 md:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <CoffeeMark size={16} />
          <h2 id="coffee-group-h" className="flex-1 font-display text-[18px] font-semibold">Start a group</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        <blockquote className="rounded-xl border border-line bg-white/[0.03] px-3 py-2 text-[12.5px] text-ink-3">
          <span className="font-medium text-ink-2">{who}:</span> {plainText(message.text).length > 160 ? `${plainText(message.text).slice(0, 160)}…` : plainText(message.text)}
        </blockquote>
        <p className="text-[12px] text-ink-3">A private group for the people and minds you pick. It keeps a link back to this message.</p>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name the group" aria-label="Group name"
          className="min-h-10 w-full rounded-xl border border-line bg-black/25 px-3 text-[14px] text-ink" />
        <div>
          <div className="flex items-baseline gap-2 pb-1.5">
            <h3 className="eyebrow flex-1">Invite from the Coffee Room</h3>
            <span className="text-[11.5px] text-ink-4" aria-live="polite">{chosen.length} picked</span>
          </div>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find someone" aria-label="Find people and minds"
            className="mb-1.5 min-h-9 w-full rounded-xl border border-line bg-black/25 px-3 text-[13px] text-ink" />
          <ul className="thin-scroll max-h-56 space-y-0.5 overflow-y-auto" aria-label="People and minds">
            {options.map((m) => (
              <li key={m.member}>
                <button onClick={() => toggle(m.member)} aria-pressed={chosen.includes(m.member)}
                  className={cx('flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]', chosen.includes(m.member) ? 'bg-accent/20 text-ink' : 'text-ink-2 hover:bg-white/[0.05]')}>
                  <Icon name={isMind(m.member) ? 'mind' : 'user'} size={14} className="text-ink-3" />
                  <span className="min-w-0 flex-1 truncate">{memberName(m)}</span>
                  <span className="text-[11px] text-ink-4">{isMind(m.member) ? 'mind' : 'person'}{m.member === message.sender ? ' · said this' : ''}</span>
                  {chosen.includes(m.member) && <Icon name="check" size={14} className="text-accent-2" />}
                </button>
              </li>
            ))}
            {!options.length && <li className="px-2.5 py-1.5 text-[12.5px] text-ink-4">No one matches.</li>}
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!chosen.length || busy} onClick={() => void create()}>Start the group</Button>
        </div>
      </div>
    </div>
  )
}

/** In a room started from a message: "Started from a message in the Coffee Room" → back to that message. */
export function OriginBackLink({ room, rooms }: { room: Room; rooms: Room[] }) {
  const origin = originOf(room)
  if (!origin) return null
  const from = rooms.find((r) => r.id === origin.room_id)
  return (
    <button
      onClick={() => navigate(originRoute(origin))}
      className="coffee-origin mx-4 mt-3 flex items-center gap-2 self-start rounded-xl border px-3 py-1.5 text-left text-[12.5px] text-ink-2 transition-colors"
    >
      {from && isCoffee(from) ? <Icon name="coffee" size={14} /> : <Icon name="back" size={14} />}
      <span>{originLabel(from)}</span>
      <span className="text-ink-4" aria-hidden="true">→</span>
      <span className="sr-only">Go back to that message</span>
    </button>
  )
}

/** A mind's unprompted note: quiet, labelled, never a bubble that shouts. */
export function NoteBody({ message }: { message: RoomMessage }) {
  return (
    <div className="coffee-thought max-w-[85%] rounded-2xl border border-dashed px-3.5 py-2">
      <span className="mb-0.5 flex items-center gap-1 text-[11px] text-ink-3"><Icon name="sparkles" size={11} />{noteLabel(memberName({ member: message.sender, name: message.name }))}</span>
      <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink-2 italic"><PlainText text={message.text} /></p>
    </div>
  )
}

/** Brings a linked message into view, moves focus to it (screen readers read it) and marks it for a moment. The mark is
 *  a class on the element, so nothing re-renders; no movement under reduced motion. */
export function useFocusMessage(id: string | undefined, ready: boolean) {
  useEffect(() => {
    if (!id || !ready) return
    const el = document.getElementById(`msg-${id}`)
    if (!el) return
    const still = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView?.({ block: 'center', behavior: still ? 'auto' : 'smooth' })
    el.focus({ preventScroll: true })
    el.classList.add('coffee-lit')
    const t = setTimeout(() => el.classList.remove('coffee-lit'), 2600)
    return () => { clearTimeout(t); el.classList.remove('coffee-lit') }
  }, [id, ready])
}

/** A mind's Coffee Room membership, on its settings: the state for everyone, the switch for admins only. */
export function CoffeeMembershipControl({ agent }: { agent: Agent }) {
  const patch = useHive((s) => s.patchAgent)
  const toast = useHive((s) => s.toast)
  const swarms = useHive((s) => s.swarms)
  const { admin } = useMe()
  return (
    <CoffeeMembershipView
      agent={agent}
      admin={admin}
      swarm={agent.swarm_id ? swarms[agent.swarm_id] ?? null : null}
      confirm={(m, l) => askConfirm(m, l)}
      patch={async (id, body) => !!(await patch(id, body))}
      done={(on) => toast({ tone: 'success', title: on ? `${shown(agent.name)} is in the Coffee Room` : `${shown(agent.name)} left the Coffee Room` })}
    />
  )
}

/** The control itself (no store, no hooks): what it shows and what its switch sends, so tests drive the real switch. */
export function CoffeeMembershipView({ agent, admin, swarm, confirm, patch, done }: {
  agent: Agent
  admin: boolean
  swarm: { visibility?: string | null } | null
  confirm: (message: string, label: string) => Promise<boolean>
  patch: (id: string, body: { coffee: boolean }) => Promise<boolean>
  done: (on: boolean) => void
}) {
  const state = coffeeState(agent)
  if (!state) return null
  const disclose = !state.on && needsDisclosure(agent, swarm)
  return (
    <section aria-labelledby="coffee-h">
      {/* askConfirm shows nothing without a host, and the mind's Model tab mounts none: the switch brings its own */}
      {admin && <ConfirmHost />}
      <h3 id="coffee-h" className="eyebrow mb-2">Coffee Room</h3>
      <div className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.02] px-3 py-2">
        <CoffeeMark size={14} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-ink">{state.label}</p>
          <p className="text-meta text-ink-4">{state.why}</p>
          {admin && disclose && <p className="text-meta text-ink-3">{COFFEE_DISCLOSURE}</p>}
        </div>
        {admin && (
          <Switch
            checked={state.on}
            label="In the Coffee Room"
            hue={agent.hue}
            onChange={async (on) => {
              if (await setCoffeeMembership(agent, on, { swarm, confirm, patch })) done(on)
            }}
          />
        )}
      </div>
    </section>
  )
}
