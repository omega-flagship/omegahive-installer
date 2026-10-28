import { m } from 'framer-motion'
import { createPortal } from 'react-dom'
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { accepts, boundNote, decisionFailure, decisionShown, type Bound, type DecisionResult, type DecisionUnsettled } from '../lib/decisionGate'
import { useEscape, useIsDesktop, useReducedMotion } from '../lib/hooks'
import { cx } from '../lib/cx'
import { Icon, type IconName } from './Icon'
import { useModalContainment } from './useModalContainment'
import { bindEpoch, onIdentityChange, STALE, type Stale } from '../lib/identityEpoch'

export interface DecisionAction {
  label: string
  busyLabel?: string
  tone: 'primary' | 'danger' | 'plain'
  /** Off until the person has given what the decision needs (an amount, a reason); `why` says what is missing. */
  blocked?: string | null
  /**
   * Resolves true when the hive took the decision (the dialog closes), a known refusal's words (a string: "Nothing
   * changed" is added), DecisionUnsettled (the outcome is not known) or DecisionFailed (a plain error, shown as written).
   * A run that throws is read by lib/decisionGate.decisionFailure: a lost answer is unsettled, never "nothing changed".
   * STALE (lib/identityEpoch) means the decision belonged to an earlier identity: the dialog shows nothing of it.
   */
  run: () => Promise<DecisionResult | Stale>
}

export type { DecisionFailed, DecisionResult, DecisionUnsettled } from '../lib/decisionGate'

/**
 * A classic decision with its full context (Review R2/R3): every fact the person needs is on screen, unclipped,
 * before anything can be decided. Focus starts on the heading, never on a decision; the decision buttons stay
 * focusable but refuse activation while the record no longer matches what was opened, during the arming window,
 * on a held key, or while a decision is in flight. Focus is contained (ui/useModalContainment) and returns to whatever opened it.
 */
export function DecisionDialog({
  icon = 'alert',
  eyebrow,
  title,
  facts,
  children,
  bound,
  thing,
  actions,
  onClose,
  dismissLabel = 'Cancel',
  restoreFocus,
}: {
  icon?: IconName
  eyebrow: string
  title: ReactNode
  /** Label and value, shown in full. */
  facts: [string, ReactNode][]
  /** Inputs the decision needs (an amount, a reason). */
  children?: ReactNode
  bound: Bound
  /** What the record is called in the notes ("This call", "This grant"). */
  thing: string
  actions: DecisionAction[]
  onClose: () => void
  /** The close button's words; set it when "Cancel" could be read as the decision itself (cancelling a goal). */
  dismissLabel?: string
  /** Where focus goes on close when the opener may have gone with the decision (a decided request's card): see useModalContainment. */
  restoreFocus?: (opener: HTMLElement | null) => HTMLElement | null | undefined
}) {
  const desktop = useIsDesktop()
  const reduced = useReducedMotion()
  const id = useId()
  const head = useRef<HTMLHeadingElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unsettled, setUnsettled] = useState<DecisionUnsettled | null>(null)
  const armed = useRef(0)
  const alive = useRef(true)
  useEscape(() => !busy && onClose())
  // Tab and Shift-Tab stay inside (from the heading too), the page behind is inert, focus returns to the opener
  useModalContainment(box, restoreFocus ? { restoreFocus } : {})
  // re-arm on open and whenever the binding changes, so a press aimed at a disabled button cannot land once it re-enables
  useLayoutEffect(() => {
    armed.current = performance.now()
  }, [bound.kind])
  useEffect(() => {
    alive.current = true
    head.current?.focus()
    return () => {
      alive.current = false
    }
  }, [])
  // Missing-UI r6 (stand-in r5 P1): a decision is the identity's that opened it. An identity change closes the dialog
  // at once (a clear, inside the change itself), and every settlement after an await is written through a binding
  // made before that await, checked in the same tick as the write; a stale answer writes nothing here.
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })
  useEffect(() => onIdentityChange(() => closeRef.current()), [])

  const note = boundNote(bound, thing)
  const open = bound.kind === 'ready' && !busy && !unsettled
  // unsettled outranks the binding's note: the decision is spent here either way, and what happened is the news
  const status = unsettled ? (busy ? `${busy}…` : unsettled.unsettled) : (note ?? (busy ? `${busy}…` : error))

  const settle = (r: DecisionResult) => {
    const shown = decisionShown(r)
    if (shown.kind === 'close') onClose()
    else if (shown.kind === 'error') setError(shown.text)
    else setUnsettled(shown.unsettled)
  }
  const failed = (err: unknown) => (err instanceof Error ? err.message : String(err))
  const recheck = async () => {
    const again = unsettled?.recheck
    if (!again || busy) return
    const binding = bindEpoch()
    setBusy('Checking')
    // a recheck that throws settles nothing: the same uncertainty stays, with the way to check again
    const r = await again().catch((err: unknown): DecisionResult => ({ unsettled: `${unsettled.unsettled} (${failed(err)})`, recheck: again }))
    if (!alive.current) return
    binding.commit(() => {
      setBusy(null)
      settle(r)
    })
  }
  const statusId = `${id}-s`

  const props = (a: DecisionAction) => ({
    'aria-disabled': !open || !!a.blocked,
    'aria-describedby': statusId,
    onKeyDown: (e: KeyboardEvent) => {
      // held Enter/Space: never a decision
      if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault()
    },
    onClick: async (e: MouseEvent) => {
      e.stopPropagation()
      if (!open || a.blocked || !accepts({ at: performance.now() }, armed.current)) return
      const binding = bindEpoch()
      setError(null)
      setBusy(a.busyLabel ?? a.label)
      // Review B1 (commons f0818d8): a thrown run is not a refusal; a lost answer stays unsettled
      const r = await a.run().catch((err: unknown) => decisionFailure(err))
      if (!alive.current || r === STALE) return
      binding.commit(() => {
        setBusy(null)
        settle(r)
      })
    },
  })

  return createPortal(
    <m.div
      className="xc-dress xc-backdrop fixed inset-0 z-[60] flex items-end justify-center bg-[#03030c]/70 p-3 backdrop-blur-[3px] md:items-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={() => !busy && onClose()}
      style={{ paddingBottom: desktop ? undefined : 'calc(var(--sab) + 12px)' }}
    >
      <m.div
        ref={box}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: reduced ? 0 : desktop ? 10 : 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
        className="xc-frame glass-strong relative flex max-h-[min(88dvh,760px)] w-full max-w-[520px] flex-col overflow-hidden rounded-[24px]"
      >
        <div className="flex items-start gap-3.5 border-b border-line px-5 pt-5 pb-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-warn/30 bg-warn/10 text-warn">
            <Icon name={icon} size={19} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="eyebrow">{eyebrow}</div>
            <h2 id={`${id}-t`} ref={head} tabIndex={-1} className="mt-0.5 font-display text-[18px] leading-tight font-semibold [overflow-wrap:anywhere] outline-none focus-visible:underline">
              {title}
            </h2>
          </div>
          <button type="button" onClick={onClose} disabled={!!busy} aria-label="Close" className="flex size-10 shrink-0 items-center justify-center rounded-xl text-ink-3 hover:bg-white/[0.07] hover:text-ink">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div role="region" aria-label="Everything this decision is about" tabIndex={0} className="thin-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4 select-text">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13.5px]">
            {facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-3">{k}</dt>
                <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{v}</dd>
              </div>
            ))}
          </dl>
          {children && <div className="mt-4 space-y-3">{children}</div>}
        </div>
        <div className="border-t border-line px-5 pt-3 pb-4">
          <p id={statusId} role="status" aria-live="polite" className={cx('mb-2 min-h-[1px] text-[13px] leading-snug [overflow-wrap:anywhere]', note || error || unsettled ? 'font-semibold text-bad' : 'text-ink-2')}>
            {status ?? actions.map((a) => a.blocked).find(Boolean) ?? ''}
          </p>
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                {...props(a)}
                className={cx(
                  'min-h-11 flex-1 basis-[140px] rounded-xl px-4 text-[14px] font-semibold transition-opacity aria-disabled:cursor-not-allowed aria-disabled:opacity-45',
                  a.tone === 'primary' && 'border border-control/50 text-[var(--color-primary-ink)]',
                  a.tone === 'danger' && 'border border-bad/30 bg-bad/15 text-bad',
                  a.tone === 'plain' && 'border border-line bg-white/[0.06] text-ink',
                )}
                style={a.tone === 'primary' ? { background: 'linear-gradient(180deg, var(--color-primary-top), var(--color-accent))' } : undefined}
              >
                {busy && (a.busyLabel ?? a.label) === busy ? `${busy}…` : a.label}
              </button>
            ))}
            {unsettled?.recheck && (
              <button type="button" onClick={() => void recheck()} disabled={!!busy} className="min-h-11 rounded-xl border border-line bg-white/[0.06] px-4 text-[14px] font-semibold text-ink">
                Check again
              </button>
            )}
            <button type="button" onClick={onClose} disabled={!!busy} className="min-h-11 rounded-xl px-4 text-[14px] text-ink-2 hover:bg-white/[0.06] hover:text-ink">
              {dismissLabel}
            </button>
          </div>
        </div>
      </m.div>
    </m.div>,
    document.body,
  )
}
