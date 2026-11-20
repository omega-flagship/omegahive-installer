// Purpose: the logs file a person saves from the feedback area to send the team: which hive and release it is and this
// page's device, then the requests the hive answered lately, what failed, the screens visited and, for an admin, the
// hive's own newest warnings and errors. One text, seen whole before it leaves, every line cleaned as a report's are.
// And what a report to a report service carries of the same (extrasOf), with the text the person sees of it first.
import type { FeedbackLogs, HiveLogLine, HiveRequestLine } from '../../api/types'
import { plural } from '../../lib/plural'
import type { PageError } from '../../lib/recentErrors'
import { errorsText, mergeErrors, redact, second, type ReportExtras, type ReportRequest } from './report'

/** What the page adds: its device, look and window, and when the logs were made, UTC to the second. */
export interface LogsPage { device: string; look: string; window: string; time: string }

/**
 * A request as the logs name it: "2026-11-17T01:23:40Z 404 GET /api/swarms/{swarm_id}, 4 ms"; a run answered alike
 * "…, 3 times, the slowest 12 ms"; and in an admin's, who made it when that was not them ("…, another person").
 */
export function requestLine(r: HiveRequestLine | ReportRequest): string {
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

/** The most a report carries of each, and of the three together as JSON (hive/core/feedback.py SEND_REQUESTS and on). */
export const SEND_REQUESTS = 50
export const SEND_ERRORS = 100
export const SEND_LOGS = 400
export const SEND_EXTRAS_BYTES = 200 * 1024

const bytes = (lines: readonly unknown[] | undefined): number => (lines ? new TextEncoder().encode(JSON.stringify(lines)).length : 0)
/** How much the three lists hold together, as the hive measures them: compact JSON, UTF-8. */
export const extrasBytes = (x: ReportExtras): number => bytes(x.recent_requests) + bytes(x.errors) + bytes(x.logs)

/**
 * What a report to a report service carries from the hive's logs, newest first: the person's own requests (an admin's
 * logs hold everyone's; another person's stay on the hive), their own error answers with the page's errors unless they
 * left the errors out (`errorsKept` false: no errors at all), and the hive's own warnings and errors as lines, which only
 * an admin's logs hold. Every text is cleaned here (report.ts redact) after the hive cleaned it as it kept it, and the
 * hive cleans it once more as it sends. Kept within what the hive takes: when the three are too much together, the list
 * that holds the most gives up its oldest lines.
 * Time: one cleaning pass over each text; the size is measured once, and again for each line dropped.
 */
export function extrasOf(hive: FeedbackLogs, pageErrors: readonly PageError[], errorsKept: boolean): ReportExtras {
  const own = hive.errors.filter((e) => !e.who || e.who === 'you')
  const out: ReportExtras = {
    recent_requests: hive.requests.filter((r) => r.who === 'you').slice(0, SEND_REQUESTS)
      .map((r) => ({ at: second(r.at), method: r.method, route: redact(r.route), status: r.status, ms: r.ms, count: r.count, who: r.who })),
    ...(errorsKept ? { errors: mergeErrors(own, pageErrors, SEND_ERRORS).map((e) => ({ ...e, where: redact(e.where),
      ...(e.message !== undefined ? { message: redact(e.message) } : {}), ...(e.raised ? { raised: redact(e.raised) } : {}) })) } : {}),
    logs: hive.log.slice(0, SEND_LOGS).map((l) => redact(logLine(l))),
  }
  while (extrasBytes(out) > SEND_EXTRAS_BYTES) {
    // the list that holds the most gives up its oldest line
    const most = [out.logs, out.recent_requests, out.errors ?? []].reduce<unknown[]>((a, b) => (bytes(b) > bytes(a) ? b : a), [])
    if (most.length === 0) break
    most.pop()
  }
  return out
}

/**
 * The text the person sees of what goes with their report, before it goes: the same requests, errors and log lines the
 * payload holds, line for line. The hive's own lines are named only for an admin (`scope` hive), whose logs alone hold them.
 */
export function extrasText(x: ReportExtras, scope: FeedbackLogs['scope']): string {
  return [
    ...section('Your recent requests to the hive, newest first', x.recent_requests.map(requestLine)).slice(1),
    ...(x.errors ? section('Errors, newest first', x.errors.length ? errorsText(x.errors).split('\n') : []) : ['', 'Errors: left out']),
    ...(scope === 'hive' ? section('The hive\'s own warnings and errors, newest first', x.logs) : []),
  ].join('\n')
}
