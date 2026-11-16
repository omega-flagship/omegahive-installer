import { useRef, useState } from 'react'
import { claimAppAsk, useAppAskStore, type PresentedAsk } from '../../store/appAsk'
import { useAskStore } from '../../store/ask'

/**
 * Always host-owned, including skins which draw no floating Ask. Recovery claims presentation, never ends a turn.
 * The card is keyed by the turn it recovers (operation, epoch, offered locally), so a different turn starts with a fresh
 * card: not busy, no error, and a late answer for the earlier turn cannot touch it.
 */
export function AppAskRecovery() {
  const turns = useAppAskStore((s) => s.turns)
  const entry = [...turns].reverse().find((t) => t.current() && (t.offeredLocally || !t.presentation.host_active))
  if (!entry) return null
  return <AppAskRecoveryCard key={`${entry.presentation.operation_id}:${entry.presentation.epoch}:${entry.offeredLocally ? 1 : 0}`} entry={entry} />
}

function AppAskRecoveryCard({ entry }: { entry: PresentedAsk }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const request = useRef(0)
  const recover = async () => {
    if (busy) return
    const ticket = ++request.current
    setBusy(true); setError(false)
    try {
      const claimed = await claimAppAsk(entry)
      if (!claimed || !entry.current()) { if (ticket === request.current) setError(true); return }
      await useAskStore.getState().showAppTurn(claimed.operation_id)
    } catch { if (entry.current() && ticket === request.current) setError(true) }
    finally { if (ticket === request.current) setBusy(false) }
  }
  return <div data-app-ask-recovery className="ask-root fixed bottom-4 right-4 z-[55] max-w-[calc(100%-2rem)] rounded-xl border border-line bg-panel p-2 text-sm shadow-lg" role="region" aria-label="Return to Ask">
    <button type="button" className="rounded-lg px-4 py-3 font-medium focus-visible:outline focus-visible:outline-2" disabled={busy} onClick={() => void recover()}>{busy ? 'Returning…' : 'Return to Ask'}</button>
    {error && <p role="status" className="max-w-xs px-3 pb-2">Could not confirm the handover. Check again; your turn has not been replaced.</p>}
  </div>
}
