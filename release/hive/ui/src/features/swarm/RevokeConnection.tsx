import { bindTo, decisionFailure } from '../../lib/decisionGate'
import { money } from '../../lib/format'
import { need } from '../../lib/useResource'
import type { ConnectionAgreement } from '../../api/types'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { boundRun, type ToastFn } from '../../lib/epochBound'
import type { Stale } from '../../lib/identityEpoch'
import type { HiveClient } from '../../api/client'
import type { DecisionResult } from '../../lib/decisionGate'

/** The host keeps the revoke reason in the connection's history (connections.py revoke; "revoked" when left empty). */
export const REVOKE_REASON_MAX = 500

/** Why the connection is revoked: optional, recorded with the revocation for everyone who reads its history. */
export function RevokeReason({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-[12px] text-ink-3">Why (optional; kept in the connection’s history for everyone who can see it)</span>
      <textarea value={value} onChange={(e) => onChange(e.target.value.slice(0, REVOKE_REASON_MAX))} rows={2} maxLength={REVOKE_REASON_MAX} placeholder="The review finished; nothing more is needed." className="mt-1 w-full resize-y rounded-xl border border-line bg-black/30 px-3 py-2 text-[13px] text-ink outline-none focus:border-line-2" />
    </label>
  )
}

/** Revoking a connection with a reason, bound to the identity it was pressed under (r5). */
export function revokeConnectionRun(d: { client: HiveClient | null; id: string; reason: string; onDone: (c: ConnectionAgreement) => void; toast: ToastFn }): () => Promise<DecisionResult | Stale> {
  return boundRun(async (binding) => {
    try {
      const out = await need(d.client, 'connectionAction', 'Revoking a connection')(d.id, 'revoke', undefined, d.reason.trim())
      binding.commit(() => {
        d.onDone(out)
        d.toast({ tone: 'success', icon: 'ban', title: 'Connection revoked', body: d.reason.trim() ? `Recorded with your reason.` : 'Recorded without a reason.' })
      })
      return true
    } catch (e) {
      return decisionFailure(e)
    }
  })
}

/** Revoke one connection, bound to exactly the record opened, with a reason sent to the host (audit drift item). */
export function RevokeConnectionDialog({ seen, live, name, mind, reason, setReason, onClose, onDone }: {
  seen: ConnectionAgreement
  live: ConnectionAgreement | undefined
  name: (id: string) => string
  mind: (id: string) => string
  reason: string
  setReason: (v: string) => void
  onClose: () => void
  onDone: (c: ConnectionAgreement) => void
}) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const c = seen
  return (
    <DecisionDialog
      icon="ban"
      eyebrow="Revoke a connection"
      title={`Revoke “${c.purpose}”?`}
      facts={[
        ['Connection', `${name(c.from_swarm)} ↔ ${name(c.to_swarm)} (${c.id})`],
        ['Coordinators', `${mind(c.from_coordinator)} ↔ ${mind(c.to_coordinator)}`],
        ['Status', c.status],
        ['Request allocation', `${money(c.allocated_usd)} of ${money(c.budget_usd)}`],
        ['Effect', 'Stops new access and cancels associated requests. Already read information is retained. It cannot be resumed.'],
      ]}
      bound={bindTo(c, live, ['id', 'status', 'scopes', 'ends_at', 'budget_usd', 'on_end'], (l) => (l.status === 'revoked' || l.status === 'ended' ? `This connection is already ${l.status}.` : null))}
      thing="This connection"
      onClose={onClose}
      actions={[
        {
          label: 'Revoke the connection',
          busyLabel: 'Revoking',
          tone: 'danger',
          run: revokeConnectionRun({ client, id: c.id, reason, onDone, toast }),
        },
      ]}
    >
      <RevokeReason value={reason} onChange={setReason} />
    </DecisionDialog>
  )
}
