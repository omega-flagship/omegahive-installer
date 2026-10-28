import type { PlaceHoldBody, UpdateHold } from '../../api/types'

/** The holds that block one target: a restart hold blocks the platform, an app hold blocks that app, 'all' blocks both. */
export function holdsFor(holds: UpdateHold[], target: string): UpdateHold[] {
  return holds.filter((h) => h.scope === 'all' || (target === 'platform' ? h.scope === 'restart' : h.scope === target))
}

export const short = (build: string | null) => (build ? build.slice(0, 7) : 'unknown')

/**
 * The exact form the hive writes its own times in (db.now(): UTC, milliseconds, Z), which is what Date.toISOString()
 * gives. Only this form is ever sent: an ISO 8601 time WITH a timezone (Z). Older hives compared `until` as a string
 * without checking it (Platform finding d); next10 (hive/core/updates.py `_until`, at ad9e82c) refuses a time without a
 * timezone and one that is not in the future and at most 7 days ahead.
 */
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/

/** A real ISO date-time in the hive's form (parses, and round-trips through Date unchanged). */
export function isIsoUtc(text: string): boolean {
  if (!ISO_UTC.test(text)) return false
  const t = Date.parse(text)
  return Number.isFinite(t) && new Date(t).toISOString() === text
}

/** next10's limit on a hold's end: in the future and at most 7 days ahead (updates.py `_until`: now < at <= now + 7 days). */
export const HOLD_MAX_DAYS = 7
export const HOLD_MAX_MS = HOLD_MAX_DAYS * 24 * 60 * 60 * 1000

/**
 * Read the "until" a person entered (a datetime-local value such as "2026-10-05T18:30", in their own time zone, or
 * empty for "until released"). Gives the ISO time to send, or why it cannot be sent. `now` is epoch milliseconds.
 */
export function holdUntil(raw: string, now = Date.now()): { ok: true; until: string | undefined } | { ok: false; why: string } {
  const text = raw.trim()
  if (!text) return { ok: true, until: undefined }
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?$/.test(text)) return { ok: false, why: 'Pick a date and time, or leave it empty to hold until released.' }
  const d = new Date(text)
  const t = d.getTime()
  // Date rolls an impossible day over (Feb 30 becomes Mar 2): the local fields must read back exactly as entered
  const [y, mo, da, h, mi] = text.split(/[-T:]/).map(Number)
  if (!Number.isFinite(t) || d.getFullYear() !== y || d.getMonth() + 1 !== mo || d.getDate() !== da || d.getHours() !== h || d.getMinutes() !== mi)
    return { ok: false, why: 'That is not a real date and time.' }
  if (t <= now) return { ok: false, why: 'The end must be in the future.' }
  if (t > now + HOLD_MAX_MS)
    return { ok: false, why: `A hold can end at most ${HOLD_MAX_DAYS} days from now (by ${new Date(now + HOLD_MAX_MS).toLocaleString()}). Pick an earlier end, or leave it empty to hold until someone releases it.` }
  const iso = new Date(t).toISOString()
  return isIsoUtc(iso) ? { ok: true, until: iso } : { ok: false, why: 'That is not a real date and time.' }
}

/** Why a hold cannot be placed yet (null when it can): the hive needs a reason (500 characters at most). */
export function holdBlocked(reason: string, until: ReturnType<typeof holdUntil>): string | null {
  if (!reason.trim()) return 'Say why this must not be interrupted: it is shown to everyone who updates.'
  if (reason.trim().length > 500) return 'Keep the reason to 500 characters.'
  return until.ok ? null : until.why
}

/** A body the hive accepts, checked before it is sent (the client refuses a malformed or out-of-range `until` itself). */
export function checkHoldBody(body: PlaceHoldBody, now = Date.now()): string | null {
  if (body.scope !== 'restart' && body.scope !== 'all' && !/^program:[\w.-]+$/.test(body.scope)) return "scope is 'restart', 'all' or 'program:<app id>'"
  if (!body.reason?.trim()) return 'a reason is required'
  if (body.until !== undefined) {
    if (!isIsoUtc(body.until)) return 'until must be an ISO date-time in UTC, like 2026-10-05T18:30:00.000Z'
    const t = Date.parse(body.until)
    if (t <= now || t > now + HOLD_MAX_MS) return `until must be in the future and at most ${HOLD_MAX_DAYS} days ahead`
  }
  return null
}

/** What a hold stops, in words. */
export function holdScopeWords(scope: string, appName: (id: string) => string = (id) => id): string {
  if (scope === 'restart') return 'No platform restart'
  if (scope === 'all') return 'No updates at all (no restart, no app reload)'
  if (scope.startsWith('program:')) return `No reload of ${appName(scope.slice(8))}`
  return scope
}
