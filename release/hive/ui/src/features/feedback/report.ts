// Purpose: a person's feedback or bug report as one value, and every form it leaves the hive in: the text they see
// whole before it goes (the same text is the copy for the testers' group and the saved file), the feedback board's
// prefilled new-issue address with its fall-back to the copy when too long, and the payload a report service takes.
import type { FeedbackContext, HiveErrorAnswer } from '../../api/types'
import type { PageError } from '../../lib/recentErrors'

export type ReportKind = 'bug' | 'ux' | 'idea'
export const KINDS: readonly ReportKind[] = ['bug', 'ux', 'idea']

/**
 * The feedback board's three issue forms (omega-flagship/omegahive-feedback, .github/ISSUE_TEMPLATE): each field's id
 * and label, every field in the form's order. The copy's lines use these labels, so the testers' group importer files a
 * pasted report whole; the prefilled address fills the same fields by id. "Potentially related repository" is left to
 * triage: fieldsOf leaves it empty, so neither the copy nor the address has it.
 */
export const FORMS: Record<ReportKind, { template: string; prefix: string; fields: readonly (readonly [string, string])[] }> = {
  bug: {
    template: 'bug_report.yml', prefix: '[Bug]: ',
    fields: [['summary', 'Summary'], ['reproduce', 'Steps to reproduce'], ['expected', 'Expected behavior'], ['actual', 'Actual behavior'],
      ['version', 'Version / build'], ['environment', 'Environment'], ['repository', 'Potentially related repository'], ['evidence', 'Evidence']],
  },
  ux: {
    template: 'ux_feedback.yml', prefix: '[UX]: ',
    fields: [['context', 'Context'], ['difficulty', 'Difficulty encountered'], ['expectation', 'Expected experience'], ['version', 'Version / build'],
      ['repository', 'Potentially related repository'], ['evidence', 'Evidence']],
  },
  idea: {
    template: 'feature_request.yml', prefix: '[Feature]: ',
    fields: [['problem', 'Need or problem'], ['proposal', 'Desired outcome'], ['use_case', 'Use case'], ['repository', 'Potentially related repository'],
      ['evidence', 'References or evidence']],
  },
}

/** What the hive and the page know at the moment the report is made; every value is shown to the person. */
export interface ReportFacts {
  /** "Mac v0.31 (build f9648d4386)" */
  version: string
  /** "own hive, Mac install" */
  which: string
  /** "Chrome 131 on macOS" */
  device: string
  /** the look the person is in: "Canvas" */
  look: string
  /** the screen and its address with every id left out: "settings (#/settings)" */
  page: string
  /** "1440×900, pixel ratio 2" */
  window: string
  /** when the report was made, UTC to the second */
  time: string
}

/** One error a report carries, the hive's answer and the page's own merged by id. */
export interface ReportError {
  at: string
  id?: string
  /** "GET /api/swarms/{swarm_id}", or where the page raised it */
  where: string
  status?: number
  code?: string
  message: string
  /** an error the hive did not expect: where in the hive it was raised */
  raised?: string
  /** what failed when it was no request: the page itself, a mind, a hand-over or a screen */
  source?: 'page' | 'mind' | 'handover' | 'screen'
}

export interface Report {
  /** HR- and 8 hex digits: the id the board, the importer and the person quote */
  id: string
  kind: ReportKind
  /** the person's words: what happened, what was hard, or what they need */
  words: string
  /** what they expected instead, or what it should let them do */
  expected: string
  /** a bug's steps: the screens visited, names only, for the person to edit */
  steps: string
  facts: ReportFacts
  errors: ReportError[]
  /** whether the picture of the screen goes with it (the picture itself travels apart: the copy cannot hold it) */
  picture: boolean
  /** who drafted it, when the person opened a draft: "the hive" or "Vega, a mind" */
  draftedBy?: string
}

/** A new report id: HR- and 8 random hex digits. */
export function reportId(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (b) => crypto.getRandomValues(b)): string {
  return 'HR-' + [...random(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** How many errors a report carries: the newest, which say most about what just broke. */
export const REPORT_ERRORS = 10

/**
 * The hive's error answers and the page's own, as one list, newest first: a page error the hive gave an id for is the
 * hive's answer, which names the route's pattern and, for an unexpected error, where it was raised.
 * Time: (h + p) log (h + p) comparisons, h and p the two lists' lengths (at most 10 and 50).
 */
export function mergeErrors(hive: readonly HiveErrorAnswer[], page: readonly PageError[]): ReportError[] {
  const byId = new Map(hive.map((e) => [e.id, e]))
  const out: ReportError[] = hive.map((e) => ({ at: second(e.at), id: e.id, where: `${e.method} ${e.route}`, status: e.status, code: e.code, message: e.message, ...(e.raised ? { raised: e.raised } : {}) }))
  for (const e of page) if (!e.id || !byId.has(e.id))
    out.push({ at: second(e.at), ...(e.id ? { id: e.id } : {}), where: e.where, status: e.status, code: e.code, message: e.message, ...(e.kind !== 'request' ? { source: e.kind } : {}) })
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, REPORT_ERRORS)
}

/** "2026-11-16T00:12:34.567Z" or "...+00:00" as UTC to the second: "2026-11-16T00:12:34Z". */
function second(at: string): string {
  const t = Date.parse(at)
  return Number.isFinite(t) ? new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z') : at
}

/**
 * What must never leave the hive in a report, replaced where it stands, so the person sees exactly what goes: email
 * addresses, phone numbers, home folders (they name the person), keys and tokens, the hive's own key ids (`k_` and 8 or
 * 32 hex digits, `env:<provider>`, either as a `key:` scope, the grammar of hive/core/keyids.py), and the ids of people
 * and conversations. The board goes public later, and the testers' group importer refuses to post any of these. Its own
 * hidden marker is taken apart too, and a line it would read as a field's start is LABEL_LINE's, so nothing a person
 * writes is read as the importer's.
 */
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  [/(?:\/Users|\/home)\/[^/\s]+/g, '~'],
  [/\b[A-Z]:\\Users\\[^\\\s]+/gi, '~'],
  [/\bBearer\s+\S+/g, 'Bearer [token]'],
  [/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, '[key]'],
  [/(?<![A-Za-z0-9_])(?:key:)?(?:k_(?:[0-9a-f]{32}|[0-9a-f]{8})|env:[a-z0-9_-]+)(?![A-Za-z0-9_-])/g, '[key]'],
  [/\bc_[A-Za-z0-9_.-]*~[A-Za-z0-9_:~.-]+/g, '[conversation]'],
  [/user:[A-Za-z0-9_.-]+/g, '[person]'],
  [/\+\d[\d\s().-]{6,}\d/g, '[phone]'],
  // a long run of letters and digits with both in it: a key, a token or a secret's digest, never a word
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, '[token]'],
  // what the importer reads as its own: its hidden marker
  [/<!--|-->/g, ''],
]

/**
 * A line opening with a label the importer reads as a field's start ("Label:" or "Label: …", any form's, and the report's
 * id line). Such a line of the person's keeps its label with the first letter lowered, so it reads as their words: a
 * line "Expected behavior: …" in a bug's steps, with the real field left out because it is empty, was filed as that
 * field. Derived from FORMS, so a field added there is covered.
 */
const LABEL_LINE = new RegExp(
  `^(?:${[...new Set([...KINDS.flatMap((k) => FORMS[k].fields.map(([, label]) => label)), 'Original feedback ID'])]
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}):`,
  'gm',
)

export function redact(text: string): string {
  return REDACTIONS.reduce((t, [pattern, put]) => t.replace(pattern, put), text).replace(LABEL_LINE, (label) => label.charAt(0).toLowerCase() + label.slice(1))
}

/** A report's title: the first sentence of the person's words, at most 80 characters, cut at a word. */
export function titleOf(words: string): string {
  const first = redact(words).trim().split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? ''
  if (first.length <= 80) return first
  const cut = first.slice(0, 79)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40))}…`
}

const errorLine = (e: ReportError) =>
  [e.at, e.status !== undefined ? String(e.status) : e.source ?? 'page', e.code, e.where, e.id ? `(${e.id})` : ''].filter(Boolean).join(' ') +
  `: ${redact(e.message)}${e.raised ? `; raised ${e.raised}` : ''}`

/** The hive's recent errors as lines, newest first; "" with none. */
export const errorsText = (errors: readonly ReportError[]) => errors.map(errorLine).join('\n')

/**
 * Each form field's text, by the field's id: the person's words where the form asks for them, the hive's facts where it
 * asks for those, and the evidence (the hive's errors first) ending with the line the board and the importer read the
 * report's id from. A bug's summary is the first sentence of what went wrong and its actual behavior all of it, so the
 * board's two required fields are filled from what the person wrote (bug_report.yml requires summary and actual).
 */
export function fieldsOf(r: Report): Record<string, string> {
  const words = redact(r.words).trim(), expected = redact(r.expected).trim(), errors = errorsText(r.errors)
  const f = r.facts
  const environment = `${f.which}; ${f.device}; look ${f.look}; window ${f.window}`
  const evidence = (lines: string[]) => [...(r.draftedBy ? [`Drafted by: ${redact(r.draftedBy)}`] : []), ...lines, `Page: ${f.page}`, `Time: ${f.time}`,
    ...(r.picture ? [`Picture: ${r.id}.png`] : []), `Original feedback ID: ${r.id}`]
    .filter(Boolean).join('\n')
  if (r.kind === 'bug')
    return { summary: titleOf(r.words), reproduce: redact(r.steps).trim(), expected, actual: words, version: f.version, environment, repository: '',
      evidence: evidence([errors && `Errors:\n${errors}`]) }
  if (r.kind === 'ux')
    return { context: `${f.page}, in ${f.look}; ${f.which}; window ${f.window}`, difficulty: words, expectation: expected, version: f.version, repository: '',
      evidence: evidence([errors && `Errors:\n${errors}`, `Environment: ${f.device}`]) }
  return { problem: words, proposal: expected, use_case: '', repository: '',
    evidence: evidence([`Version / build: ${f.version}`, `Environment: ${f.which}; ${f.device}`, errors && `Errors:\n${errors}`]) }
}

/**
 * The report as the person sees it, and as the testers' group and the saved file get it: the first line the importer
 * matches ("Omega report HR-1a2b3c4d · bug · <title>"), then each field that has words, on a line of its own opening
 * with the form's label; the evidence ends with "Original feedback ID: HR-…", the report's last line.
 */
export function reportText(r: Report): string {
  const fields = fieldsOf(r)
  const lines = [`Omega report ${r.id} · ${r.kind} · ${titleOf(r.words) || 'no title'}`]
  for (const [id, label] of FORMS[r.kind].fields) if (fields[id]) lines.push(`${label}: ${fields[id]}`)
  return lines.join('\n')
}

/**
 * The longest prefilled new-issue address the board takes: GitHub answered 500 from about 6,975 characters, sent a
 * signed-out visitor to sign in at 6,675, and gave 414 from 8,267 (checked against the board, 16 Nov), so the address
 * stops short of all of them, as VS Code's issue reporter stops at 7,500 for the same reason.
 */
export const MAX_ISSUE_URL = 6000

/**
 * The board's prefilled new-issue address for a report: its form, the title with the form's prefix, and each field by
 * id. Nothing else is passed: a label or an assignee in the address answers 404 to anyone who may not set them. When
 * the whole report does not fit, the address carries the title and the short fields, and the evidence asks the person to
 * paste the whole report, which the page has put on their clipboard (`copied` true), as VS Code's issue reporter does.
 */
export function issueUrl(board: { url: string }, r: Report): { url: string; copied: boolean } {
  const form = FORMS[r.kind]
  const fields = fieldsOf(r)
  const build = (values: Record<string, string>) => {
    const q = [`template=${encodeURIComponent(form.template)}`, `title=${encodeURIComponent(form.prefix + (titleOf(r.words) || 'Feedback from the hive'))}`]
    for (const [id] of form.fields) if (values[id]) q.push(`${id}=${encodeURIComponent(values[id])}`)
    return `${board.url}/issues/new?${q.join('&')}`
  }
  const whole = build(fields)
  if (whole.length <= MAX_ISSUE_URL) return { url: whole, copied: false }
  const short: Record<string, string> = {}
  for (const id of ['version', 'environment']) if (fields[id]) short[id] = fields[id]
  short.evidence = `The whole report is on your clipboard: paste it here.\nOriginal feedback ID: ${r.id}`
  return { url: build(short), copied: true }
}

/** What a report service takes (POST /api/feedback/send; hive/core/feedback.py report_problems checks the shape). */
export interface ReportPayload {
  schema: 'omega-hive-report-1'
  id: string
  kind: ReportKind
  title: string
  /** the board's form the fields are for */
  form: string
  fields: Record<string, string>
  /** the report as the person saw it */
  text: string
  /** the picture of the screen, when the person kept it: a PNG data address */
  picture: string | null
}

export function payloadOf(r: Report, picture: string | null): ReportPayload {
  return { schema: 'omega-hive-report-1', id: r.id, kind: r.kind, title: titleOf(r.words), form: FORMS[r.kind].template, fields: fieldsOf(r), text: reportText(r),
    picture: r.picture ? picture : null }
}

/** The facts from what the hive answered and what the page knows; the hive's context may be missing (an older hive). */
export function factsOf(ctx: Pick<FeedbackContext, 'version' | 'which'> | null, page: { device: string; look: string; page: string; window: string; time: string }): ReportFacts {
  return { version: ctx?.version ?? 'unknown', which: ctx?.which ?? 'unknown', ...page }
}

/**
 * A browser and system in a person's words, from the user agent: "Chrome 131 on macOS", "Safari 18 on iOS". The order
 * matters: Edge and Opera also name Chrome, and Chrome also names Safari.
 */
export function deviceOf(ua: string): string {
  const browser = ([['Edg/', 'Edge'], ['OPR/', 'Opera'], ['Firefox/', 'Firefox'], ['Chrome/', 'Chrome'], ['Version/', 'Safari']] as const)
    .map(([mark, name]) => { const m = ua.match(new RegExp(`${mark.replace('/', '\\/')}(\\d+)`)); return m ? `${name} ${m[1]}` : '' })
    .find(Boolean) ?? 'a browser'
  const system = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'an unknown system'
  return `${browser} on ${system}`
}
