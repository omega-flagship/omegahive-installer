import { m } from 'framer-motion'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useEscape, useIsDesktop } from '../lib/hooks'
import { Icon, type IconName } from './Icon'
import { Button } from './primitives'
import { useModalContainment } from './useModalContainment'

/**
 * A strong confirmation: the destructive button only arms once the operator types `phrase`.
 * Used for "Stop all" and "Reset memory".
 */
export function ConfirmDialog({
  title,
  body,
  phrase,
  confirmLabel,
  onConfirm,
  onClose,
  icon = 'alert',
  tour,
}: {
  title: string
  body: ReactNode
  phrase: string
  confirmLabel: string
  onConfirm: () => Promise<boolean | void> | boolean | void
  onClose: () => void
  icon?: IconName
  /** Tour anchor (data-tour) on the dialog. */
  tour?: string
}) {
  const desktop = useIsDesktop()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLFormElement>(null)
  const id = useId()
  useEscape(onClose)
  useModalContainment(box)
  const armed = text.trim().toLowerCase() === phrase.trim().toLowerCase()

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!armed || busy) return
    setBusy(true)
    const ok = await onConfirm()
    setBusy(false)
    if (ok !== false) onClose()
  }

  return (
    <m.div
      className="xc-dress xc-backdrop fixed inset-0 z-[60] flex items-end justify-center bg-[#03030c]/70 p-3 backdrop-blur-[3px] md:items-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      style={{ paddingBottom: desktop ? undefined : 'calc(var(--sab) + 12px)' }}
    >
      <m.form
        ref={box}
        role="alertdialog"
        data-tour={tour}
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        aria-describedby={`${id}-b`}
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: desktop ? 10 : 40, scale: desktop ? 0.96 : 1 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: desktop ? 6 : 30, scale: 0.98, transition: { duration: 0.15 } }}
        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
        className="xc-frame glass-strong relative w-full max-w-[420px] overflow-hidden rounded-[24px] p-5"
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-28" style={{ background: 'radial-gradient(70% 100% at 50% 0%, color-mix(in srgb, var(--color-bad) 22%, transparent), transparent)' }} />
        <div className="relative flex items-start gap-3.5">
          <span className="relative flex size-11 shrink-0 items-center justify-center rounded-2xl border border-bad/30 bg-bad/10 text-bad shadow-[0_0_24px_-4px_rgb(251_113_133/0.55)]">
            <Icon name={icon} size={21} />
          </span>
          <div className="min-w-0">
            <h2 id={`${id}-t`} className="font-display text-[18px] leading-tight font-semibold">
              {title}
            </h2>
            <div id={`${id}-b`} className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
              {body}
            </div>
          </div>
        </div>
        <label className="relative mt-4 block">
          <span className="text-[12px] text-ink-3">
            Type <span className="rounded-md border border-line-2 bg-white/[0.05] px-1.5 py-px font-mono text-ink">{phrase}</span> to confirm
          </span>
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="mt-2 min-h-12 w-full rounded-xl border bg-black/30 px-3.5 font-mono text-ink transition-colors outline-none placeholder:text-ink-4"
            style={{ borderColor: armed ? 'rgb(251 113 133 / 0.6)' : 'var(--color-line)' }}
            placeholder={phrase}
            aria-invalid={text.length > 0 && !armed}
          />
        </label>
        <div className="relative mt-4 flex gap-2">
          <Button type="button" variant="ghost" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={!armed || busy}
            className="flex-[1.4] data-[armed=true]:bg-bad data-[armed=true]:text-[#1d0309] data-[armed=true]:shadow-[0_8px_30px_-6px_rgb(251_113_133/0.8)]"
            data-armed={armed}
          >
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </m.form>
    </m.div>
  )
}
