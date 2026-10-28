import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { PlainText } from '../sdk'
import { useDraft } from '../drafts'
import type { AgentAction } from '../../api/types'
import { shown, useHive, type Agent, type Message } from '../sdk'
import type { PendingMessage } from '../../store/store'
import { current } from './binding'
import { bindEpoch } from '../../lib/identityEpoch'
import { guardComposing } from '../../features/ask/keys'

const NO_MESSAGES: Message[] = []
const NO_PENDING: PendingMessage[] = []

export function MindControls({ agent, ctx }: { agent: Agent; ctx: string }) {
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const action: AgentAction | null = agent.status === 'awake' ? 'sleep' : agent.status === 'asleep' ? 'wake' : agent.status === 'starting' ? null : 'start'
  const label = action === 'sleep' ? 'Sleep' : action === 'wake' ? 'Wake' : 'Start'

  const run = async () => {
    if (!action || inFlight.current || !current(ctx)) return
    const state = useHive.getState()
    const live = state.agents[agent.id]
    if (!live || live.status !== agent.status || live.kind !== agent.kind) {
      setOutcome('This mind changed. Read its current state before trying again.')
      return
    }
    const binding = bindEpoch()
    inFlight.current = true
    setBusy(true)
    setOutcome(null)
    try {
      const taken = await state.agentAction(agent.id, action)
      binding.commit(() => setOutcome(taken ? 'The hive confirmed the change.' : 'The change was not confirmed. Check the mind before trying again.'))
    } finally {
      inFlight.current = false
      binding.commit(() => setBusy(false))
    }
  }
  // External/module lifecycle remains the native panel's responsibility, not a guessed local wake.
  return (
    <div className="pr-mind-control">
      {agent.kind === 'omega' && action && <button type="button" className="pr-button" disabled={busy || !current(ctx)} onClick={() => void run()} aria-label={`${label} ${shown(agent.name)}`}>{busy ? 'Working…' : label}</button>}
      {agent.kind !== 'omega' && <span className="pr-muted">{agent.connected ? 'Connected' : 'Not connected'} · {agent.kind}</span>}
      {outcome && <span className="pr-outcome" role="status">{outcome}</span>}
    </div>
  )
}

/** Real messages and delivery state from the canonical store; no preview reply or second thread store. */
export function Conversation({ agent, ctx }: { agent: Agent; ctx: string }) {
  const id = agent.id
  const messages = useHive((s) => s.messages[id] ?? NO_MESSAGES)
  const pending = useHive((s) => s.pending[id] ?? NO_PENDING)
  const loaded = useHive((s) => !!s.messagesLoaded[id])
  const thinking = useHive((s) => s.thinking[id])
  const agents = useHive((s) => s.agents)
  const load = useHive((s) => s.loadMessages)
  const [draft, setDraft] = useDraft(`professional:mind:${id}`)
  const [error, setError] = useState<string | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)
  const composer = useRef<HTMLFormElement>(null)
  // opened: the composer is brought fully into view, clear of the Universal Ask (.pr-main's scroll-padding-bottom is
  // the Ask's room); already in view (a desk), nothing moves
  useEffect(() => {
    composer.current?.scrollIntoView?.({ block: 'nearest' })
  }, [])

  useEffect(() => {
    let showing = true
    const binding = bindEpoch()
    void load(id).catch((e: unknown) => {
      if (showing) binding.commit(() => { if (current(ctx)) setError(e instanceof Error ? e.message : 'Could not load this conversation.') })
    })
    return () => { showing = false }
  }, [ctx, id, load])

  useLayoutEffect(() => {
    if (stick.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [messages.length, pending.length, thinking, loaded])

  const submit = () => {
    const text = draft.trim()
    const state = useHive.getState()
    const live = state.agents[id]
    if (!text || !current(ctx) || !live || (live.kind !== 'omega' && live.kind !== 'iter')) return
    setDraft('')
    stick.current = true
    // The canonical action owns optimistic pending/delivery/error state and session-bound readback.
    void state.sendMessage(id, text)
    input.current?.focus()
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (guardComposing(e) || e.defaultPrevented || e.repeat) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
  }
  const retry = (tempId: string) => {
    const state = useHive.getState()
    const live = state.agents[id]
    if (!current(ctx) || !live || (live.kind !== 'omega' && live.kind !== 'iter')) return
    if (state.pending[id]?.find((p) => p.tempId === tempId)?.status !== 'failed') return
    void state.retryMessage(id, tempId)
  }
  const discard = (tempId: string) => {
    if (current(ctx)) useHive.getState().dismissPending(id, tempId)
  }
  const sender = (m: Message) => {
    if (m.sender.startsWith('user:')) return m.sender
    if (m.sender.startsWith('agent:')) return shown(agents[m.sender.slice(6)]?.name ?? m.sender)
    return m.sender
  }
  const busy = thinking === 'llm' || thinking === 'skills'

  return (
    <div className="pr-conversation">
      <div ref={scroll} className="pr-transcript" role="log" aria-live="polite" aria-relevant="additions text" aria-label={`Conversation with ${shown(agent.name)}`} onScroll={() => {
        const el = scroll.current
        if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}>
        {error && <p className="pr-notice" role="alert">{error} <button type="button" className="pr-link" onClick={() => {
          if (!current(ctx)) return
          const binding = bindEpoch()
          void load(id).then(() => binding.commit(() => { if (current(ctx)) setError(null) }), () => undefined)
        }}>Try again</button></p>}
        {!loaded && !messages.length && <p className="pr-muted" role="status">Loading conversation…</p>}
        {loaded && !messages.length && !pending.length && <div className="pr-chat-empty"><h3>Talk to {shown(agent.name)}</h3><p>Give it a task, ask a question or continue your work.</p></div>}
        <ol className="pr-message-list">
          {messages.map((m) => <li key={m.id} data-message-id={m.id} data-conversation-id={m.conversation_id} className={`pr-message${m.sender.startsWith('user:') ? ' pr-message-person' : ''}`}>
            <div className="pr-message-meta"><strong>{sender(m)}</strong><time dateTime={m.created_at}>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
            <p><PlainText text={m.text} /></p>
          </li>)}
          {pending.map((p) => <li key={p.tempId} className="pr-message pr-message-person" data-pending-id={p.tempId}>
            <div className="pr-message-meta"><strong>You</strong><span>{p.status === 'sending' ? 'Sending…' : 'Not delivered'}</span></div>
            <p>{p.text}</p>
            {p.status === 'failed' && <div className="pr-message-error"><span>{p.error}</span><button type="button" className="pr-link" onClick={() => retry(p.tempId)}>Retry</button><button type="button" className="pr-link" onClick={() => discard(p.tempId)}>Discard</button></div>}
          </li>)}
        </ol>
        {busy && <p className="pr-muted" role="status">{shown(agent.name)} is {thinking === 'llm' ? 'thinking' : 'using skills'}…</p>}
      </div>
      {/* r2.4 (Kimi r2.3 #3): the form never sends on submission; Enter is the textarea's own guarded key, and the Send
          button sends on its own click (src/enterGuard.test.ts holds every form to this) */}
      <form ref={composer} className="pr-composer" onSubmit={(e) => e.preventDefault()}>
        {agent.status === 'asleep' && <p className="pr-muted">A message wakes this mind.</p>}
        <label htmlFor={`pr-message-${id}`} className="pr-sr">Message {shown(agent.name)}</label>
        <textarea id={`pr-message-${id}`} ref={input} rows={3} value={draft} onChange={(e) => { if (current(ctx)) setDraft(e.target.value) }} onKeyDown={onKey} placeholder={`Message ${shown(agent.name)}…`} disabled={!current(ctx)} />
        <div className="pr-composer-actions"><span className="pr-muted">Enter to send · Shift+Enter for a new line</span><button type="button" className="pr-button pr-primary" disabled={!draft.trim() || !current(ctx)} onClick={submit}>Send message</button></div>
      </form>
    </div>
  )
}
