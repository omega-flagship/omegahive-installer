import { ApiError } from '../api/client'

/**
 * Platform host-identity r1 (live 26e94774, `answerable`): the host refuses an approval answer with
 * - 404 `not_found` when the person cannot see the request's mind (the host does not say which: an approval the person
 *   cannot see "is not found", the same as one that is gone), and
 * - 403 `owner_only` for a durable answer (Always, For a time, Never) by someone who is neither the mind's owner nor a
 *   hive admin nor the hive's owner.
 * The host is the lock; the dialog's `canAnswer` gate is only a hint. A refusal is said in plain words, never as a
 * generic error and never as success. Pure, with no store import (the store and the dialog both read it).
 */
export const DURABLE_REFUSED_WORDS = "Only this mind's owner or a hive admin can answer this for good. You can allow it once."
export const NOT_VISIBLE_WORDS = "You can't see this mind, so you can't answer its request."
/** 404 not_found: the host does not tell "you cannot see its mind" from "it is gone", so neither do we. */
export const GONE_OR_HIDDEN_WORDS = "You can't answer this request: it is gone, or its mind isn't one you can see."

/** The answers that last beyond this one request. */
export const isDurable = (d: string): boolean => d === 'remember' || d === 'for' || d === 'never'

/** The plain sentence for a host refusal of this answer, or null when `err` is not one (403, or 404 not_found). */
export function approvalRefusalWords(err: unknown, d: string): string | null {
  if (!(err instanceof ApiError)) return null
  if (err.status === 404 && err.code === 'not_found') return GONE_OR_HIDDEN_WORDS
  if (err.status !== 403) return null
  const code = err.code.toLowerCase()
  if (/visib|cannot_see|cant_see|not_found|hidden/.test(code)) return NOT_VISIBLE_WORDS
  if (/owner|admin|durable/.test(code)) return DURABLE_REFUSED_WORDS
  return isDurable(d) ? DURABLE_REFUSED_WORDS : NOT_VISIBLE_WORDS
}

/**
 * The last refusal for a request, noted by the store for the answer's ORIGIN (the dialog instance that sent it) and
 * taken once by that same dialog (r1.2, Kimi r1.1 #3): two dialogs open on one request never take each other's words.
 * An answer sent without an origin notes nothing here (its toast still says it).
 */
const refusals = new WeakMap<object, Map<string, string>>()
export function noteRefusal(id: string, words: string, origin: object | undefined): void {
  if (!origin) return
  const mine = refusals.get(origin) ?? new Map<string, string>()
  mine.set(id, words)
  refusals.set(origin, mine)
}
export function takeRefusal(id: string, origin: object): string | null {
  const mine = refusals.get(origin)
  const words = mine?.get(id) ?? null
  mine?.delete(id)
  return words
}
