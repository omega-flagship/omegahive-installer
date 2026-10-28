/** J3 r4.3 O3: Directing Studio's status words, from host records only (kept apart from the components). */

/**
 * Kimi K2 (r1.2): the host stop is confirmed only when the session state AND the stop record both say it is over and
 * nothing is in flight (r1.9: `stopped`, or the terminal `ended`). Anything else after a Stop is "not confirmed".
 */
export function remoteStopConfirmed(state: string | undefined, stop: { state: string; in_flight: number | null; maker_released?: boolean | null } | undefined): boolean {
  if (!(state === 'stopped' || state === 'ended') || !(stop?.state === 'stopped' || stop?.state === 'ended')) return false
  // host R5 sends in_flight (reserved + dispatched calls under the session's label): confirmed only at 0, and never while
  // the host says the maker is NOT released. Host R3 sends none and reaches `stopped` only with every dispatched call
  // settled or unknown and the maker released, so there the release is the confirmation.
  if (stop.in_flight !== null) return stop.in_flight === 0 && stop.maker_released !== false
  return stop.maker_released === true
}
/**
 * r1.4 (stand-in r1.3 P2): a reload may forget the kept session only once the host stop is confirmed (the shared
 * R3-aware rule above) AND the money is resolved: the host's authoritative `budget.unknown` is known and 0 (R3 sends no
 * stop-level figure; the plan's `stop.unknown_usd`, when given, must not disagree). Unknown money keeps it.
 */
export function reloadMayForget(l: { state: string; stop: { state: string; in_flight: number | null; maker_released?: boolean | null; unknown_usd: number | null }; budget: { unknown: number | null } }): boolean {
  return remoteStopConfirmed(l.state, l.stop) && l.budget.unknown === 0 && !((l.stop.unknown_usd ?? 0) > 0)
}
export function remoteWords(state: string | undefined, stop: { state: string; in_flight: number | null; maker_released?: boolean | null } | undefined): string {
  if (remoteStopConfirmed(state, stop)) return 'remote: stopped'
  if (state === 'stopping') return 'remote: stopping…'
  if (state === 'stopped' || state === 'ended' || (stop && stop.state !== 'none')) return 'remote: stop not confirmed'
  if (state === 'paused') return 'paused'
  if (state === 'held') return 'held'
  return 'running'
}

/** E5: a queued direction is not delivered until a step admits it (host plan r1.2); words from the host state only. */
/** Kimi K5: the maker's effective role and tools from the consent payload (explicit none when null / empty). */
export function roleToolsWords(c: { role_id: string | null; tools: string[] }): string {
  return `role: ${c.role_id ?? 'none'} · tools: ${c.tools.length ? c.tools.join(', ') : 'none'}`
}

export const DIRECTION_WORDS: Record<string, string> = { queued: 'still queued', delivered: 'with the next step', read: 'read by the maker', cancelled: 'not sent: the session stopped before the maker read it' }

/** r1.7 (stand-in r1.6 #2): after "also queue as new work", what became of the ORIGINAL direction, from its host state */
export function alsoQueuedWords(state: string): string {
  if (state === 'cancelled') return 'Asked as new work. The original was never read by the maker: Stop cancelled it.'
  if (state === 'read') return 'Also queued as new work. The maker has already read the original.'
  return 'Also queued as new work. The original direction is still active.'
}

/** host R5: a queued direction while the session is paused or held waits; say so (never "sent") */
export function directionWords(state: string, sessionState: string | undefined): string {
  if (state === 'queued' && sessionState === 'paused') return 'still queued: the session is paused, so it reaches the maker after you resume'
  if (state === 'queued' && sessionState === 'held') return 'still queued: the session is held, so it waits until the hive clears it'
  return DIRECTION_WORDS[state] ?? state
}

/** host R5 Stop progress, from the stop view only: calls still settling, money not settled, the maker's ack */
export function stopProgressWords(state: string, stop: { state: string; in_flight: number | null; cancel_ack: string | null }): string | null {
  // r1.7 (Kimi r1.6 #2): only while BOTH the session and its stop record say stopping (never after either settles)
  if (state !== 'stopping' || stop.state !== 'stopping') return null
  const n = stop.in_flight
  if (n !== null && n > 0) return `Stopping: ${n === 1 ? 'one call was already sent and is finishing' : `${n} calls were already sent and are finishing`}. Stop completes when ${n === 1 ? 'it settles' : 'they settle'}; nothing new starts.`
  return 'Stopping: nothing new starts; the hive is releasing the maker.'
}

/**
 * The current step in a few words, from the ledger only (Code's receipt binding; Design routing review P2): a published
 * proposal is "proposal ready", "drawn" only on the host-recorded applied outcome, and any other end says what it is,
 * never "done".
 */
export function stepWords(steps: { n: number; state: string; proposal_n: number | null; outcome: string | null }[]): string {
  const s = steps.at(-1)
  if (!s) return 'the maker is starting'
  if (s.state === 'admitted') return `step ${s.n}: the maker is working`
  if (s.proposal_n !== null && !s.outcome) return `step ${s.n}: proposal ready, waiting for the canvas`
  switch (s.outcome) {
    case 'applied': return `step ${s.n} drawn`
    case 'refused': return `step ${s.n} not applied`
    case 'accepted-no-source-change': return `step ${s.n}: nothing changed in the piece`
    case 'invalid': return `step ${s.n} could not be used`
    case 'unreported':
    case 'unknown': return `step ${s.n}: not confirmed`
  }
  // no confirmed result (interrupted, timed out, stopped, or finished without a confirmed publication): never "nothing drawn"
  if (s.state === 'timed_out' || s.state === 'timed_out_unread' || s.state === 'interrupted' || s.state === 'stopped' || s.state === 'finished') return `step ${s.n}: drawing not confirmed`
  return `step ${s.n}: held`
}

/** r1.5 (host R4 L6): an outcome held over its op ids. Honest: not confirmed, not skipped, not replayed. */
export function opIdHoldWords(why: 'op-ids-missing' | 'op-ids-malformed' | 'op-ids-differ' | 'op-ids-refused', n: number | null): string {
  const step = n !== null ? `Step ${n}` : 'This step'
  return why === 'op-ids-missing'
    ? `${step}: result not confirmed. The canvas didn’t say which changes it checked, so nothing was reported. It won’t be skipped or replayed.`
    : why === 'op-ids-malformed'
      ? `${step}: result not confirmed. The canvas named its changes in a form the hive can’t accept, so nothing was reported. It won’t be skipped or replayed.`
      : `${step}: result not confirmed. The canvas and the hive disagree about which changes were in it. It won’t be skipped or replayed.`
}
