import { useEffect, useState } from 'react'
import type { AgentIsolation, AgentStatus } from '../../api/types'
import { isolationText } from './mindStatus'
import { cx } from '../../lib/cx'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'

/** "Sandboxed" / "Not sandboxed", from what the running process actually has (GET /api/agents/{id}/isolation). */
export function IsolationChip({ agentId, status }: { agentId: string; status: AgentStatus }) {
  const client = useHive((s) => s.client)
  const [iso, setIso] = useState<{ id: string; value: AgentIsolation } | null>(null)
  // the boundary is set when the process starts, so ask again after a status change
  useEffect(() => {
    if (!client?.agentIsolation) return
    let cancelled = false
    client
      .agentIsolation(agentId)
      .then((value) => {
        if (!cancelled) setIso({ id: agentId, value })
      })
      .catch(() => {
        // unknown is not shown as either answer
        if (!cancelled) setIso(null)
      })
    return () => {
      cancelled = true
    }
  }, [client, agentId, status])
  if (!iso || iso.id !== agentId) return null
  const { label, title } = isolationText(iso.value)
  const safe = iso.value.os_sandbox
  return (
    <span
      tabIndex={0}
      title={title}
      aria-label={`${label}. ${title}`}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        safe ? 'border-good/30 bg-good/[0.07] text-good' : 'border-line bg-tint/[0.04] text-ink-3',
      )}
    >
      <Icon name={safe ? 'shield' : 'info'} size={10} />
      {label}
    </span>
  )
}
