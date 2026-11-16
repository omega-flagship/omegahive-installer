/**
 * "From your swarm talk": collect the person's swarm conversations the hive holds for their personal mind (Jon,
 * 2026-10-08: "it should remember like I would"), keep them in this browser's memory, and only then let the hive
 * delete them. The order is the whole point (Platform P1, personal_inbox): READ a page, WRITE it into the browser
 * memory store, wait for that storage transaction to COMPLETE, then ACK exactly the copies it settled. A copy that was
 * not durably kept is never acknowledged, so the hive keeps it (up to 7 days) and the next collect tries again.
 *
 * Every step after an await is bound to the identity the collect started under (lib/identityEpoch): a sign-out or a
 * different person stops it before the next write or acknowledgement, and the memory store refuses a write for an
 * owner it is no longer bound to. A host without the routes (404) is remembered as such for this page's life and never
 * asked again; it is not an error.
 */
import { ApiError, type HiveClient } from '../../api/client'
import { ACK_MAX, INBOX_PAGE, readInboxPage } from '../../api/personalMind'
import type { EpochBinding } from '../../lib/identityEpoch'
import type { AskMemoryStore } from '../../lib/askMemory'

/*
 * Trust boundary (Kimi r1 follow-up): what is held is the HOST's to decide. Platform P1 (personal_inbox.hold) holds
 * only the asker's own turn (their words and the swarm's answer), one per turn, never for a private app or a private
 * swarm, and serves it to that person only. This page re-checks the shape, its caps and private-app names, but it
 * cannot verify whose exchange it was: it relies on that host guarantee.
 */

export type CollectResult =
  /**
   * collected (possibly nothing); `kept`: how many copies were settled and acknowledged; `dropped` / `expired`: how
   * many the hive let go before this browser collected them (the host's own counts; never silent)
   */
  | { state: 'done'; kept: number; dropped: number; expired: number }
  /** the host has no personal-mind inbox (404), or this account has no personal mind (403 person_required) */
  | { state: 'absent' }
  /** nobody whose memory this browser keeps is signed in yet */
  | { state: 'nobody' }
  /** this browser does not keep memory durably (no IndexedDB): nothing read, nothing acknowledged; the hive keeps it */
  | { state: 'volatile' }
  /** the person or identity changed meanwhile: stopped, nothing more written or acknowledged */
  | { state: 'stale' }
  /** a read, the write or the acknowledgement failed: the hive still holds what was not acknowledged */
  | { state: 'failed' }

export interface CollectDeps {
  client: Pick<HiveClient, 'myMindInbox' | 'myMindInboxAck'>
  memory: Pick<AskMemoryStore, 'rememberTalks' | 'whenReady' | 'getView' | 'keepsDurably'>
  bind: () => EpochBinding
}

/** At most this many pages per collect (the hive holds at most 200 copies per person: four pages). */
export const PAGES_PER_COLLECT = 6

export async function collectInbox({ client, memory, bind }: CollectDeps): Promise<CollectResult> {
  if (!client.myMindInbox || !client.myMindInboxAck) return { state: 'absent' }
  const binding = bind()
  if (!memory.getView().owner) return { state: 'nobody' }
  await memory.whenReady()
  if (!binding.current()) return { state: 'stale' }
  if (!memory.getView().owner) return { state: 'nobody' }
  // r1.1 P1: memory that would not survive this page closing never lets the hive delete its copy: nothing is read
  const durable = await memory.keepsDurably()
  if (!binding.current()) return { state: 'stale' }
  if (!durable) return { state: 'volatile' }
  let after: string | null = null
  let kept = 0
  let lost = { dropped: 0, expired: 0 }
  for (let page = 0; page < PAGES_PER_COLLECT; page++) {
    let raw: unknown
    try {
      raw = await client.myMindInbox(after, INBOX_PAGE)
    } catch (e) {
      if (!binding.current()) return { state: 'stale' }
      if (e instanceof ApiError && (e.status === 404 || (e.status === 403 && e.code === 'person_required'))) return { state: 'absent' }
      return { state: 'failed' }
    }
    if (!binding.current()) return { state: 'stale' }
    const { items, next, dropped, expired } = readInboxPage(raw)
    lost = { dropped: Math.max(lost.dropped, dropped), expired: Math.max(lost.expired, expired) }
    // a page whose items were all left out still says where to go on (Kimi r1): read until the host has no more
    if (!items.length) {
      if (!next) break
      after = next
      continue
    }
    // WRITE: resolves once the storage transaction completed, with the copies it settled (null: none may be acked)
    const settled = await memory.rememberTalks(items)
    if (!binding.current()) return { state: 'stale' }
    if (settled === null) return { state: 'failed' }
    // ACK: only what was durably settled, in the host's cap per call, each call under the same identity
    for (let i = 0; i < settled.length; i += ACK_MAX) {
      if (!binding.current()) return { state: 'stale' }
      try {
        await client.myMindInboxAck(settled.slice(i, i + ACK_MAX))
      } catch {
        // kept here already; the hive keeps its copy too and delivers it again (the store settles a repeat without a second row)
        return binding.current() ? { state: 'failed' } : { state: 'stale' }
      }
    }
    kept += settled.length
    if (!next) break
    after = next
  }
  return binding.current() ? { state: 'done', kept, ...lost } : { state: 'stale' }
}
