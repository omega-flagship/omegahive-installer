/**
 * Create's Draw live as ONE press (Dot R3 on f7deb7e2): from the press to the picker is a single flight, bound to the
 * person and Ask thread of the press until the very moment the picker opens.
 *
 * - The Ask turn comes from recordDrawTurn (typed words win; the Ask's own receipt; deadline first).
 * - Then, immediately before opening anything (beginLiveStudio binds to whoever is current), the press's own binding is
 *   checked again: an identity change, a new Ask thread, leaving the page or an abort in between opens nothing. The
 *   empty-Ask path (a recorded turn reused) is checked the same way.
 * - A second press while one is in flight joins it (same person, thread and identity): one Ask, one picker.
 * Resolves { opened: true }, { reason } (plain words for the page) or { cancelled: true } (say nothing).
 */
import { bindOperation } from '../../lib/boundOperation'
import { bindEpoch } from '../../lib/identityEpoch'
import { useAskStore } from '../../store/ask'
import { beginLiveStudio, recordDrawTurn } from './store'
import type { SetupTurn } from './api'

export type DrawLiveResult = { opened: true } | { reason: string } | { cancelled: true }
let flight: { key: string; run: Promise<DrawLiveResult> } | null = null
const pressKey = () => { const s = useAskStore.getState(); return `${bindEpoch().epoch}|${s.epoch}|${s.bound?.principal ?? ''}` }

export function drawLive(o: { programId: string; alive: () => boolean; signal?: AbortSignal; sim: boolean }): Promise<DrawLiveResult> {
  const key = pressKey()
  if (flight?.key === key) return flight.run
  const run = press(o).finally(() => { if (flight?.run === run) flight = null })
  flight = { key, run }
  return run
}

async function press({ programId, alive, signal, sim }: Parameters<typeof drawLive>[0]): Promise<DrawLiveResult> {
  const op = bindOperation(alive)
  const at = useAskStore.getState(), thread = at.epoch, principal = at.bound?.principal ?? null
  const live = () => { const s = useAskStore.getState(); return op.current() && !signal?.aborted && s.epoch === thread && (s.bound?.principal ?? null) === principal }
  let turn: SetupTurn | null = null
  if (!sim) {
    const got = await recordDrawTurn({ alive, signal })
    if ('cancelled' in got) return got
    if (!live()) return { cancelled: true }
    if ('reason' in got) return got
    turn = got.turn
  }
  // the last check, synchronously before the picker opens (and binds to whoever is current)
  if (!live()) return { cancelled: true }
  // r1.13: the live card draws on one of the person's SAVED canvases in their own Studio space (picked from a list read
  // through the host); the intent is recorded on their Ask turn (live). The simulator has its own Ask.
  useAskStore.getState().setThreadOpen(true)
  void beginLiveStudio(programId, turn)
  return { opened: true }
}
