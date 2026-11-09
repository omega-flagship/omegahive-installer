import { useCanvasCurrent } from './actionAuthority'
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { heldForInbox, shown, useHive, type Approval, type Decision } from '../sdk'
import { ago, RISK_PAPER } from './data'
import { accepts, askedAt, bind, bindingNote, canDecide, inspect, type Inspected } from './decision'
import { MONO } from './theme'
import { Avatar } from './parts'
import { useModalContainment } from '../../ui/useModalContainment'

/**
 * The only place a decision is taken on the board. Shows the complete, exact request (never clipped), who asked
 * and from which swarm, the skill, risk, the full rule or reason and when it was asked. The answer buttons are
 * bound to the request as it was opened: if it changes, disappears or is decided elsewhere they switch off and
 * say why. Focus starts on the heading, never on Approve; held keys and carried-over activations are ignored.
 */
export function DecisionInspect({ id, now, onClose, fallbackFocus }: { id: string; now: number; onClose: () => void; fallbackFocus: () => HTMLElement | null }) {
  const live = useHive((s) => s.approvals[id])
  // the request exactly as it was when the person opened it (the component is keyed by id)
  const [seen] = useState<Inspected | null>(() => (live ? inspect(live) : null))
  if (!seen) return <Gone onClose={onClose} fallbackFocus={fallbackFocus} />
  return <Inspector seen={seen} live={live} now={now} onClose={onClose} fallbackFocus={fallbackFocus} />
}

function Inspector({ seen, live, now, onClose, fallbackFocus }: { seen: Inspected; live: Approval | undefined; now: number; onClose: () => void; fallbackFocus: () => HTMLElement | null }) {
  const current = useCanvasCurrent()
  const deciding = useHive((s) => s.deciding[seen.id])
  // Surface R: re-check the binding when the store's session changes (a different client is a different hive)
  useHive((s) => s.session)
  const agent = useHive((s) => s.agents[seen.agent_id])
  const swarm = useHive((s) => (agent?.swarm_id ? s.swarms[agent.swarm_id] : undefined))
  const binding = bind(seen, live, deciding)
  const note = bindingNote(binding)
  const enabled = canDecide(binding)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  // re-arm whenever the binding changes state, so a press aimed at a disabled button cannot land once it re-enables
  const armed = useRef(0)
  useLayoutEffect(() => {
    armed.current = performance.now()
  }, [binding.kind])
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const who = agent ? shown(agent.name) : 'A mind'
  const paper = RISK_PAPER[seen.risk]

  const decide = async (d: Decision, minutes?: number) => {
    if (!current()) return
    setError(null)
    setSent(true)
    const r = await useHive.getState().decide(seen.id, d, minutes, seen.session)
    if (!alive.current || !current()) return
    // UI review S5: held for the Inbox in a surface-preview build (said there): close, claiming nothing
    if (heldForInbox(r) || r) onClose()
    else {
      setSent(false)
      setError(d === 'deny' || d === 'never' ? 'Not refused: the hive did not take the answer. Nothing changed; you can try again.' : 'Not approved: the hive did not take the answer. Nothing changed; you can try again.')
    }
  }
  const answer = (d: Decision, minutes?: number) => ({
    // stays focusable while off (a disabled button would drop focus out of the dialog); clicks are refused below
    'aria-disabled': !enabled || sent,
    'aria-describedby': statusId,
    onKeyDown: (e: KeyboardEvent) => {
      // held Enter/Space: never a decision
      if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault()
    },
    onClick: (e: MouseEvent) => {
      e.stopPropagation()
      if (!enabled || sent || !accepts({ at: performance.now() }, armed.current)) return
      void decide(d, minutes)
    },
  })

  // never hand focus back to a note whose request is settled (it may still be on screen while it leaves)
  const restoreTo = (opener: HTMLElement | null) => {
    const cur = useHive.getState().approvals[seen.id]
    const settled = !cur || cur.status !== 'pending'
    if (opener && opener.isConnected && opener !== document.body && !(settled && opener.closest(`[data-item="decision:${seen.id}"], [data-outline-decision="${seen.id}"]`))) return opener
    return fallbackFocus()
  }
  const status = note ?? (sent ? 'Sending your answer…' : error)
  const statusId = useId()
  return (
    <Shell onClose={onClose} restoreTo={restoreTo}>
      {(headingId, headRef) => (
        <>
          <div className="flex items-start gap-3 border-b px-5 pt-4 pb-3" style={{ borderColor: 'var(--line)' }}>
            {agent && <Avatar name={agent.name} hue={agent.hue} size={32} radius={9} />}
            <div className="min-w-0 flex-1">
              <span className="inline-block rounded-[4px] px-1.5 py-[2px] text-[11px] font-bold tracking-[0.08em] uppercase" style={{ background: paper, color: '#16161a' }}>
                {seen.risk} risk
              </span>
              <h2 id={headingId} ref={headRef} tabIndex={-1} className="m-0 mt-1.5 text-[18px] leading-[1.25] font-semibold tracking-[-0.015em] [overflow-wrap:anywhere] outline-none focus-visible:underline" style={{ color: 'var(--ink)' }}>
                {who} asks to use <span style={{ fontFamily: MONO }}>{seen.skill}</span>
              </h2>
            </div>
            <CloseBtn onClose={onClose} />
          </div>

          <div data-scroll role="region" aria-label="The full request" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 select-text" style={{ touchAction: 'pan-y' }}>
            <Field label="Exact request">
              <pre className="m-0 rounded-[8px] px-3 py-2.5 text-[13px] leading-[1.45] break-words whitespace-pre-wrap [overflow-wrap:anywhere]" style={{ fontFamily: MONO, background: 'var(--card-2)', color: 'var(--ink)', border: '1px solid var(--line-2)' }}>
                {seen.command}
              </pre>
            </Field>
            <Field label="Why it needs you">
              <p className="m-0 text-[14px] leading-[1.45] whitespace-pre-wrap [overflow-wrap:anywhere]" style={{ color: 'var(--ink)' }}>
                {seen.reason || 'No rule given: this skill always needs a person.'}
              </p>
            </Field>
            <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13.5px]">
              <Row k="Asked by">
                {who} <span className="text-[12px]" style={{ fontFamily: MONO, color: 'var(--ink-3)' }}>{seen.agent_id}</span>
              </Row>
              <Row k="Swarm">{swarm ? shown(swarm.name) : agent?.swarm_id ? <span style={{ fontFamily: MONO }}>{agent.swarm_id}</span> : 'No swarm'}</Row>
              <Row k="Skill">
                <span style={{ fontFamily: MONO }}>{seen.skill}</span>
              </Row>
              <Row k="Risk">{seen.risk}</Row>
              <Row k="Asked">
                <time dateTime={seen.created_at}>{askedAt(seen.created_at)}</time> <span style={{ color: 'var(--ink-3)' }}>({ago(seen.created_at, now)} ago)</span>
              </Row>
              <Row k="Request">
                <span className="text-[12px]" style={{ fontFamily: MONO, color: 'var(--ink-2)' }}>{seen.id}</span>
              </Row>
            </dl>
          </div>

          <div className="border-t px-5 pt-3 pb-[max(14px,env(safe-area-inset-bottom))]" style={{ borderColor: 'var(--line)', background: 'var(--card)' }}>
            <p id={statusId} role="status" aria-live="polite" className="m-0 mb-2 min-h-[1px] text-[13px] leading-[1.4] [overflow-wrap:anywhere]" style={{ color: note || error ? 'var(--bad)' : 'var(--ink-2)', fontWeight: note || error ? 600 : 400 }}>
              {status}
            </p>
            <div className="flex flex-wrap gap-2">
              <button {...answer('approve')} className="min-h-[44px] flex-1 basis-[120px] rounded-[10px] px-3 text-[15px] font-semibold aria-disabled:cursor-not-allowed aria-disabled:opacity-45" style={{ background: 'var(--ink)', color: 'var(--paper)' }}>
                {deciding === 'approve' ? 'Approving…' : 'Approve'}
              </button>
              <button {...answer('deny')} className="min-h-[44px] flex-1 basis-[120px] rounded-[10px] px-3 text-[15px] font-semibold aria-disabled:cursor-not-allowed aria-disabled:opacity-45" style={{ border: '2px solid var(--ink)', color: 'var(--ink)' }}>
                {deciding === 'deny' ? 'Denying…' : 'Deny'}
              </button>
              <button type="button" aria-expanded={more} aria-controls="cv-more-answers" onClick={() => setMore(!more)} className="ml-auto min-h-[44px] rounded-[10px] px-3 text-[14px] font-medium" style={{ color: 'var(--ink-2)', border: '1px solid var(--line-2)' }}>
                More answers
              </button>
            </div>
            {more && (
              <div id="cv-more-answers" className="mt-2 flex flex-wrap gap-2">
                <button {...answer('for', 60)} className="min-h-[40px] flex-1 basis-[140px] rounded-[10px] px-3 text-[13.5px] font-medium aria-disabled:opacity-45" style={{ border: '1px solid var(--line-2)', color: 'var(--ink)' }}>
                  Allow for 1 hour
                </button>
                <button {...answer('remember')} className="min-h-[40px] flex-1 basis-[140px] rounded-[10px] px-3 text-[13.5px] font-medium aria-disabled:opacity-45" style={{ border: '1px solid var(--line-2)', color: 'var(--ink)' }}>
                  Always allow this
                </button>
                <button {...answer('never')} className="min-h-[40px] flex-1 basis-[140px] rounded-[10px] px-3 text-[13.5px] font-medium aria-disabled:opacity-45" style={{ border: '1px solid var(--line-2)', color: 'var(--ink)' }}>
                  Never allow this
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </Shell>
  )
}

function Gone({ onClose, fallbackFocus }: { onClose: () => void; fallbackFocus: () => HTMLElement | null }) {
  return (
    <Shell onClose={onClose} restoreTo={(op) => (op && op.isConnected && op !== document.body ? op : fallbackFocus())}>
      {(headingId, headRef) => (
        <div className="flex items-start gap-3 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={headingId} ref={headRef} tabIndex={-1} className="m-0 text-[18px] font-semibold outline-none" style={{ color: 'var(--ink)' }}>
              Request not found
            </h2>
            <p className="m-0 mt-1.5 text-[14px]" style={{ color: 'var(--ink-2)' }}>
              It was decided or withdrawn before it opened. Nothing was decided here.
            </p>
          </div>
          <CloseBtn onClose={onClose} />
        </div>
      )}
    </Shell>
  )
}

let restoring = 0

/**
 * Modal frame: backdrop, Esc to close, focus restored to the opener (or a stable fallback). Containment is the shared
 * one (ui/useModalContainment): Tab/Shift-Tab cycle inside from anywhere, the board behind is inert. Restoring stays
 * here, a frame later, because the opener may be a note that is re-rendered by the decision.
 */
function Shell({ onClose, restoreTo, children }: { onClose: () => void; restoreTo: (opener: HTMLElement | null) => HTMLElement | null; children: (headingId: string, headRef: RefObject<HTMLHeadingElement | null>) => ReactNode }) {
  const headingId = useId()
  const headRef = useRef<HTMLHeadingElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  useModalContainment(boxRef, { restoreFocus: false })
  // whatever had focus when the dialog was first rendered (before it moves focus to its heading)
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  useEffect(() => {
    // a remount (StrictMode replays effects) cancels the restore its unmount scheduled
    cancelAnimationFrame(restoring)
    headRef.current?.focus({ preventScroll: true })
    return () => {
      // restore after the board has re-rendered (the opener may have been a note that just left)
      restoring = requestAnimationFrame(() => {
        restoreTo(opener)?.focus({ preventScroll: true })
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open
  }, [])
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }
  return (
    <div
      data-chrome
      data-ownkeys
      className="absolute inset-0 flex items-end justify-center sm:items-center sm:p-6"
      style={{ zIndex: 70, background: 'rgba(10,10,14,0.42)' }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={onKeyDown}
        className="flex max-h-[calc(100dvh-8px)] w-full flex-col overflow-hidden rounded-t-[18px] sm:max-h-[min(760px,calc(100dvh-48px))] sm:w-[min(620px,100%)] sm:rounded-[18px]"
        style={{ background: 'var(--card)', color: 'var(--ink)', boxShadow: 'var(--shadow-lg)', border: '1px solid var(--line-2)' }}
      >
        {children(headingId, headRef)}
      </div>
    </div>
  )
}

function CloseBtn({ onClose }: { onClose: () => void }) {
  return (
    <button aria-label="Close without deciding" title="Close (Esc)" onClick={onClose} className="grid size-10 shrink-0 place-items-center rounded-full hover:bg-[var(--accent-soft)]" style={{ color: 'var(--ink-2)' }}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 4l8 8M12 4l-8 8" /></svg>
    </button>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      <h3 className="m-0 mb-1.5 text-[11.5px] font-semibold tracking-[0.06em] uppercase" style={{ color: 'var(--ink-3)' }}>
        {label}
      </h3>
      {children}
    </section>
  )
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt style={{ color: 'var(--ink-3)' }}>{k}</dt>
      <dd className="m-0 min-w-0 [overflow-wrap:anywhere]" style={{ color: 'var(--ink)' }}>
        {children}
      </dd>
    </>
  )
}
