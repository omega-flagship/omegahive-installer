// Purpose: the hive's own failures the Ask meets, noted with the page's errors (lib/recentErrors), where the feedback
// area drafts reports from them (drafts.ts): a mind that stopped while it owed the person an answer (a turn refused for
// running out of time, or ended with an error or out of time), and a hand-over the hive made that was refused
// afterwards, read from its intent until it settles.
import type { HiveClient } from '../../api/client'
import type { AskEvent, DoneOutcome, RefusalReason } from '../../api/ask'
import { parseIntentView } from '../../api/askIntents'
import { onIdentityChange } from '../../lib/identityEpoch'
import { noteError, utcSecond } from '../../lib/recentErrors'
import { useAskStore, type TurnMeta } from '../../store/ask'
import { DONE_WORDS, doneErrorWords, REFUSAL_WORDS } from '../ask/words'

/**
 * How a turn ends when a mind stopped while it owed an answer: the host's deadline passed (refused timed_out, done
 * time_cap) or the mind failed (done error). A person's stop or takeover, a limit and a sleeping mind are said in the
 * Ask's own words and drafted nothing: they are not the hive failing.
 */
export const STOPPED_REFUSALS: ReadonlySet<RefusalReason> = new Set<RefusalReason>(['timed_out'])
export const STOPPED_ENDS: ReadonlySet<DoneOutcome> = new Set<DoneOutcome>(['error', 'time_cap'])

const mindOf = (t: TurnMeta) => t.answerer?.name || t.about || 'The mind'
const second = (at: string) => (Number.isFinite(Date.parse(at)) ? utcSecond(Date.parse(at)) : utcSecond())

/** What one of the Ask's frames says failed, as the page's errors keep it; null for a frame that says nothing failed. */
export function stoppedMind(t: TurnMeta, e: AskEvent): Parameters<typeof noteError>[0] | null {
  if (e.phase === 'refused' && STOPPED_REFUSALS.has(e.reason))
    return { kind: 'mind', where: mindOf(t), code: e.reason, message: REFUSAL_WORDS[e.reason].say, at: second(e.at) }
  if (e.phase === 'done' && e.outcome && STOPPED_ENDS.has(e.outcome))
    return {
      kind: 'mind', where: mindOf(t), code: e.outcome === 'error' && typeof e.error === 'string' ? `error ${e.error}` : e.outcome,
      message: e.outcome === 'error' ? doneErrorWords(e.error) : DONE_WORDS[e.outcome] ?? e.outcome, at: second(e.at),
    }
  return null
}

/** The first wait before reading a hand-over's intent, and the longest between reads (doubling between them). */
export const FOLLOW_FIRST_MS = 2_000
export const FOLLOW_MAX_MS = 60_000

/**
 * Read a dispatched hand-over's intent until it settles: linked (taken), refused, or abandoned (given up, after a refusal
 * when it carries one), or until the intent's own lifetime ends. A refusal is noted once. Stops on `stopped()`.
 * Time: one read per wait, the waits doubling from FOLLOW_FIRST_MS to FOLLOW_MAX_MS, so log2(30) + (lifetime / 60 s) reads.
 */
export async function followHandover(client: () => HiveClient | null, e: Extract<AskEvent, { phase: 'dispatched' }>, stopped: () => boolean,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  const to = e.to.name ?? e.to.ref
  for (let wait = FOLLOW_FIRST_MS; ; wait = Math.min(wait * 2, FOLLOW_MAX_MS)) {
    await sleep(wait)
    const c = client()
    if (stopped() || !c?.askIntent) return
    let v
    try {
      v = parseIntentView(await c.askIntent(e.intent_id), { intent_id: e.intent_id })
    } catch {
      // a read the hive refused is with the page's errors already (api/live.ts); one it answered unreadably says nothing
      return
    }
    if (v.state === 'refused' || (v.state === 'abandoned' && v.last_refusal)) {
      const code = v.last_refusal?.code ?? 'refused'
      noteError({ kind: 'handover', where: to, code, message: `The hive handed "${e.label ?? e.intent_kind}" to ${to}, and it was refused (${code}).` })
      return
    }
    if (v.state === 'linked' || v.state === 'abandoned' || (v.until !== null && Date.parse(v.until) < Date.now())) return
  }
}

/**
 * Watch the Ask's turns for frames that say a mind stopped owing an answer, and follow each hand-over. Only frames from
 * after `since` count, so a turn read back after a reload drafts nothing again. Returns the undo.
 * Time: per change of the Ask's store, the turns plus each turn's new frames (read from its newest back to the last seen).
 */
export function watchAsk(client: () => HiveClient | null, since = Date.now()): () => void {
  const seen = new Map<string, number>()
  let stop = false
  const offIdentity = onIdentityChange(() => {
    stop = true
  })
  const scan = (turns: Record<string, TurnMeta>) => {
    for (const t of Object.values(turns)) {
      const last = seen.get(t.op) ?? 0
      let i = t.events.length
      while (i > 0 && t.events[i - 1].seq > last) i--
      for (const e of t.events.slice(i)) {
        if (Date.parse(e.at) < since) continue
        const failed = stoppedMind(t, e)
        if (failed) noteError(failed)
        if (e.phase === 'dispatched') void followHandover(client, e, () => stop)
      }
      if (t.events.length) seen.set(t.op, Math.max(last, t.events[t.events.length - 1].seq))
    }
  }
  scan(useAskStore.getState().turns)
  const unsubscribe = useAskStore.subscribe((s) => scan(s.turns))
  return () => {
    stop = true
    unsubscribe()
    offIdentity()
  }
}
