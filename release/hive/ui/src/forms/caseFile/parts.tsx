import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ProgramAction, ProgramDescription, Uncertainty, WorkItem } from '../../api/types'
import { paramsSummary } from '../../lib/hostConfirm'
import type { ActContext } from '../contract'
import { ARM_MS, finished, opened, released, tryConfirm, type GateState } from './confirmGate'
import {
  CUSTODY_WORDS,
  custodySteps,
  GATE_WORDS,
  gateOf as gateOfId,
  kindLabel,
  labelU,
  placeActions,
  proposalOf,
  REVIEW_WORDS,
  roleOf,
  TRANSPORT_WORDS,
  type Exhibit,
} from './model'
import type { CaseState, Outcome, Sheet } from './useCase'
import { useModalContainment } from '../../ui/useModalContainment'

/** The material a part is drawn in. */
export type Material = 'glass' | 'paper' | 'mono'

// ------------------------------------------------------------------ identity

/** Truth's mark: a balance, drawn as strokes so it takes each grammar's ink. */
export function Scales({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M12 3v17M7 20h10M4 7h16M12 3.5l-.01 0" />
      <path d="M6 7l-3 6.5a3.2 3.2 0 0 0 6 0L6 7zM18 7l-3 6.5a3.2 3.2 0 0 0 6 0L18 7z" />
    </svg>
  )
}

// ------------------------------------------------------------------ uncertainty: method always named, never fused

export function U({ u, m }: { u: Uncertainty | null | undefined; m: Material }) {
  const l = labelU(u)
  if (!l.assessed)
    return (
      <span className="cf-u cf-u-none" title={l.text}>
        {m === 'mono' ? '[unassessed]' : 'unassessed'}
      </span>
    )
  if (m === 'mono')
    return (
      <span className="cf-u" data-method={l.method} title={l.text}>
        [{l.methodName.toUpperCase()} {l.parts.map((p) => (l.method === 'nal' || l.method === 'pln' ? `${p.key}=${p.value}` : p.value)).join(' ')}]
      </span>
    )
  if (m === 'paper')
    return (
      <span className="cf-u" data-method={l.method}>
        <span className="cf-u-m">{l.methodName}</span> {l.parts.map((p, i) => `${i ? ', ' : ''}${l.method === 'qualitative' || l.method === 'other' ? '' : p.name + ' '}${p.value}`)}
      </span>
    )
  return (
    <span className="cf-u" data-method={l.method} title={l.text} aria-label={l.text} role="img">
      <span className="cf-u-m">{l.methodName}</span>
      {l.parts.map((p) => (
        <span key={p.key} className="cf-u-p">
          {p.n !== undefined && <span className="cf-u-bar" aria-hidden="true" style={{ ['--v' as string]: Math.max(0, Math.min(1, p.n)) }} />}
          <i>{l.method === 'nal' || l.method === 'pln' ? p.key : ''}</i>
          {p.value}
        </span>
      ))}
    </span>
  )
}

// ------------------------------------------------------------------ status, flags, proposal

const STATUS_WORD: Record<string, string> = { corrected: 'Corrected', retracted: 'Retracted', superseded: 'Superseded' }

export function StatusMarks({ item, m }: { item: WorkItem; m: Material }) {
  const st = String(item.status ?? 'current')
  const flags = item.flags ?? []
  if (st === 'current' && !flags.length) return null
  return (
    <span className="cf-marks">
      {STATUS_WORD[st] && (
        <span className="cf-status" data-status={st} title={st === 'retracted' ? 'Withdrawn: do not rely on it. It adds no weight.' : st === 'superseded' ? 'Replaced; kept for the record. It adds no weight.' : 'Corrected; the earlier wording is in the errata.'}>
          {m === 'mono' ? `<${st.toUpperCase()}>` : STATUS_WORD[st]}
        </span>
      )}
      {flags.map((f) => (
        <span key={f} className="cf-flag" title={f === 'affected-by-correction' ? 'Something this depends on was corrected. Review whether it still holds.' : f}>
          {f === 'affected-by-correction' ? (m === 'mono' ? '!affected-by-correction' : 'Affected by a correction') : f}
        </span>
      ))}
    </span>
  )
}

/** Transport (what the hive checked) and review (what the case decided), always as two separate parts. */
export function Proposal({ item, m }: { item: WorkItem; m: Material }) {
  const p = proposalOf(item)
  if (!p) return null
  const t = TRANSPORT_WORDS[p.transport] ?? { label: p.transport, why: 'Reported by the program.', tone: 'muted' as const }
  const r = REVIEW_WORDS[p.review] ?? { label: p.review, why: 'Reported by the program.', tone: 'muted' as const }
  if (m === 'mono')
    return (
      <span className="cf-prop" aria-label={`Proposal ${p.goalId ?? ''}: transport ${t.label}; review ${r.label}`}>
        proposal{p.goalId ? ` ${p.goalId}` : ''} transport=<b data-tone={t.tone}>{t.label}</b> review=<b data-tone={r.tone}>{r.label}</b>
      </span>
    )
  return (
    <span className="cf-prop" role="group" aria-label={`Proposal${p.goalId ? ' ' + p.goalId : ''}`}>
      <span className="cf-prop-part" data-tone={t.tone} title={t.why}>
        <span className="cf-prop-k">Transport</span> {t.label}
      </span>
      <span className="cf-prop-part" data-tone={r.tone} title={r.why}>
        <span className="cf-prop-k">Review</span> {r.label}
      </span>
    </span>
  )
}

// ------------------------------------------------------------------ custody

export function CustodyChain({ status, m }: { status: unknown; m: Material }) {
  const steps = custodySteps(status)
  const now = steps.find((s) => s.state === 'current' || s.state === 'broken') ?? steps[steps.length - 1]
  const words = CUSTODY_WORDS[now.step]
  if (m === 'mono')
    return (
      <span className="cf-custody" title={words.why}>
        {steps.map((s, i) => (
          <span key={s.step} data-state={s.state}>
            {i ? '→' : ''}
            {s.state === 'broken' ? '✗' : s.state === 'todo' ? '·' : '■'}
            {s.step}
          </span>
        ))}
      </span>
    )
  return (
    <span className="cf-custody" role="img" aria-label={`Custody: ${words.label}. ${words.why}`} title={words.why}>
      {steps.map((s) => (
        <span key={s.step} className="cf-cstep" data-state={s.state}>
          <span className="cf-cdot" aria-hidden="true" />
          <span className="cf-cname">{CUSTODY_WORDS[s.step].label}</span>
        </span>
      ))}
    </span>
  )
}

export function ExhibitMarks({ marks, exhibits, onOpen, m }: { marks: string[]; exhibits: Exhibit[]; onOpen?: (mark: string) => void; m: Material }) {
  if (!marks.length) return <span className="cf-nosrc">{m === 'mono' ? 'no-source' : 'No source'}</span>
  return (
    <span className="cf-exmarks">
      {marks.map((mk) => {
        const ex = exhibits.find((e) => e.mark === mk)
        const shared = !!ex?.sameOrigin.length
        return (
          <button
            key={mk}
            type="button"
            className="cf-exmark"
            data-custody={ex?.custody}
            data-shared={shared || undefined}
            onClick={(e) => {
              e.stopPropagation()
              onOpen?.(mk)
            }}
            title={`Exhibit ${mk}: ${ex?.source.label ?? ''}. ${ex ? CUSTODY_WORDS[ex.custody].label : ''}${shared ? `. Shares its origin with ${ex!.sameOrigin.join(', ')}: not independent.` : ''}`}
          >
            {m === 'paper' ? mk : `Ex.${mk}`}
            {shared && <span aria-hidden="true">⁼</span>}
            <span className="sr-only">{shared ? ' (shared origin, not independent)' : ''}</span>
          </button>
        )
      })}
    </span>
  )
}

export function OriginNote({ ex, m }: { ex: Exhibit; m: Material }) {
  if (!ex.source.origin) return <span className="cf-origin" data-none>{m === 'mono' ? 'origin=?' : 'Origin not given'}</span>
  return (
    <span className="cf-origin" data-shared={ex.sameOrigin.length ? true : undefined} title={ex.sameOrigin.length ? `Shares origin “${ex.source.origin}” with exhibit ${ex.sameOrigin.join(', ')}: not independent.` : 'No other exhibit shares this origin.'}>
      {m === 'mono' ? `origin=${ex.source.origin}` : ex.source.origin}
      {ex.sameOrigin.length > 0 && <b className="cf-notindep">{m === 'mono' ? ` NOT-INDEPENDENT(${ex.sameOrigin.join(',')})` : ` · same origin as ${ex.sameOrigin.join(', ')} · not independent`}</b>}
    </span>
  )
}

// ------------------------------------------------------------------ action buttons

export function ActionRow({ item, cs, describe, m, limit }: { item: WorkItem; cs: CaseState; describe: ProgramDescription | null; m: Material; limit?: number }) {
  const { primary, more } = placeActions(describe, item)
  const [open, setOpen] = useState(false)
  const shownPrimary = limit ? primary.slice(0, limit) : primary
  const rest = limit ? [...primary.slice(limit), ...more] : more
  const btn = (a: (typeof primary)[number]) => {
    const g = cs.request
    const gated = !!gateOfId(a.id)
    return (
      <button
        key={a.id}
        type="button"
        className="cf-act"
        data-gated={gated || undefined}
        disabled={!!cs.running}
        onClick={(e) => {
          e.stopPropagation()
          g(a.id, [item.id], e.detail === 0)
        }}
      >
        {m === 'mono' ? a.id : (a.label ?? a.id)}
        {gated && <span className="cf-act-gate" aria-label=" (asks to confirm)">{m === 'mono' ? '*' : '◆'}</span>}
      </button>
    )
  }
  if (!primary.length && !more.length) return null
  return (
    <div className="cf-acts" role="group" aria-label={`Actions on ${item.label}`}>
      {shownPrimary.map(btn)}
      {rest.length > 0 && (
        <button type="button" className="cf-act cf-act-more" aria-expanded={open} onClick={(e) => (e.stopPropagation(), setOpen(!open))}>
          {open ? 'Fewer' : `More · ${rest.length}`}
        </button>
      )}
      {open && rest.map(btn)}
    </div>
  )
}


// ------------------------------------------------------------------ the selected item, in full

export function ItemPanel({ item, cs, describe, m, onClose }: { item: WorkItem; cs: CaseState; describe: ProgramDescription | null; m: Material; onClose: () => void }) {
  const exhibits = cs.model.exhibits.filter((e) => e.citedBy.some((c) => c.id === item.id))
  const headRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => headRef.current?.focus(), [item.id])
  return (
    <section className="cf-panel" aria-label={`${kindLabel(item.kind, describe)}: ${item.label}`}>
      <header className="cf-panel-h">
        <span className="cf-kind" data-role={roleOf(item.kind, describe)}>
          {kindLabel(item.kind, describe)} <span className="cf-id">{item.id}</span>
        </span>
        <button type="button" className="cf-close" onClick={onClose} aria-label="Close">
          {m === 'mono' ? '[esc]' : '×'}
        </button>
      </header>
      <h3 ref={headRef} tabIndex={-1} className="cf-panel-t">
        {item.label}
      </h3>
      {item.text && <p className="cf-panel-text">{item.text}</p>}
      <div className="cf-panel-meta">
        <U u={item.uncertainty} m={m} />
        <StatusMarks item={item} m={m} />
        <Proposal item={item} m={m} />
      </div>
      {exhibits.length > 0 && (
        <div className="cf-panel-sec">
          <h4>Exhibits</h4>
          <ul>
            {exhibits.map((ex) => (
              <li key={ex.key} className="cf-panel-ex">
                <span className="cf-exmark" data-custody={ex.custody}>
                  {m === 'paper' ? ex.mark : `Ex.${ex.mark}`}
                </span>
                <span className="cf-panel-exl">{ex.source.label}</span>
                <CustodyChain status={ex.source.status} m={m} />
                <OriginNote ex={ex} m={m} />
                {(ex.source.locator || ex.source.date) && (
                  <span className="cf-loc">
                    {[ex.source.locator, ex.source.date].filter(Boolean).join(' · ')}
                  </span>
                )}
                {ex.source.url && (
                  <a className="cf-ref" href={ex.source.url} target="_blank" rel="noopener noreferrer nofollow">
                    {ex.source.url.replace(/^https?:\/\//, '')}
                    <span className="sr-only"> (external reference, opens a new tab; the hive never opens it for you)</span>
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(item.revisions ?? []).length > 0 && (
        <div className="cf-panel-sec">
          <h4>Revisions</h4>
          <ol className="cf-revs">
            {(item.revisions ?? []).map((r, i) => (
              <li key={i}>
                <span className="cf-id">{r.revision}</span> <s>{r.label}</s>
                {r.note && <span className="cf-note"> — {r.note}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
      <ActionRow item={item} cs={cs} describe={describe} m={m} />
    </section>
  )
}

// ------------------------------------------------------------------ outcomes

const STATUS_TEXT: Record<string, string> = { done: 'Done', started: 'Started', needs_input: 'Needs input', stale: 'Stale: the case changed', refused: 'Refused', error: 'Error' }

export function Outcomes({ cs, m }: { cs: CaseState; m: Material }) {
  return (
    <div className="cf-outcomes" role="status" aria-live="polite">
      {cs.running && <div className="cf-outcome" data-status="running">{m === 'mono' ? `… ${cs.running}` : `Working: ${cs.running}…`}</div>}
      {cs.outcomes.slice(0, 3).map((o) => (
        <div key={o.at} className="cf-outcome" data-status={o.result.status}>
          <span className="cf-outcome-s">{m === 'mono' ? `[${o.result.status}]` : STATUS_TEXT[o.result.status] ?? o.result.status}</span>
          <span className="cf-outcome-a">{o.label}</span>
          {o.result.message && <span className="cf-outcome-m">{o.result.message}</span>}
          {o.result.task && (
            <span className="cf-outcome-m">
              Task {o.result.task.id} · {o.result.task.status}
            </span>
          )}
          {o.result.receipt && <span className="cf-outcome-m">Receipt {o.result.receipt.state}</span>}
          {o.result.detail?.sources && (
            <span className="cf-outcome-m">{o.result.detail.sources.map((s) => `${s.label} (${s.status ?? 'cited'})`).join('; ')}</span>
          )}
          <button type="button" className="cf-close" onClick={() => cs.dismiss(o.at)} aria-label="Dismiss">
            {m === 'mono' ? 'x' : '×'}
          </button>
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ the full-context confirm

const VERB: Record<string, string> = { spend: 'Spend and dispatch', dispatch: 'Dispatch', egress: 'Fetch from outside', durable: 'Record permanently' }

/** §9d: the hive's describe says this action takes the host confirm (its effective `confirm`, or person_activity). */
export const takesHostConfirm = (a: ProgramAction) => a.confirm === true || a.person_activity === true

/**
 * Kimi next22b/23b r2 #2: ONE dialog per act. When the sheet opens for an action that takes the host confirm, the
 * sheet IS that confirm: it is armed like a gated sheet, shows what the act sends (action, items, the exact params,
 * the revision) and tells the host `confirmed`, so the host mints at once instead of asking a second time. A gated
 * sheet is a full-context confirm too. Anything else confirms nothing and the host asks as usual.
 */
export function sheetContext(sheet: Pick<Sheet, 'action' | 'gate'>, inspected: string): ActContext {
  return { baseRevision: inspected, ...(sheet.gate || takesHostConfirm(sheet.action) ? { confirmed: true as const } : {}) }
}

/** The params the sheet sends: exactly the filled fields (what the sheet shows under "Sends"). */
export const sheetParams = (values: Record<string, string>): Record<string, string> | undefined => {
  const params = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()))
  return Object.keys(params).length ? params : undefined
}

export function ActionSheet({ sheet, cs, revision, m, className }: { sheet: Sheet; cs: CaseState; revision: string; m: Material; className?: string }) {
  const { action, gate, items } = sheet
  const req = { action: action.id, items, revision }
  // Review C2: the revision this sheet was opened on (one sheet per opening); the host is given exactly it
  const inspected = useRef(revision)
  const gateRef = useRef<GateState | null>(null)
  // a gated sheet, or the one confirm for an action that takes the host confirm: armed only after a moment
  const hostConfirm = takesHostConfirm(action)
  const confirming = !!gate || hostConfirm
  const [armed, setArmed] = useState(!confirming)
  const [why, setWhy] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const headRef = useRef<HTMLHeadingElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const fields = Object.entries(action.params ?? {})
  // Review B1: Tab and Shift-Tab (from the initial heading too) stay in the sheet; the case behind is inert
  useModalContainment(boxRef)

  useEffect(() => {
    gateRef.current = opened({ action: action.id, items, revision }, performance.now(), sheet.viaKey)
    headRef.current?.focus()
    const up = () => {
      if (gateRef.current) gateRef.current = released(gateRef.current)
    }
    window.addEventListener('keyup', up)
    window.addEventListener('blur', up)
    const t = confirming ? window.setTimeout(() => setArmed(true), ARM_MS) : 0
    return () => {
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', up)
      window.clearTimeout(t)
    }
    // one opening per sheet: a new request is a new sheet (seq)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet.seq])

  const submit = async (press: Parameters<typeof tryConfirm>[2]) => {
    if (confirming) {
      if (!gateRef.current) return
      const v = tryConfirm(gateRef.current, req, press)
      if (!v.ok) {
        setWhy(v.words)
        return
      }
      gateRef.current = v.next
    }
    cs.closeSheet()
    try {
      // §9d: this sheet IS the full-context confirm (gated, or an action that takes the host confirm), so the host
      // mints at once instead of asking a second time (sheetContext)
      await cs.run(action, items, sheetParams(values), sheetContext(sheet, inspected.current))
    } finally {
      if (gateRef.current) gateRef.current = finished(gateRef.current, req)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cs.closeSheet()
    }
  }

  const targets = items.map((i) => cs.byId.get(i)).filter((x): x is WorkItem => !!x)
  const row = (k: string, v: ReactNode) => (
    <div className="cf-sheet-row">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  )
  return (
    <div className={`cf-scrim ${className ?? ''}`} onMouseDown={(e) => e.target === e.currentTarget && cs.closeSheet()}>
      <div ref={boxRef} className="cf-sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-h`} data-gate={gate?.kind} onKeyDown={onKey}>
        {gate && <div className="cf-sheet-gate">{m === 'mono' ? `!! ${GATE_WORDS[gate.kind].toUpperCase()}` : GATE_WORDS[gate.kind]}</div>}
        <h2 id={`${id}-h`} ref={headRef} tabIndex={-1} className="cf-sheet-t">
          {action.label ?? action.id}
        </h2>
        <dl className="cf-sheet-ctx">
          {row(
            'On',
            <ul>
              {targets.map((t) => (
                <li key={t.id}>
                  “{t.label}” <span className="cf-id">{t.id}</span>
                </li>
              ))}
            </ul>,
          )}
          {gate && row('Who acts', gate.who)}
          {gate && row('Cost', gate.cost)}
          {gate && row('Deadline', gate.deadline)}
          {gate?.disclosure && row('Shared', gate.disclosure)}
          {row('Bound to', `Revision ${revision}. If the case changes first, it is refused and nothing happens.`)}
          {hostConfirm && row('Action', action.label && action.label !== action.id ? `${action.label} (${action.id})` : action.id)}
          {hostConfirm && fields.length > 0 && row('Sends', paramsSummary(sheetParams(values)))}
          {hostConfirm && row('What happens', 'The app carries out this action in this swarm as you, once you confirm here. The hive checks it is exactly what this sheet shows; you are not asked a second time.')}
        </dl>
        {fields.length > 0 && (
          <div className="cf-sheet-fields">
            {fields.map(([k, hint]) => (
              <label key={k} className="cf-field">
                <span className="cf-field-k">{k.replace(/_/g, ' ')}</span>
                {k === 'text' || k === 'note' || k === 'content' ? (
                  <textarea rows={k === 'text' ? 3 : 2} value={values[k] ?? ''} placeholder={hint} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
                ) : (
                  <input value={values[k] ?? ''} placeholder={hint} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
                )}
              </label>
            ))}
          </div>
        )}
        <p className="cf-sheet-why" aria-live="assertive">
          {why ?? (confirming && !armed ? 'Read what this will do. Confirm becomes available in a moment.' : '')}
        </p>
        <div className="cf-sheet-btns">
          <button type="button" className="cf-btn cf-btn-quiet" onClick={() => cs.closeSheet()}>
            Cancel
          </button>
          <button
            type="button"
            className="cf-btn cf-btn-go"
            data-armed={armed || undefined}
            aria-disabled={!armed || !!cs.running}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              if (!armed || cs.running) return
              void submit({ kind: 'key', key: e.key, repeat: e.repeat, at: performance.now() })
            }}
            onClick={(e) => {
              if (e.detail === 0 || !armed || cs.running) return
              void submit({ kind: 'pointer', at: performance.now() })
            }}
          >
            {gate ? VERB[gate.kind] : hostConfirm ? 'Confirm' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  )
}

export type { Outcome }
