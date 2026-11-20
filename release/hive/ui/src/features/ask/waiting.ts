// Purpose: say what waits on the person in the Ask while its thread is folded: how many minds' offers to build and
// stopped tasks its cards hold, and the words a folded skin's conversation button gives for them.
import { useOpenOffers } from '../dot/useOpenOffers'
import { useTaskStops } from '../tasks/useTaskStops'

/** What waits on the person in the Ask's thread (Thread's AskCards): every mind's open offers and unacknowledged stops. */
export interface AskWaiting {
  offers: number
  stops: number
}

/**
 * What the Ask's cards hold now, counted from the reads they draw (useOpenOffers, useTaskStops: shared, so the mark and
 * the cards never disagree and nothing is read twice; while a folded skin counts them, the cards open on lists already
 * read). Directing Studio isn't counted: it is a session the person is in, never something waiting on them.
 */
export function useAskWaiting(): AskWaiting {
  return { offers: useOpenOffers().data?.length ?? 0, stops: useTaskStops().data?.length ?? 0 }
}

const counted = (n: number, one: string, many: string) => (n === 0 ? '' : n === 1 ? one : `${n} ${many}`)

/**
 * What waits, in words, or '' when nothing does. Example: one offer and two stops give "an offer to build and 2 stopped
 * tasks are waiting".
 */
export function waitingWords({ offers, stops }: AskWaiting): string {
  const parts = [counted(offers, 'an offer to build', 'offers to build'), counted(stops, 'a stopped task', 'stopped tasks')].filter(Boolean)
  return parts.length ? `${parts.join(' and ')} ${offers + stops > 1 ? 'are' : 'is'} waiting` : ''
}

/** A folded conversation button's words: what it does, then what waits ("Show the conversation, an offer to build is waiting"). */
export function withWaiting(does: string, waiting: AskWaiting): string {
  const words = waitingWords(waiting)
  return words ? `${does}, ${words}` : does
}
