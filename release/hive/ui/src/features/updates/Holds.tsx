import { useState } from 'react'
import type { PlaceHoldBody, UpdateHold } from '../../api/types'
import { bindTo, decisionFailure } from '../../lib/decisionGate'
import { ago, until as untilWords } from '../../lib/format'
import { need } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { holdBlocked, holdScopeWords, holdUntil } from './updates'

/** One hold target: the platform (a restart hold), one app (program:<id>), or everything. */
export interface HoldTarget {
  scope: PlaceHoldBody['scope']
  label: string
}

const local = (iso: string) => `${new Date(iso).toLocaleString()} (${Date.parse(iso) > Date.now() ? untilWords(iso) : ago(iso)})`

/**
 * Place a hold (admins): a reason and an optional end, decided in the shared DecisionDialog. A hold refuses the update
 * for everyone (only an admin signed in as a person can override it, and that is recorded); minds can never override.
 */
export function PlaceHold({ target, existing, onClose, onDone }: { target: HoldTarget; existing: UpdateHold[]; onClose: () => void; onDone: () => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [reason, setReason] = useState('')
  const [end, setEnd] = useState('')
  const parsed = holdUntil(end)
  return (
    <DecisionDialog
      icon="pause"
      eyebrow="Hold updates"
      title={`Hold: ${holdScopeWords(target.scope, () => target.label)}?`}
      facts={[
        ['Stops', holdScopeWords(target.scope, () => target.label)],
        ['Scope sent', <span className="font-mono text-[12px]">{target.scope}</span>],
        ['Already held by', existing.length ? existing.map((h) => `${h.held_by}: ${h.reason}`).join('; ') : 'nothing'],
        ['Ends', parsed.ok ? (parsed.until ? local(parsed.until) : 'when someone releases it') : 'not set yet'],
      ]}
      bound={{ kind: 'ready' }}
      thing="This hold"
      onClose={onClose}
      actions={[
        {
          label: 'Place hold',
          busyLabel: 'Placing',
          tone: 'primary',
          blocked: holdBlocked(reason, parsed),
          run: async () => {
            const p = holdUntil(end)
            if (!p.ok) return p.why
            try {
              await need(client, 'placeHold', 'Placing a hold')({ scope: target.scope, reason: reason.trim(), ...(p.until ? { until: p.until } : {}) })
              toast({ tone: 'success', icon: 'pause', title: 'Hold placed', body: holdScopeWords(target.scope, () => target.label) })
              onDone()
              return true
            } catch (e) {
              return decisionFailure(e)
            }
          },
        },
      ]}
    >
      <label className="block">
        <span className="text-[12px] text-ink-3">Why it must not be interrupted (shown to everyone who updates)</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={600} placeholder="The nightly contract review is running until about 6pm." className="mt-1 w-full resize-y rounded-xl border border-line bg-black/30 px-3 py-2 text-[13px] text-ink outline-none focus:border-line-2" />
      </label>
      <label className="block">
        <span className="text-[12px] text-ink-3">Ends (your time; leave empty to hold until released)</span>
        <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} aria-invalid={!parsed.ok} className="mt-1 min-h-11 w-full rounded-xl border border-line bg-black/30 px-3 text-[13px] text-ink outline-none focus:border-line-2" />
        {!parsed.ok && <span className="mt-1 block text-meta text-bad">{parsed.why}</span>}
      </label>
    </DecisionDialog>
  )
}

/** Lift (release) a hold, bound to the exact hold opened: if it lapsed or someone released it, nothing is decided. */
export function LiftHold({ seen, live, label, onClose, onDone }: { seen: UpdateHold; live: UpdateHold | undefined; label: string; onClose: () => void; onDone: () => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  return (
    <DecisionDialog
      icon="replay"
      eyebrow="Lift a hold"
      title={`Lift “${seen.reason}”?`}
      facts={[
        ['Stops', label],
        ['Placed by', `${seen.held_by}, ${local(seen.created_at)}`],
        ['Reason', seen.reason],
        ['Ends', seen.until ? local(seen.until) : 'when someone releases it'],
        ['Hold', <span className="font-mono text-[12px]">{seen.id}</span>],
      ]}
      bound={bindTo(seen, live, ['id', 'scope', 'reason', 'held_by', 'until'])}
      thing="This hold"
      onClose={onClose}
      actions={[
        {
          label: 'Lift hold',
          busyLabel: 'Lifting',
          tone: 'danger',
          run: async () => {
            try {
              await need(client, 'releaseHold', 'Lifting a hold')(seen.id)
              toast({ tone: 'success', title: 'Hold lifted', body: label })
              onDone()
              return true
            } catch (e) {
              return decisionFailure(e)
            }
          },
        },
      ]}
    >
      <p className="text-[13px] leading-relaxed text-ink-2">Updates it held back can then be applied, interrupting whatever {seen.held_by} protected. Only lift it if that work is finished.</p>
    </DecisionDialog>
  )
}
