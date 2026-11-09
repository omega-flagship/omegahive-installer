import { useEffect, useRef, useState } from 'react'
import { useEscape } from '../lib/hooks'
import { Button } from './primitives'
import { useModalContainment } from './useModalContainment'

/**
 * In-app confirmation. Never the browser's native confirm(): native dialogs block the page for automation
 * and assistive tools, and cannot be styled or dismissed by the app.
 *
 * Any view that calls askConfirm mounts a <ConfirmHost />. Several may be mounted at once; only the most
 * recently mounted one renders, and a pending question is cancelled only when the last host goes away.
 */
type Pending = { message: string; confirmLabel: string; danger: boolean; resolve: (ok: boolean) => void }
let pending: Pending | null = null
const listeners = new Set<() => void>()
const hosts: number[] = []
let hostSeq = 0
const emit = () => listeners.forEach((l) => l())

/** `signal`: the caller's own lifetime. Aborting it answers this question "no" (only this one, never a newer one). */
export function askConfirm(message: string, confirmLabel = 'Continue', opts: { danger?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
  // an already-ended lifetime answers only itself: the question on screen (anyone's) is left exactly as it is
  if (opts.signal?.aborted) return Promise.resolve(false)
  pending?.resolve(false)
  return new Promise((resolve) => {
    const mine: Pending = { message, confirmLabel, danger: !!opts.danger, resolve }
    pending = mine
    opts.signal?.addEventListener('abort', () => { if (pending === mine) settle(false) }, { once: true })
    emit()
  })
}

/** Read-only view for tests: the question on screen, and a way to hear when it changes. */
export const confirmShowing = (): string | null => pending?.message ?? null
export function onConfirmChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function settle(ok: boolean) {
  const p = pending
  pending = null
  emit()
  p?.resolve(ok)
}

export function ConfirmHost() {
  const [, tick] = useState(0)
  const [id] = useState(() => ++hostSeq)
  useEffect(() => {
    const l = () => tick((n) => n + 1)
    listeners.add(l)
    hosts.push(id)
    emit()
    return () => {
      listeners.delete(l)
      hosts.splice(hosts.indexOf(id), 1)
      if (hosts.length === 0 && pending) settle(false)
      else emit()
    }
  }, [id])
  const active = hosts[hosts.length - 1] === id
  // only while a question is open here: an idle host never takes Esc from the sheet or page it sits in (mind-chat r1:
  // the mind panel's Model tab carries one, and Esc there did nothing)
  useEscape(() => settle(false), !!pending && active)
  const box = useRef<HTMLDivElement>(null)
  useModalContainment(box, { active: !!pending && active })
  if (!pending || !active) return null
  return (
    <div className="xc-dress xc-backdrop fixed inset-0 z-[95] flex items-center justify-center bg-shade/50 p-4" role="presentation" onClick={() => settle(false)}>
      <div ref={box} role="alertdialog" aria-modal="true" aria-label="Confirm" className="xc-frame w-full max-w-sm rounded-2xl border border-line bg-abyss p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <p className="text-[14px] text-ink [overflow-wrap:anywhere]">{pending.message}</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => settle(false)}>
            Cancel
          </Button>
          <Button variant={pending.danger ? 'danger' : 'primary'} autoFocus onClick={() => settle(true)}>
            {pending.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
