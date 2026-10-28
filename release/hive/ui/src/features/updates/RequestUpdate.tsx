import { useState } from 'react'
import { UPDATE_NOTE_MAX, UPDATE_RECEIPT_LEN, UPDATE_RECEIPTS_MAX, type UpdateRequestBody } from '../../api/missingUi'
import { decisionFailure } from '../../lib/decisionGate'
import { shown } from '../../lib/displayName'
import { need } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { boundRun, type ToastFn } from '../../lib/epochBound'
import type { Stale } from '../../lib/identityEpoch'
import type { HiveClient } from '../../api/client'
import type { DecisionResult } from '../../lib/decisionGate'

/** The request body for what was typed: receipts one per line, blanks dropped. Pure. */
export function requestBody(target: string, note: string, receipts: string): UpdateRequestBody {
  const lines = receipts.split('\n').map((l) => l.trim()).filter(Boolean)
  return { target, note: note.trim(), ...(lines.length ? { receipts: lines } : {}) }
}

/** Why the request cannot be sent yet, or null. The host's limits (updates.py request), checked before sending. Pure. */
export function requestBlocked(b: UpdateRequestBody): string | null {
  if (!b.target) return 'Choose what to update.'
  if (!b.note) return 'Say what the update is for.'
  if (b.note.length > UPDATE_NOTE_MAX) return `The note is longer than ${UPDATE_NOTE_MAX} characters.`
  const r = b.receipts ?? []
  if (r.length > UPDATE_RECEIPTS_MAX) return `At most ${UPDATE_RECEIPTS_MAX} receipts.`
  if (r.some((x) => x.length > UPDATE_RECEIPT_LEN)) return `A receipt line is longer than ${UPDATE_RECEIPT_LEN} characters.`
  return null
}

/**
 * Ask for an update (POST /api/updates/requests; admins; Surface missing-UI batch 1, audit item 7). A request is a
 * note to whoever applies updates: it changes nothing by itself, shows beside its target on this page, and is closed
 * when that update is applied.
 */
/** Sending an update request, bound to the identity it was pressed under (r5). */
export function requestUpdateRun(d: { client: HiveClient | null; body: UpdateRequestBody; label: string; onDone: () => void; toast: ToastFn }): () => Promise<DecisionResult | Stale> {
  return boundRun(async (binding) => {
    const why = requestBlocked(d.body)
    if (why) return why
    try {
      const r = await need(d.client, 'requestUpdate', 'Asking for an update')(d.body)
      binding.commit(() => {
        d.toast({ tone: 'success', icon: 'replay', title: 'Update requested', body: `${d.label}: ${r.note}` })
        d.onDone()
      })
      return true
    } catch (e) {
      return decisionFailure(e)
    }
  })
}

export function RequestUpdate({ apps, initial, onClose, onDone }: { apps: { id: string; name: string }[]; initial?: string; onClose: () => void; onDone: () => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [target, setTarget] = useState(initial ?? 'platform')
  const [note, setNote] = useState('')
  const [receipts, setReceipts] = useState('')
  const body = requestBody(target, note, receipts)
  const label = target === 'platform' ? 'The platform' : shown(apps.find((a) => `program:${a.id}` === target)?.name ?? target.slice(8))
  return (
    <DecisionDialog
      icon="replay"
      eyebrow="Ask for an update"
      title={`Ask for an update to ${target === 'platform' ? 'the platform' : label}?`}
      facts={[
        ['Target', <span className="font-mono text-[12px]">{target}</span>],
        ['What it does', 'Records your request and shows it beside the target here. Nothing is reloaded or restarted until someone applies the update.'],
        ['Receipts', body.receipts?.length ? `${body.receipts.length} line${body.receipts.length === 1 ? '' : 's'}` : 'none'],
      ]}
      bound={{ kind: 'ready' }}
      thing="This request"
      onClose={onClose}
      actions={[
        {
          label: 'Send the request',
          busyLabel: 'Sending',
          tone: 'primary',
          blocked: requestBlocked(body),
          run: requestUpdateRun({ client, body, label, onDone, toast }),
        },
      ]}
    >
      <label className="block">
        <span className="text-[12px] text-ink-3">What to update</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-line bg-black/30 px-2.5 text-[13px] text-ink outline-none focus:border-line-2">
          <option value="platform">The platform</option>
          {apps.map((a) => (
            <option key={a.id} value={`program:${a.id}`}>
              {shown(a.name)}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-[12px] text-ink-3">Why (shown to everyone who updates)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={UPDATE_NOTE_MAX} placeholder="The new release fixes the pin overlay; reviewed and signed off." className="mt-1 w-full resize-y rounded-xl border border-line bg-black/30 px-3 py-2 text-[13px] text-ink outline-none focus:border-line-2" />
      </label>
      <label className="block">
        <span className="text-[12px] text-ink-3">Receipts (optional, one per line: review links, hashes)</span>
        <textarea value={receipts} onChange={(e) => setReceipts(e.target.value)} rows={2} className="mt-1 w-full resize-y rounded-xl border border-line bg-black/30 px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-line-2" />
      </label>
    </DecisionDialog>
  )
}
