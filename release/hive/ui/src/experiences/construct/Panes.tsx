import { healthCheck } from '../../lib/healthQuestion'
import { m } from 'framer-motion'
import { useDraft } from '../drafts'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { beliefText, closeToHome, hsl, plainText, openClassic, shown, useHive, useReducedMotion, type Agent, type Approval, type Goal, type Message } from '../sdk'
import { openSession, run, sendTo } from './commands'
import { Decode } from './Decode'
import { useNow } from './hooks'
import { ago, bar, clock, goalList, orderedMinds, orderedSwarms, pendingList, recentDecided, shortModel, slug, SPARK } from './model'
import { pulse } from './rain'
import { PANE_TITLE, PANES, useC, type PaneId } from './state'
import { guardComposing } from '../../features/ask/keys'

const EMPTY_M: Message[] = []

// ------------------------------------------------------------------ frame

/** The registry feature each pane shows, so the orchestrator can point at it (presence, UNIVERSAL_ASK_DESIGN §9). */
export const PANE_FEATURE: Record<PaneId, string | undefined> = { stream: 'watch.activity', minds: 'minds.see', session: undefined, inbox: 'decide.approvals' }

export function Pane({ id, meta, children, style, boot, alert }: { id: PaneId; meta?: ReactNode; children: ReactNode; style?: CSSProperties; boot: number; alert?: boolean }) {
  const focus = useC((s) => s.focus)
  const glitch = useC((s) => s.glitch[id])
  const reduced = useReducedMotion()
  const morphing = useC((s) => s.morphing)
  const [g, setG] = useState(0)
  const seen = useRef(glitch)
  useEffect(() => {
    if (glitch === seen.current) return
    seen.current = glitch
    if (reduced) return
    const t1 = setTimeout(() => setG((x) => x + 1), 0)
    const t2 = setTimeout(() => setG(0), 720)
    return () => (clearTimeout(t1), clearTimeout(t2))
  }, [glitch, reduced])
  const active = focus === id
  const n = PANES.indexOf(id) + 1
  return (
    <m.section
      layout={!reduced && morphing}
      initial={reduced ? false : { opacity: 0, clipPath: 'inset(50% 0% 50% 0%)' }}
      animate={{ opacity: 1, clipPath: 'inset(0% 0% 0% 0%)' }}
      transition={reduced ? { duration: 0 } : { delay: boot + n * 0.07, duration: 0.42, ease: [0.2, 0.9, 0.1, 1], layout: { type: 'spring', stiffness: 380, damping: 38 } }}
      style={style}
      data-pane={id}
      data-presence-region={id}
      data-presence-feature={PANE_FEATURE[id]}
      className={`cx-pane${active ? ' is-active' : ''}${g ? ' is-glitch' : ''}${alert ? ' is-alert' : ''}`}
      onPointerDown={() => useC.getState().setFocus(id)}
      aria-label={`${PANE_TITLE[id]} pane`}
    >
      <header className="cx-pane-head">
        <span className="cx-pane-n">{String(n).padStart(2, '0')}</span>
        <span className="cx-pane-t">{PANE_TITLE[id]}</span>
        <span className="cx-pane-meta">{meta}</span>
      </header>
      <div className="cx-pane-body">{children}</div>
    </m.section>
  )
}

// ------------------------------------------------------------------ 1 stream

const KIND: Record<string, { tag: string; c: string }> = {
  belief: { tag: 'BELIEF', c: 'hi' },
  message: { tag: 'MSG', c: 'cyan' },
  status: { tag: 'STATE', c: 'txt' },
  error: { tag: 'ERROR', c: 'red' },
  birth: { tag: 'BIRTH', c: 'hi' },
  approval: { tag: 'ASK', c: 'amber' },
  goal: { tag: 'TASK', c: 'hi' },
  wakeup: { tag: 'WAKE', c: 'txt' },
}

export function StreamPane({ boot }: { boot: number }) {
  const activity = useHive((s) => s.activity)
  const agents = useHive((s) => s.agents)
  const seq = useHive((s) => s.activitySeq)
  const [base] = useState(seq)
  const stamps = useRef<number[]>([])
  const last = useRef(seq)
  const [{ spark, rate }, setSpark] = useState({ spark: '·'.repeat(30), rate: 0 })
  useEffect(() => {
    const d = seq - last.current
    last.current = seq
    if (d > 0) for (let i = 0; i < Math.min(d, 20); i++) stamps.current.push(Date.now())
  }, [seq])
  // 30 buckets of 6 s = the last three minutes
  useEffect(() => {
    const compute = () => {
      if (document.hidden) return
      const now = Date.now()
      const b = new Array(30).fill(0)
      stamps.current = stamps.current.filter((t) => now - t < 180000)
      for (const t of stamps.current) b[29 - Math.min(29, Math.floor((now - t) / 6000))]++
      const max = Math.max(1, ...b)
      setSpark({
        spark: b.map((v) => (v ? SPARK[Math.min(7, Math.max(1, Math.round((v / max) * 7)))] : '·')).join(''),
        rate: stamps.current.filter((t) => now - t < 60000).length,
      })
    }
    const t = setInterval(compute, 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <Pane
      id="stream"
      boot={boot}
      meta={
        <>
          <span className="cx-spark" aria-hidden>
            {spark}
          </span>{' '}
          <span className="cx-c-dim">{rate}/min</span>
        </>
      }
    >
      {activity.length === 0 ? (
        <div className="cx-empty">
          <div className="cx-c-hi cx-glow">listening on the hive bus<span className="cx-cursor" /></div>
          <div className="cx-c-dim">beliefs, messages, wakes and requests scroll here as they happen.</div>
        </div>
      ) : (
        <ol className="cx-stream" aria-live="polite" aria-relevant="additions">
          {activity.map((a, i) => {
            const who = a.agent_id ? agents[a.agent_id] : null
            const fresh = a.id > base
            // uifix-r3 (S3): the belief as its sentence, never the notation (this list is a live region: it is read aloud)
            const text = a.statement ? `${plainText(a.text)} “${beliefText(a.statement).replace(/\.$/, '')}”` : plainText(a.text)
            return <EvLine key={a.id} at={a.at} kind={a.kind} name={who ? shown(who.name) : null} hue={who?.hue ?? 0} text={text} fresh={fresh} animate={fresh || i < 14} delay={fresh ? 0 : boot * 1000 + 300 + i * 45} />
          })}
        </ol>
      )}
    </Pane>
  )
}

const EvLine = memo(function EvLine(p: { at: string; kind: string; name: string | null; hue: number; text: string; fresh: boolean; animate: boolean; delay: number }) {
  const k = KIND[p.kind] ?? { tag: p.kind.toUpperCase(), c: 'txt' }
  return (
    <li className={`cx-ev${p.fresh ? ' is-fresh' : ''}`}>
      <span className="cx-c-dim cx-ev-t">{clock(p.at)}</span>
      <span className={`cx-tag cx-c-${k.c}`}>{k.tag}</span>
      <span className="cx-ev-x">
        {p.name && (
          <span className="cx-c-hi">
            <span aria-hidden style={{ color: hsl(p.hue, 90, 64) }}>
              ■{' '}
            </span>
            {p.name}{' '}
          </span>
        )}
        <Decode text={p.text} animate={p.animate} delay={p.delay} className="cx-c-txt" />
      </span>
    </li>
  )
})

// ------------------------------------------------------------------ 2 minds

const STATE_TONE: Record<Agent['status'], string> = { awake: 'hi', starting: 'amber', error: 'red', asleep: 'txt', stopped: 'dim', created: 'dim' }

export function MindsPane({ boot }: { boot: number }) {
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const thinking = useHive((s) => s.thinking)
  const sel = useC((s) => s.mindSel)
  const open = useC((s) => s.mind)
  const focus = useC((s) => s.focus)
  const now = useNow(15000)
  const list = useMemo(() => orderedMinds(agents, swarms), [agents, swarms])
  const awake = list.filter((a) => a.status === 'awake').length
  const busy = list.filter((a) => thinking[a.id] === 'llm' || thinking[a.id] === 'skills').length
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (focus !== 'minds') return
    ref.current?.querySelector('[data-sel="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [sel, focus])
  const act = (a: Agent, verb: 'wake' | 'sleep') => {
    pulse(0.4)
    const action = verb === 'wake' && (a.status === 'stopped' || a.status === 'created' || a.status === 'error') ? 'start' : verb
    void useHive.getState().agentAction(a.id, action)
  }
  return (
    <Pane
      id="minds"
      boot={boot}
      meta={
        <>
          <span className="cx-c-hi">{awake}</span>
          <span className="cx-c-dim">/{list.length} awake</span>
          {busy > 0 && <span className="cx-c-cyan"> · {busy} thinking</span>}
        </>
      }
    >
      {list.length === 0 ? (
        <div className="cx-empty">
          <div className="cx-c-hi">no minds in this hive yet</div>
          <div className="cx-c-dim">
            run <button className="cx-link" onClick={() => openClassic({ name: 'new' })}>page new</button> to bring one to life.
          </div>
        </div>
      ) : (
        <div className="cx-minds" ref={ref} role="listbox" aria-label="Minds">
          <div className="cx-mrow cx-mhead" aria-hidden>
            <span>#</span>
            <span>NAME</span>
            <span>STATE</span>
            <span>PHASE</span>
            <span className="cx-col-model">MODEL</span>
            <span className="cx-col-budget">SPEND</span>
            <span className="cx-col-seen">SEEN</span>
          </div>
          {list.map((a, i) => {
            const head = i === 0 || list[i - 1].swarm_id !== a.swarm_id
            const sw = a.swarm_id ? swarms[a.swarm_id] : null
            const members = head ? list.filter((x) => x.swarm_id === a.swarm_id) : []
            const ph = thinking[a.id]
            const frac = a.budget_usd ? a.spent_usd / a.budget_usd : 0
            const isSel = i === sel
            return (
              <div key={a.id} className="cx-mgroup">
                {head && (
                  <div className="cx-swarm" aria-hidden>
                    <span style={{ color: sw ? hsl(sw.hue, 85, 66) : undefined }}>{sw ? '◆' : '◇'}</span> {sw ? shown(sw.name).toUpperCase() : 'UNSWARMED'}
                    <span className="cx-swarm-rule" />
                    <span className="cx-c-dim">
                      {members.filter((x) => x.status === 'awake').length}/{members.length}
                    </span>
                  </div>
                )}
                <div
                  role="option"
                  aria-selected={isSel}
                  data-sel={isSel ? '1' : undefined}
                  className={`cx-mrow${isSel ? ' is-sel' : ''}${open === a.id ? ' is-open' : ''}`}
                  data-presence-ref={`mind:${a.id}`}
                  onClick={() => {
                    useC.getState().setMindSel(i)
                    openSession(a)
                  }}
                >
                  <span className="cx-c-dim">{String(i + 1).padStart(2, '0')}</span>
                  <span className="cx-mname">
                    <span aria-hidden style={{ color: hsl(a.hue, 90, 64) }}>
                      ■
                    </span>{' '}
                    <span className={open === a.id ? 'cx-c-hi cx-glow' : 'cx-c-hi'}>{shown(a.name)}</span>
                    {open === a.id && <span className="cx-c-cyan"> ◂</span>}
                  </span>
                  <span className={`cx-c-${STATE_TONE[a.status]}${a.status === 'starting' ? ' cx-blink' : ''}`}>{a.status.toUpperCase()}</span>
                  <span>
                    {ph === 'llm' ? (
                      <span className="cx-c-cyan">
                        <span className="cx-spin" aria-hidden /> think
                      </span>
                    ) : ph === 'skills' ? (
                      <span className="cx-c-amber">
                        <span className="cx-gear" aria-hidden>⚙</span> act
                      </span>
                    ) : a.status === 'awake' ? (
                      <span className="cx-c-dim">· idle</span>
                    ) : (
                      <span className="cx-c-dim">—</span>
                    )}
                  </span>
                  <span className="cx-col-model cx-c-dim">{shortModel(a.model)}</span>
                  <span className="cx-col-budget">
                    {a.budget_usd ? (
                      <span className={`cx-pre ${frac > 0.85 ? 'cx-c-amber' : 'cx-c-txt'}`} title={`$${a.spent_usd.toFixed(2)} of $${a.budget_usd}`}>
                        ▕{bar(frac, 6)}▏
                      </span>
                    ) : (
                      <span className="cx-c-dim">${a.spent_usd.toFixed(2)}</span>
                    )}
                  </span>
                  <span className="cx-col-seen cx-c-dim">{ago(a.last_active_at, now)}</span>
                  {isSel && (
                    <span className="cx-rowacts" onClick={(e) => e.stopPropagation()}>
                      {a.status === 'awake' || a.status === 'starting' ? (
                        <button className="cx-key" onClick={() => act(a, 'sleep')}>
                          <u>s</u>leep
                        </button>
                      ) : (
                        <button className="cx-key" onClick={() => act(a, 'wake')}>
                          <u>w</u>ake
                        </button>
                      )}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Pane>
  )
}

// ------------------------------------------------------------------ 3 session

// the Omega mark (brand/markOutline), traced as half-block art
const ART = [
  '        ▄▄▄██▀▀▀▀▀███           ',
  '    ▄▄█▀▀     ▄▄████████▄▄▄     ',
  '  ▄█▀       ▄█▀  ▀▀█▄     ▀▀█▄  ',
  '▄█▀        █▀       ▀█       ▀█ ',
  '██        ▀█         █        ██',
  '▀█         █▄       ▄█       ▄█▀',
  '  ▀▄▄       ▀█▄▄   ▄█     ▄▄█▀  ',
  ' ▄▄███████▄▄▄▄▄█████▄▄▄▄███▄▄▄██',
  '██▄▄▄▄▄▄▄▄▄▄████████████████▄▄█▀',
]

export function SessionPane({ boot, phone }: { boot: number; phone: boolean }) {
  const id = useC((s) => s.mind)
  const agent = useHive((s) => (id ? s.agents[id] : undefined))
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  return (
    <Pane
      id="session"
      boot={boot}
      meta={
        agent ? (
          <>
            <span className="cx-c-dim">tty/</span>
            <span className="cx-c-hi">{slug(agent.name)}</span>
          </>
        ) : (
          <span className="cx-c-dim">no session</span>
        )
      }
    >
      {agent ? <Session agent={agent} phone={phone} /> : <NoSession agents={orderedMinds(agents, swarms)} />}
    </Pane>
  )
}

function NoSession({ agents }: { agents: Agent[] }) {
  const awake = agents.filter((a) => a.status === 'awake').slice(0, 5)
  return (
    <div className="cx-nosession">
      <pre className="cx-art cx-glow" aria-hidden>
        {ART.join('\n')}
      </pre>
      <div className="cx-c-hi cx-glow">NO CARRIER</div>
      <div className="cx-c-dim">
        open a session: <span className="cx-c-hi">open &lt;mind&gt;</span>, or pick a row in MINDS and press ⏎
      </div>
      {awake.length > 0 && (
        <div className="cx-quick">
          {awake.map((a) => (
            <button key={a.id} className="cx-chip" onClick={() => openSession(a)}>
              <span style={{ color: hsl(a.hue, 90, 64) }}>■</span> open {slug(a.name)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Session({ agent, phone }: { agent: Agent; phone: boolean }) {
  const id = agent.id
  const messages = useHive((s) => s.messages[id] ?? EMPTY_M)
  const pending = useHive((s) => s.pending[id])
  const loaded = useHive((s) => !!s.messagesLoaded[id])
  const thinking = useHive((s) => s.thinking[id])
  const fresh = useHive((s) => s.freshMessages)
  const agents = useHive((s) => s.agents)
  const swarm = useHive((s) => (agent.swarm_id ? s.swarms[agent.swarm_id] : undefined))
  const sessionFocus = useC((s) => s.sessionFocus)
  const [text, setText] = useDraft(`construct:mind:${id}`)
  const [err, setErr] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const stick = useRef(true)
  const hist = useRef<string[]>([])
  const hi = useRef(-1)
  useEffect(() => {
    // a late answer for another mind (or a closed session) never writes here
    let live = true
    useHive
      .getState()
      .loadMessages(id)
      .then(
        () => live && setErr(null),
        (e: unknown) => live && setErr(e instanceof Error ? e.message : 'could not load the conversation'),
      )
    return () => {
      live = false
    }
  }, [id])
  useEffect(() => {
    if (sessionFocus && !phone) input.current?.focus({ preventScroll: true })
  }, [sessionFocus, phone])
  const busy = thinking === 'llm' || thinking === 'skills'
  const pend = pending ?? []
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages.length, pend.length, busy, loaded])
  const submit = () => {
    const raw = text.trim()
    if (!raw) return
    hist.current.push(raw)
    hi.current = -1
    setText('')
    // a leading slash escapes to the command language, so commands never leak into a conversation
    if (raw.startsWith('/')) {
      void run(raw.slice(1))
      return
    }
    const v = raw.replace(/^>\s*/, '')
    if (!v) return
    stick.current = true
    sendTo(agent, v)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // an IME's confirming Enter belongs to the input method (features/ask/keys; r2.4 sweep)
    if (guardComposing(e)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'ArrowUp' && hist.current.length) {
      e.preventDefault()
      hi.current = hi.current < 0 ? hist.current.length - 1 : Math.max(0, hi.current - 1)
      setText(hist.current[hi.current])
    } else if (e.key === 'ArrowDown' && hi.current >= 0) {
      e.preventDefault()
      hi.current = hi.current + 1 >= hist.current.length ? -1 : hi.current + 1
      setText(hi.current < 0 ? '' : hist.current[hi.current])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (text) setText('')
      else useC.getState().focusCmd()
    }
  }
  const sleeping = agent.status !== 'awake' && agent.status !== 'starting'
  const tone = STATE_TONE[agent.status]
  const act = (verb: 'wake' | 'sleep') => {
    pulse(0.4)
    const action = verb === 'wake' && (agent.status === 'stopped' || agent.status === 'created' || agent.status === 'error') ? 'start' : verb
    void useHive.getState().agentAction(id, action)
  }
  return (
    <div className="cx-session">
      <div className="cx-shead">
        <span className="cx-c-dim">ssh </span>
        <span className="cx-c-cyan">operator</span>
        <span className="cx-c-dim">@</span>
        <span className="cx-c-hi cx-glow">
          <span style={{ color: hsl(agent.hue, 90, 64) }}>■</span> {shown(agent.name)}
        </span>
        <span className={`cx-badge cx-c-${tone}`}>{agent.status.toUpperCase()}</span>
        <span className="cx-c-dim cx-shead-meta">
          {swarm ? slug(swarm.name) + ' · ' : ''}
          {shortModel(agent.model)} · ${agent.spent_usd.toFixed(2)}
          {agent.budget_usd ? `/$${agent.budget_usd}` : ''}
        </span>
        <span className="cx-shead-acts">
          {sleeping ? (
            <button className="cx-key" onClick={() => act('wake')}>
              wake
            </button>
          ) : (
            <button className="cx-key" onClick={() => act('sleep')}>
              sleep
            </button>
          )}
          <button className="cx-key" onClick={() => openClassic({ name: 'dot', id })} title="memory, model, schedule (classic panel)">
            inspect ↗
          </button>
          <button className="cx-key" aria-label="Close session" onClick={closeToHome}>
            ×
          </button>
        </span>
      </div>
      <Telemetry agent={agent} />
      <div
        ref={scroller}
        className="cx-transcript"
        onScroll={() => {
          const el = scroller.current
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
        aria-live="polite"
        aria-label={`Conversation with ${shown(agent.name)}`}
      >
        <div className="cx-motd cx-c-dim">
          {'── connected to '}
          {slug(agent.name)}
          {' · '}
          {agent.kind}
          {' · '}
          {agent.persona ? agent.persona.slice(0, 120) : 'a mind of the hive'}
          {' ──'}
        </div>
        {err && !messages.length ? (
          <div className="cx-c-red">
            ✗ {err}{' '}
            <button className="cx-link" onClick={() => useHive.getState().loadMessages(id).then(() => setErr(null), () => undefined)}>
              retry
            </button>
          </div>
        ) : !loaded && !messages.length ? (
          <div className="cx-c-dim">
            fetching transcript<span className="cx-cursor" />
          </div>
        ) : !messages.length && !pend.length ? (
          <div className="cx-c-dim">
            no messages yet. say hello{sleeping ? ` (${shown(agent.name)} is ${agent.status}; wake it to get a reply)` : ''}.
          </div>
        ) : null}
        {messages.map((msg) => {
          const peer = msg.sender.startsWith('agent:') && msg.sender !== `agent:${id}` ? agents[msg.sender.slice(6)] : null
          const mine = msg.direction === 'out'
          const who = healthCheck(msg) ? 'health-check' : mine ? slug(agent.name) : peer ? slug(peer.name) : 'you'
          return <MsgLine key={msg.id} text={msg.text} at={msg.created_at} who={who} kind={mine ? 'mind' : peer || healthCheck(msg) ? 'peer' : 'you'} fresh={!!fresh[msg.id] && mine} />
        })}
        {pend.map((p) => (
          <div key={p.tempId} className="cx-msg is-you">
            <span className="cx-msg-t cx-c-dim">--:--</span>
            <span className="cx-msg-who cx-c-cyan">you ▸</span>
            <span className="cx-msg-x cx-c-txt">
              {p.text}{' '}
              {p.status === 'sending' ? (
                <span className="cx-c-dim">
                  <span className="cx-spin" /> sending
                </span>
              ) : (
                <span className="cx-c-red">
                  ✗ {p.error ?? 'failed'}{' '}
                  <button className="cx-link" onClick={() => void useHive.getState().retryMessage(id, p.tempId)}>
                    retry
                  </button>{' '}
                  <button className="cx-link" onClick={() => useHive.getState().dismissPending(id, p.tempId)}>
                    drop
                  </button>
                </span>
              )}
            </span>
          </div>
        ))}
        {busy && (
          <div className="cx-msg is-mind">
            <span className="cx-msg-t cx-c-dim">     </span>
            <span className="cx-msg-who cx-c-hi">{slug(agent.name)} ◂</span>
            <span className="cx-msg-x cx-c-cyan">
              <span className="cx-spin" /> {thinking === 'llm' ? 'thinking' : 'running skills'}
              <span className="cx-cursor" />
            </span>
          </div>
        )}
      </div>
      <label className="cx-sin">
        <span className="cx-c-cyan">you</span>
        <span className="cx-c-dim">@</span>
        <span className="cx-c-hi">{slug(agent.name)}</span>
        <span className="cx-c-hi"> ❯ </span>
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => useC.getState().setFocus('session')}
          placeholder={sleeping ? `${shown(agent.name)} is ${agent.status} · messages wait for it` : phone ? `talk to ${shown(agent.name)}…` : `talk to ${shown(agent.name)} · /cmd runs a command · esc → prompt`}
          aria-label={`Message ${shown(agent.name)}`}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
        />
      </label>
    </div>
  )
}

/** One line of live vitals for the open mind: what it holds, what it asks, what it costs, what it did lately. */
function Telemetry({ agent }: { agent: Agent }) {
  const goals = useHive((s) => s.goals)
  const approvals = useHive((s) => s.approvals)
  const activity = useHive((s) => s.activity)
  const now = useNow(5000)
  const held = useMemo(() => Object.values(goals).filter((g) => g.claimed_by === agent.id && (g.status === 'claimed' || g.status === 'waiting')), [goals, agent.id])
  const asks = useMemo(() => pendingList(approvals).filter((a) => a.agent_id === agent.id).length, [approvals, agent.id])
  const mine = useMemo(() => activity.filter((a) => a.agent_id === agent.id).slice(0, 18), [activity, agent.id])
  const frac = agent.budget_usd ? agent.spent_usd / agent.budget_usd : 0
  const MARK: Record<string, string> = { belief: '◆', message: '▸', status: '●', error: '✗', birth: '✦', approval: '?', goal: '◎', wakeup: '◷' }
  return (
    <div className="cx-tele" aria-label="Vitals">
      <span>
        <span className="cx-c-dim">task </span>
        {held.length ? <span className="cx-c-hi" title={held.map((g) => plainText(g.title)).join('\n')}>{plainText(held[0].title).slice(0, 34)}{plainText(held[0].title).length > 34 ? '…' : ''}{held.length > 1 ? ` +${held.length - 1}` : ''}</span> : <span className="cx-c-dim">none</span>}
      </span>
      <span>
        <span className="cx-c-dim">asks </span>
        <span className={asks ? 'cx-c-amber' : 'cx-c-dim'}>{asks}</span>
      </span>
      {agent.budget_usd > 0 && (
        <span>
          <span className="cx-c-dim">budget </span>
          <span className={`cx-pre ${frac > 0.85 ? 'cx-c-amber' : 'cx-c-txt'}`}>▕{bar(frac, 8)}▏</span>
        </span>
      )}
      <span>
        <span className="cx-c-dim">seen </span>
        <span className="cx-c-txt">{ago(agent.last_active_at, now)}</span>
      </span>
      <span className="cx-tele-trace" aria-hidden title="recent activity, newest left">
        {mine.length ? mine.map((a) => <span key={a.id} className={a.kind === 'error' ? 'cx-c-red' : a.kind === 'approval' ? 'cx-c-amber' : a.kind === 'message' ? 'cx-c-cyan' : 'cx-c-hi'}>{MARK[a.kind] ?? '·'}</span>) : <span className="cx-c-dim">quiet</span>}
      </span>
    </div>
  )
}

const MsgLine = memo(function MsgLine({ text, at, who, kind, fresh }: { text: string; at: string; who: string; kind: 'mind' | 'peer' | 'you'; fresh: boolean }) {
  const mine = kind === 'mind'
  return (
    <div className={`cx-msg is-${kind}`}>
      <span className="cx-msg-t cx-c-dim">{clock(at).slice(0, 5)}</span>
      <span className={`cx-msg-who ${mine ? 'cx-c-hi' : kind === 'peer' ? 'cx-c-amber' : 'cx-c-cyan'}`}>
        {who}
        {mine ? ' ◂' : ' ▸'}
      </span>
      <Decode text={plainText(text)} animate={fresh} className={`cx-msg-x ${mine ? 'cx-c-hi' : 'cx-c-txt'}`} />
    </div>
  )
})

// ------------------------------------------------------------------ 4 inbox

const RISK_TONE = { low: 'txt', medium: 'amber', high: 'red' } as const

export function InboxPane({ boot }: { boot: number }) {
  const approvals = useHive((s) => s.approvals)
  const goals = useHive((s) => s.goals)
  const tab = useC((s) => s.inboxTab)
  const list = useMemo(() => pendingList(approvals), [approvals])
  const glist = useMemo(() => goalList(goals), [goals])
  const live = glist.filter((g) => g.status !== 'done' && g.status !== 'cancelled' && g.status !== 'failed')
  return (
    <Pane
      id="inbox"
      boot={boot}
      alert={list.length > 0}
      meta={list.length ? <span className="cx-c-amber cx-blink-soft">● {list.length} waiting</span> : <span className="cx-c-dim">clear</span>}
    >
      <div className="cx-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'approvals'} className={tab === 'approvals' ? 'is-on' : ''} onClick={() => useC.getState().setInboxTab('approvals')}>
          APPROVALS <span className={list.length ? 'cx-c-amber' : 'cx-c-dim'}>{list.length}</span>
        </button>
        <button role="tab" aria-selected={tab === 'goals'} className={tab === 'goals' ? 'is-on' : ''} onClick={() => useC.getState().setInboxTab('goals')}>
          TASKS <span className="cx-c-dim">{live.length}</span>
        </button>
        <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'is-on' : ''} onClick={() => useC.getState().setInboxTab('history')}>
          HISTORY
        </button>
      </div>
      {tab === 'approvals' ? <Approvals list={list} approvals={approvals} /> : tab === 'goals' ? <Goals list={glist} /> : <History approvals={approvals} />}
    </Pane>
  )
}

function Approvals({ list, approvals }: { list: Approval[]; approvals: Record<string, Approval> }) {
  const agents = useHive((s) => s.agents)
  const deciding = useHive((s) => s.deciding)
  // the session this inbox was shown under: an answer goes only there (Surface O, as Flux)
  const session = useHive((s) => s.session)
  const sel = useC((s) => s.inboxSel)
  const now = useNow(15000)
  const recent = useMemo(() => recentDecided(approvals, 5), [approvals])
  return (
    <div className="cx-inbox">
      {list.length === 0 ? (
        <div className="cx-empty">
          <div className="cx-c-hi cx-glow">✓ inbox zero</div>
          <div className="cx-c-dim">when a mind asks to run something gated, it lands here.</div>
        </div>
      ) : (
        list.map((ap, i) => {
          const a = agents[ap.agent_id]
          const busy = deciding[ap.id]
          return (
            <div key={ap.id} data-cx-ap={ap.id} className={`cx-ap${i === sel ? ' is-sel' : ''} risk-${ap.risk}`} onClick={() => useC.getState().setInboxSel(i)}>
              <div className="cx-ap-h">
                <span className="cx-c-hi">[{i + 1}]</span>
                <span className={`cx-badge cx-c-${RISK_TONE[ap.risk]}`}>{ap.risk.toUpperCase()}</span>
                <span className="cx-c-hi">
                  {a && <span style={{ color: hsl(a.hue, 90, 64) }}>■ </span>}
                  {a ? shown(a.name) : ap.agent_id}
                </span>
                <span className="cx-c-txt">{ap.skill}</span>
                <span className="cx-c-dim cx-ap-age">{ago(ap.created_at, now)}</span>
              </div>
              <code className="cx-ap-cmd">{ap.command}</code>
              <div className="cx-c-dim cx-ap-why">↳ {ap.reason}</div>
              <div className="cx-ap-acts">
                {busy ? (
                  <span className="cx-c-amber">
                    <span className="cx-spin" /> {busy === 'deny' || busy === 'never' ? 'refusing' : 'approving'}
                  </span>
                ) : (
                  // never an answer here: the shared decision dialog shows it in full and takes the answer (Review R2/R3)
                  <button className="cx-key is-go" aria-label={`Review and answer request ${i + 1}: ${a ? shown(a.name) : ap.agent_id} asks to run ${ap.skill}`} onClick={(e) => (e.stopPropagation(), useC.getState().setInboxSel(i), useC.getState().answer(ap, session))}>
                    <u>a</u>nswer…
                  </button>
                )}
              </div>
            </div>
          )
        })
      )}
      {recent.length > 0 && (
        <div className="cx-recent">
          <div className="cx-c-dim cx-rule">── decided ──</div>
          {recent.map((ap) => {
            const a = agents[ap.agent_id]
            const ok = ap.status === 'approved' || ap.status === 'used'
            return (
              <div key={ap.id} className="cx-recent-row">
                <span className={ok ? 'cx-c-hi' : ap.status === 'expired' ? 'cx-c-dim' : 'cx-c-amber'}>{ok ? '✓' : ap.status === 'expired' ? '…' : '✗'}</span>{' '}
                <span className="cx-c-txt">{a ? shown(a.name) : '?'}</span> <span className="cx-c-dim">{ap.skill} · {ap.status}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const GOAL_TONE: Record<string, string> = { stalled: 'red', failed: 'red', waiting: 'amber', claimed: 'cyan', open: 'hi', submitted: 'txt', done: 'dim', cancelled: 'dim' }
const GOAL_MARK: Record<string, string> = { stalled: '!', failed: '✗', waiting: '…', claimed: '◐', open: '○', submitted: '◑', done: '●', cancelled: '–' }

function Goals({ list }: { list: Goal[] }) {
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const sel = useC((s) => s.inboxSel)
  const sws = useMemo(() => orderedSwarms(swarms), [swarms])
  const [sw, setSw] = useState('')
  const [title, setTitle] = useState('')
  const target = sw || sws[0]?.id || ''
  const post = async () => {
    const t = title.trim()
    if (!t || !target) return
    setTitle('')
    pulse(0.6)
    const g = await useHive.getState().createGoal(target, { title: t })
    if (g) useC.getState().print([[{ t: '✓ ', c: 'hi' }, { t: 'task posted: ', c: 'txt' }, { t: `“${plainText(g.title)}”`, c: 'hi' }]])
  }
  return (
    <div className="cx-goals">
      <div className="cx-goal-list">
        {list.length === 0 ? (
          <div className="cx-empty">
            <div className="cx-c-hi">no tasks yet</div>
            <div className="cx-c-dim">post one below, or: task &lt;swarm&gt; &lt;title&gt;</div>
          </div>
        ) : (
          list.slice(0, 60).map((g, i) => {
            const holder = g.claimed_by ? agents[g.claimed_by] : null
            return (
              <div key={g.id} className={`cx-goal${i === sel ? ' is-sel' : ''}`} onClick={() => useC.getState().setInboxSel(i)}>
                <span className={`cx-c-${GOAL_TONE[g.status] ?? 'txt'}`}>{GOAL_MARK[g.status] ?? '·'}</span>
                <span className={g.status === 'done' || g.status === 'cancelled' ? 'cx-c-dim' : 'cx-c-txt'}>{plainText(g.title)}</span>
                <span className="cx-c-dim cx-goal-m">
                  {holder ? shown(holder.name) : swarms[g.swarm_id] ? slug(swarms[g.swarm_id].name) : ''} · <span className={`cx-c-${GOAL_TONE[g.status] ?? 'txt'}`}>{g.status}</span>
                </span>
              </div>
            )
          })
        )}
      </div>
      {sws.length > 0 && (
        <form
          className="cx-goal-new"
          onSubmit={(e) => {
            e.preventDefault()
            void post()
          }}
        >
          <span className="cx-c-hi">+</span>
          <select value={target} onChange={(e) => setSw(e.target.value)} aria-label="Swarm for the new task">
            {sws.map((w) => (
              <option key={w.id} value={w.id}>
                {slug(w.name)}
              </option>
            ))}
          </select>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="new task…" aria-label="New task title" spellCheck={false} />
        </form>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ 4c history: decided requests and the policy rules

const MODE_TONE = { allow: 'hi', ask: 'amber', deny: 'red' } as const

function History({ approvals }: { approvals: Record<string, Approval> }) {
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const policy = useHive((s) => s.policy)
  const now = useNow(30000)
  const decided = useMemo(() => recentDecided(approvals, 40), [approvals])
  const [err, setErr] = useState(false)
  useEffect(() => {
    void useHive.getState().loadPolicy().catch(() => setErr(true))
  }, [])
  const scope = (sc: string) => {
    if (sc === 'hive') return 'hive'
    const [k, id] = sc.split(':')
    const n = k === 'agent' ? agents[id]?.name : swarms[id]?.name
    return `${k === 'agent' ? 'mind' : 'swarm'}:${n ? slug(n) : id.slice(-6)}`
  }
  return (
    <div className="cx-inbox cx-history">
      <div className="cx-c-dim cx-rule">── decided · {decided.length} ──</div>
      {decided.length === 0 ? (
        <div className="cx-c-dim">nothing decided yet.</div>
      ) : (
        decided.map((ap) => {
          const a = agents[ap.agent_id]
          const ok = ap.status === 'approved' || ap.status === 'used'
          return (
            <div key={ap.id} className="cx-hrow">
              <span className={ok ? 'cx-c-hi' : ap.status === 'expired' ? 'cx-c-dim' : 'cx-c-amber'}>{ok ? '✓' : ap.status === 'expired' ? '…' : '✗'}</span>
              <span className="cx-hrow-x">
                <span className="cx-c-txt">{a ? shown(a.name) : ap.agent_id}</span> <span className="cx-c-hi">{ap.skill}</span> <span className="cx-c-dim">{ap.status}{ap.decided_by ? ` by ${ap.decided_by}` : ''}</span>
              </span>
              <span className="cx-c-dim cx-hrow-t">{ago(ap.decided_at ?? ap.created_at, now)}</span>
            </div>
          )
        })
      )}
      <div className="cx-c-dim cx-rule">── rules{policy ? ` · ${policy.length}` : ''} ──</div>
      {err && !policy ? (
        <div className="cx-c-red">✗ could not load the rules</div>
      ) : !policy ? (
        <div className="cx-c-dim">
          reading rules<span className="cx-cursor" />
        </div>
      ) : policy.length === 0 ? (
        <div className="cx-c-dim">no rules: every gated skill asks a person.</div>
      ) : (
        policy.map((r) => (
          <div key={r.id} className="cx-hrow">
            <span className={`cx-c-${MODE_TONE[r.mode]}`}>{r.mode === 'allow' ? '+' : r.mode === 'deny' ? '−' : '?'}</span>
            <span className="cx-hrow-x">
              <span className={`cx-c-${MODE_TONE[r.mode]}`}>{r.mode}</span> <span className="cx-c-hi">{r.skill}</span> <span className="cx-c-dim">@ {scope(r.scope)}</span>
              {r.note && <span className="cx-c-dim"> · {r.note}</span>}
            </span>
          </div>
        ))
      )}
      <div className="cx-c-dim">
        change rules: <button className="cx-link" onClick={() => openClassic({ name: 'approvals', tab: 'rules' })}>page decide.rules</button>
      </div>
    </div>
  )
}
