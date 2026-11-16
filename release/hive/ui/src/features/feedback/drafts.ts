// Purpose: draft reports in the feedback area: what the hive noticed going wrong for the person (a request it failed,
// with its error id; a mind that stopped while it owed them an answer; a hand-over that was refused; a screen that could
// not be drawn), one draft per cause however often it happens, and what minds drafted with their report skill (GET
// /api/feedback/drafts). A draft sends nothing: it waits until the person opens it into a report and presses one of the
// area's ways out, or dismisses it.
import { create } from 'zustand'
import type { HiveClient } from '../../api/client'
import type { FeedbackDraft, HiveEvent } from '../../api/types'
import { onIdentityChange } from '../../lib/identityEpoch'
import { pageErrors, subscribePageErrors, utcSecond, type PageError } from '../../lib/recentErrors'
import type { ReportKind } from './report'
import { screensVisited, stepsOf } from './trail'

export interface Draft {
  /** hd- and 8 hex digits for what the hive noticed (one per cause); the hive's fd-… for a mind's */
  id: string
  origin: 'hive' | 'mind'
  kind: ReportKind
  title: string
  /** the report's words, for the person to read and change before anything goes */
  words: string
  steps: string
  expected: string
  /** who drafted it, as the report says: "the hive", or "Vega, a mind" */
  draftedBy: string
  /** when it last happened, UTC to the second */
  at: string
  /** how many times the hive noticed it in this tab (1 for a mind's) */
  count: number
}

/** One cause the hive drafts a report about: its key (one draft per key), title and words. */
export interface Noticed {
  key: string
  title: string
  words: string
}

/**
 * What the hive drafts from one of the page's errors, or null when it drafts nothing: a request it answered with 500 or
 * above (its own failure, named with its error id), and every failed mind, hand-over and screen. A 4xx is the hive
 * answering as it should, a request that never reached it is the person's connection, and the page's own uncaught
 * errors go into any report's errors without a draft each.
 */
export function noticed(e: PageError): Noticed | null {
  switch (e.kind) {
    case 'request':
      if ((e.status ?? 0) < 500) return null
      return {
        key: `request ${e.status} ${e.code ?? ''} ${e.where}`,
        title: `The hive answered ${e.status} to ${e.where}`,
        words: `The hive answered ${e.status}${e.code ? ` ${e.code}` : ''} to ${e.where}${e.id ? ` (error ${e.id})` : ''}: ${e.message}`,
      }
    case 'mind':
      return { key: `mind ${e.code ?? ''} ${e.where}`, title: `${e.where} stopped while it owed you an answer`, words: `${e.where} stopped while it owed you an answer: ${e.message}` }
    case 'handover':
      return { key: `handover ${e.code ?? ''} ${e.where}`, title: `A hand-over to ${e.where} was refused`, words: e.message }
    case 'screen':
      return { key: `screen ${e.where}`, title: `The ${e.where} screen could not be drawn`, words: `The ${e.where} screen could not be drawn: ${e.message}` }
    case 'page':
      return null
  }
}

/** A cause's draft id: FNV-1a over its key, so the same cause keeps one draft and one id. */
export function draftIdOf(key: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `hd-${h.toString(16).padStart(8, '0')}`
}

interface DraftsState {
  drafts: Draft[]
}

export const useDrafts = create<DraftsState>(() => ({ drafts: [] }))

const newestFirst = (a: Draft, b: Draft) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)
/** Causes the person dismissed or reported: not drafted again in this tab, however often they happen again. */
const settled = new Set<string>()
/** The page's errors already looked at, known by identity (the ring drops its oldest, so positions move). */
let looked = new WeakSet<PageError>()

/** Draft from one of the page's errors, or count it again on its cause's draft. */
export function draftFrom(e: PageError): void {
  const n = noticed(e)
  if (!n) return
  const id = draftIdOf(n.key)
  if (settled.has(id)) return
  useDrafts.setState((s) => {
    const was = s.drafts.find((d) => d.id === id)
    const draft: Draft = was
      ? { ...was, title: n.title, words: n.words, at: e.at > was.at ? e.at : was.at, count: was.count + 1 }
      : { id, origin: 'hive', kind: 'bug', title: n.title, words: n.words, steps: stepsOf(screensVisited()), expected: '', draftedBy: 'the hive', at: e.at, count: 1 }
    return { drafts: [draft, ...s.drafts.filter((d) => d.id !== id)].sort(newestFirst) }
  })
}

/**
 * Draft from the page's errors as they come (lib/recentErrors), each once. Returns the undo.
 * Time: one pass over the kept errors (at most KEEP_PAGE_ERRORS) per change.
 */
export function watchHiveDrafts(): () => void {
  const scan = () => {
    for (const e of pageErrors()) {
      if (looked.has(e)) continue
      looked.add(e)
      draftFrom(e)
    }
  }
  scan()
  return subscribePageErrors(scan)
}

/** A mind's draft as the area lists it. */
export function fromMind(d: FeedbackDraft): Draft {
  const t = Date.parse(d.created)
  return {
    id: d.id, origin: 'mind', kind: d.kind, title: d.title, words: d.words, steps: d.steps ?? '', expected: d.expected ?? '',
    draftedBy: `${d.source.name}, a mind`, at: Number.isFinite(t) ? utcSecond(t) : d.created, count: 1,
  }
}

/** The minds' drafts as the hive has them now, beside what the hive itself noticed. */
export function setMindDrafts(list: readonly FeedbackDraft[]): void {
  useDrafts.setState((s) => ({ drafts: [...s.drafts.filter((d) => d.origin === 'hive'), ...list.map(fromMind)].sort(newestFirst) }))
}

/** A hive event about a mind's drafts (feedback.draft, feedback.draft.removed); any other event changes nothing. */
export function draftEvent(ev: HiveEvent): void {
  if (ev.type === 'feedback.draft') {
    const d = fromMind(ev.draft)
    useDrafts.setState((s) => ({ drafts: [d, ...s.drafts.filter((x) => x.id !== d.id)].sort(newestFirst) }))
  } else if (ev.type === 'feedback.draft.removed') useDrafts.setState((s) => ({ drafts: s.drafts.filter((x) => x.id !== ev.id) }))
}

let loads = 0
/** Read the minds' drafts from the hive (a hive without the route has none to give). */
export async function loadMindDrafts(client: HiveClient | null): Promise<void> {
  if (!client?.feedbackDrafts) return
  const run = ++loads
  const { drafts } = await client.feedbackDrafts()
  if (run === loads) setMindDrafts(drafts)
}

/**
 * Settle a draft: the person dismissed it, or the report made from it left. What the hive noticed is not drafted again
 * in this tab; a mind's is removed on the hive too, and comes back here if the hive would not remove it.
 */
export async function settleDraft(client: HiveClient | null, id: string): Promise<void> {
  const d = useDrafts.getState().drafts.find((x) => x.id === id)
  if (!d) return
  useDrafts.setState((s) => ({ drafts: s.drafts.filter((x) => x.id !== id) }))
  if (d.origin === 'hive') {
    settled.add(id)
    return
  }
  try {
    await client?.dismissFeedbackDraft?.(id)
  } catch {
    // the client has noted the failed request with the page's errors; the draft stays, so the person sees it did not go
    useDrafts.setState((s) => ({ drafts: [d, ...s.drafts.filter((x) => x.id !== id)].sort(newestFirst) }))
  }
}

/** An identity change forgets every draft: one person's never reaches another's area. */
onIdentityChange(() => {
  settled.clear()
  looked = new WeakSet()
  useDrafts.setState({ drafts: [] })
})
