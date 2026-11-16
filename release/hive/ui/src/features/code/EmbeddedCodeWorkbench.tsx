import type { EmbeddedDepartureHandle } from './embeddedDeparture'
/** The original controller; local recovery contains text, never authority. */
import { useState, type ReactNode } from 'react'
import { ConfirmHost } from '../../ui/confirm'
import { useHive } from '../../store/store'
import { readContext } from '../../lib/readContext'
import { usePrincipal } from './EditSession'
import { retainedEmbeddedDrafts } from './embeddedDrafts'
import { Workbench, type SandboxTestHandler } from './CodePage'

export interface EmbeddedCodeWorkbenchProps {
  attachment: { task: string; repository: string; workspace?: string }
  onBack: () => void
  onClose: () => void
  onGrantRefused?: (why: string) => void
  onSandboxTest?: SandboxTestHandler
  sandboxTestStatus?: ReactNode
  sandboxTestPanel?: ReactNode
  sandboxTestAvailable?: boolean
  departure?: EmbeddedDepartureHandle
}

/** Attachment changes and forced parent unmounts keep drafts recoverable in this
 * tab/current sign-in. Recovery is read-only; saving still requires a fresh host
 * attachment and source read. No hidden generic run or source-write fallback. */
export function EmbeddedCodeWorkbench({ attachment, onBack, onClose, onGrantRefused,
  onSandboxTest, sandboxTestStatus, sandboxTestPanel, sandboxTestAvailable = false, departure }: EmbeddedCodeWorkbenchProps) {
  const client = useHive(s => s.client)
  const principal = usePrincipal()
  const [, changed] = useState(0)
  const [showDrafts, setShowDrafts] = useState(false)
  const context = readContext(client, principal)
  const kept = retainedEmbeddedDrafts(client, context, principal)
  const key = JSON.stringify([context, attachment.task, attachment.repository, attachment.workspace ?? null])
  if (!principal) return <section role="status">{principal === undefined ? 'Confirming your sign-in before opening Code…' : 'Code cannot confirm your sign-in. Reconnect before editing.'}</section>
  const recovery = kept.length > 0 && <section aria-label="Retained Code drafts" className="px-3 py-2">
        <button type="button" onClick={() => setShowDrafts(v => !v)} aria-expanded={showDrafts}>
          {kept.length} unsaved {kept.length === 1 ? 'draft' : 'drafts'} kept in this tab
        </button>
        {showDrafts && <div><p>Your text is recoverable here until this tab reloads or you sign out. Copy it before leaving; it is not saved to the repository.</p>
          {kept.map(d => <label key={d.slot} className="block">
            {d.repository} · {d.task} · {d.workspace} · {d.path}
            <textarea readOnly aria-label={`Retained draft ${d.path} ${d.slot}`} value={d.text} />
          </label>)}</div>}
      </section>
  return (
    <>

      <Workbench key={key} targetId={`repo:${attachment.repository}`} attachment={attachment}
        embedded={{ onBack, onClose, onDraftRetained: () => changed(n => n + 1), draftRecovery: recovery, departure }}
        onGrantRefused={onGrantRefused} onSandboxTest={onSandboxTest}
        sandboxTestStatus={sandboxTestStatus} sandboxTestPanel={sandboxTestPanel} sandboxTestAvailable={sandboxTestAvailable} />
      <ConfirmHost />
    </>
  )
}
