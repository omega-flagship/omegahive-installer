import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type Ref, type RefObject } from 'react'
import { openClassic, shown, useHive, type Approval } from '../sdk'
import { began, canActivate, initialGate, keyUp, refusalWords, settled, shown as shownGate, type Activation, type GateState } from './gate'
import { shortId } from './ident'
import { ago, decisionFacts, explainApproval } from './language'
import { inkOf, useMinds, useNow, useSprings } from './shared'

type Dir = 'yes' | 'no' | 'later'
const DIRS: Record<string, Dir> = { yes: 'yes', no: 'no', later: 'later' }

/**
 * Decisions, one at a time: a single card, plain words, the exact request beside them, Yes or No. The rest wait,
 * stacked, behind it. Every Yes/No/Later passes the decision gate (./gate.ts): no key repeat, no carry-over from a
 * key still held, a short pause whenever a different request comes to the top, and nothing while any decision is in
 * flight. After a decision, focus goes to the next request's heading (never to its Yes) and the change is announced.
 */
export function Needs({ headRef }: { headRef: RefObject<HTMLElement | null> }) {
  const approvals = useHive((s) => s.approvals)
  const loaded = useHive((s) => s.approvalsLoaded)
  const agents = useMinds()
  const swarms = useHive((s) => s.swarms)
  const deciding = useHive((s) => s.deciding)
  const decide = useHive((s) => s.decide)
  // Surface R: the session this queue was rendered under; an answer from a stale render is refused by the store
  const session = useHive((s) => s.session)
  const [later, setLater] = useState<string[]>([])
  const [dir, setDir] = useState<Dir>('yes')
  const [flying, setFlying] = useState<string | null>(null)
  const [say, setSay] = useState('')
  const [note, setNote] = useState('')
  const gate = useRef<GateState>(initialGate)
  const stackRef = useRef<HTMLDivElement>(null)
  const keepFocus = useRef(false)
  const lastKeyAt = useRef(-Infinity)
  const prevTop = useRef<string | null>(null)
  const noteTimer = useRef<number | undefined>(undefined)
  const now = useNow()
  const sp = useSprings()

  const queue = useMemo(() => {
    const list = Object.values(approvals).filter((a) => a.status === 'pending')
    const rank = (a: Approval) => (later.includes(a.id) ? 1 + later.indexOf(a.id) : 0)
    return list.sort((a, b) => rank(a) - rank(b) || a.created_at.localeCompare(b.created_at))
  }, [approvals, later])
  const top = queue[0]

  const describe = (a: Approval) => {
    const mind = agents[a.agent_id]
    const sw = mind?.swarm_id ? swarms[mind.swarm_id] : undefined
    const name = shown(mind?.name) || 'A mind'
    return `${name}${sw ? ` in ${shown(sw.name)}` : ''} would like to ${explainApproval(a).wants}`
  }

  // A different request at the top (decision, arrival, reorder, later): re-arm the gate before any key can reach
  // it, move focus to its heading if focus was in the stack, and say what is now in front of the person.
  useLayoutEffect(() => {
    const id = top?.id ?? null
    if (id === prevTop.current) return
    const had = prevTop.current
    prevTop.current = id
    gate.current = shownGate(gate.current, id, performance.now())
    const active = document.activeElement
    const inside = keepFocus.current || (!!active && !!stackRef.current?.contains(active))
    keepFocus.current = false
    if (had !== null) {
      setSay(top ? `${queue.length === 1 ? 'Now' : `Next, 1 of ${queue.length}`}: ${describe(top)}. Read it, then answer.` : 'Nothing else needs you.')
      if (inside) headRef.current?.focus({ preventScroll: true })
    }
    // describe/queue are read for the announcement only; the effect is keyed to the request on top
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top?.id, headRef])

  // Any key released (or the window losing focus, which can swallow a keyup) re-allows keyboard decisions.
  useEffect(() => {
    const up = () => (gate.current = keyUp(gate.current))
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', up)
    return () => {
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', up)
      window.clearTimeout(noteTimer.current)
    }
  }, [])

  const refuse = (words: string | null) => {
    if (!words) return
    setNote(words)
    setSay(words)
    window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => setNote(''), 4000)
  }

  /** Everything that answers a request comes through here, bound to the request it was aimed at. */
  const activate = (e: Activation, d: Dir) => {
    const v = canActivate(gate.current, e)
    if (!v.ok) return refuse(refusalWords(v.why))
    const a = queue.find((x) => x.id === e.boundId)
    if (!a || deciding[a.id]) return
    gate.current = began(gate.current, e, d !== 'later')
    setNote('')
    setDir(d)
    keepFocus.current = !!document.activeElement && !!stackRef.current?.contains(document.activeElement)
    if (d === 'later') {
      setLater((l) => [...l.filter((x) => x !== a.id), a.id])
      return
    }
    setFlying(a.id)
    void decide(a.id, d === 'yes' ? 'approve' : 'deny', undefined, session)
      .then((r) => {
        // refused or failed: the same request stays; do not carry focus intent over to a later change
        if (!r) keepFocus.current = false
      })
      .finally(() => {
        gate.current = settled(gate.current, a.id)
        setFlying((f) => (f === a.id ? null : f))
      })
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>, a: Approval) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key.toLowerCase()
    let d: Dir | null = k === 'y' ? 'yes' : k === 'n' ? 'no' : k === 'l' && queue.length > 1 ? 'later' : null
    // Enter/Space on a decision button: handled here (with the gate), not by the browser's click
    if (!d && (e.key === 'Enter' || e.key === ' ')) d = DIRS[(e.target as HTMLElement).closest<HTMLElement>('[data-dir]')?.dataset.dir ?? ''] ?? null
    if (!d) return
    // keep the shell's single-key shortcuts (n = new mind…) and the button's own activation from also firing
    e.preventDefault()
    e.stopPropagation()
    lastKeyAt.current = performance.now()
    activate({ kind: 'key', key: k, repeat: e.repeat, at: performance.now(), boundId: a.id }, d)
  }
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    // a Space released on a decision button must not become a click; the keydown already went through the gate
    if (e.key === ' ' && (e.target as HTMLElement).closest('[data-dir]')) e.preventDefault()
  }
  const onClick = (e: MouseEvent<HTMLButtonElement>, a: Approval, d: Dir) => {
    // a click the browser makes from a key we already handled
    if (e.detail === 0 && performance.now() - lastKeyAt.current < 600) return
    activate({ kind: 'pointer', at: performance.now(), boundId: a.id }, d)
  }

  if (!loaded && !queue.length) return <p className="st-quiet">Looking for anything that needs you…</p>

  const exit = {
    yes: { opacity: 0, y: -40, x: 60, rotate: 3, scale: 0.96 },
    no: { opacity: 0, y: 20, x: -80, rotate: -3, scale: 0.96 },
    later: { opacity: 0, y: 34, scale: 0.94 },
  }

  return (
    <div ref={stackRef} className="st-stack" style={{ paddingBottom: Math.min(Math.max(queue.length - 1, 0), 2) * 12 }}>
      <p className="st-sr" role="status" aria-live="polite" aria-atomic="true">
        {say}
      </p>
      {/* the stack hint: up to two sheets peeking out underneath */}
      <AnimatePresence initial={false}>
        {queue.slice(1, 3).map((_a, i) => (
          <m.div
            key={`ghost-${i}`}
            className="st-card-ghost"
            aria-hidden
            initial={{ opacity: 0, y: 0, scale: 1 }}
            animate={{ y: (i + 1) * 12, scale: 1 - (i + 1) * 0.035, opacity: 1 - (i + 1) * 0.3 }}
            exit={{ opacity: 0, y: 0, scale: 1 }}
            transition={sp.soft}
            style={{ zIndex: -1 - i }}
          />
        ))}
      </AnimatePresence>
      <AnimatePresence initial={false} mode="popLayout" custom={dir}>
        {top ? (
          <Card
            key={top.id}
            a={top}
            mind={agents[top.agent_id]}
            swarm={swarms[agents[top.agent_id]?.swarm_id ?? '']}
            busy={!!deciding[top.id] || flying !== null}
            total={queue.length}
            now={now}
            headRef={headRef}
            note={note}
            onClick={(e, d) => onClick(e, top, d)}
            onKey={(e) => onKey(e, top)}
            onKeyUp={onKeyUp}
            exitTo={exit}
          />
        ) : (
          <m.div key="empty" initial={sp.reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...sp.gentle, delay: sp.reduced ? 0 : 0.25 }}>
            <p ref={(el) => bindRef(headRef, el)} tabIndex={-1} className="st-card-wants" style={{ marginTop: 0, fontStyle: 'italic' }}>
              Nothing needs you.
            </p>
            <p className="st-card-why" style={{ maxWidth: '30em' }}>
              When a mind wants to do something a person should check, it waits here, one thing at a time.
            </p>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Point a shared ref at `el` while it is mounted, without an exiting card clearing the newer one's. */
function bindRef(r: RefObject<HTMLElement | null>, el: HTMLElement | null) {
  if (el) r.current = el
  return () => {
    if (r.current === el) r.current = null
  }
}

interface CardProps {
  a: Approval
  mind: { name: string; hue: number } | undefined
  swarm: { id: string; name: string } | undefined
  busy: boolean
  total: number
  now: number
  headRef: RefObject<HTMLElement | null>
  note: string
  onClick: (e: MouseEvent<HTMLButtonElement>, d: Dir) => void
  onKey: (e: KeyboardEvent<HTMLDivElement>) => void
  onKeyUp: (e: KeyboardEvent<HTMLDivElement>) => void
  exitTo: Record<Dir, object>
  ref?: Ref<HTMLDivElement>
}

function Card({ a, mind, swarm, busy, total, now, headRef, note, onClick, onKey, onKeyUp, exitTo, ref }: CardProps) {
  const sp = useSprings()
  const x = explainApproval(a)
  const name = shown(mind?.name) || 'A mind'
  const swarmName = shown(swarm?.name)
  const facts = decisionFacts(a, mind && { name }, swarm && { id: swarm.id, name: swarmName }, shortId)
  const hid = `st-need-${a.id}`
  return (
    <m.div
      ref={ref}
      className="st-card"
      role="group"
      aria-labelledby={hid}
      onKeyDown={onKey}
      onKeyUp={onKeyUp}
      variants={{ exit: (d: Dir) => ({ ...exitTo[d], transition: sp.reduced ? { duration: 0 } : { duration: 0.42, ease: [0.4, 0, 0.2, 1] } }) }}
      initial={sp.reduced ? false : { opacity: 0.5, y: 12, scale: 0.965 }}
      animate={{ opacity: 1, y: 0, x: 0, rotate: 0, scale: 1 }}
      exit="exit"
      transition={sp.soft}
    >
      <div className="st-card-who">
        <span className="st-dot" data-state="idle" style={{ ['--c' as string]: inkOf(mind?.hue ?? 30) }}>
          <i />
        </span>
        <span>
          {name}
          {swarmName ? ` · ${swarmName}` : ''} · asked {ago(a.created_at, now)}
        </span>
      </div>
      <h3 id={hid} ref={(el) => bindRef(headRef, el)} tabIndex={-1} className="st-card-wants">
        <em>{name}</em> would like to {x.wants}.
      </h3>
      {x.detail &&
        (x.sentence ? (
          <blockquote className="st-card-detail st-card-quote">{x.detail}</blockquote>
        ) : (
          <pre className="st-card-detail" style={{ whiteSpace: 'pre-wrap' }}>
            {x.detail}
          </pre>
        ))}
      <p className="st-card-why">
        <strong className={a.risk === 'high' ? 'st-stakes-high' : undefined}>{x.stakes}</strong> {x.why} {name} is paused until you answer.
      </p>
      <div className="st-exact">
        <p className="st-exact-label" id={`${hid}-raw`}>
          The exact request
        </p>
        <pre className="st-raw" aria-labelledby={`${hid}-raw`}>
          {facts.raw}
        </pre>
        <dl className="st-scope">
          {facts.rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd data-risk={k === 'Risk' ? v : undefined}>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="st-actions">
        <button className="st-btn st-btn-yes" data-dir="yes" disabled={busy} onClick={(e) => onClick(e, 'yes')}>
          <span>Yes<span className="st-wide">, allow it</span></span> <kbd>Y</kbd>
        </button>
        <button className="st-btn st-btn-no" data-dir="no" disabled={busy} onClick={(e) => onClick(e, 'no')}>
          No <kbd>N</kbd>
        </button>
        {total > 1 && (
          <button className="st-btn-later" data-dir="later" disabled={busy} onClick={(e) => onClick(e, 'later')}>
            later
          </button>
        )}        <span className="st-count">
          {total > 1 ? (
            <>
              1 of {total} ·{' '}
              <button className="st-link" onClick={() => openClassic({ name: 'approvals', focus: a.id })}>
                more choices
              </button>
            </>
          ) : (
            <button className="st-link" onClick={() => openClassic({ name: 'approvals', focus: a.id })}>
              more choices
            </button>
          )}
        </span>
      </div>
      {note && (
        <p className="st-gate-note" aria-hidden>
          {note}
        </p>
      )}
    </m.div>
  )
}
