import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '../../../api/client'
import type { Program, WorkGraph } from '../../../api/types'
import { cx } from '../../../lib/cx'
import { useNow } from '../../../lib/hooks'
import { navigate } from '../../../lib/router'
import { useHive } from '../../../store/store'
import { Icon } from '../../../ui/Icon'
import { ErrorState, Skeleton } from '../../../ui/primitives'
import { useAskFillable } from '../../ask/fields'
import { useAskView } from '../../ask/view'
import { FiguresSection, type FigureFetcher } from './Figures'
import { claimSentences, pcBands, pcIntent, PC_PROGRAM, shortName, statusWords, type AsSubmitted, type PcBands, type PcReport, type PcRun } from './model'

/**
 * The predictive-coding family in Lab: a "runs" band (host runs only) and a "reports and plans" band (recorded
 * claims: OmegaEvolve contributions). Read-only. It reads OmegaEvolve's own view and nothing else, and writes nothing
 * to the Lab's runs, scorecard or history (rules in ./model.ts).
 */

export type PcState =
  /** `waitingForTab` (followups-r7): the tab opened hidden and no read has started yet; nothing is being read */
  | { kind: 'loading'; waitingForTab?: true }
  | { kind: 'not-served'; why: string }
  | { kind: 'failed'; why: string }
  | { kind: 'served'; bands: PcBands; source: PcSource }

/** The swarm a served view was read from, and why that swarm. */
export interface PcSource {
  swarm: string
  why: string
  /** r1.4: set only when the homes answer behind this source is kept through a failed recheck (epoch ms) */
  lastConfirmed?: number
}

/** "HH:MM", local time. */
export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * When a source was last confirmed, in the browser's locale (r1.6, Kimi): the time today, else a short date and the
 * time. Without `now`, always with the date. `locale` is for tests; the page passes none (the browser's own).
 */
export function confirmedWords(ms: number, now?: number, locale?: string): string {
  const d = new Date(ms)
  const n = now === undefined ? null : new Date(now)
  const today = !!n && n.getFullYear() === d.getFullYear() && n.getMonth() === d.getMonth() && n.getDate() === d.getDate()
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d)
  return today ? time : `${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(d)}, ${time}`
}

/** Within this long of the last homes ask, returning to the tab does not ask again (the interval still restarts). */
export const RETURN_ASK_MIN_MS = 10_000

export const PC_COPY = {
  family: 'Predictive coding',
  slice: 'Research reports (Evolve)',
  scope: 'OmegaEvolve’s research is general: this lists every recorded contribution in the source swarm, not only predictive-coding studies. Which swarm or family holds the PC work is not settled yet; the PC family is where it will live in Lab.',
  sourceTeam: 'Source swarm',
  runs: 'Runs',
  runsWhat: 'Host protocol qualifications only: they qualify the OmegaEvolve protocol, not a predictive-coding model.',
  runsNone: 'No host runs yet.',
  runQualification: 'protocol qualification',
  runNotHere: 'not in this Lab’s runs',
  asSubmitted: 'as submitted (not recognised by the host)',
  reports: 'Reports and plans',
  reportsWhat: 'Recorded claims, shown as reported. Not runs: they are not counted in run totals, Compare, History or Health.',
  reportsNone: 'No research reports have been contributed here yet.',
  loading: 'Reading OmegaEvolve’s research view…',
  waitingForTab: 'Waiting until this tab is shown.',
  notServed: 'Not served here',
  failed: 'The reports could not be read',
  declared: 'declared by submitter',
  verdict: 'Scientific verdict',
  unassessed: 'unassessed',
  claim: 'Claim, as reported',
  method: 'Method, as reported',
  finding: 'Reported finding',
  limits: 'Limits',
  source: 'Source',
  fullClaim: 'Show the full claim as reported',
  lessClaim: 'Show less',
  more: 'Method, evidence and record details',
  evidence: 'Evidence references',
  sources: 'Sources (status as the host reports it)',
  askField: 'Question about the research reports',
  failuresNote: 'Sentences whose own words state a negative, a failure or a limit are marked. Matched by words, not assessed.',
  failuresNone: 'No sentence in this report states a negative in words. The full claim is above.',
} as const

const READ_ONLY_NOTE = 'Read-only. Nothing here contributes, assesses or publishes.'

/** Before any read: what the hive's app list says. Null when the view can be read. */
export function programGate(programs: Program[] | null | undefined, programsError: string | null): PcState | null {
  if (!programs) return programsError ? { kind: 'failed', why: `The hive’s app list could not be read: ${programsError}` } : { kind: 'loading' }
  const program = programs.find((p) => p.id === PC_PROGRAM)
  if (!program) return { kind: 'not-served', why: 'This hive does not serve OmegaEvolve, so there are no research reports to show here.' }
  if (program.error) return { kind: 'failed', why: `OmegaEvolve is installed but failed to load: ${program.error}` }
  if (!program.enabled) return { kind: 'not-served', why: 'OmegaEvolve is switched off on this hive, so its reports are not served here.' }
  return null
}

/** A view that did not come back: not served (no route, switched off, refused in this swarm) or failed. Never empty. */
export function viewFailure(e: unknown): PcState {
  if (e instanceof ApiError && (e.status === 404 || e.code === 'program_disabled' || e.code === 'program_refused'))
    return { kind: 'not-served', why: `This hive does not serve OmegaEvolve’s research view here (${e.code}).` }
  return { kind: 'failed', why: e instanceof Error && e.message ? e.message : 'The view could not be read.' }
}

/** How often the homes are asked again while the band is shown and the tab is visible (r1.2, Kimi #1). */
export const HOMES_RECHECK_MS = 60_000

/** The homes step's answer for one identity epoch. */
type HomesAnswer =
  | { client: unknown; epoch: number; status: 'answered'; home: string | null; why: string | null; gen: number; confirmedAt: number; stale: boolean; round: number }
  | { client: unknown; epoch: number; status: 'failed'; error: string; gen: number; round: number }

/** A homes route that failed, in words for an error with Retry: never "no home". */
export function homesFailureWords(e: unknown): string {
  const words = e instanceof Error && e.message ? e.message : 'the homes route did not answer'
  return `OmegaEvolve’s homes could not be read, so the source swarm is not known: ${words}`
}

/**
 * Reads OmegaEvolve's view from one source swarm: the app's first home, else the first open swarm.
 *
 * Identity: client, person session, fallback swarm, gate and read generation (Retry). Every time an identity starts,
 * including when it comes back after another, it gets a new **epoch** (r1.3), so nothing read under an earlier epoch
 * (homes answers or views) can be shown under the new one.
 *
 * Homes: asked when the epoch starts, every HOMES_RECHECK_MS while the tab is visible, and on returning to the tab.
 * The interval exists only while the tab is visible: it is cleared when the tab hides and restarted on return, and
 * the listener and interval go on unmount or a new epoch. Each ask has a sequence number; an answer is taken only if
 * it is newer than the last one taken, so an older ask that lands late never wins (r1.3). A homes route that fails
 * shows an error with Retry when nothing has been answered in this epoch; after a good answer, a failed recheck keeps
 * that answer (no flapping). A client without a homes route resolves "no home" at once.
 *
 * View: read for exactly one key = epoch + identity + resolved home + that answer's generation, and stored only if
 * the key is still current when the answer arrives (r1.3); shown only under that key.
 */
export function usePcFamily(): { state: PcState; retry: () => void; retryBusy: boolean; identity: string } {
  const client = useHive((s) => s.client)
  const session = useHive((s) => s.session)
  const programs = useHive((s) => s.programs)
  const programsError = useHive((s) => s.programsError)
  const firstSwarm = useHive((s) => Object.values(s.swarms).find((x) => !x.archived_at)?.id ?? null)
  // Retry, three kinds (r1.4, r1.5):
  //  - after a homes failure: `retries.reset` starts a new identity epoch (the full reset);
  //  - on a stale source: `retries.homes` re-asks the homes only (no view re-read, no remount);
  //  - otherwise: `retries.view` re-reads the view under the current epoch (and re-asks the homes, unless they were
  //    asked under 10 s ago); its result is held until that Retry's homes answer settles.
  // `tick` counts both; a homes answer records the tick it settled in (`round`).
  // r1.6 (Kimi): `pending` is the ONE source for both the busy state shown and the click latch (see `retry`).
  const [retries, setRetries] = useState<{ view: number; homes: number; reset: number; last: 'view' | 'homes' | null; pending: boolean }>({ view: 0, homes: 0, reset: 0, last: null, pending: false })
  const tick = retries.view + retries.homes
  const gate = programGate(programs, programsError)
  const blocked = gate !== null
  const ident = `${session}|${firstSwarm ?? ''}|${gate ? gate.kind : 'on'}|${retries.reset}`
  // the identity epoch: a new one whenever the identity (or client) differs from the last render's (React's
  // "adjust state while rendering" pattern), independent of any homes answer
  const [track, setTrack] = useState<{ client: unknown; ident: string; epoch: number }>({ client, ident, epoch: 0 })
  let epoch = track.epoch
  if (track.client !== client || track.ident !== ident) {
    epoch = track.epoch + 1
    setTrack({ client, ident, epoch })
  }
  const [homes, setHomes] = useState<HomesAnswer | null>(null)
  const asksHomes = !!client?.programHomes
  const mine = homes && homes.client === client && homes.epoch === epoch ? homes : null
  // the resolved home for this epoch: undefined while it is being asked (or when the homes route failed)
  const resolved = !asksHomes ? { home: null, why: null, gen: 0 } : mine && mine.status === 'answered' ? mine : undefined
  const key = resolved ? `${epoch}|${ident}|${resolved.home ?? ''}|${resolved.gen}|${retries.view}` : null
  // the last homes ask, across effect runs (r1.5: the 10 s window survives re-runs), and the epoch last answered
  const lastAsk = useRef(-Infinity)
  const answered = useRef<{ client: unknown; epoch: number } | null>(null)
  // followups-r7: whether this epoch's first homes ask has started (state, so the copy changes when it does)
  const [started, setStarted] = useState<{ client: unknown; epoch: number } | null>(null)
  const viewRetry = retries.last === 'view'

  useEffect(() => {
    if (blocked || !client || !client.programHomes) return
    let alive = true
    let asked = 0
    let taken = 0
    let settledHere = false
    const settle = (next: (cur: HomesAnswer | null, same: boolean) => HomesAnswer | null) =>
      setHomes((cur) => next(cur, !!cur && cur.client === client && cur.epoch === epoch))
    const ask = () => {
      const n = ++asked
      lastAsk.current = Date.now()
      setStarted((s) => (s && s.client === client && s.epoch === epoch ? s : { client, epoch }))
      client.programHomes!(PC_PROGRAM).then(
        (r) => ({ ok: true as const, h: r?.homes[0] ?? null }),
        (e: unknown) => ({ ok: false as const, error: homesFailureWords(e) }),
      ).then((r) => {
        if (!alive || n <= taken) return   // a newer ask was already taken: this one landed late
        taken = n
        settledHere = true
        if (r.ok) answered.current = { client, epoch }
        settle((cur, same) => {
          // a failed recheck keeps a good answer, marked stale (disclosed, r1.4); with none, the error
          if (!r.ok) return same && cur!.status === 'answered' ? { ...cur!, stale: true, round: tick } : { client, epoch, status: 'failed', error: r.error, gen: (same ? cur!.gen : 0) + 1, round: tick }
          const home = r.h?.swarm_id ?? null
          const at = Date.now()
          // the same home confirmed again: fresh, same generation (no re-read)
          if (same && cur!.status === 'answered' && cur!.home === home) return { ...cur!, why: r.h ? r.h.why : null, confirmedAt: at, stale: false, round: tick }
          return { client, epoch, status: 'answered', home, why: r.h ? r.h.why : null, gen: (same ? cur!.gen : 0) + 1, confirmedAt: at, stale: false, round: tick }
        })
      })
    }
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer === null && typeof setInterval === 'function') timer = setInterval(ask, HOMES_RECHECK_MS)
    }
    const stop = () => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
    const recent = () => Date.now() - lastAsk.current < RETURN_ASK_MIN_MS
    // r1.4: a hidden tab asks nothing until it is shown
    if (visible()) {
      const a = answered.current
      if (viewRetry && tick > 0 && recent() && a && a.client === client && a.epoch === epoch) {
        // r1.5: a view Retry within 10 s of the last homes ask keeps that answer: it settles for this Retry, unasked
        settledHere = true
        void Promise.resolve().then(() => alive && settle((cur, same) => (same && cur!.status === 'answered' ? { ...cur!, round: tick } : cur)))
      } else ask()
      start()
    }
    const onVisibility = () => {
      if (visible()) {
        // a quick hide/show does not ask again; a run that has not asked yet (it started hidden) always does
        if ((asked === 0 && !settledHere) || !recent()) ask()
        start()
      } else stop()
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      stop()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [blocked, client, ident, epoch, tick, viewRetry])

  const [got, setGot] = useState<{ client: unknown; key: string; state: PcState } | null>(null)
  // the key as of the last commit, for the check when a view answer arrives
  const currentKey = useRef<string | null>(key)
  useEffect(() => {
    currentKey.current = key
  })
  const home = resolved?.home ?? null
  const homeWhy = resolved?.why ?? null
  useEffect(() => {
    if (blocked || !client || key === null) return
    let alive = true
    const read = async (): Promise<PcState> => {
      const swarm = home ?? firstSwarm
      const why = home ? `OmegaEvolve’s first home: ${homeWhy ?? ''}` : 'the first open swarm (OmegaEvolve names no home here)'
      if (!swarm) return { kind: 'not-served', why: 'There is no swarm here to read OmegaEvolve’s research from.' }
      try {
        const g: WorkGraph = await client.programView(PC_PROGRAM, { swarm_id: swarm })
        return { kind: 'served', bands: pcBands(g), source: { swarm, why } }
      } catch (e) {
        return viewFailure(e)
      }
    }
    read().then((state) => {
      if (alive && currentKey.current === key) setGot({ client, key, state })
    })
    return () => {
      alive = false
    }
  }, [blocked, client, key, home, homeWhy, firstSwarm])

  const homesFailed = asksHomes && !!mine && mine.status === 'failed'
  const homesSettled = !asksHomes || (!!mine && mine.round >= tick)
  const viewPending = key === null || !got || got.client !== client || got.key !== key
  const staleServed = !viewPending && !!mine && mine.status === 'answered' && mine.stale && got!.state.kind === 'served'
  // a Retry is in progress until its homes answer has settled and its view (if any) has arrived
  const inProgress = !gate && (!homesSettled || (viewPending && !homesFailed))
  // r1.6: the pending Retry ends in the render that sees it done (React's "adjust state while rendering"), so the
  // busy state shown and the latch below are the same state; they cannot differ by a frame
  let pending = retries.pending
  if (pending && !inProgress) {
    pending = false
    setRetries({ ...retries, pending: false })
  }
  const retryBusy = pending
  const identity = String(epoch)
  // r1.5 backpressure, r1.6 one source: a Retry while one is pending changes nothing (the updater reads `pending`)
  const retry = useCallback(() => {
    setRetries((r) => {
      if (r.pending) return r
      if (homesFailed) return { ...r, reset: r.reset + 1, pending: true }
      if (staleServed) return { ...r, homes: r.homes + 1, last: 'homes', pending: true }
      return { ...r, view: r.view + 1, last: 'view', pending: true }
    })
  }, [homesFailed, staleServed])
  if (gate) return { state: gate, retry, retryBusy: false, identity }
  if (homesFailed) return { state: { kind: 'failed', why: (mine as { error: string }).error }, retry, retryBusy, identity }
  // r1.5: after a view Retry, the view's result waits for that Retry's homes answer (never the old home, even briefly)
  if (viewPending || (!homesSettled && retries.last !== 'homes')) {
    // followups-r7: a tab that opened hidden reads nothing until it is shown (r1.4), so until this epoch's first ask
    // starts the band says it is waiting for the tab, never that it is reading
    const askStarted = !asksHomes || !!mine || (!!started && started.client === client && started.epoch === epoch)
    const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible'
    return { state: !askStarted && hidden ? { kind: 'loading', waitingForTab: true } : { kind: 'loading' }, retry, retryBusy, identity }
  }
  const st = got!.state
  if (st.kind === 'served' && mine && mine.status === 'answered' && mine.stale) return { state: { ...st, source: { ...st.source, lastConfirmed: mine.confirmedAt } }, retry, retryBusy, identity }
  return { state: st, retry, retryBusy, identity }
}

/** The family as it shows in the Lab overview, with its Ask intents. */
export default function PcFamily() {
  const { state, retry, retryBusy, identity } = usePcFamily()
  // figures are read through the client, the session in the header (Figures.tsx); one function per client
  const hiveClient = useHive((s) => s.client)
  const fetchFigure = useMemo<FigureFetcher | null>(() => (hiveClient?.figureBlob ? (u: string) => hiveClient.figureBlob!(u) : null), [hiveClient])
  const now = useNow(60_000)
  // what is open (and the Ask's last note) belongs to one served read: another swarm's read starts closed
  const session = useHive((s) => s.session)
  const scope = state.kind === 'served' ? `${session}|${state.source.swarm}` : null
  const [ui, setUi] = useState<{ scope: string | null; open: string | null; failures: boolean; askNote: string | null }>({ scope: null, open: null, failures: false, askNote: null })
  const mine = useMemo(() => (ui.scope === scope ? ui : { scope, open: null, failures: false, askNote: null }), [ui, scope])
  const reports = useMemo(() => (state.kind === 'served' ? state.bands.reports : []), [state])
  const onWords = useCallback(
    (w: string) => {
      if (scope === null) return setUi({ scope, open: null, failures: false, askNote: 'The reports are not shown here yet.' })
      const i = pcIntent(w, reports, mine.open)
      if (i.kind === 'none') return setUi({ ...mine, askNote: i.why })
      setUi({ scope, open: i.id, failures: i.failures, askNote: null })
      window.requestAnimationFrame(() => document.querySelector(`[data-pc-report="${CSS.escape(i.id)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
    },
    [reports, mine, scope],
  )
  // the run link opens only a run this Lab holds; an id is only looked up, never counted
  const labRuns = useHive((s) => s.labRuns)
  const knownRuns = useMemo(() => new Set(Object.keys(labRuns)), [labRuns])
  const team = state.kind === 'served' ? state.source.swarm : null
  const teamName = useHive((s) => (team ? (s.swarms[team]?.name ?? null) : null))
  useAskFillable('lab.pc.question', PC_COPY.askField, 'search', onWords)
  useAskView(
    'lab.pc',
    state.kind === 'served'
      ? {
          title: `Lab · ${PC_COPY.family} · ${PC_COPY.slice}`,
          summary: `${PC_COPY.slice} from swarm ${state.source.swarm}: ${state.bands.runs.length} host protocol qualifications; ${reports.length} recorded claims (${reports.map(shortName).join(', ') || 'none'}), verdict unassessed. Ask e.g. "show the R10 report" or "what failed in this report".`.slice(0, 480),
          refs: reports.slice(0, 40).map((r) => ({ kind: 'item' as const, ref: r.id })),
          regions: ['lab-pc'],
        }
      : { title: `Lab · ${PC_COPY.family} · ${PC_COPY.slice}`, summary: `${PC_COPY.slice}: ${state.kind}`, regions: ['lab-pc'] },
  )
  return (
    <PcFamilyView
      state={state}
      teamName={teamName}
      knownRuns={knownRuns}
      open={mine.open}
      failures={mine.failures}
      askNote={mine.askNote}
      onToggle={(id) => setUi({ scope, open: mine.open === id ? null : id, failures: false, askNote: null })}
      onRetry={retry}
      retryBusy={retryBusy}
      identity={identity}
      fetchFigure={fetchFigure}
      now={now}
    />
  )
}

/** Presentational: everything shown comes from `state`. */
const NO_RUNS: ReadonlySet<string> = new Set()

export function PcFamilyView({ state, teamName = null, knownRuns = NO_RUNS, open, failures, askNote, onToggle, onRetry, retryBusy = false, now, identity = '0', fetchFigure = null }: { state: PcState; teamName?: string | null; knownRuns?: ReadonlySet<string>; open: string | null; failures: boolean; askNote: string | null; onToggle: (id: string) => void; onRetry?: () => void; retryBusy?: boolean; now?: number; identity?: string; fetchFigure?: FigureFetcher | null }) {
  return (
    <section aria-labelledby="lab-pc" data-lab-pc-family={state.kind} data-presence-region="lab-pc">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1">
        <h2 id="lab-pc" className="eyebrow">
          {PC_COPY.family}
        </h2>
        <span className="text-[12px] text-ink-3">{PC_COPY.slice}</span>
      </div>
      <p data-pc-scope className="mb-2.5 px-1 text-[11.5px] leading-snug text-ink-4">
        {state.kind === 'served' && (
          <span data-pc-source-team={state.source.swarm} className="mr-1 text-ink-3">
            {PC_COPY.sourceTeam}: <b className="font-semibold text-ink-2">{teamName ?? state.source.swarm}</b>
            {teamName ? <span className="font-mono text-[11px]"> ({state.source.swarm})</span> : null}
            {state.source.lastConfirmed == null ? (
              <>, chosen as {state.source.why}.</>
            ) : (
              <span data-pc-stale className="text-warn">
                . Source last confirmed {confirmedWords(state.source.lastConfirmed, now)}; refresh failed.{' '}
                {onRetry && (
                  <button type="button" data-pc-stale-retry onClick={onRetry} disabled={retryBusy} aria-busy={retryBusy} className="font-medium text-accent underline-offset-2 hover:underline disabled:cursor-default disabled:text-ink-4 disabled:no-underline">
                    {retryBusy ? 'Retrying…' : 'Retry'}
                  </button>
                )}
              </span>
            )}
          </span>
        )}
        {PC_COPY.scope}
      </p>
      {state.kind === 'loading' ? (
        <div data-pc-state="loading" data-pc-waiting-for-tab={state.waitingForTab ? "" : undefined} role="status" aria-live="polite" className="space-y-2">
          <p className="px-1 text-[12.5px] text-ink-4">{state.waitingForTab ? PC_COPY.waitingForTab : PC_COPY.loading}</p>
          <Skeleton className="h-16 w-full rounded-[20px]" />
        </div>
      ) : state.kind === 'not-served' ? (
        <p data-pc-state="not-served" className="rounded-[20px] border border-dashed border-line px-4 py-3 text-[12.5px] leading-snug text-ink-3" style={{ background: 'var(--lab-tile-empty)' }}>
          <b className="font-semibold text-ink-2">{PC_COPY.notServed}.</b> {state.why}
        </p>
      ) : state.kind === 'failed' ? (
        <div data-pc-state="failed" className="rounded-[20px] border border-line" style={{ background: 'var(--lab-tile)' }}>
          <ErrorState title={PC_COPY.failed} body={state.why} onRetry={retryBusy ? undefined : onRetry} />
        </div>
      ) : (
        <div data-pc-state="served" className="space-y-4">
          <RunsBand runs={state.bands.runs} knownRuns={knownRuns} />
          <ReportsBand reports={state.bands.reports} notes={state.bands.notes} open={open} failures={failures} onToggle={onToggle} identity={identity} fetchFigure={fetchFigure} />
          {askNote && (
            <p data-pc-ask-note role="status" className="px-1 text-[12.5px] text-ink-3">
              {askNote}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function BandHead({ id, title, what, count }: { id: string; title: string; what: string; count: number }) {
  return (
    <div className="mb-1.5 px-1">
      <h3 id={id} className="flex items-baseline gap-2 text-[13px] font-semibold text-ink-2">
        {title}
        <span className="text-[11.5px] font-normal text-ink-4 tabular-nums">{count}</span>
      </h3>
      <p className="text-[11.5px] leading-snug text-ink-4">{what}</p>
    </div>
  )
}

function RunsBand({ runs, knownRuns }: { runs: PcRun[]; knownRuns: ReadonlySet<string> }) {
  return (
    <div data-pc-band="runs" aria-labelledby="lab-pc-runs">
      <BandHead id="lab-pc-runs" title={PC_COPY.runs} what={PC_COPY.runsWhat} count={runs.length} />
      {runs.length ? (
        <ul className="grid gap-2">
          {runs.map((r) => (
            <li key={r.id} data-pc-run={r.id}>
              {knownRuns.has(r.runId) ? (
                <button data-pc-run-link onClick={() => navigate({ name: 'lab', run: r.runId })} className="flex min-h-11 w-full flex-wrap items-center gap-x-2 rounded-2xl border border-line px-3.5 text-left text-[13px] text-ink-2 hover:border-line-2" style={{ background: 'var(--lab-tile)' }}>
                  <Icon name="flask" size={15} className="text-ink-3" />
                  <span className="min-w-0 flex-1 truncate">{PC_COPY.runQualification}</span>
                  <span className="text-[11.5px] text-ink-4">{r.state}</span>
                  <span className="font-mono text-[11px] text-ink-3">{r.runId}</span>
                </button>
              ) : (
                <div data-pc-run-inert className="flex min-h-11 w-full flex-wrap items-center gap-x-2 rounded-2xl border border-dashed border-line px-3.5 text-[13px] text-ink-3">
                  <Icon name="flask" size={15} className="text-ink-4" />
                  <span className="min-w-0 flex-1 truncate">{PC_COPY.runQualification}</span>
                  <span className="text-[11.5px] text-ink-4">{r.state}</span>
                  <span className="font-mono text-[11px] text-ink-4">{r.runId}</span>
                  <span className="text-[11.5px] text-ink-4">· {PC_COPY.runNotHere}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p data-pc-runs-empty className="rounded-2xl border border-dashed border-line px-3.5 py-2.5 text-[12.5px] text-ink-4">
          {PC_COPY.runsNone}
        </p>
      )}
    </div>
  )
}

function ReportsBand({ reports, notes, open, failures, onToggle, identity, fetchFigure }: { reports: PcReport[]; notes: string[]; open: string | null; failures: boolean; onToggle: (id: string) => void; identity: string; fetchFigure: FigureFetcher | null }) {
  return (
    <div data-pc-band="reports" aria-labelledby="lab-pc-reports">
      <BandHead id="lab-pc-reports" title={PC_COPY.reports} what={PC_COPY.reportsWhat} count={reports.length} />
      {reports.length ? (
        <ul className="grid gap-2">
          {reports.map((r) => (
            <ReportRow key={r.id} r={r} open={open === r.id} failures={open === r.id && failures} onToggle={() => onToggle(r.id)} identity={identity} fetchFigure={fetchFigure} />
          ))}
        </ul>
      ) : (
        <p data-pc-reports-empty className="rounded-2xl border border-dashed border-line px-3.5 py-2.5 text-[12.5px] text-ink-4">
          {PC_COPY.reportsNone}
        </p>
      )}
      {(notes.length > 0 || reports.length > 0) && (
        <ul data-pc-notes className="mt-2 space-y-0.5 px-1 text-[11.5px] leading-snug text-ink-4">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          <li>{READ_ONLY_NOTE}</li>
        </ul>
      )}
    </div>
  )
}

function Chip({ children, tone, attr }: { children: ReactNode; tone?: 'warn'; attr?: string }) {
  return (
    <span data-pc-chip={attr} className={cx('inline-flex shrink-0 items-center rounded-md border px-1.5 py-px text-[11px] whitespace-nowrap', tone === 'warn' ? 'border-warn/30 bg-warn/10 text-warn' : 'border-line-2 bg-tint/[0.04] text-ink-3')}>
      {children}
    </span>
  )
}

function ReportRow({ r, open, failures, onToggle, identity, fetchFigure }: { r: PcReport; open: boolean; failures: boolean; onToggle: () => void; identity: string; fetchFigure: FigureFetcher | null }) {
  const panel = `pc-report-${r.id}`
  return (
    <li data-pc-report={r.id} data-pc-kind="recorded-claim" className="rounded-[20px] border" style={{ background: 'var(--lab-tile)', borderColor: open ? 'var(--color-line-2)' : 'var(--color-line)' }}>
      <button onClick={onToggle} aria-expanded={open} aria-controls={panel} className="flex min-h-12 w-full items-start gap-3 px-3.5 py-3 text-left">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed border-line-2 text-ink-4">
          <Icon name="flask" size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-display text-[14.5px] leading-snug font-semibold tracking-tight text-ink">{r.title}</span>
          <span className="mt-1 flex flex-wrap gap-1.5">
            <Chip attr="state">{r.state}</Chip>
            <Chip attr="lifecycle">{r.lifecycle}</Chip>
            <Chip attr="verdict" tone="warn">
              {PC_COPY.verdict.toLowerCase()}: {r.verdict}
            </Chip>
            <Chip attr="evidence">
              {r.evidence.length} evidence {r.evidence.length === 1 ? 'reference' : 'references'} · origin {PC_COPY.declared}
            </Chip>
            {r.affectedRevision && <Chip attr="revision">{shortName(r)}</Chip>}
          </span>
        </span>
        <Icon name="chevron" size={14} className={cx('mt-1.5 shrink-0 text-ink-4 transition-transform', open && 'rotate-90')} />
      </button>
      {open && <ReportDetail id={panel} r={r} failures={failures} identity={identity} fetchFigure={fetchFigure} />}
    </li>
  )
}

/**
 * The raw values the host would not have set (withheld or unrecognised above), closed by default and labelled
 * "as submitted": the record's own words, never shown as a fact about the record (r1.2, both reviewers).
 */
function AsSubmittedView({ items }: { items: AsSubmitted[] }) {
  if (!items.length) return null
  return (
    <details data-pc-as-submitted className="mt-1.5 text-[11.5px] text-ink-4">
      <summary className="cursor-pointer select-none">{PC_COPY.asSubmitted}</summary>
      <dl className="mt-1 space-y-0.5">
        {items.map((x) => (
          <div key={x.field} className="flex flex-wrap gap-x-2">
            <dt className="font-mono">{x.field}</dt>
            <dd className="font-mono break-all">{x.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

function Field({ label, children, attr }: { label: string; children: ReactNode; attr?: string }) {
  return (
    <div data-pc-field={attr} className="min-w-0">
      <dt className="text-[11px] text-ink-4">{label}</dt>
      <dd className="mt-0.5 text-[12.5px] leading-snug break-words text-ink-2">{children}</dd>
    </div>
  )
}

function ReportDetail({ id, r, failures, identity, fetchFigure }: { id: string; r: PcReport; failures: boolean; identity: string; fetchFigure: FigureFetcher | null }) {
  const sentences = claimSentences(r.claim)
  const anyNegative = sentences.some((s) => s.negative)
  // the full claim is always in the page; it is shown in full when asked, or when the Ask marks what failed in it
  const [whole, setWhole] = useState(false)
  const fullClaim = whole || failures
  return (
    <div id={id} data-pc-detail={r.id} className="space-y-4 border-t border-line px-3.5 pt-3 pb-4">
      {/* r1.6 (Design): lead with the status, reported finding, limits and source, at a readable measure */}
      <div data-pc-lead className="max-w-[72ch] space-y-2.5">
        <p data-pc-status className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
          <span data-pc-status-words className="font-medium text-ink-2">{statusWords(r)}</span>
          <span className="text-warn">
            {PC_COPY.verdict}: {r.verdict}
          </span>
        </p>
        <div>
          <h4 className="text-[11.5px] font-semibold text-ink-3">{PC_COPY.finding}</h4>
          <p data-pc-claim data-pc-claim-full={fullClaim ? '' : undefined} className={cx('mt-1 text-[13px] leading-relaxed whitespace-pre-wrap text-ink', !fullClaim && 'line-clamp-4')}>
            {failures
              ? sentences.map((s, i) =>
                  s.negative ? (
                    <mark key={i} data-pc-negative className="rounded-sm bg-warn/15 text-ink">
                      {s.text}
                    </mark>
                  ) : (
                    <span key={i}>{s.text}</span>
                  ),
                )
              : r.claim}
          </p>
          {!failures && (
            <button type="button" data-pc-claim-toggle aria-expanded={fullClaim} onClick={() => setWhole((v) => !v)} className="mt-1 min-h-9 text-[12px] font-medium text-accent hover:underline">
              {fullClaim ? PC_COPY.lessClaim : PC_COPY.fullClaim}
            </button>
          )}
          {failures && (
            <p data-pc-failures-note role="status" className="mt-1.5 text-[11.5px] leading-snug text-ink-4">
              {anyNegative ? PC_COPY.failuresNote : PC_COPY.failuresNone}
            </p>
          )}
        </div>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
          <Field label={PC_COPY.limits} attr="limits">
            {PC_COPY.verdict.toLowerCase()} {r.verdict} · {r.adoption} · uncertainty {r.uncertainty}
          </Field>
          <Field label={PC_COPY.source} attr="lead-source">
            {r.affectedRevision ? <span className="font-mono text-[11.5px] break-all">{shortName(r)}</span> : 'no revision named'} · {r.evidence.length} evidence {r.evidence.length === 1 ? 'reference' : 'references'}, origin {PC_COPY.declared}
          </Field>
        </dl>
      </div>
      <FiguresSection figures={r.figures} fetcher={fetchFigure} identity={identity} />
      <details data-pc-more open={failures || undefined} className="group">
        <summary className="min-h-10 cursor-pointer text-[12.5px] font-medium text-ink-2 select-none">{PC_COPY.more}</summary>
        <div className="mt-3 space-y-4">
      {r.method && (
        <div>
          <h4 className="text-[11.5px] font-semibold text-ink-3">{PC_COPY.method}</h4>
          <p data-pc-method className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
            {r.method}
          </p>
        </div>
      )}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={PC_COPY.verdict} attr="verdict">
          {r.verdict}
        </Field>
        <Field label="Record" attr="state">
          {r.state} · {r.lifecycle}
          {r.relation ? ` · ${r.relation}` : ''}
          {r.predecessor ? ` of ${r.predecessor}` : ''}
        </Field>
        <Field label="Adoption" attr="adoption">
          {r.adoption}
        </Field>
        <Field label="Uncertainty" attr="uncertainty">
          {r.uncertainty}
        </Field>
        {r.affectedRevision && (
          <Field label="Affected revision" attr="revision">
            <span className="font-mono text-[11.5px] break-all">{r.affectedRevision}</span>
          </Field>
        )}
        {r.flags.length > 0 && (
          <Field label="Flags" attr="flags">
            {r.flags.join(', ')}
          </Field>
        )}
      </dl>
      <AsSubmittedView items={r.asSubmitted} />
      <div>
        <h4 className="text-[11.5px] font-semibold text-ink-3">
          {PC_COPY.evidence} <span className="font-normal text-ink-4">· {r.evidence.length}</span>
        </h4>
        {r.evidence.length ? (
          <ol className="mt-1.5 space-y-2">
            {r.evidence.map((e, i) => (
              <li key={i} data-pc-ref={i} className="rounded-xl border border-line px-3 py-2" style={{ background: 'var(--lab-tile-empty)' }}>
                <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <Field label="Source" attr="source">
                    <span className="font-mono text-[11.5px] break-all">{e.source}</span>
                  </Field>
                  <Field label={`Origin · ${PC_COPY.declared}`} attr="origin">
                    {e.origin}
                  </Field>
                  <Field label="Locator" attr="locator">
                    <span className="font-mono text-[11.5px] break-all">{e.locator}</span>
                  </Field>
                  <Field label="Custody · verification" attr="custody">
                    {e.custody} · {e.verification}
                  </Field>
                </dl>
                <AsSubmittedView items={e.asSubmitted} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-[12px] text-ink-4">The record lists no evidence references.</p>
        )}
      </div>
      {r.sources.length > 0 && (
        <div>
          <h4 className="text-[11.5px] font-semibold text-ink-3">{PC_COPY.sources}</h4>
          <ul className="mt-1.5 space-y-1">
            {r.sources.map((s) => (
              <li key={s.id} data-pc-source={s.id} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                <span className="text-ink-2">{s.label}</span>
                <span data-pc-source-status className="rounded-md border border-line-2 px-1.5 text-[11px] text-ink-3">
                  {s.status}
                </span>
                <span className="text-[11.5px] text-ink-4">{s.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
        </div>
      </details>
    </div>
  )
}
