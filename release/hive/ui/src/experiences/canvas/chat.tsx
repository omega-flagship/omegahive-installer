import { useCanvasCurrent } from './actionAuthority'
import { healthCheck } from '../../lib/healthQuestion'
import { HealthCheckLabel } from '../../ui/HealthCheckLabel'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useDraft } from '../drafts'
import { m } from 'framer-motion'
import { openClassic, PlainText, shown, useHive, type Agent, type Message } from '../sdk'
import { agentIdOf, ago, shortModel, STATUS_LABEL } from './data'
import { CHAT_H, CHAT_W, type Rect } from './layout'
import { Avatar } from './parts'
import { sc } from './util'
import { MONO } from './theme'
import { withBusy } from './busy'
import { guardComposing } from '../../features/ask/keys'

const EMPTY: Message[] = []

/** `onCloseX`: the visible X (home, closeToHome). `onDismiss`: Esc, closing just this conversation. */
export function ChatCard({ r, agent, phase, now, reduced, onCloseX, onDismiss }: { r: Rect; agent: Agent; phase: string | undefined; now: number; reduced: boolean; onCloseX: () => void; onDismiss: () => void }) {
  const current = useCanvasCurrent()
  const messages = useHive((s) => s.messages[agent.id] ?? EMPTY)
  const pending = useHive((s) => s.pending[agent.id])
  const agents = useHive((s) => s.agents)
  const [text, setText] = useDraft(`canvas:mind:${agent.id}`)
  const [waking, setWaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const thinking = phase === 'llm' || phase === 'skills'
  const awake = agent.status === 'awake' || agent.status === 'starting'

  useEffect(() => {
    void useHive.getState().loadMessages(agent.id).catch(() => undefined)
    const t = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), reduced ? 0 : 380)
    return () => clearTimeout(t)
  }, [agent.id, reduced])

  const count = messages.length + (pending?.length ?? 0)
  useLayoutEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count, thinking])

  const send = () => {
    if (!current()) return
    const t = text.trim()
    if (!t) return
    setError(null)
    // with no connection the message could never leave: keep the draft and say so
    if (!useHive.getState().client) return setError('Not connected to the hive. Your message is kept; send it again once connected.')
    // the text moves into a pending bubble (a failed send stays there with Retry); if the send itself throws,
    // the draft comes back to the box
    setText('')
    useHive
      .getState()
      .sendMessage(agent.id, t)
      .catch(() => {
        if (!current()) return
        setText((cur) => (cur ? cur : t))
        setError('Not sent. Your message is back in the box.')
      })
  }
  const toggle = async () => {
    if (!current()) return
    setError(null)
    // busy always clears, whatever the hive answers (the store reports refusals as a toast)
    const r = await withBusy(setWaking, () => useHive.getState().agentAction(agent.id, awake ? 'sleep' : 'wake'))
    if (!current()) return
    if (!r.ok) setError(`Could not ${awake ? 'put it to sleep' : 'wake it'}: ${r.error}`)
    else if (!r.value) setError(`The hive did not ${awake ? 'put it to sleep' : 'wake it'}. Nothing changed.`)
  }

  const shownMsgs = messages.slice(-60)
  return (
    <m.div
      data-item={`mind:${agent.id}`}
      data-nopan
      role="dialog"
      aria-label={`Talking with ${shown(agent.name)}`}
      initial={reduced ? false : { width: r.w, height: r.h }}
      animate={{ width: CHAT_W, height: CHAT_H }}
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      className="flex flex-col overflow-hidden"
      style={{ position: 'absolute', left: r.x, top: r.y, zIndex: 20, background: 'var(--card)', borderRadius: 20, border: '1px solid var(--line)', boxShadow: `0 0 0 ${sc(2)} var(--accent), var(--shadow-lg)` }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onDismiss()
        }
      }}
    >
      <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--line)' }}>
        <Avatar name={agent.name} hue={agent.hue} size={38} radius={11} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-semibold tracking-[-0.015em]" style={{ color: 'var(--ink)' }}>
            {shown(agent.name)}
          </div>
          <div className="flex items-center gap-1.5 truncate text-[12px]" style={{ color: thinking ? 'var(--accent-ink)' : 'var(--ink-3)' }}>
            {thinking ? (phase === 'skills' ? 'Using skills…' : 'Thinking…') : STATUS_LABEL[agent.status]}
            <span aria-hidden>·</span>
            <span style={{ fontFamily: MONO, color: 'var(--ink-3)' }}>{shortModel(agent.model)}</span>
          </div>
        </div>
        <button
          onClick={() => void toggle()}
          disabled={waking || agent.status === 'starting'}
          className="rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition-colors disabled:opacity-60"
          style={awake ? { border: '1px solid var(--line-2)', color: 'var(--ink)' } : { background: 'var(--accent)', color: 'var(--on-accent)' }}
        >
          {waking ? '…' : awake ? 'Sleep' : 'Wake'}
        </button>
        <button aria-label="Open the full page for this mind" title="Open full page" onClick={() => { if (current()) openClassic({ name: 'dot', id: agent.id }) }} className="grid size-8 place-items-center rounded-full hover:bg-[var(--accent-soft)]" style={{ color: 'var(--ink-2)' }}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V13H3V4h3.5" /></svg>
        </button>
        <button aria-label="Close the conversation" title="Close (Esc)" onClick={onCloseX} className="grid size-8 place-items-center rounded-full hover:bg-[var(--accent-soft)]" style={{ color: 'var(--ink-2)' }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>

      <div ref={listRef} data-scroll className="flex-1 overflow-y-auto overscroll-contain px-4 py-3" style={{ touchAction: 'pan-y' }}>
        {shownMsgs.length === 0 && !pending?.length ? (
          <div className="grid h-full place-items-center text-center text-[13.5px]" style={{ color: 'var(--ink-3)' }}>
            <div>
              <div className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>Say hello to {shown(agent.name)}</div>
              <div className="mt-1">{awake ? 'It is awake and listening.' : 'It is resting. Your message waits until it wakes.'}</div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {shownMsgs.map((m, i) => {
              const fromPeer = m.direction === 'in' && m.sender.startsWith('agent:')
              const mine = m.direction === 'in' && !fromPeer && !healthCheck(m)
              const peer = fromPeer ? agents[agentIdOf(m.sender) ?? ''] : null
              const prev = shownMsgs[i - 1]
              // Health's question starts its own group, so its label shows after an ordinary Health alert (Copilot on omegahive#50)
              const grouped = prev && prev.sender === m.sender && prev.direction === m.direction && healthCheck(prev) === healthCheck(m)
              return (
                <div key={m.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'} ${grouped ? '' : 'mt-1.5'}`}>
                  {!grouped && healthCheck(m) && <div className="mb-0.5 text-[11.5px] font-medium" style={{ color: 'var(--ink-3)' }}><HealthCheckLabel className="" /></div>}
                  {!grouped && fromPeer && (
                    <div className="mb-0.5 flex items-center gap-1 text-[11.5px] font-medium" style={{ color: 'var(--ink-3)' }}>
                      {peer && <Avatar name={peer.name} hue={peer.hue} size={14} radius={4} />}
                      {peer ? shown(peer.name) : 'Another mind'}
                    </div>
                  )}
                  <div
                    className="max-w-[86%] rounded-[14px] px-3 py-[7px] text-[13.5px] leading-[1.42] break-words whitespace-pre-wrap"
                    style={
                      mine
                        ? { background: 'var(--bubble-me)', color: 'var(--bubble-me-ink)', borderBottomRightRadius: 5 }
                        : fromPeer
                          ? { background: 'transparent', color: 'var(--ink)', border: '1px solid var(--line-2)', borderBottomLeftRadius: 5 }
                          : { background: 'var(--bubble)', color: 'var(--ink)', borderBottomLeftRadius: 5 }
                    }
                  >
                    <PlainText text={m.text} />
                  </div>
                </div>
              )
            })}
            {pending?.map((p) => (
              <div key={p.tempId} className="mt-1 flex flex-col items-end">
                <div className="max-w-[86%] rounded-[14px] px-3 py-[7px] text-[13.5px] leading-[1.42] break-words whitespace-pre-wrap" style={{ background: 'var(--bubble-me)', color: 'var(--bubble-me-ink)', opacity: 0.6, borderBottomRightRadius: 5 }}>
                  {p.text}
                </div>
                <div className="mt-0.5 text-[11.5px]" style={{ color: p.status === 'failed' ? 'var(--bad)' : 'var(--ink-3)' }}>
                  {p.status === 'failed' ? (
                    <button className="underline" onClick={() => { if (current()) void useHive.getState().retryMessage(agent.id, p.tempId) }}>
                      Not sent. Retry
                    </button>
                  ) : (
                    'Sending…'
                  )}
                </div>
              </div>
            ))}
            {thinking && (
              <div className="mt-1.5 flex items-center gap-1 self-start rounded-[14px] px-3 py-2.5" style={{ background: 'var(--bubble)' }} aria-label="Thinking">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="cv-dot inline-block size-[6px] rounded-full" style={{ background: 'var(--ink-3)', animationDelay: `${i * 0.16}s` }} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t p-2.5" style={{ borderColor: 'var(--line)' }}>
        <div className="flex items-end gap-2 rounded-[14px] px-3 py-2" style={{ background: 'var(--card-2)', border: '1px solid var(--line-2)' }}>
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            aria-label={`Message ${shown(agent.name)}`}
            placeholder={awake ? `Message ${shown(agent.name)}…` : `Leave a note for ${shown(agent.name)}…`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !guardComposing(e)) {
                e.preventDefault()
                send()
              }
            }}
            className="max-h-[96px] min-h-[22px] flex-1 resize-none border-0 bg-transparent p-0 text-[14px] leading-[1.45] outline-none"
            style={{ color: 'var(--ink)', fieldSizing: 'content' } as CSSProperties}
          />
          <button
            aria-label="Send"
            onClick={send}
            disabled={!text.trim()}
            className="grid size-[30px] shrink-0 place-items-center rounded-full transition-[transform,opacity] active:scale-90 disabled:opacity-35"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
          </button>
        </div>
        {error && (
          <div role="alert" className="mt-1.5 px-1 text-[12px] font-semibold" style={{ color: 'var(--bad)' }}>
            {error}
          </div>
        )}
        <div className="mt-1.5 flex justify-between px-1 text-[11.5px]" style={{ color: 'var(--ink-3)' }}>
          <span>Enter to send · Shift+Enter for a new line</span>
          <span>{messages.length ? `last ${ago(messages[messages.length - 1].created_at, now)}` : ''}</span>
        </div>
      </div>
    </m.div>
  )
}
