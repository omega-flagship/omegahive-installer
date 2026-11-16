// Purpose: the page's own recent errors, kept in this tab for a person's feedback or bug report: requests the hive
// refused or that never reached it, each with the hive's error id (its X-Hive-Error-Id header), errors the page hit,
// and the hive's own failures the feedback area drafts reports from (a mind that stopped while it owed an answer, a
// hand-over that was refused, a screen that could not be drawn).
import { useSyncExternalStore } from 'react'
import { onIdentityChange } from './identityEpoch'
import { onScreenFailure } from './screenFailures'

/**
 * One error the page met. Requests are named by method and route with every id left out ("GET /api/swarms/:id"), so a
 * report names what failed without naming what the person was looking at.
 */
export interface PageError {
  /** when, in UTC to the second: "2026-11-16T00:12:34Z" */
  at: string
  /**
   * request: the hive answered with an error, or it never reached the hive; page: an error nothing on the page caught;
   * mind: a mind stopped while it owed the person an answer; handover: work the hive handed on was refused; screen: a
   * screen could not be composed or one of its parts drawn
   */
  kind: 'request' | 'page' | 'mind' | 'handover' | 'screen'
  /** the hive's id for this error answer (e-xxxxxxxx), when it gave one */
  id?: string
  /**
   * a request: "POST /api/agents/:id/messages"; the page: where it was raised ("Screen.tsx:812"), when known; a mind:
   * its name; a hand-over: where it was handed; a screen: the screen's name
   */
  where: string
  /** a request: its HTTP status, 0 when it never reached the hive */
  status?: number
  /** a request: the hive's error code ("not_found"), or "network"; a mind or a hand-over: why it stopped ("timed_out") */
  code?: string
  message: string
}

/** How many the tab keeps: a report carries the newest of them, and older ones say nothing about what just broke. */
export const KEEP_PAGE_ERRORS = 50

let errors: readonly PageError[] = []
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((fn) => fn())

/** UTC to the second, the form a report quotes. */
export const utcSecond = (t: number = Date.now()): string => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** Keep one error; the oldest goes once KEEP_PAGE_ERRORS are kept. */
export function noteError(e: Omit<PageError, 'at'> & { at?: string }): void {
  const entry: PageError = { ...e, at: e.at ?? utcSecond(), message: e.message.slice(0, 300) }
  errors = [...errors, entry].slice(-KEEP_PAGE_ERRORS)
  changed()
}

// a screen that could not be composed or a part that could not be drawn, as the screen engine tells it (screenFailures:
// the engine imports that and not this, since this module reads the store through identityEpoch when it loads)
onScreenFailure((f) => noteError({ kind: 'screen', where: f.where, message: f.message }))

/** The errors kept, oldest first. */
export const pageErrors = (): readonly PageError[] => errors

export function subscribePageErrors(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const usePageErrors = (): readonly PageError[] => useSyncExternalStore(subscribePageErrors, pageErrors, pageErrors)

/** Forget them (an identity change: one person's errors never go into another's report). */
export function clearPageErrors(): void {
  if (errors.length === 0) return
  errors = []
  changed()
}
onIdentityChange(clearPageErrors)

/**
 * A request path as a report names it: the query dropped and every part that names a thing replaced by ":id" ("/api/
 * agents/a_7f3k2/messages?after=4" is "/api/agents/:id/messages"). A part names a thing when it carries a digit, an
 * underscore, a tilde, an @, a colon or an escape; the hive's own route words carry none.
 */
export function routeOf(path: string): string {
  const bare = path.split(/[?#]/)[0]
  return bare
    .split('/')
    .map((part) => (/[\d_~@:%]/.test(part) ? ':id' : part))
    .join('/')
}

/**
 * Where a page error was raised: the file and line of the first frame in the hive's own code, never an address (which
 * names the hive's host). "" when the stack says nothing usable.
 */
export function raisedAt(stack: string | undefined): string {
  const m = stack?.match(/\/([A-Za-z0-9_.-]+\.(?:tsx?|jsx?|mjs)):(\d+)/)
  return m ? `${m[1]}:${m[2]}` : ''
}

/** Watch the page for errors nothing caught (thrown, or a promise nobody handled). Returns the undo. */
export function watchPageErrors(target: Window = window): () => void {
  const onError = (ev: ErrorEvent) => {
    const err = ev.error instanceof Error ? ev.error : null
    noteError({ kind: 'page', where: raisedAt(err?.stack) || raisedAt(`/${ev.filename}:${ev.lineno}`), message: err?.message || ev.message || 'An error the page did not catch' })
  }
  const onRejection = (ev: PromiseRejectionEvent) => {
    const r = ev.reason
    noteError({ kind: 'page', where: raisedAt(r instanceof Error ? r.stack : undefined), message: r instanceof Error ? r.message : String(r ?? 'A promise nobody handled') })
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
