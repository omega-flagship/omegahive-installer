// Purpose: the feedback area's screen data and facts (features/feedback/feedback.metta), from the area's state: pure, so
// which parts show for each moment is tested without a browser.
import type { FeedbackDestination } from '../../api/types'
import type { ScreenFacts } from '../../screens/screenSpace'
import { plural } from '../../lib/plural'
import type { Draft } from './drafts'
import { extrasText } from './logs'
import { errorsText, reportText, type Report, type ReportExtras } from './report'
import { sendWaits, type FeedbackState } from './store'

/** How a report can leave this hive now (feedback.metta's to.route). */
export type Route = 'service' | 'board' | 'copy' | 'invalid'

/**
 * The route from where this hive sends reports: a report service; the board once GitHub answers it as public; the copy
 * while it is private, not known yet, or when nothing is set (or the hive did not say).
 */
export function routeOf(to: FeedbackDestination | undefined): Route {
  if (!to) return 'copy'
  if (to.kind === 'service') return 'service'
  if (to.kind === 'board') return to.public === true ? 'board' : 'copy'
  if (to.kind === 'invalid') return 'invalid'
  return 'copy'
}

/** When a draft last happened, in the person's own clock: "14:32", or "16 Nov 14:32" on an earlier day. */
export function whenOf(at: string, now = Date.now()): string {
  const t = new Date(at)
  if (!Number.isFinite(t.getTime())) return at
  const time = t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return t.toDateString() === new Date(now).toDateString() ? time : `${t.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

/** The entries block's rows for the drafts waiting (the one in use leaves the list while its report is open). */
export function draftRows(drafts: readonly Draft[], inUse: string | null, when: (at: string) => string = whenOf) {
  return drafts.filter((d) => d.id !== inUse).map((d) => ({
    id: d.id, title: d.title, detail: d.words.length > 160 ? `${d.words.slice(0, 159)}…` : d.words,
    meta: `${d.draftedBy === 'the hive' ? 'Noticed by the hive' : `Drafted by ${d.draftedBy}`}, ${when(d.at)}${d.count > 1 ? `, ${plural(d.count, 'time')}` : ''}`,
  }))
}

/**
 * `report` is the report as it would go; `errors` how many recent errors there are to send, kept or left out; `drafts`
 * what the hive and its minds drafted, waiting for the person; `extras` the requests, errors and log lines that go with
 * it to a report service as it stands (store.ts extrasOfState), null when none do.
 */
export function feedbackScreen(s: FeedbackState, report: Report, device: { share: boolean }, errors: number, drafts: readonly Draft[] = [],
  extras: ReportExtras | null = null): { data: Record<string, unknown>; facts: ScreenFacts } {
  const pictureGoes = !!s.picture.url && s.picture.kept
  const empty = s.words.trim() === ''
  const waiting = draftRows(drafts, s.draft?.id ?? null)
  return {
    data: {
      'report.kind': s.kind, 'report.words': s.words, 'report.expected': s.expected, 'report.steps': s.steps, 'report.id': s.id,
      'facts.version': report.facts.version, 'facts.which': report.facts.which, 'facts.device': report.facts.device, 'facts.look': report.facts.look,
      'facts.page': report.facts.page, 'facts.window': report.facts.window, 'facts.time': report.facts.time,
      'picture.url': s.picture.url ?? '',
      // the list block's rows: what failed, its words, when and by which id (the same line the report carries)
      'report.errors': report.errors.map((e, i) => ({ id: e.id ?? `page-${i}`, what: errorsText([{ ...e, message: '' }]).replace(/: $/, ''), message: e.message, at: e.at })),
      'report.text': reportText(report),
      'to.reason': s.ctx?.to.kind === 'invalid' ? s.ctx.to.reason : '',
      // where a report goes, named beside the button that sends it there
      'to.host': s.ctx?.to.kind === 'service' ? s.ctx.to.host : '',
      'to.board': s.ctx?.to.kind === 'board' ? `${s.ctx.to.owner}/${s.ctx.to.repo}` : '',
      'report.reference': s.reference || 'none given',
      'report.error': s.failed,
      'report.drafted_by': s.draft?.draftedBy ?? '',
      drafts: waiting,
      // what holds every way out: nothing written yet, or a send under way
      'report.held': empty || s.sending,
      // the send also waits for what goes with it: the picture being drawn, the requests and logs being gathered
      'send.held': empty || s.sending || sendWaits(s),
      // the one switch for the requests and logs, and the text of them as they go
      'report.attach': [{ id: 'logs', label: 'Include requests and logs', on: s.attach.kept }],
      'attach.text': extras ? extrasText(extras, s.attach.hive?.scope ?? 'person') : '',
      'attach.missing': s.attach.missing,
      // the logs, gathered on the person's press and shown whole before they leave (store.ts showLogs)
      'logs.text': s.logs.text, 'logs.file': s.logs.file, 'logs.missing': s.logs.missing, 'logs.failed': s.logs.failed,
      'logs.loading': s.logs.loading,
    },
    facts: {
      values: { 'report.kind': s.kind, 'to.route': routeOf(s.ctx?.to), 'report.done': s.done, 'logs.scope': s.logs.scope, 'logs.done': s.logs.done },
      flags: {
        'picture.drawing': s.picture.drawing, 'picture.kept': s.picture.kept, 'picture.failed': s.picture.failed,
        'picture.goes': pictureGoes, 'errors.kept': s.errorsKept, 'report.empty': empty, 'report.failed': s.failed !== '',
        'report.copied_too': s.copiedToo, 'device.share': device.share, 'report.drafted': s.draft !== null,
        'logs.shown': s.logs.shown, 'logs.loading': s.logs.loading, 'logs.missing': s.logs.missing !== '', 'logs.failed': s.logs.failed !== '',
        'attach.loading': s.attach.kept && s.attach.loading, 'attach.missing': s.attach.kept && s.attach.missing !== '', 'attach.goes': extras !== null,
      },
      counts: { 'report.errors': errors, drafts: waiting.length },
    },
  }
}
