import { healthCheck } from '../../lib/healthQuestion'
import { HealthCheckLabel } from '../../ui/HealthCheckLabel'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useDraft } from '../drafts'
import { AnimatePresence, m } from 'framer-motion'
import { asWritten, AsWritten, beliefText, closeToHome, compareSureness, hsl, openClassic, PlainText, plainText, shown, Sureness, useHive, useReducedMotion, type Agent, type Approval, type Belief, type Message } from '../sdk'
import type { Trace } from '../../api/types'
import { statusWord } from './layout'
import { pulseQueue, useCosmos } from './state'
import { ASK_RESERVE } from '../../ui/overlays'
import { guardComposing } from '../../features/ask/keys'

const EMPTY_M: Message[] = []
const EMPTY_P: never[] = []
const clock = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '--:--' : d.toTimeString().slice(0, 8)
}
const pad = (n: number, w = 2) => String(Math.max(0, Math.round(n))).padStart(w, '0')

/* ------------------------------------------------------------ shared bits */

export function Corners() {
  return (
    <>
      <i />
      <i />
      <i />
      <i />
    </>
  )
}

export function Orb({ hue, lit, size = 28, busy }: { hue: number; lit: boolean; size?: number; busy?: boolean }) {
  return (
    <span
      aria-hidden
      className="relative inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: lit
          ? `radial-gradient(circle at 35% 30%, ${hsl(hue, 95, 82)}, ${hsl(hue, 80, 50)} 45%, ${hsl(hue + 20, 70, 14)} 100%)`
          : `radial-gradient(circle at 35% 30%, hsl(215 30% 70%), hsl(220 25% 30%) 50%, hsl(225 30% 8%) 100%)`,
        boxShadow: lit ? `0 0 ${busy ? 22 : 12}px ${hsl(hue, 95, 60, busy ? 0.75 : 0.45)}` : 'none',
      }}
    >
      {busy && <span className="cx-ping absolute inset-0 rounded-full" style={{ border: `1px solid ${hsl(hue, 95, 75)}` }} />}
    </span>
  )
}

/** Holographic unfold: the panel resolves out of a scan line. */
export function Holo({ children, className, style, hue, label, side }: { children: ReactNode; className?: string; style?: CSSProperties; hue: number; label: string; side: 'right' | 'bottom' | 'top' }) {
  const reduced = useReducedMotion()
  const from = side === 'right' ? { opacity: 0, x: 40, clipPath: 'inset(48% 0 48% 0)' } : side === 'top' ? { opacity: 0, y: -20, clipPath: 'inset(0 0 100% 0)' } : { opacity: 0, y: 60, clipPath: 'inset(0 0 0 0)' }
  return (
    <m.section
      // a panel beside the galaxy, not a modal: the galaxy, navigator and deck stay usable around it (decisions are the
      // shared, contained DecisionDialog); a named region, so it is announced and reachable as a landmark
      role="region"
      aria-label={label}
      data-cx-occlude=""
      initial={reduced ? false : from}
      animate={{ opacity: 1, x: 0, y: 0, clipPath: 'inset(0% 0 0% 0)' }}
      exit={reduced ? { opacity: 0 } : { ...from, transition: { duration: 0.22 } }}
      transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}
      className={`cx-glass cx-corners flex flex-col ${className ?? ''}`}
      style={{ ...style, ['--cx-hue' as string]: hsl(hue, 95, 70) }}
    >
      <Corners />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${hsl(hue, 95, 70)}, transparent)` }} />
      {children}
    </m.section>
  )
}

/* Text that decodes itself in when it arrives live. */
const GLYPHS = '▚▞▙▟░▒#*+<>/\\=01'
function Decode({ text: raw, live }: { text: string; live: boolean }) {
  // uifix-r3 (S3): the decoded words are the plain ones; "Show as written" keeps the original once it has landed
  const text = useMemo(() => plainText(raw), [raw])
  const reduced = useReducedMotion()
  const [n, setN] = useState(live && !reduced ? 0 : text.length)
  useEffect(() => {
    if (!live || reduced) return
    let raf = 0
    const t0 = performance.now()
    const dur = Math.min(1400, 250 + text.length * 9)
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / dur)
      setN(Math.floor(text.length * k))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [text, live, reduced])
  if (n >= text.length) return <PlainText text={raw} />
  const tail = text.slice(n, n + 6).replace(/\S/g, (_, i: number) => GLYPHS[(i * 7 + n) % GLYPHS.length])
  return (
    <>
      {text.slice(0, n)}
      <span style={{ opacity: 0.55 }}>{tail}</span>
    </>
  )
}

export function Bar({ value, hue, label }: { value: number; hue: number; label: string }) {
  return (
    <span className="relative block h-[3px] w-full overflow-hidden" style={{ background: 'rgba(160,196,255,0.14)' }} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={1} aria-valuenow={value}>
      <span className="absolute inset-y-0 left-0" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`, background: hsl(hue, 90, 66), boxShadow: `0 0 8px ${hsl(hue, 95, 60)}` }} />
    </span>
  )
}

export function BeliefRow({ b, as: Tag = 'li' }: { b: Belief; as?: 'li' | 'div' }) {
  return (
    <Tag className="py-2.5">
      <p className="cx-selectable text-[13.5px] leading-snug" style={{ color: 'var(--cx-ink)' }}>
        {beliefText(b.statement)}
      </p>
      <div className="mt-1.5 grid grid-cols-[auto_1fr_auto_1fr] items-center gap-x-2 cx-mono text-[10.5px]" style={{ color: 'var(--cx-ink-3)' }} aria-hidden="true">
        {/* uifix-r3.4 (Kimi 3): the two numbers, each named for what it is; how sure is the word below, not a bar colour */}
        <span>LIKELIHOOD</span>
        <Bar value={b.tv.f} hue={212} label="likelihood" />
        <span>CONFIDENCE</span>
        <Bar value={b.tv.c} hue={190} label="confidence" />
      </div>
      <div className="mt-1 text-[11px]" style={{ color: 'var(--cx-ink-3)' }}>
        <Sureness tv={b.tv} /> · {b.sources.length} {b.sources.length === 1 ? 'source' : 'sources'}
        <AsWritten text={asWritten(b.statement, b.tv)} />
      </div>
    </Tag>
  )
}

/* ------------------------------------------------------------ decisions */

const riskHue: Record<string, number> = { low: 168, medium: 38, high: 2 }

/**
 * A request as a transmission card: who, skill, risk, the request and the reason, for finding and reading. It never
 * answers: "Review and answer" opens the shared decision dialog (experiences/ApprovalDecision, Review R2/R3), bound to
 * the request exactly as it was when opened.
 */
export function DecisionCard({ a, compact }: { a: Approval; compact?: boolean }) {
  const agent = useHive((s) => s.agents[a.agent_id])
  const deciding = useHive((s) => s.deciding[a.id])
  const answer = useCosmos((s) => s.answer)
  // the session this card was shown under: the answer goes only there (Surface O, as Flux)
  const session = useHive((s) => s.session)
  const go = useCosmos((s) => s.go)
  const hue = riskHue[a.risk] ?? 38
  const pending = a.status === 'pending'
  const who = agent ? shown(agent.name) : 'A mind'
  return (
    <m.li
      layout
      data-cx-decision={a.id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: deciding === 'deny' || deciding === 'never' ? -30 : 30, transition: { duration: 0.25 } }}
      className="relative border p-3.5"
      style={{ borderColor: 'var(--cx-line)', background: 'rgba(8,14,30,0.55)', boxShadow: `inset 3px 0 0 ${hsl(hue, 95, 62)}` }}
    >
      <div className="flex items-center gap-2">
        <span className="cx-mono text-[10px] px-1.5 py-0.5" style={{ background: hsl(hue, 95, 62), color: '#0a0600', fontWeight: 600, letterSpacing: '0.14em' }}>
          {a.risk.toUpperCase()}
        </span>
        <span className="cx-caps min-w-0 text-[11px] [overflow-wrap:anywhere]" style={{ color: 'var(--cx-ink-2)' }}>
          {a.skill}
        </span>
        <span className="ml-auto cx-mono text-[10.5px]" style={{ color: 'var(--cx-ink-3)' }}>
          {clock(a.created_at)}
        </span>
      </div>
      {!compact && agent && (
        <button className="mt-2 flex items-center gap-2 cx-focus" onClick={() => go({ kind: 'mind', id: agent.id })} aria-label={`Fly to ${shown(agent.name)}`}>
          <Orb hue={agent.hue} lit={agent.status === 'awake'} size={14} />
          <span className="cx-caps text-[11px]" style={{ color: hsl(agent.hue, 90, 80) }}>
            {shown(agent.name)}
          </span>
          <span className="text-[12px]" style={{ color: 'var(--cx-ink-3)' }}>
            requests clearance
          </span>
        </button>
      )}
      <pre className="cx-mono cx-selectable mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all p-2 text-[12px] leading-relaxed" style={{ background: 'rgba(0,0,0,0.35)', color: '#d6e4ff', border: '1px solid var(--cx-line)' }}>
        {a.command}
      </pre>
      {a.reason && (
        <p className="mt-2 text-[12.5px] leading-snug [overflow-wrap:anywhere]" style={{ color: 'var(--cx-ink-2)' }}>
          {a.reason}
        </p>
      )}
      {pending ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="cx-btn cx-btn-hue" data-cx-review={a.id} style={{ ['--cx-hue' as string]: hsl(hue, 95, 66) }} disabled={!!deciding} onClick={() => answer(a, session)} aria-label={`Review and answer: ${who} asks to use ${a.skill}`}>
            {deciding ? 'Transmitting…' : 'Review and answer'}
          </button>
        </div>
      ) : (
        <p className="mt-2 cx-mono text-[11px]" style={{ color: a.status === 'approved' || a.status === 'used' ? hsl(150, 70, 70) : hsl(2, 80, 75) }}>
          {a.status.toUpperCase()}
          {a.decided_by ? ` · ${a.decided_by}` : ''}
        </p>
      )}
    </m.li>
  )
}

export function ApprovalsPanel({ desktop }: { desktop: boolean }) {
  const approvals = useHive((s) => s.approvals)
  const pending = useMemo(() => Object.values(approvals).filter((a) => a.status === 'pending').sort((a, b) => b.created_at.localeCompare(a.created_at)), [approvals])
  return (
    <Holo
      hue={38}
      label="Incoming transmissions"
      side="top"
      className="fixed z-30"
      style={desktop ? { top: 76, left: '50%', width: 560, marginLeft: -280, maxHeight: 'calc(100dvh - 92px - var(--ask-room, 88px))' } : { top: 64, left: 8, right: 8, maxHeight: 'calc(100dvh - 72px - var(--ask-room, 78px) - var(--sab, 0px))' }}
    >
      <header className="flex items-center gap-3 px-4 pt-4 pb-3">
        <span className="relative grid size-3 place-items-center">
          <span className="absolute size-3 rounded-full cx-ping" style={{ background: 'var(--cx-amber)' }} />
          <span className="size-2 rounded-full" style={{ background: 'var(--cx-amber)' }} />
        </span>
        <h2 data-cx-incoming tabIndex={-1} className="cx-wide text-[12px] outline-none" style={{ color: 'var(--cx-amber)', letterSpacing: '0.34em' }}>
          Incoming
        </h2>
        <span className="cx-mono text-[11px]" style={{ color: 'var(--cx-ink-3)' }}>
          {pad(pending.length)} AWAITING CLEARANCE
        </span>
        <button className="cx-icon-btn ml-auto cx-icon-sm" aria-label="Close incoming transmissions" onClick={closeToHome}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </header>
      <div className="cx-rule" />
      <div className="cx-scroll min-h-0 flex-1 px-4 pt-3 pb-[calc(max(64px,var(--ask-room,0px))+var(--sab,0px))] [@media(min-width:768px)_and_(min-height:560px)]:pb-3">
        {pending.length ? (
          <ul className="flex flex-col gap-2.5">
            <AnimatePresence initial={false}>
              {pending.map((a) => (
                <DecisionCard key={a.id} a={a} />
              ))}
            </AnimatePresence>
          </ul>
        ) : (
          <div className="py-10 text-center">
            <div className="cx-wide text-[11px]" style={{ color: 'var(--cx-ink-2)' }}>
              Channel clear
            </div>
            <p className="mt-2 text-[13px]" style={{ color: 'var(--cx-ink-3)' }}>
              No mind is waiting on you. Requests for clearance appear here as they arrive.
            </p>
          </div>
        )}
      </div>
      <div className="cx-rule" />
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="cx-mono text-[10.5px]" style={{ color: 'var(--cx-ink-3)' }}>
          A · toggle   ESC · close
        </span>
        <button className="cx-btn cx-btn-sm" onClick={() => useCosmos.getState().setDeck('decisions', { tab: 'history' })}>
          History & rules
        </button>
      </div>
    </Holo>
  )
}

/* ------------------------------------------------------------ the mind: a transmission */

type Tab = 'comms' | 'beliefs' | 'log' | 'vitals'

export function MindPanel({ id, desktop }: { id: string; desktop: boolean }) {
  const agent = useHive((s) => s.agents[id])
  const swarm = useHive((s) => (agent?.swarm_id ? s.swarms[agent.swarm_id] : undefined))
  const [tab, setTab] = useState<Tab>('comms')
  if (!agent) return null
  return (
    <Holo
      key={id}
      hue={agent.hue}
      label={`Transmission with ${shown(agent.name)}`}
      side={desktop ? 'right' : 'bottom'}
      className="fixed z-20"
      style={desktop ? { top: 76, right: 20, bottom: 'max(20px, var(--ask-room, 0px))', width: 440 } : { left: 0, right: 0, bottom: 0, height: '58%', borderLeft: 0, borderRight: 0, borderBottom: 0 }}
    >
      <MindHeader agent={agent} swarmName={swarm ? shown(swarm.name) : 'Deep space'} onClose={closeToHome} />
      <div role="tablist" aria-label="Transmission sections" className="flex gap-1 px-4">
        {(['comms', 'beliefs', 'log', 'vitals'] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className="cx-caps relative px-2.5 py-2 text-[10.5px]"
            style={{ color: tab === t ? '#fff' : 'var(--cx-ink-3)', letterSpacing: '0.22em' }}
          >
            {t === 'comms' ? 'Comms' : t === 'beliefs' ? 'Beliefs' : t === 'log' ? 'Log' : 'Vitals'}
            {tab === t && <m.span layoutId="cx-tab" className="absolute inset-x-1 -bottom-px h-[2px]" style={{ background: hsl(agent.hue, 95, 70), boxShadow: `0 0 10px ${hsl(agent.hue, 95, 60)}` }} />}
          </button>
        ))}
      </div>
      <div className="cx-rule" />
      {tab === 'comms' && <Comms agent={agent} />}
      {tab === 'beliefs' && <SwarmBeliefs swarmId={agent.swarm_id} />}
      {tab === 'log' && <Log agent={agent} />}
      {tab === 'vitals' && <Vitals agent={agent} />}
      {/* on a phone the panel reaches the bottom edge: its content (the composer, each tab's list) ends above the universal
          Ask and the OS clock, which stay on screen over it, the same room the shared phone sheet keeps (ui/Sheet, ui/overlays) */}
      {!desktop && <div aria-hidden className="shrink-0" data-ask-reserve="" style={{ height: `max(${ASK_RESERVE}, var(--os-clock-lift, 0px))` }} />}
    </Holo>
  )
}

function MindHeader({ agent, swarmName, onClose }: { agent: Agent; swarmName: string; onClose: () => void }) {
  const thinking = useHive((s) => s.thinking[agent.id])
  const act = useHive((s) => s.agentAction)
  const [busy, setBusy] = useState(false)
  const lit = agent.status === 'awake'
  const word = statusWord(agent, thinking)
  const action = agent.status === 'awake' ? 'sleep' : agent.status === 'asleep' ? 'wake' : agent.status === 'starting' ? null : 'start'
  const run = async () => {
    if (!action) return
    setBusy(true)
    try {
      await act(agent.id, action)
    } finally {
      setBusy(false)
    }
  }
  return (
    <header className="flex items-start gap-3 px-4 pt-4 pb-3">
      <Orb hue={agent.hue} lit={lit || agent.status === 'starting'} size={38} busy={thinking === 'llm' || thinking === 'skills'} />
      <div className="min-w-0 flex-1">
        <div className="cx-mono text-[10px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.18em' }}>
          TRANSMISSION · {swarmName.toUpperCase()}
        </div>
        <h2 className="cx-wide mt-0.5 truncate text-[17px]" style={{ letterSpacing: '0.3em', color: '#fff' }}>
          {shown(agent.name)}
        </h2>
        <div className="mt-1 flex items-center gap-2 cx-mono text-[10.5px]" style={{ color: 'var(--cx-ink-2)' }}>
          <span className="inline-flex items-center gap-1.5" style={{ color: lit ? hsl(agent.hue, 95, 80) : agent.status === 'error' ? hsl(2, 90, 72) : 'var(--cx-ink-2)' }}>
            <span className={`size-1.5 rounded-full ${thinking && thinking !== 'idle' ? 'cx-blink' : ''}`} style={{ background: 'currentColor' }} />
            {word}
          </span>
          <span aria-hidden>·</span>
          <span className="truncate">{agent.model.split('/').pop()?.toUpperCase()}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {action && (
          <button className="cx-btn cx-btn-hue cx-btn-md !px-3" style={{ ['--cx-hue' as string]: hsl(agent.hue, 90, 66) }} disabled={busy} onClick={() => void run()} aria-label={`${action === 'sleep' ? 'Put' : action === 'wake' ? 'Wake' : 'Start'} ${shown(agent.name)}${action === 'sleep' ? ' to sleep' : ''}`}>
            {action === 'sleep' ? 'Sleep' : action === 'wake' ? 'Wake' : 'Ignite'}
          </button>
        )}
        <button className="cx-icon-btn cx-icon-sm" aria-label="Close transmission" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </div>
    </header>
  )
}

const SUGGEST = ['What are you working on?', 'What have you learned today?', 'Anything you need from me?']

function Comms({ agent }: { agent: Agent }) {
  const id = agent.id
  const messages = useHive((s) => s.messages[id] ?? EMPTY_M)
  const pending = useHive((s) => s.pending[id] ?? EMPTY_P)
  const loaded = useHive((s) => !!s.messagesLoaded[id])
  const fresh = useHive((s) => s.freshMessages)
  const thinking = useHive((s) => s.thinking[id])
  const agents = useHive((s) => s.agents)
  const approvals = useHive((s) => s.approvals)
  const load = useHive((s) => s.loadMessages)
  const send = useHive((s) => s.sendMessage)
  const retry = useHive((s) => s.retryMessage)
  const [text, setText] = useDraft(`cosmos:mind:${id}`)
  const [err, setErr] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const asks = useMemo(() => Object.values(approvals).filter((a) => a.agent_id === id && a.status === 'pending'), [approvals, id])
  const busy = thinking === 'llm' || thinking === 'skills'
  useEffect(() => {
    load(id).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not open the channel'))
  }, [id, load])
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, pending.length, busy, loaded])
  const submit = (t = text) => {
    const v = t.trim()
    if (!v) return
    setText('')
    pulseQueue.push({ from: 'you', to: id, hue: agent.hue })
    void send(id, v)
  }
  const recent = messages.slice(-80)
  return (
    <>
      {asks.length > 0 && (
        <ul className="cx-scroll flex max-h-[42%] shrink-0 flex-col gap-2 px-4 pt-3" aria-label="Waiting on your clearance">
          <AnimatePresence initial={false}>
            {asks.map((a) => (
              <DecisionCard key={a.id} a={a} compact />
            ))}
          </AnimatePresence>
        </ul>
      )}
      <div ref={scroller} className="cx-scroll min-h-0 flex-1 px-4 py-3" aria-live="polite">
        {err ? (
          <div className="py-8 text-center">
            <p className="cx-caps text-[11px]" style={{ color: hsl(2, 90, 75) }}>
              Signal lost
            </p>
            <p className="mt-1 text-[13px]" style={{ color: 'var(--cx-ink-2)' }}>
              {err}
            </p>
            <button className="cx-btn mt-3" onClick={() => load(id).then(() => setErr(null), () => undefined)}>
              Retry
            </button>
          </div>
        ) : !loaded && !messages.length ? (
          <div className="flex items-center gap-2 py-8 cx-mono text-[11px]" style={{ color: 'var(--cx-ink-3)' }}>
            <span className="cx-blink">▮</span> ACQUIRING SIGNAL…
          </div>
        ) : !recent.length && !pending.length ? (
          <div className="py-6">
            <p className="cx-wide text-[11px]" style={{ color: hsl(agent.hue, 90, 80) }}>
              Open a channel
            </p>
            <p className="mt-2 text-[13.5px]" style={{ color: 'var(--cx-ink-2)' }}>
              Nothing has passed between you and {shown(agent.name)} yet. Say something.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {SUGGEST.map((s) => (
                <button key={s} className="cx-btn cx-btn-md !normal-case !tracking-normal !text-[12.5px] !font-normal" onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="flex flex-col gap-3">
            {recent.map((msg) => {
              const mine = msg.direction === 'in' && !msg.sender.startsWith('agent:') && !healthCheck(msg)
              const peer = msg.direction === 'in' && msg.sender.startsWith('agent:') ? agents[msg.sender.slice(6)] : undefined
              return (
                <li key={msg.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                  <div className="cx-mono mb-1 text-[9.5px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.16em' }}>
                    {healthCheck(msg) ? <HealthCheckLabel className="" upper /> : mine ? 'YOU' : peer ? `FROM ${shown(peer.name).toUpperCase()}` : shown(agent.name).toUpperCase()} · {clock(msg.created_at)}
                  </div>
                  <div
                    className="cx-selectable max-w-[88%] whitespace-pre-wrap break-words px-3 py-2 text-[14px] leading-relaxed"
                    style={
                      mine
                        ? { background: 'rgba(140,180,255,0.1)', border: '1px solid var(--cx-line)', color: '#eef4ff' }
                        : { borderLeft: `2px solid ${hsl(peer?.hue ?? agent.hue, 90, 66)}`, background: `linear-gradient(90deg, ${hsl(peer?.hue ?? agent.hue, 90, 50, 0.12)}, transparent)`, color: '#eef4ff' }
                    }
                  >
                    <Decode text={msg.text} live={!mine && !!fresh[msg.id]} />
                  </div>
                </li>
              )
            })}
            {pending.map((p) => (
              <li key={p.tempId} className="flex flex-col items-end">
                <div className="cx-mono mb-1 text-[9.5px]" style={{ color: p.status === 'failed' ? hsl(2, 90, 75) : 'var(--cx-ink-3)', letterSpacing: '0.16em' }}>
                  {p.status === 'sending' ? 'TRANSMITTING…' : `NOT DELIVERED${p.error ? ` · ${p.error}` : ''}`}
                </div>
                <div className="max-w-[88%] whitespace-pre-wrap px-3 py-2 text-[14px] leading-relaxed" style={{ background: 'rgba(140,180,255,0.07)', border: `1px ${p.status === 'failed' ? 'solid' : 'dashed'} ${p.status === 'failed' ? hsl(2, 90, 62) : 'var(--cx-line-2)'}`, opacity: p.status === 'sending' ? 0.75 : 1 }}>
                  {p.text}
                </div>
                {p.status === 'failed' && (
                  <button className="cx-btn mt-1.5 cx-btn-sm" onClick={() => void retry(id, p.tempId)}>
                    Retry
                  </button>
                )}
              </li>
            ))}
            {busy && (
              <li className="flex items-center gap-2 cx-mono text-[10.5px]" style={{ color: hsl(agent.hue, 95, 80), letterSpacing: '0.18em' }} aria-label={`${shown(agent.name)} is ${thinking === 'llm' ? 'thinking' : 'using skills'}`}>
                <span className="flex items-end gap-[2px]" aria-hidden>
                  {[0, 1, 2, 3].map((i) => (
                    <i key={i} className="cx-bar" style={{ animationDelay: `${i * 0.1}s` }} />
                  ))}
                </span>
                {thinking === 'llm' ? 'RECEIVING' : 'ACTING'}
              </li>
            )}
          </ol>
        )}
      </div>
      <form
        className="cx-clear-escape shrink-0 px-3 pt-2 pb-3"
        style={{ borderTop: '1px solid var(--cx-line)' }}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {agent.status !== 'awake' && (
          <p className="mb-1.5 px-1 cx-mono text-[10.5px]" style={{ color: 'var(--cx-ink-3)' }}>
            {agent.status === 'asleep' ? 'DORMANT · a transmission will wake it' : `${statusWord(agent)} · messages wait in the queue`}
          </p>
        )}
        <div className="cx-composer flex items-end gap-2 border px-3 py-2 transition-shadow" style={{ borderColor: 'var(--cx-line-2)', background: 'rgba(0,0,0,0.3)' }}>
          <span aria-hidden className="cx-mono pb-[3px] text-[13px]" style={{ color: hsl(agent.hue, 95, 72) }}>
            ›
          </span>
          <textarea
            className="cx-input cx-selectable"
            rows={1}
            value={text}
            placeholder={`Transmit to ${shown(agent.name)}…`}
            aria-label={`Message ${shown(agent.name)}`}
            onChange={(e) => {
              setText(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !guardComposing(e)) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <button type="submit" className="cx-btn cx-btn-hue cx-btn-md !px-3" style={{ ['--cx-hue' as string]: hsl(agent.hue, 90, 66) }} disabled={!text.trim()} aria-label="Send">
            Send
          </button>
        </div>
      </form>
    </>
  )
}

function SwarmBeliefs({ swarmId }: { swarmId: string | null }) {
  const beliefs = useHive((s) => (swarmId ? s.beliefs[swarmId] : undefined))
  const loaded = useHive((s) => (swarmId ? !!s.beliefsLoaded[swarmId] : true))
  const list = useMemo(() => Object.values(beliefs ?? {}).sort((a, b) => compareSureness(b.tv, a.tv) || a.statement.localeCompare(b.statement)), [beliefs])
  return (
    <div className="cx-scroll min-h-0 flex-1 px-4 pt-2 pb-2">
      {!swarmId ? (
        <p className="py-6 text-[13.5px]" style={{ color: 'var(--cx-ink-2)' }}>
          A drifter belongs to no system, so it shares no beliefs. What it carries it says in comms.
        </p>
      ) : !loaded ? (
        <p className="py-6 cx-mono text-[11px]" style={{ color: 'var(--cx-ink-3)' }}>
          CHARTING BELIEFS…
        </p>
      ) : !list.length ? (
        <p className="py-6 text-[13.5px]" style={{ color: 'var(--cx-ink-2)' }}>
          No beliefs charted in this system yet. They appear as a glittering belt around its star.
        </p>
      ) : (
        <>
          <p className="pt-2 cx-mono text-[10.5px]" style={{ color: 'var(--cx-ink-3)' }}>
            {pad(list.length)} SHARED BELIEFS · BELT COLOUR = TRUTH, BRIGHTNESS = CONFIDENCE
          </p>
          <ul className="divide-y" style={{ borderColor: 'var(--cx-line)' }}>
            {list.map((b) => (
              <BeliefRow key={b.statement} b={b} />
            ))}
          </ul>
          <button className="cx-btn my-3" onClick={() => openClassic({ name: 'swarm', id: swarmId })}>
            Open the swarm
          </button>
        </>
      )}
    </div>
  )
}

const EMPTY_T: Trace[] = []

/** The flight recorder: what the mind did, iteration by iteration (its traces). */
function Log({ agent }: { agent: Agent }) {
  const traces = useHive((s) => s.traces[agent.id] ?? EMPTY_T)
  const loaded = useHive((s) => !!s.tracesLoaded[agent.id])
  const load = useHive((s) => s.loadTraces)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => {
    load(agent.id).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'The recorder is unreachable'))
  }, [agent.id, load])
  const list = useMemo(() => [...traces].reverse().slice(0, 60), [traces])
  return (
    <div className="cx-scroll min-h-0 flex-1 px-4 pt-3 pb-3">
      {err ? (
        <p className="py-6 text-[13px]" style={{ color: hsl(2, 90, 78) }}>
          {err}
        </p>
      ) : !loaded && !list.length ? (
        <p className="py-6 cx-mono text-[11px]" style={{ color: 'var(--cx-ink-3)' }}>
          <span className="cx-blink">▮</span> READING THE FLIGHT RECORDER…
        </p>
      ) : !list.length ? (
        <p className="py-6 text-[13.5px]" style={{ color: 'var(--cx-ink-2)' }}>
          Nothing recorded yet. Each time {shown(agent.name)} thinks, a line appears here.
        </p>
      ) : (
        <ol className="flex flex-col">
          {list.map((t) => (
            <li key={t.id} className="border-b py-2" style={{ borderColor: 'var(--cx-line)' }}>
              <button className="w-full text-left" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>
                <span className="cx-mono flex items-center gap-2 text-[10px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.12em' }}>
                  <span style={{ color: hsl(agent.hue, 90, 78) }}>#{t.iteration}</span>
                  {clock(t.created_at)}
                  {t.commands.length > 0 && <span>· {t.commands.length} CMD</span>}
                  {t.tokens != null && <span>· {t.tokens} TOK</span>}
                  {t.llm_ms != null && <span>· {(t.llm_ms / 1000).toFixed(1)}S</span>}
                </span>
                <span className={`mt-0.5 block text-[13px] leading-snug ${open === t.id ? 'whitespace-pre-wrap break-words' : 'truncate'}`} style={{ color: 'var(--cx-ink)' }}>
                  {t.input ? `› ${t.input}` : t.response.slice(0, open === t.id ? undefined : 160) || '(no output)'}
                </span>
              </button>
              {open === t.id && (
                <div className="cx-selectable mt-1.5">
                  {t.input && (
                    <p className="text-[12.5px] leading-snug whitespace-pre-wrap break-words" style={{ color: 'var(--cx-ink-2)' }}>
                      {t.response}
                    </p>
                  )}
                  {t.commands.map((c, i) => (
                    <pre key={i} className="cx-mono mt-1.5 overflow-x-auto whitespace-pre-wrap break-all p-2 text-[11.5px]" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid var(--cx-line)', color: '#d6e4ff' }}>
                      {c.command}
                      {c.result ? `\n→ ${c.result.slice(0, 400)}` : ''}
                    </pre>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      <button className="cx-btn my-3" onClick={() => openClassic({ name: 'dot', id: agent.id, tab: 'mind' })}>
        Full record ↗
      </button>
    </div>
  )
}

function Vitals({ agent }: { agent: Agent }) {
  const rows: [string, string][] = [
    ['CLASS', agent.kind.toUpperCase()],
    ['MODEL', agent.model],
    ['STATUS', agent.status.toUpperCase()],
    ['SPENT', `$${agent.spent_usd.toFixed(2)}${agent.budget_usd ? ` / $${agent.budget_usd.toFixed(2)}` : ''}`],
    ['LAST SIGNAL', agent.last_active_at ? `${agent.last_active_at.slice(0, 10)} ${clock(agent.last_active_at)}` : '—'],
    ['IGNITED', agent.created_at.slice(0, 10)],
  ]
  return (
    <div className="cx-scroll min-h-0 flex-1 px-4 pt-3 pb-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="cx-mono text-[10.5px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.16em' }}>
              {k}
            </dt>
            <dd className="cx-mono cx-selectable truncate text-[12px]" style={{ color: 'var(--cx-ink)' }}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      {agent.budget_usd > 0 && (
        <div className="mt-3">
          <Bar value={agent.spent_usd / agent.budget_usd} hue={agent.spent_usd / agent.budget_usd > 0.85 ? 2 : agent.hue} label="budget used" />
        </div>
      )}
      {agent.last_error && (
        <p className="mt-3 border p-2 cx-mono text-[11.5px]" style={{ borderColor: hsl(2, 80, 55, 0.5), color: hsl(2, 90, 80) }}>
          {agent.last_error}
        </p>
      )}
      {agent.persona && (
        <>
          <div className="cx-caps mt-4 text-[10px]" style={{ color: 'var(--cx-ink-3)' }}>
            Persona
          </div>
          <p className="cx-selectable mt-1.5 text-[13.5px] leading-relaxed" style={{ color: 'var(--cx-ink-2)' }}>
            {agent.persona}
          </p>
        </>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="cx-btn" onClick={() => openClassic({ name: 'dot', id: agent.id })}>
          Full dossier
        </button>
        <button className="cx-btn" onClick={() => openClassic({ name: 'dot', id: agent.id, tab: 'memory' })}>
          Memory
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ a star system */

export function SystemPanel({ id, desktop }: { id: string; desktop: boolean }) {
  const swarm = useHive((s) => s.swarms[id])
  const agents = useHive((s) => s.agents)
  const thinking = useHive((s) => s.thinking)
  const beliefs = useHive((s) => s.beliefs[id])
  const goals = useHive((s) => s.goals)
  const go = useCosmos((s) => s.go)
  const top = useMemo(() => Object.values(beliefs ?? {}).sort((a, b) => compareSureness(b.tv, a.tv)).slice(0, desktop ? 5 : 0), [beliefs, desktop])
  if (!swarm) return null
  const members = swarm.member_ids.map((m) => agents[m]).filter(Boolean)
  const lit = members.filter((a) => a.status === 'awake').length
  const open = Object.values(goals).filter((g) => g.swarm_id === id && (g.status === 'open' || g.status === 'claimed' || g.status === 'waiting')).length
  return (
    <Holo
      key={id}
      hue={swarm.hue}
      label={`${shown(swarm.name)} system`}
      side={desktop ? 'right' : 'bottom'}
      className="fixed z-20"
      style={desktop ? { top: 76, right: 20, width: 360, maxHeight: 'calc(100dvh - 170px)' } : { left: 0, right: 0, bottom: 0, maxHeight: '40%', borderLeft: 0, borderRight: 0, borderBottom: 0 }}
    >
      <header className="px-4 pt-4 pb-3">
        <div className="cx-mono text-[10px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.18em' }}>
          STAR SYSTEM
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <h2 className="cx-wide truncate text-[17px]" style={{ letterSpacing: '0.32em', color: '#fff' }}>
            {shown(swarm.name)}
          </h2>
          <button className="cx-icon-btn ml-auto cx-icon-sm shrink-0" aria-label="Back to the galaxy" onClick={() => go({ kind: 'galaxy' })}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        </div>
        {swarm.description && desktop && (
          <p className="mt-1.5 text-[13px] leading-snug" style={{ color: 'var(--cx-ink-2)' }}>
            {swarm.description}
          </p>
        )}
        <div className="mt-2.5 grid grid-cols-4 gap-2">
          {[
            ['WORLDS', members.length],
            ['LIT', lit],
            ['BELIEFS', Object.keys(beliefs ?? {}).length],
            ['TASKS', open],
          ].map(([k, v]) => (
            <div key={k} className="border px-2 py-1.5" style={{ borderColor: 'var(--cx-line)' }}>
              <div className="cx-mono text-[16px]" style={{ color: hsl(swarm.hue, 90, 80) }}>
                {pad(v as number)}
              </div>
              <div className="cx-mono text-[9px]" style={{ color: 'var(--cx-ink-3)', letterSpacing: '0.16em' }}>
                {k}
              </div>
            </div>
          ))}
        </div>
      </header>
      <div className="cx-rule" />
      <div className="cx-scroll min-h-0 flex-1 px-2 py-2">
        <ul className={desktop ? 'flex flex-col' : 'cx-hscroll cx-clear-escape flex gap-1.5 px-2'}>
          {members.map((a) => {
            const t = thinking[a.id]
            const busy = t === 'llm' || t === 'skills'
            return (
              <li key={a.id} className={desktop ? '' : 'shrink-0'}>
                <button className="flex w-full items-center gap-3 px-2 py-2 text-left hover:bg-white/5 cx-focus" onClick={() => go({ kind: 'mind', id: a.id })} aria-label={`Open transmission with ${shown(a.name)}`}>
                  <Orb hue={a.hue} lit={a.status === 'awake'} size={desktop ? 22 : 18} busy={busy} />
                  <span className="min-w-0 flex-1">
                    <span className="cx-caps block truncate text-[11.5px]" style={{ color: '#eef4ff', letterSpacing: '0.2em' }}>
                      {shown(a.name)}
                    </span>
                    <span className="cx-mono block text-[9.5px]" style={{ color: busy ? hsl(a.hue, 95, 80) : 'var(--cx-ink-3)', letterSpacing: '0.14em' }}>
                      {statusWord(a, t)}
                    </span>
                  </span>
                  {desktop && (
                    <span className="cx-mono text-[10px]" style={{ color: 'var(--cx-ink-3)' }}>
                      {a.kind.toUpperCase()}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
        {top.length > 0 && (
          <div className="px-2 pt-3">
            <div className="cx-caps text-[10px]" style={{ color: 'var(--cx-ink-3)' }}>
              Strongest beliefs
            </div>
            <ul className="divide-y" style={{ borderColor: 'var(--cx-line)' }}>
              {top.map((b) => (
                <BeliefRow key={b.statement} b={b} />
              ))}
            </ul>
          </div>
        )}
        {desktop && (
          <div className="flex flex-wrap gap-2 px-2 py-3">
            <button className="cx-btn" onClick={() => openClassic({ name: 'swarm', id })}>
              Open swarm
            </button>
            <button className="cx-btn" onClick={() => useCosmos.getState().setDeck('goals', { swarm: id })}>
              Tasks
            </button>
            <button className="cx-btn" onClick={() => useCosmos.getState().setDeck('beliefs', { swarm: id })}>
              Beliefs
            </button>
          </div>
        )}
      </div>
    </Holo>
  )
}

