// Purpose: the feedback area's state (open or not, what the person wrote, the picture, what the hive adds) and the ways a
// report leaves: sent to the report service the hive names, opened on the feedback board, copied for the testers' group
// or saved as files; and the hive's logs, gathered, shown whole, then saved as a file or copied. Each happens only on the
// person's press, after they have seen the whole of what goes.
import { create } from 'zustand'
import type { HiveClient } from '../../api/client'
import type { FeedbackContext, FeedbackLogs } from '../../api/types'
import { onIdentityChange } from '../../lib/identityEpoch'
import { copyText } from '../../lib/hooks'
import { pageErrors, utcSecond } from '../../lib/recentErrors'
import { downloadBlob } from '../../lib/download'
import { capturePage, pngBlob } from './capture'
import { loadMindDrafts, settleDraft, type Draft } from './drafts'
import { extrasOf, logsFile, logsText } from './logs'
import { deviceOf, factsOf, issueUrl, mergeErrors, payloadOf, reportId, reportText, type Report, type ReportExtras, type ReportKind } from './report'
import { pageOf, screensVisited, stepsOf } from './trail'

/** What the person did with the report last, for the words that follow it. */
export type Done = 'none' | 'sent' | 'opened' | 'copied' | 'saved'

/**
 * The hive's logs as the area holds them: gathered on the person's press into `text`, the one text they see and the
 * only one saved (as `file`) or copied. `scope` says whose they are (the hive's part's scope, or page when it is missing,
 * `missing` saying why); `failed` why the last copy did not go through.
 */
export interface LogsState {
  shown: boolean
  loading: boolean
  text: string
  file: string
  scope: FeedbackLogs['scope'] | 'page'
  missing: string
  failed: string
  done: 'none' | 'saved' | 'copied'
}

/**
 * The person's recent requests and the hive's logs for a report to a report service: asked of the hive when the area
 * opens (`hive`, the answer of GET /api/feedback/logs; `missing` why there is none), shown, and sent with the report
 * while `kept`, which is the person's to switch off.
 */
export interface AttachState {
  kept: boolean
  loading: boolean
  hive: FeedbackLogs | null
  missing: string
}

export interface FeedbackState {
  open: boolean
  id: string
  kind: ReportKind
  words: string
  expected: string
  steps: string
  /** the page's facts, fixed when the report was opened: the page and window the person was looking at */
  page: { device: string; look: string; page: string; window: string; time: string }
  /** what the hive adds (GET /api/feedback); null until it answers, or when it could not (`ctxError` says why) */
  ctx: FeedbackContext | null
  ctxError: string
  picture: { url: string | null; drawing: boolean; failed: boolean; kept: boolean }
  errorsKept: boolean
  done: Done
  /** the board's address could not hold the whole report, so the page also put it on the clipboard */
  copiedToo: boolean
  /** the report service's reference for a sent report */
  reference: string
  sending: boolean
  /** why the last try to send did not go through ("" when it did, or none was made) */
  failed: string
  /** the draft this report was made from (drafts.ts): settled once the report leaves */
  draft: Pick<Draft, 'id' | 'origin' | 'draftedBy'> | null
  logs: LogsState
  attach: AttachState
}

const noLogs = (): LogsState => ({ shown: false, loading: false, text: '', file: '', scope: 'page', missing: '', failed: '', done: 'none' })

const closed = (): FeedbackState => ({
  open: false, id: '', kind: 'bug', words: '', expected: '', steps: '',
  page: { device: '', look: '', page: '', window: '', time: '' },
  // the picture is the person's to add (Jon on #367): a picture shows everything on the page, unredacted
  ctx: null, ctxError: '', picture: { url: null, drawing: false, failed: false, kept: false }, errorsKept: true,
  done: 'none', copiedToo: false, reference: '', sending: false, failed: '', draft: null, logs: noLogs(),
  // the requests and logs go with a report to a report service unless the person switches them off
  attach: { kept: true, loading: false, hive: null, missing: '' },
})

export const useFeedback = create<FeedbackState>(() => closed())

/** An identity change closes the area and forgets what was in it: one person's report never reaches another. */
onIdentityChange(() => useFeedback.setState(closed()))

/** The report as it stands now: what the person wrote, the facts, and the errors the page and the hive met. */
export function reportOf(s: FeedbackState, errors = pageErrors()): Report {
  return {
    id: s.id, kind: s.kind, words: s.words, expected: s.expected, steps: s.kind === 'bug' ? s.steps : '',
    facts: factsOf(s.ctx, s.page),
    errors: s.errorsKept ? mergeErrors(s.ctx?.errors ?? [], errors) : [],
    picture: s.picture.kept && !!s.picture.url,
    ...(s.draft ? { draftedBy: s.draft.draftedBy } : {}),
  }
}

/**
 * The requests, errors and log lines that go with the report as it stands, or null when none do: only to a report
 * service, only while the person keeps them in, and only once the hive has given them and the area shows them.
 */
export function extrasOfState(s: FeedbackState, errors = pageErrors()): ReportExtras | null {
  if (s.ctx?.to.kind !== 'service' || !s.attach.kept || !s.attach.hive) return null
  return extrasOf(s.attach.hive, errors, s.errorsKept)
}

let opened = 0

/**
 * Ask the hive for the person's recent requests and its logs, to show them with a report to a report service. A read
 * of the person's own hive: nothing leaves it here. A hive that cannot give them says why, and the report goes without.
 */
function gatherExtras(client: HiveClient, run: number): void {
  const put = (over: Partial<AttachState>) => run === opened && useFeedback.setState((st) => ({ attach: { ...st.attach, loading: false, ...over } }))
  if (!client.feedbackLogs) {
    put({ missing: 'this hive does not give its logs yet' })
    return
  }
  put({ loading: true })
  client.feedbackLogs().then((hive) => put({ hive }), (e: unknown) => put({ missing: e instanceof Error ? e.message : 'the hive did not answer' }))
}

/**
 * Open the area with a fresh report: a new id, the steps from the screens visited, the page as it is, and the hive asked
 * what it adds and which drafts minds made. No picture is drawn until the person adds one (addPicture). When reports go
 * to a report service, the hive is also asked for the person's recent requests and its logs, shown before they go.
 * `seed` is a draft the person chose to use: its kind, words, steps and expected start the report, all theirs to change.
 */
export function openFeedback(client: HiveClient | null, look: string, seed?: Draft): void {
  const run = ++opened
  const now = Date.now()
  useFeedback.setState({
    ...closed(), open: true, id: reportId(), kind: seed?.kind ?? 'bug', words: seed?.words ?? '', expected: seed?.expected ?? '',
    steps: seed?.steps || stepsOf(screensVisited()),
    draft: seed ? { id: seed.id, origin: seed.origin, draftedBy: seed.draftedBy } : null,
    page: { device: deviceOf(navigator.userAgent), look, page: pageOf(window.location.hash), time: utcSecond(now),
      window: `${window.innerWidth}×${window.innerHeight}, pixel ratio ${Math.round(window.devicePixelRatio * 100) / 100}` },
  })
  // what the hive adds; a hive too old to answer leaves the version unknown and the report still goes by copy or file
  if (client?.feedback) {
    client.feedback().then(
      (ctx) => {
        if (run !== opened) return
        useFeedback.setState({ ctx })
        if (ctx.to.kind === 'service') gatherExtras(client, run)
      },
      (e: unknown) => run === opened && useFeedback.setState({ ctxError: e instanceof Error ? e.message : 'The hive did not answer' }),
    )
  }
  // the minds' drafts as the hive has them now; a read the hive refused is with the page's errors (api/live.ts)
  loadMindDrafts(client).catch(() => undefined)
}

export const closeFeedback = () => {
  opened++
  useFeedback.setState(closed())
}

/**
 * The person adds a picture of the page: drawn from the page itself, the area left out, the first time they ask, and kept
 * from then on until they remove it. A picture that could not be drawn is not kept, so they can try again.
 */
export function addPicture(): void {
  const s = useFeedback.getState()
  if (!s.open || s.picture.drawing) return
  if (s.picture.url) {
    useFeedback.setState({ picture: { ...s.picture, kept: true }, done: 'none' })
    return
  }
  const run = opened
  useFeedback.setState({ picture: { url: null, drawing: true, failed: false, kept: true }, done: 'none' })
  capturePage().then(
    (url) => run === opened && useFeedback.setState((st) => ({ picture: { ...st.picture, url, drawing: false } })),
    () => run === opened && useFeedback.setState((st) => ({ picture: { ...st.picture, drawing: false, failed: true, kept: false } })),
  )
}

/** The text the person sees, copies and saves: one text, one format (report.ts reportText). */
const textNow = () => reportText(reportOf(useFeedback.getState()))

/** The report left: the draft it was made from is settled (drafts.ts settleDraft), so it is not offered again. */
const left = (client: HiveClient | null) => {
  const d = useFeedback.getState().draft
  if (d) void settleDraft(client, d.id)
}

/** Copy the report for the testers' group; the picture goes as its own message, captioned with the id. */
export async function copyReport(client: HiveClient | null = null): Promise<boolean> {
  const ok = await copyText(textNow())
  useFeedback.setState(ok ? { done: 'copied', failed: '' } : { failed: 'Your browser would not copy it. Save it as files instead.' })
  if (ok) left(client)
  return ok
}

/** Save the report as HR-….txt, and the picture beside it as HR-….png when it goes. */
export function saveReport(client: HiveClient | null = null): void {
  const s = useFeedback.getState()
  downloadBlob(`${s.id}.txt`, new Blob([textNow() + '\n'], { type: 'text/plain;charset=utf-8' }))
  if (s.picture.kept && s.picture.url) downloadBlob(`${s.id}.png`, pngBlob(s.picture.url))
  useFeedback.setState({ done: 'saved', failed: '' })
  left(client)
}

/**
 * Open the board's form filled in, in a new tab. The picture cannot travel in an address, so it is saved for the person
 * to drag into the form; a report too long for the address is put on the clipboard for them to paste.
 */
export async function openOnBoard(client: HiveClient | null = null): Promise<void> {
  const s = useFeedback.getState()
  if (s.ctx?.to.kind !== 'board') return
  const report = reportOf(s)
  const { url, copied } = issueUrl(s.ctx.to, report)
  if (copied) await copyText(reportText(report))
  window.open(url, '_blank', 'noopener,noreferrer')
  if (report.picture && s.picture.url) downloadBlob(`${s.id}.png`, pngBlob(s.picture.url))
  useFeedback.setState({ done: 'opened', copiedToo: copied, failed: '' })
  left(client)
}

/** A send waits while something that goes with the report is still coming: the picture being drawn, or the requests and logs. */
export const sendWaits = (s: FeedbackState): boolean => (s.picture.kept && s.picture.drawing) || (s.attach.kept && s.attach.loading)

/**
 * Hand the report to the report service the hive names; the hive passes it on as the person saw it: the picture if they
 * added one, and their recent requests and the hive's logs unless they switched those off.
 */
export async function sendReport(client: HiveClient | null): Promise<void> {
  const s = useFeedback.getState()
  if (!client?.sendFeedback || s.ctx?.to.kind !== 'service' || s.sending || sendWaits(s)) return
  useFeedback.setState({ sending: true, failed: '' })
  try {
    const out = await client.sendFeedback(payloadOf(reportOf(s), s.picture.url, extrasOfState(s)))
    useFeedback.setState({ sending: false, done: 'sent', reference: out.reference ?? '' })
    left(client)
  } catch (e) {
    useFeedback.setState({ sending: false, failed: e instanceof Error ? e.message : 'The report did not go.' })
  }
}

/** On a phone, hand the picture to the share sheet, captioned with the report's id, as the testers' group expects. */
export async function sharePicture(): Promise<void> {
  const s = useFeedback.getState()
  if (!s.picture.url) return
  const file = new File([pngBlob(s.picture.url)], `${s.id}.png`, { type: 'image/png' })
  try {
    await navigator.share({ files: [file], text: s.id })
  } catch (e) {
    // the person closing the share sheet is no failure
    if (!(e instanceof DOMException && e.name === 'AbortError')) useFeedback.setState({ failed: 'Your phone would not share the picture. Save it as files instead.' })
  }
}

/** Whether this device can hand a picture to its share sheet (most phones). */
export function canSharePicture(): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([new Uint8Array(1)], 'x.png', { type: 'image/png' })] })
  } catch {
    return false
  }
}

/**
 * Gather the logs on the person's press: the hive's part (GET /api/feedback/logs) and the page's (its device, errors and
 * screens visited), made into the one text the area then shows whole (logs.ts logsText). A hive that cannot give its
 * part still gets the page's, and the text and the area say why. Nothing leaves here.
 */
export async function showLogs(client: HiveClient | null): Promise<void> {
  const s = useFeedback.getState()
  if (!s.open || s.logs.loading) return
  const run = opened
  useFeedback.setState({ logs: { ...s.logs, loading: true, failed: '', done: 'none' } })
  let hive: FeedbackLogs | null = null
  let missing = ''
  if (!client?.feedbackLogs) missing = 'this hive does not give its logs yet'
  else {
    try {
      hive = await client.feedbackLogs()
    } catch (e) {
      missing = e instanceof Error ? e.message : 'the hive did not answer'
    }
  }
  if (run !== opened) return
  const { page } = useFeedback.getState()
  const time = utcSecond()
  useFeedback.setState({ logs: {
    shown: true, loading: false, scope: hive?.scope ?? 'page', missing, failed: '', done: 'none', file: logsFile(time),
    text: logsText(hive, missing, { device: page.device, look: page.look, window: page.window, time }, pageErrors(), screensVisited()),
  } })
}

/** Save the logs as shown, as omega-hive-logs-….txt where the browser keeps downloads. */
export function saveLogs(): void {
  const { logs } = useFeedback.getState()
  if (!logs.shown) return
  downloadBlob(logs.file, new Blob([logs.text + '\n'], { type: 'text/plain;charset=utf-8' }))
  useFeedback.setState({ logs: { ...logs, done: 'saved', failed: '' } })
}

/** Copy the logs as shown, for the testers' group or a message to the team. */
export async function copyLogs(): Promise<void> {
  const { logs } = useFeedback.getState()
  if (!logs.shown) return
  const ok = await copyText(logs.text)
  useFeedback.setState((st) => ({ logs: { ...st.logs, ...(ok ? { done: 'copied', failed: '' } : { failed: 'Your browser would not copy them. Save them as a file instead.' }) } }))
}
