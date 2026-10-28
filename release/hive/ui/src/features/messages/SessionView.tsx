import { useCallback, useEffect, useRef, useState } from 'react'
import { PlainText } from '../../ui/Belief'
import type { SessionItem, WorkSession } from '../../api/types'
import { cx } from '../../lib/cx'
import { shown } from '../../lib/displayName'
import { navigate } from '../../lib/router'
import { hiveBus, useHive, type Decision } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button, IconButton, Meter } from '../../ui/primitives'
import { answerShown } from './sessionDecide'
import { guardComposing } from '../../features/ask/keys'

/** One working session with one mind: what you said, what it did (its steps), what it asked to do (approvals),
 *  all in one timeline, with the goal and the spend against the session's cap. */
export function SessionView({ sessionId, roomId }: { sessionId: string; roomId: string }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [session, setSession] = useState<WorkSession | null>(null)
  const [items, setItems] = useState<SessionItem[]>([])
  // Review D1: the store session the shown timeline (and so its approvals) was read under; an answer goes only in that session
  const [shownUnder, setShownUnder] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [workspaces, setWorkspaces] = useState<{ id: string; repository_id: string; status?: string }[]>([])
  const scroller = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    if (!client?.sessionTimeline) return
    const asked = useHive.getState().session
    void client.sessionTimeline(sessionId).then((r) => {
      // read for an earlier session: not what this connection shows
      if (useHive.getState().session !== asked) return
      setSession(r.session)
      setItems(r.items)
      setShownUnder(asked)
    }).catch(() => undefined)
    void client.sessionWorkspaces?.(sessionId).then((r) => setWorkspaces(r.workspaces)).catch(() => undefined)
  }, [client, sessionId])
  useEffect(() => { load() }, [load])
  const mindId = session?.agent_id
  useEffect(() => hiveBus.on((e) => {
    if ((e.type === 'room' && e.room_id === roomId) || e.type === 'approval.created' || e.type === 'approval.updated'
      || (e.type === 'agent.trace' && e.trace.agent_id === mindId)) load()
  }), [load, roomId, mindId])
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [items.length])

  const send = async () => {
    const body = text.trim()
    if (!body || !client?.postRoomMessage) return
    setSending(true)
    try { await client.postRoomMessage(roomId, body); setText(''); load() }
    catch (e) { toast({ tone: 'error', title: 'Message not sent', body: e instanceof Error ? e.message : String(e) }) }
    finally { setSending(false) }
  }
  const storeDecide = useHive((s) => s.decide)
  // the approval as the person saw it: stamped with the session its timeline was read under (an earlier session's is refused);
  // Kimi #4: taken or refused, the timeline is read again (sessionDecide)
  const decide = (id: string, d: Decision) => answerShown(id, d, shownUnder, storeDecide, load)

  if (!session) return <p className="p-6 text-[13px] text-ink-4">Loading the session…</p>
  const active = session.status === 'active'
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="space-y-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon name="terminal" size={18} className="text-ink-3" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-[16px] font-semibold">{session.title}</h2>
            <p className="truncate text-[12px] text-ink-3">
              Session with{' '}
              <button className="text-ink-2 hover:text-ink" onClick={() => navigate({ name: 'dot', id: session.mind.id })}>{shown(session.mind.name)}</button>
              {session.goal && <> · task {session.goal.status}</>}
              {!active && ' · ended'}
            </p>
          </div>
          {session.goal && (
            <Button variant="ghost" icon="target" className="min-h-9 px-2.5 text-[12.5px]" onClick={() => navigate({ name: 'tasks' })}>Task</Button>
          )}
          {active && (
            <Button variant="subtle" className="min-h-9 px-3 text-[12.5px]"
              onClick={async () => { try { await client!.endSession!(session.id); load() } catch (e) { toast({ tone: 'error', title: 'Not ended', body: String(e) }) } }}>
              End session
            </Button>
          )}
        </div>
        {workspaces.length > 0 && session.goal && (
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
            <span className="text-ink-3">Code:</span>
            {workspaces.map((w) => (
              <button key={w.id} onClick={() => navigate({ name: 'code', target: `repo:${w.repository_id}`, task: session.goal!.id, workspace: w.id, repository: w.repository_id })}
                className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-0.5 text-ink-2 hover:bg-white/[0.06] hover:text-ink">
                <Icon name="terminal" size={12} /> {w.repository_id} · open in Workbench
              </button>
            ))}
          </div>
        )}
        <Meter value={session.spent_usd} max={session.budget_usd} hue={session.mind.hue ?? 252} label={`Session spend $${session.spent_usd.toFixed(2)} of $${session.budget_usd.toFixed(2)}`} />
        <p className="text-[11.5px] text-ink-4">${session.spent_usd.toFixed(2)} of ${session.budget_usd.toFixed(2)} this session. The cap is a hard limit on the mind while the session runs.</p>
      </header>
      <div ref={scroller} className="thin-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-live="polite">
        {!items.length && <p className="pt-6 text-center text-[13px] text-ink-4">Say what you want done. {shown(session.mind.name)} hears every message here.</p>}
        {items.map((it, i) => <Item key={`${it.type}-${it.at}-${i}`} it={it} mindName={shown(session.mind.name)} hue={session.mind.hue ?? 252} onDecide={decide} />)}
      </div>
      <div className="border-t border-line p-3">
        {active ? (
          <div className="flex items-end gap-2">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} aria-label="Message"
              onKeyDown={(e) => { if (guardComposing(e)) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
              placeholder={`Tell ${shown(session.mind.name)} what to do…`}
              className="max-h-40 min-h-11 min-w-0 flex-1 resize-none rounded-xl border border-line bg-black/25 px-3 py-2.5 text-[14px] text-ink outline-none focus:border-line-2" />
            <IconButton icon="send" label="Send" onClick={() => void send()} disabled={sending || !text.trim()} className="bg-accent/30" />
          </div>
        ) : (
          <p className="text-center text-[12.5px] text-ink-4">This session has ended. Its history stays here.</p>
        )}
      </div>
    </div>
  )
}

function Item({ it, mindName, hue, onDecide }: { it: SessionItem; mindName: string; hue: number; onDecide: (id: string, d: Decision) => void }) {
  const [open, setOpen] = useState(false)
  if (it.type === 'message') {
    const mind = it.sender.startsWith('agent:')
    return (
      <div className={cx('flex flex-col', mind ? 'items-start' : 'items-end')}>
        <span className="mb-0.5 text-[11.5px] text-ink-3" style={mind ? { color: `hsl(${hue} 90% 72%)` } : undefined}>{mind ? mindName : shown(it.name)}</span>
        <p className={cx('max-w-[85%] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap', mind ? 'border border-line bg-white/[0.04]' : 'bg-accent/25')}><PlainText text={it.text} /></p>
      </div>
    )
  }
  if (it.type === 'approval') {
    const pending = it.status === 'pending'
    return (
      <div className={cx('rounded-xl border px-3 py-2.5', pending ? 'border-warn/40 bg-warn/[0.06]' : 'border-line bg-white/[0.02]')}>
        <div className="flex items-center gap-2 text-[12.5px]">
          <Icon name="shield" size={14} className={pending ? 'text-warn' : 'text-ink-3'} />
          <span className="flex-1 text-ink-2">{mindName} asks to run <span className="font-mono text-ink">{it.skill}</span> ({it.risk} risk)</span>
          <span className="text-[11.5px] text-ink-4">{it.status}</span>
        </div>
        <pre className="mt-1.5 max-h-32 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-ink-2">{it.command}</pre>
        {it.reason && <p className="mt-1 text-[11.5px] text-ink-4">{it.reason}</p>}
        {pending && (
          <div className="mt-2 flex gap-2">
            <Button variant="primary" className="min-h-8 px-3 text-[12.5px]" onClick={() => onDecide(it.id, 'approve')}>Once</Button>
            <Button variant="danger" className="min-h-8 px-3 text-[12.5px]" onClick={() => onDecide(it.id, 'deny')}>No</Button>
            <Button variant="danger" className="min-h-8 px-3 text-[12.5px]" onClick={() => onDecide(it.id, 'never')}>Never</Button>
            <Button variant="ghost" className="min-h-8 px-3 text-[12.5px]" onClick={() => navigate({ name: 'approvals', focus: it.id })}>For a time / Always…</Button>
          </div>
        )}
      </div>
    )
  }
  const first = it.steps[0]
  return (
    <div className="rounded-xl border border-line bg-white/[0.02]">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-ink-3 hover:text-ink-2">
        <Icon name={open ? 'chevronDown' : 'chevron'} size={13} />
        <span className="min-w-0 flex-1 truncate font-mono">{first.command}</span>
        {it.steps.length > 1 && <span className="text-[11px] text-ink-4">+{it.steps.length - 1} more</span>}
        {it.steps.some((s) => s.gated) && <span className="text-[11px] text-warn">gated</span>}
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2">
          {it.steps.map((s, i) => (
            <div key={i} className="space-y-1">
              <p className="font-mono text-[11.5px] text-ink">{s.command}</p>
              <pre className="max-h-48 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[11px] whitespace-pre-wrap text-ink-3">{s.result || '(no result)'}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
