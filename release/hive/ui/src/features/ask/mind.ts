/**
 * Words for the mind, from the field: one path for typed and spoken words alike. While a turn is open the words steer
 * it (the field never locks, the owner 2026-10-05); otherwise they are a new request. `via` is audit only.
 *
 * J3 r4.3 O3: while the person directs a live Studio session the words are a direction for its maker, through the coalesced
 * direction path (no new turn, no paid Ask turn per remark). There is no manual toggle (the owner 2640): the thread shows a chip,
 * "→ steering Studio", from the host's steer record, with a one-tap "Queue instead" (features/studioLive). When the Ask's
 * own per-part routing exists (J2), it decides; until then a live session means steer.
 */
import type { AskContext } from '../../api/ask'
import { useAskStore, type AskOpts } from '../../store/ask'
import { studioRoute } from '../studioLive/route'

export function askMind(text: string, context: AskContext, opts: AskOpts = {}): Promise<void> {
  const studio = studioRoute()
  if (studio) return studio.steer(text, opts.via ?? 'typed', context).then(() => undefined)
  const s = useAskStore.getState()
  return s.open ? s.steer(text, context, opts) : s.send(text, context, opts)
}
