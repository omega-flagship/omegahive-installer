// Purpose: the logs file a person saves from the feedback area to send the team: which hive and release it is and this
// page's device, then the requests the hive answered lately, what failed, the screens visited and, for an admin, the
// hive's own newest warnings and errors. One text, seen whole before it leaves, every line cleaned as a report's are.
import type { FeedbackLogs, HiveLogLine, HiveRequestLine } from '../../api/types'
import { plural } from '../../lib/plural'
import type { PageError } from '../../lib/recentErrors'
import { errorsText, mergeErrors, redact, second } from './report'

/** What the page adds: its device, look and window, and when the logs were made, UTC to the second. */
export interface LogsPage { device: string; look: string; window: string; time: string }

/**
 * A request as the logs name it: "2026-11-17T01:23:40Z 404 GET /api/swarms/{swarm_id}, 4 ms"; a run answered alike
 * "…, 3 times, the slowest 12 ms"; and in an admin's, who made it when that was not them ("…, another person").
 */
export function requestLine(r: HiveRequestLine): string {
  const times = r.count > 1 ? `${plural(r.count, 'time')}, the slowest ` : ''
  return `${second(r.at)} ${r.status} ${r.method} ${r.route}, ${times}${r.ms} ms${r.who === 'you' ? '' : `, ${r.who}`}`
}

/** One of the hive's own lines: "2026-11-17T01:23:31Z WARNING hive: the model provider answered 429". */
export const logLine = (l: HiveLogLine): string => `${second(l.at)} ${l.level} ${l.logger}: ${l.message}`

/** Whose logs these are, as the file says it: an admin's whole hive, a person's own, or the page's alone. */
export function holdsOf(hive: FeedbackLogs | null): string {
  if (!hive) return 'what this page kept, without the hive\'s part'
  return hive.scope === 'hive' ? 'the whole hive\'s requests and errors, other people\'s errors by route, status and code only, and its own warnings and errors'
    : 'your own requests and errors on this hive'
}

const section = (title: string, lines: readonly string[]): string[] => ['', `${title}:`, ...(lines.length ? lines : ['none'])]

/**
 * The logs file's text: its first line naming it and when it was made, the hive's version, which hive, the page's device,
 * look and window, and whose logs they are; then the requests the hive answered, the errors (the hive's error answers and
 * the page's own, by id, newest first, all of them; in an admin's, another person's as where and how it failed and whose,
 * "… 404 not_found GET /api/swarms/{swarm_id} (e-1a2b3c4d), another person"), the screens visited and, in an admin's, the
 * hive's own warnings and errors. `missing` says why the hive's part is absent, when it is. The whole text passes redact,
 * as a report's does, after the hive has cleaned its messages with the same rules.
 */
export function logsText(hive: FeedbackLogs | null, missing: string, page: LogsPage, pageErrors: readonly PageError[], screens: readonly string[]): string {
  const errors = errorsText(mergeErrors(hive?.errors ?? [], pageErrors, Infinity))
  return redact([
    `Omega hive logs · ${page.time}`,
    `Version: ${hive?.version ?? 'unknown'}`,
    `Hive: ${hive?.which ?? 'unknown'}`,
    `Device: ${page.device}; look ${page.look}; window ${page.window}`,
    `Holds: ${holdsOf(hive)}`,
    ...(missing ? [`The hive's part is missing: ${missing}`] : []),
    ...section('Requests to the hive, newest first', (hive?.requests ?? []).map(requestLine)),
    ...section('Errors, newest first', errors ? errors.split('\n') : []),
    ...section('Screens visited, oldest first', screens),
    ...(hive?.scope === 'hive' ? section('The hive\'s own warnings and errors, newest first', hive.log.map(logLine)) : []),
  ].join('\n'))
}

/** The file's name from when the logs were made: "omega-hive-logs-2026-11-17T01-23-45Z.txt", no colon for Windows. */
export const logsFile = (time: string): string => `omega-hive-logs-${time.replace(/:/g, '-')}.txt`
