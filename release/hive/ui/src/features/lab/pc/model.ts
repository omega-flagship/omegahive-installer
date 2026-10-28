/**
 * The predictive-coding (PC) family in Lab: pure rules over OmegaEvolve's own program view (POST /api/programs/
 * omegaevolve/view; hive/plugins/omegaevolve/program.py). There is no PC route: the host's seam is the existing
 * Evolve program (platform → code, 2026-10-11 §3), and Lab only reads it.
 *
 * Rendering rules (Surface → Code, 2026-10-11, "origin is read from meta.evidence[].origin"):
 *  1. Banding is by RECORD KIND. Every `contribution` is a recorded claim, so it is always in "reports and plans" and
 *     never in "runs". Runs are host runs only: a `qualification` record (the host's lab-receipt) naming a host Lab
 *     run id. Origin never moves a record between bands.
 *  2. Origin is per evidence ref: each `meta.evidence[]` ref's source, locator and origin, verbatim, "declared by
 *     submitter", with its custody and verification as the body says. Never collapsed; no top-level origin is read.
 *  3. The claim is shown in full, as reported. No verdict, no winner, no comparison: the scientific verdict is
 *     "unassessed".
 *  4. Nothing here counts anywhere else (run totals, Compare, History, Health). This module never touches the Lab store.
 *  6. Authority words fail closed (r1.1, Kimi's sharpest point): the record state, adoption and verification are
 *     shown only as the host's own forced values (recorded-claim, not authorized, unverified). Anything else is
 *     "unrecognised (as the record says: …)", and a value that reads as an authority claim is withheld, never echoed.
 *  5. Program0.1 source status (cited / retrieved / inspected / unavailable) is shown verbatim; "cited" never means
 *     the measurement is available.
 */
import { figureRouteSha } from '../../../api/figures'
import type { WorkGraph, WorkItem, WorkSource } from '../../../api/types'

/** The app whose view holds the family's records. */
export const PC_PROGRAM = 'omegaevolve'

/** One evidence reference, exactly as the stored body carries it. */
export interface PcEvidenceRef {
  source: string
  locator: string
  /** the submitter's declaration, verbatim ("not declared" only when the body has none) */
  origin: string
  /** the body's custody, fail closed: "unresolved" or unrecognised */
  custody: string
  /** the body's `verified`: literal false → "unverified"; a truthy claim → withheld; else "not stated (as declared)" */
  verification: string
  /** raw values the host would not have set, for the closed "as submitted" view only */
  asSubmitted: AsSubmitted[]
}

/** A Program0.1 source descriptor with its status as the host reports it. */
export interface PcSourceRow {
  id: string
  label: string
  /** the status word, verbatim ("not stated" when absent) */
  status: string
  /** what the word does and does not mean here; never "available" for a cited source */
  note: string
}

/** A recorded claim (an Evolve `contribution`), for the "reports and plans" band. */
export interface PcReport {
  id: string
  title: string
  /** the full claim, verbatim */
  claim: string
  method: string | null
  affectedRevision: string | null
  /** the body's record state, fail closed: "recorded-claim" (the host's forced value) or unrecognised */
  state: string
  /** the record's lifecycle status, verbatim (current / corrected / retracted …) */
  lifecycle: string
  relation: string | null
  predecessor: string | null
  flags: string[]
  /** fail closed: "not authorized" only for the host's forced false; anything else is unrecognised, never "authorized" */
  adoption: string
  /** raw state / adoption values the host would not have set, for the closed "as submitted" view only */
  asSubmitted: AsSubmitted[]
  uncertainty: string
  evidence: PcEvidenceRef[]
  sources: PcSourceRow[]
  /** r1.6: producer figures on the report (host lab-figures r1), in attach order; [] when it has none */
  figures: PcFigure[]
  /**
   * r1.6.1 (Platform's ruling): the analysis kind the record itself declares (`meta.analysis_kind`), or null. Never
   * inferred from the claim, the title or the submitter.
   */
  analysisKind: string | null
  /** always "unassessed": nothing in Lab assesses a recorded claim */
  verdict: 'unassessed'
}

/**
 * A host protocol qualification (the host's lab-receipt: a `qualification` record naming the Lab run it qualified).
 * It qualifies the OmegaEvolve protocol, not a PC model.
 */
/**
 * A figure on a recorded report, as the host's view item carries it (hive/API.md "Figures on recorded research
 * reports"): producer content shown with the claim, never a verdict or a run. `readUrl` is null when the host's
 * read route is missing or not the expected shape: the figure keeps its identity and shows as not available here.
 */
export interface PcFigure {
  sha256: string
  mime: string
  bytes: number
  width: number
  height: number
  /** verbatim */
  caption: string
  sourceLocator: string | null
  /** host-relative, exactly `/api/evolve/swarms/{swarm}/records/{record}/figures/{sha256}`; never carries a query */
  readUrl: string | null
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null)

/** One figure from the view item, or null when it has no identity (a 64-hex sha256 and a caption). */
export function figureOf(raw: unknown): PcFigure | null {
  const f = obj(raw)
  const sha = typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256) ? f.sha256 : null
  const caption = typeof f.caption === 'string' && f.caption.length > 0 ? f.caption : null
  if (!sha || !caption) return null
  const routeSha = typeof f.read_url === 'string' ? figureRouteSha(f.read_url) : null
  return {
    sha256: sha,
    mime: str(f.mime) ?? 'not stated',
    bytes: count(f.bytes) ?? 0,
    width: count(f.width) ?? 0,
    height: count(f.height) ?? 0,
    caption,
    sourceLocator: str(f.source_locator),
    // the route must name this very figure; anything else (another sha, a query, an absolute URL) is not read
    readUrl: routeSha === sha && f.mime === 'image/png' ? (f.read_url as string) : null,
  }
}

export interface PcRun {
  id: string
  runId: string
  label: string
  state: string
}

export interface PcBands {
  runs: PcRun[]
  reports: PcReport[]
  /** the host's own notes on this view, verbatim */
  notes: string[]
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Rule 1: a run is a host run, named by the host. A contribution is never one, whatever it carries. */
export function isHostRun(item: WorkItem): boolean {
  return item.kind === 'qualification' && !!str(obj(item.meta).lab_run_id)
}

/** Rule 1: every contribution is a recorded claim, in reports and plans. */
export function isRecordedClaim(item: WorkItem): boolean {
  return item.kind === 'contribution'
}

/** Words that read as a claim of authority, verification or a host run: never echoed from a submitted body. */
const AUTHORITY = /verif|authori[sz]|approv|adopt|certif|accept|host[\s_-]*run|run[\s_-]*by[\s_-]*host|official|trusted|signed/i

/** A body value as words for "unrecognised (as the record says: …)"; authority-sounding values are withheld. */
export function asRecordSays(v: unknown): string {
  const words = v === undefined || v === null ? 'nothing' : typeof v === 'string' ? (v.trim() ? v : 'an empty value') : JSON.stringify(v)
  const shown = words.length > 80 ? `${words.slice(0, 80)}…` : words
  return AUTHORITY.test(words) ? 'unrecognised (the record’s value is withheld: it reads as an authority claim the host never sets)' : `unrecognised (as the record says: ${shown})`
}

/** Only the host's forced values are recognised (hive/core/evolve.py contribute()). */
export const recordStateWords = (v: unknown): string => (v === 'recorded-claim' ? 'recorded-claim' : asRecordSays(v))
export const adoptionWords = (v: unknown): string => (v === false ? 'not authorized' : asRecordSays(v))
export const custodyWords = (v: unknown): string => (v === 'unresolved' ? 'unresolved' : asRecordSays(v))
/** r1.2 (Kimi #5): a submitter's affirmative verification is a claim the host never grants, not an absence. */
export const VERIFICATION_CLAIM_WITHHELD = 'withheld: the record claims verification; the host never grants it'
export const verificationWords = (v: unknown): string => (v === false ? 'unverified' : v ? VERIFICATION_CLAIM_WITHHELD : 'not stated (as declared)')

/** A raw submitted value, kept only for the closed "as submitted" details view. */
export interface AsSubmitted {
  field: string
  value: string
}
const rawWords = (v: unknown): string => (v === undefined ? '(absent)' : typeof v === 'string' ? v : JSON.stringify(v))
/** The fields whose value is not the host's own: their raw values, for "as submitted" only. */
function submitted(pairs: [string, unknown, boolean][]): AsSubmitted[] {
  return pairs.filter(([, v, recognised]) => !recognised && v !== undefined).map(([field, v]) => ({ field, value: rawWords(v) }))
}

/** Rule 2: one ref, read from itself only. */
export function evidenceRef(raw: unknown): PcEvidenceRef {
  const r = obj(raw)
  return {
    source: str(r.source) ?? 'not stated',
    locator: str(r.locator) ?? 'not stated',
    origin: str(r.origin) ?? 'not declared',
    custody: custodyWords(r.custody),
    verification: verificationWords(r.verified),
    asSubmitted: submitted([
      ['custody', r.custody, r.custody === 'unresolved'],
      ['verified', r.verified, r.verified === false],
    ]),
  }
}

/** Rule 5: a Program0.1 status word, verbatim, and what it means here. "cited" is never the measurement. */
export function sourceRow(s: WorkSource): PcSourceRow {
  const status = str(s.status) ?? 'not stated'
  const note =
    status === 'cited'
      ? 'cited only: the measurement is not available here'
      : status === 'unavailable'
        ? 'the source could not be reached'
        : status === 'retrieved'
          ? 'the source was fetched; its measurement is not checked here'
          : status === 'inspected'
            ? 'the source was inspected; not checked here'
            : 'status not stated by the host'
  return { id: s.id, label: str(s.label) ?? s.id, status, note }
}

function uncertaintyWords(u: WorkItem['uncertainty']): string {
  const x = obj(u)
  const method = str(x.method)
  if (!method) return 'not stated'
  const status = str(x.status)
  return status ? `${method} · ${status}` : method
}

/** The report's status words: "Reported", plus "local developmental analysis" only when the record declares it. */
export const LOCAL_DEVELOPMENTAL = 'local-developmental'
export function statusWords(r: Pick<PcReport, 'analysisKind'>): string {
  return r.analysisKind === LOCAL_DEVELOPMENTAL ? 'Reported · local developmental analysis' : 'Reported'
}

/** One recorded claim from a view item. The claim is the body's own text, never shortened. */
export function reportOf(item: WorkItem): PcReport {
  const meta = obj(item.meta)
  const evidence = Array.isArray(meta.evidence) ? meta.evidence.map(evidenceRef) : []
  return {
    id: item.id,
    title: str(meta.title) ?? item.label,
    claim: str(meta.claim) ?? item.text ?? '',
    method: str(meta.method),
    affectedRevision: str(meta.affected_revision),
    state: recordStateWords(meta.state),
    lifecycle: str(item.status) ?? 'not stated',
    relation: str(meta.relation),
    predecessor: str(meta.predecessor),
    flags: Array.isArray(item.flags) ? item.flags.filter((f): f is string => typeof f === 'string') : [],
    adoption: adoptionWords(meta.adoption_authorized),
    asSubmitted: submitted([
      ['state', meta.state, meta.state === 'recorded-claim'],
      ['adoption_authorized', meta.adoption_authorized, meta.adoption_authorized === false],
    ]),
    uncertainty: uncertaintyWords(item.uncertainty),
    evidence,
    sources: (item.sources ?? []).map(sourceRow),
    figures: Array.isArray(item.figures) ? item.figures.map(figureOf).filter((x): x is PcFigure => x !== null) : [],
    analysisKind: str(meta.analysis_kind),
    verdict: 'unassessed',
  }
}

/** The two bands, by record kind only. */
export function pcBands(graph: Pick<WorkGraph, 'items' | 'notes'>): PcBands {
  const runs: PcRun[] = []
  const reports: PcReport[] = []
  for (const item of graph.items) {
    if (isRecordedClaim(item)) reports.push(reportOf(item))
    else if (isHostRun(item)) {
      const meta = obj(item.meta)
      runs.push({ id: item.id, runId: str(meta.lab_run_id)!, label: item.label, state: meta.state === 'protocol-qualified' ? 'protocol-qualified' : asRecordSays(meta.state) })
    }
  }
  return { runs, reports, notes: (graph.notes ?? []).filter((n): n is string => typeof n === 'string') }
}

/** A short name for a report: its revision tag ("R10") when the body names one, else its title. */
export function shortName(r: PcReport): string {
  const tag = r.affectedRevision?.match(/^(R\d+):/i)?.[1] ?? r.title.match(/\b(R\d+)\b/)?.[1]
  return tag ? tag.toUpperCase() : r.title
}

/**
 * The claim's sentences, each marked when its own words state a negative, a failure or a limit. This only points at
 * the reported words; it never judges them and never drops a sentence.
 */
const NEGATIVE = /\b(false|fail(?:s|ed|ing|ure)?|disabled|negatives?|not|no|neither|nor|without|exception|exit1|retract(?:s|ed|ion)?)\b/i
export function claimSentences(claim: string): { text: string; negative: boolean }[] {
  // each part keeps its own trailing space, so the parts joined are the claim, byte for byte
  const parts = claim.split(/(?<=[.;]\s+)(?=\S)/).filter((s) => s.length > 0)
  return parts.map((text) => ({ text, negative: NEGATIVE.test(text) }))
}

/** What the shared Ask's words ask of this band. */
export type PcIntent = { kind: 'open'; id: string; failures: boolean } | { kind: 'none'; why: string }

/**
 * Words → one visible intent ("show the R10 report", "what failed in this report"). A report is named by its tag or
 * title; "this report" is the open one. Never guessed: no match or more than one gives a plain reason.
 */
export function pcIntent(words: string, reports: PcReport[], openId: string | null): PcIntent {
  const w = words.trim()
  if (!w) return { kind: 'none', why: 'Say which report, for example “show the R10 report”.' }
  if (!reports.length) return { kind: 'none', why: 'There are no reports here to show.' }
  const failures = /\b(fail\w*|negative\w*|wrong|false|broke\w*|didn.?t work|went wrong)\b/i.test(w)
  const tags = [...w.matchAll(/\bR\s?(\d+)\b/gi)].map((m) => `R${m[1]}`)
  let picked: PcReport[]
  if (tags.length) picked = reports.filter((r) => tags.includes(shortName(r)))
  else {
    const lower = w.toLowerCase()
    picked = reports.filter((r) => lower.includes(r.title.toLowerCase()))
    if (!picked.length && /\b(this|that|the open)\b/i.test(w)) picked = reports.filter((r) => r.id === openId)
    if (!picked.length && reports.length === 1) picked = reports
  }
  if (picked.length === 1) return { kind: 'open', id: picked[0].id, failures }
  if (picked.length > 1) return { kind: 'none', why: `${picked.length} reports match; name one, for example “${shortName(picked[0])}”.` }
  if (tags.length) return { kind: 'none', why: `No report here is named ${tags.join(' or ')}.` }
  return { kind: 'none', why: openId ? 'Name a report, or open one and ask about “this report”.' : 'Name a report, for example “show the R10 report”.' }
}
