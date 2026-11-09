import { healthCheck } from '../../lib/healthQuestion'
import { HEALTH_CHECK, HealthCheckLabel } from '../../ui/HealthCheckLabel'
import { m } from 'framer-motion'
import { useDraft } from '../drafts'
import { memo, useEffect, useMemo, useRef, type KeyboardEvent } from 'react'
import { openClassic, shown, useHive, useRoute, type Message } from '../sdk'
import { stillModal } from './containment'
import { ago } from './language'
import { plainPieces } from '../../lib/beliefSentence'
import { AsWritten } from '../../ui/Belief'
import { inkOf, isAwake, useNow, useSprings } from './shared'
import { useModalContainment } from '../../ui/useModalContainment'
import { ASK_RESERVE } from '../../ui/overlays'
import { guardComposing } from '../../features/ask/keys'

const NO_MSGS: Message[] = []
const NO_PENDING: never[] = []

/** A mind, in reading mode: one centred column of serif prose and a quiet place to write. Esc returns. */
export function Reading({ id, onClose }: { id: string; onClose: () => void }) {
  const agent = useHive((s) => s.agents[id])
  // names only (a primitive), so spending updates on other minds do not re-render the page
  const nameList = useHive((s) => Object.values(s.agents).map((a) => `${a.id}\u0001${a.name}`).join('\u0002'))
  const names = useMemo(() => new Map(nameList.split('\u0002').map((x) => x.split('\u0001') as [string, string])), [nameList])
  const swarm = useHive((s) => (agent?.swarm_id ? s.swarms[agent.swarm_id] : undefined))
  const messages = useHive((s) => s.messages[id] ?? NO_MSGS)
  const pending = useHive((s) => s.pending[id] ?? NO_PENDING)
  const loaded = useHive((s) => !!s.messagesLoaded[id])
  const phase = useHive((s) => s.thinking[id])
  const loadMessages = useHive((s) => s.loadMessages)
  const sendMessage = useHive((s) => s.sendMessage)
  const retry = useHive((s) => s.retryMessage)
  const agentAction = useHive((s) => s.agentAction)
  const [text, setText] = useDraft(`still:mind:${id}`)
  const scroller = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const page = useRef<HTMLElement>(null)
  // modal only while Still is in front: a shared page or panel opened from here stays usable (close-home r4)
  const modal = stillModal(useRoute().name, !!agent)
  useModalContainment(page, { active: modal.active, restoreFocus: modal.restoreFocus })
  const sp = useSprings()
  const now = useNow()

  useEffect(() => {
    void loadMessages(id).catch(() => undefined)
  }, [id, loadMessages])

  useEffect(() => {
    const t = window.setTimeout(() => box.current?.focus({ preventScroll: true }), sp.reduced ? 0 : 280)
    return () => window.clearTimeout(t)
  }, [sp.reduced])

  const busy = phase === 'llm' || phase === 'skills'
  const tail = useMemo(() => messages.slice(-80), [messages])
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: sp.reduced ? 'auto' : 'smooth' })
  }, [tail.length, pending.length, busy, sp.reduced])

  if (!agent) return null
  const name = shown(agent.name)
  const awake = isAwake(agent)

  const send = () => {
    const t = text.trim()
    if (!t) return
    setText('')
    if (box.current) box.current.style.height = 'auto'
    void sendMessage(id, t)
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !guardComposing(e)) {
      e.preventDefault()
      send()
    }
  }

  const who = (msg: Message) => {
    if (healthCheck(msg)) return { label: HEALTH_CHECK, me: false }
    if (msg.direction === 'out') return { label: name, me: false }
    if (msg.sender.startsWith('agent:')) return { label: shown(names.get(msg.sender.slice(6))) || 'Another mind', me: false }
    return { label: 'You', me: true }
  }

  const status = agent.status === 'error'
    ? 'has run into a problem.'
    : busy
      ? `is ${phase === 'llm' ? 'thinking' : 'at work with its tools'}${swarm ? `, in ${shown(swarm.name)}` : ''}.`
      : awake
        ? `is awake${swarm ? ` in ${shown(swarm.name)}` : ''} and listening.`
        : agent.status === 'asleep'
          ? 'is asleep.'
          : 'is switched off.'

  return (
    <m.section
      ref={page}
      className="st-read"
      role="dialog"
      aria-modal={modal.ariaModal}
      aria-label={`Conversation with ${name}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: sp.reduced ? 0 : 0.22 } }}
      transition={sp.fade}
    >
      <div className="still-paper" style={{ position: 'absolute' }} />
      <div className="st-read-bar">
        <div className="st-read-col">
          <div className="st-read-top">
        <button className="st-back" onClick={onClose}>
          <span aria-hidden style={{ fontSize: 20 }}>←</span> Back to the hive
          <kbd className="st-ask-key st-wide" style={{ marginLeft: 6 }}>esc</kbd>
        </button>
        <button className="st-link" style={{ fontSize: 15 }} onClick={() => openClassic({ name: 'dot', id, tab: 'mind' })}>
          <span className="st-wide">Everything about {name}</span><span className="st-narrow">Details</span>
        </button>
      </div>
        </div>
      </div>
      <div className="st-read-scroll" ref={scroller}>
        <div className="st-read-col">
          <header style={{ paddingTop: 'clamp(24px, 6vh, 64px)' }}>
            <m.h1 layoutId={`st-name-${id}`} transition={sp.soft} className="st-read-title">
              {name}
            </m.h1>
            <m.p className="st-read-sub" initial={sp.reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...sp.soft, delay: sp.reduced ? 0 : 0.12 }}>
              <span className="st-dot" data-state={busy ? 'thinking' : awake ? 'idle' : 'asleep'} style={{ ['--c' as string]: inkOf(agent.hue), marginRight: 12, display: 'inline-block' }} aria-hidden>
                <i />
                <i />
              </span>
              {name} {status}{' '}
              {!awake && agent.status !== 'error' && (
                <button className="st-inline-btn" onClick={() => void agentAction(id, 'wake')}>
                  wake {name}
                </button>
              )}
              {awake && !busy && (
                <button className="st-inline-btn" onClick={() => void agentAction(id, 'sleep')}>
                  let it rest
                </button>
              )}
            </m.p>
          </header>

          <div className="st-msgs" aria-live="polite">
            {loaded && !tail.length && !pending.length && (
              <p className="st-quiet">
                You and {name} have not spoken yet. Write below; {awake ? `${name} is listening.` : `${name} will read it on waking.`}
              </p>
            )}
            {!loaded && !tail.length && <p className="st-quiet">Opening the conversation…</p>}
            {tail.map((msg, i) => {
              const w = who(msg)
              return <Row key={msg.id} msg={msg} label={w.label} me={w.me} reduced={sp.reduced} delay={sp.reduced ? 0 : Math.max(0, i - (tail.length - 6)) * 0.04} when={ago(msg.created_at, now)} />
            })}
            {pending.map((p) => (
              <m.article key={p.tempId} className="st-msg" data-me="true" initial={sp.reduced ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={sp.soft}>
                <div className="st-msg-who">
                  <b>You</b>
                  <span>
                    {p.status === 'sending' ? (
                      'sending…'
                    ) : (
                      <>
                        not sent ·{' '}
                        <button className="st-link" onClick={() => void retry(id, p.tempId)}>
                          try again
                        </button>
                      </>
                    )}
                  </span>
                </div>
                <p className="st-msg-text">{p.text}</p>
              </m.article>
            ))}
            {busy && (
              <m.p className="st-quiet" style={{ fontSize: 18 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={sp.fade} role="status">
                <span className="st-dot" data-state="thinking" style={{ ['--c' as string]: inkOf(agent.hue), marginRight: 14, display: 'inline-block' }} aria-hidden>
                  <i />
                  <i />
                </span>
                {name} is {phase === 'llm' ? 'thinking' : 'working'}…
              </m.p>
            )}
          </div>
        </div>
      </div>

      {/* the reading room covers Still's own question box, so the host's floating line takes over at the bottom: the
          composer ends above it (the room the shared phone sheet keeps, ui/overlays), never under it */}
      <div className="st-compose-wrap" style={{ paddingBottom: `max(18px, ${ASK_RESERVE})` }}>
        <div className="st-read-col">
          <div className="st-compose">
            <textarea
              ref={box}
              rows={1}
              value={text}
              placeholder={`Write to ${name}…`}
              aria-label={`Write to ${name}`}
              onChange={(e) => {
                setText(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = `${Math.min(180, e.target.scrollHeight)}px`
              }}
              onKeyDown={onKey}
            />
            <button className="st-send" disabled={!text.trim()} onClick={send}>
              Send
            </button>
          </div>
        </div>
      </div>
    </m.section>
  )
}

/** A message body: statements and truth numbers read as English; "Show as written" gives the original (uifix-r3). */
const Prose = memo(function Prose({ text }: { text: string }) {
  const pieces = plainPieces(text)
  return (
    <p className="st-msg-text">
      {pieces.map((p, j) =>
        p.raw !== undefined ? (
          <span key={j} className="st-stmt">
            {p.t}
          </span>
        ) : (
          <span key={j}>{p.t}</span>
        ),
      )}
      {pieces.some((p) => p.raw !== undefined) && <AsWritten text={text} />}
    </p>
  )
})

/** One message. Memoised: a busy hive re-renders the page often, the words themselves rarely change. */
const ROW_SPRING = { type: 'spring' as const, stiffness: 170, damping: 26 }
const Row = memo(function Row({ msg, label, me, delay, when, reduced }: { msg: Message; label: string; me: boolean; delay: number; when: string; reduced: boolean }) {
  return (
    <m.article className="st-msg" data-me={me} initial={reduced ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={reduced ? { duration: 0 } : { ...ROW_SPRING, delay }}>
      <div className="st-msg-who">
        <b>{healthCheck(msg) ? <HealthCheckLabel className="" /> : label}</b>
        <span>{when}</span>
      </div>
      <Prose text={msg.text} />
    </m.article>
  )
})
