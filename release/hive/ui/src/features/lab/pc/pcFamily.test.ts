/**
 * lab-pc-band r1: the predictive-coding family's two bands in Lab, over OmegaEvolve's own view. One block per
 * review-blocking rule. Fixtures are Code's prepared contribution payloads, byte-identical (hashes checked here).
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError, pcReportsRequested } from '../../../api/client'
import type { Program, WorkItem } from '../../../api/types'
import { conformingField } from '../../../api/ask'
import { deriveStates, evolveDescribe, evolvePcGraph, PC_FIXTURE_RAW } from '../../../api/sim/evolvePc'
import simAskSrc from '../../../api/sim/ask.ts?raw'
import { validateGraph } from '../../../api/sim/programs'
import { asRecordSays, VERIFICATION_CLAIM_WITHHELD, claimSentences, evidenceRef, figureOf, pcBands, pcIntent, reportOf, shortName, sourceRow, statusWords } from './model'
import { FIGURE_COPY } from './Figures'
import { crc32 } from '../../../api/sim/pngFixture'
import { SIM_FIGURE_SHA, SIM_MISSING_FIGURE_SHA, simFigureBytes } from '../../../api/sim/evolvePc'
import { FIGURE_READ_ROUTE, figureRouteSha } from '../../../api/figures'
import viewInfoSrc from '../../../tour/ViewInfo.tsx?raw'
import { VIEW_HELP } from '../../../tour/views'
import liveSrc from '../../../api/live.ts?raw'
import { PC_COPY, PcFamilyView, confirmedWords, programGate, viewFailure, type PcState } from './PcFamily'
import pcFamilySrc from './PcFamily.tsx?raw'
import pcModelSrc from './model.ts?raw'
import labViewSrc from '../LabView.tsx?raw'
import compareSrc from '../Compare.tsx?raw'
import historySrc from '../History.tsx?raw'
import reducerSrc from '../../../store/reducer.ts?raw'
import labBadgeSrc from '../../../shell/LabBadge.tsx?raw'
import clientSrc from '../../../api/client.ts?raw'
import simClientSrc from '../../../api/sim/SimClient.ts?raw'
import simProgramsSrc from '../../../api/sim/programs.ts?raw'

const HEALTH = import.meta.glob<string>('../../health/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true })

const sha256Bytes = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as unknown as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('')
const sha256 = async (text: string) => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
/** React's text escaping, to find verbatim text in static markup. */
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
const graph = () => validateGraph('omegaevolve', evolveDescribe(), evolvePcGraph(), 'unfold')
const bands = () => pcBands(graph())
const SOURCE = { swarm: 's_lyra', why: 'OmegaEvolve’s first home: the app is set up here' }
const served = (b = bands()): PcState => ({ kind: 'served', bands: b, source: SOURCE })
const html = (state: PcState, open: string | null = null, failures = false, askNote: string | null = null, knownRuns?: ReadonlySet<string>) =>
  renderToStaticMarkup(createElement(PcFamilyView, { state, open, failures, askNote, onToggle: () => undefined, knownRuns }))
/** The markup of one band: from its marker to the next band (or the end). */
const band = (h: string, which: 'runs' | 'reports') => {
  const at = h.indexOf(`data-pc-band="${which}"`)
  if (at < 0) return ''
  const next = which === 'runs' ? h.indexOf('data-pc-band="reports"', at) : -1
  return h.slice(at, next < 0 ? undefined : next)
}
const r10 = () => bands().reports.find((r) => shortName(r) === 'R10')!
const r7 = () => bands().reports.find((r) => shortName(r) === 'R7')!
const contribution = (id: string, meta: Record<string, unknown>, extra: Partial<WorkItem> = {}): WorkItem => ({ id, kind: 'contribution', label: String(meta.title ?? id), text: String(meta.claim ?? ''), status: 'current', meta, ...extra })

describe('fixtures: Code’s payloads, byte-identical, recorded as the host records them', () => {
  it('R10 and R7 payloads hash to Code’s published sha256', async () => {
    expect(await sha256(PC_FIXTURE_RAW.r10)).toBe('ddd3ab93e2676cff185c03999c59a0c1bf57b5c2c57174e3a799eebb56c0cb0a')
    expect(await sha256(PC_FIXTURE_RAW.r7)).toBe('ad67a5845dca76609d4fce0a04bdf6b27c55d8365c1f2684b24f1d031249ec31')
    // R11 as published (7c64a455…) but for its three workspace locators, shortened to drop an internal-notes path
    expect(await sha256(PC_FIXTURE_RAW.r11)).toBe('c7e7c961cb8d32badf4fec370b84b5f018db9e7afdef3c51e7233b43e614fd15')
  })
  it('the sim view passes the host-shape validation and carries both contributions as recorded claims', () => {
    const g = graph()
    const cs = g.items.filter((i) => i.kind === 'contribution')
    expect(cs).toHaveLength(3)
    for (const c of cs) {
      expect(c.meta?.state).toBe('recorded-claim')
      expect(c.meta?.adoption_authorized).toBe(false)
      expect(c.meta && 'origin' in c.meta).toBe(false)   // the host stores no top-level origin
      for (const e of c.meta?.evidence as Record<string, unknown>[]) expect(e).toMatchObject({ custody: 'unresolved', verified: false })
    }
    expect(r10().evidence).toHaveLength(9)
    expect(r7().evidence).toHaveLength(4)
  })
  it('the fixture is opt-in by the URL alone, and loads lazily', () => {
    expect(pcReportsRequested('?sim=1&pcreports=fixture')).toBe('fixture')
    expect(pcReportsRequested('?sim=1&pcreports=fail')).toBe('fail')
    expect(pcReportsRequested('?pcreports=fixture')).toBeNull()
    expect(pcReportsRequested('?sim=0&pcreports=fixture')).toBeNull()
    expect(pcReportsRequested('?sim=1&pcreports=yes')).toBeNull()
    expect(clientSrc).toContain("await import('./sim/evolvePc')")
    expect(clientSrc).not.toMatch(/^import .*evolvePc/m)
    expect(simClientSrc).not.toMatch(/^import .*evolvePc/m)
    expect(simProgramsSrc).not.toMatch(/^import .*evolvePc/m)
  })
  it('the sim fixture declares no actions (a read-only specimen)', () => {
    expect(evolveDescribe().actions).toEqual([])
  })
})

describe('rule 1: banding is by record kind; a contribution is never a run', () => {
  it('both fixtures are in reports and plans; the runs band holds none of them', () => {
    const b = bands()
    expect(b.runs).toEqual([])
    expect(b.reports.map(shortName).sort()).toEqual(['R10', 'R11', 'R7'])
    const h = html(served(b))
    expect(band(h, 'runs')).not.toContain('data-pc-report')
    expect(band(h, 'reports').match(/data-pc-report="/g)).toHaveLength(3)
    expect(band(h, 'runs')).toContain(PC_COPY.runsNone)
  })
  it('a contribution dressed as a run (host-run origin, a lab_run_id, a run state) still sits in reports', () => {
    const b = pcBands({ items: [contribution('ev_x', { title: 'Dressed', claim: 'c', origin: 'host-run', lab_run_id: 'run_1', state: 'host-run', evidence: [{ source: 's', locator: 'l', origin: 'host-run', custody: 'unresolved', verified: false }] })], notes: [] })
    expect(b.runs).toEqual([])
    expect(b.reports.map((r) => r.id)).toEqual(['ev_x'])
    expect(band(html(served(b)), 'runs')).not.toContain('ev_x')
  })
  it('the runs band is host runs only: a qualification naming a host Lab run', () => {
    const items: WorkItem[] = [
      { id: 'ev_q', kind: 'qualification', label: 'Qualification', meta: { lab_run_id: 'run_42', state: 'protocol-qualified' } },
      { id: 'ev_q0', kind: 'qualification', label: 'No run', meta: { state: 'protocol-qualified' } },
      { id: 'ev_e', kind: 'experiment', label: 'Plan', meta: { lab_run_id: 'run_9' } },
    ]
    const b = pcBands({ items, notes: [] })
    expect(b.runs.map((r) => r.runId)).toEqual(['run_42'])
    expect(b.reports).toEqual([])
    expect(band(html(served(b)), 'runs')).toContain('run_42')
  })
})

describe('rule 2: origin is per evidence reference, declared by submitter, never collapsed', () => {
  it('every R10 ref shows its own source, locator and origin verbatim, with custody unresolved and unverified', () => {
    const r = r10()
    const h = html(served(), r.id)
    const raw = JSON.parse(PC_FIXTURE_RAW.r10) as { evidence: { source: string; locator: string; origin: string }[] }
    expect(h.match(/data-pc-ref="/g)).toHaveLength(raw.evidence.length)
    for (const e of raw.evidence) {
      expect(h).toContain(esc(e.source))
      expect(h).toContain(esc(e.locator))
    }
    expect(h.match(new RegExp(`Origin · ${PC_COPY.declared}`, 'g'))).toHaveLength(raw.evidence.length)
    expect(h.match(/unresolved · unverified/g)).toHaveLength(raw.evidence.length)
  })
  it('refs with different origins each keep their own; a top-level origin is never read', () => {
    const item = contribution('ev_m', {
      title: 'Mixed',
      claim: 'c',
      origin: 'host-run',
      evidence: [
        { source: 'a', locator: 'la', origin: 'imported-report', custody: 'unresolved', verified: false },
        { source: 'b', locator: 'lb', origin: 'planned', custody: 'unresolved', verified: false },
        { source: 'c', locator: 'lc', custody: 'unresolved', verified: false },
      ],
    })
    const r = reportOf(item)
    expect(r.evidence.map((e) => e.origin)).toEqual(['imported-report', 'planned', 'not declared'])
    const h = html(served({ runs: [], reports: [r], notes: [] }), 'ev_m')
    expect(h).toContain('>imported-report<')
    expect(h).toContain('>planned<')
    expect(h).toContain('>not declared<')
    expect(h).not.toContain('host-run')
    expect(pcModelSrc).not.toMatch(/meta\.origin|\bmeta\[['"]origin['"]\]/)
  })
  it('custody and verification fail closed: the host’s values read plainly, absent is unrecognised / not stated (as declared)', () => {
    expect(evidenceRef({ source: 's', locator: 'l', origin: 'o', custody: 'unresolved', verified: false })).toMatchObject({ custody: 'unresolved', verification: 'unverified' })
    expect(evidenceRef({ source: 's', locator: 'l', origin: 'o' })).toMatchObject({ custody: 'unrecognised (as the record says: nothing)', verification: 'not stated (as declared)' })
  })
})

describe('rule 3: the full claim, as reported; no verdict, no winner, no comparison', () => {
  it('R10’s claim is shown whole, with PC 21/24 beside Adam 24/24 as written, and the verdict unassessed', () => {
    const r = r10()
    const h = html(served(), r.id)
    expect(h).toContain(esc(r.claim))
    expect(h).toContain(esc((JSON.parse(PC_FIXTURE_RAW.r10) as { method: string }).method))
    expect(h).toContain('PC remains 21/24 overall and 1/2 corrected while Adam is 24/24 and 2/2 corrected.')
    expect(h).toContain('neither supersedes nor retracts them')
    expect(h).toMatch(/data-pc-field="verdict"[^]*?<dd[^>]*>unassessed<\/dd>/)
  })
  it('R7’s negatives are shown as written: full validation false, the cache-logit gate failed, cache disabled, the failing probes', () => {
    const h = html(served(), r7().id)
    for (const words of ['full bridge validation false', 'cache-logit gate false', 'cache disabled', 'deliberately exit1 without Ready']) expect(h).toContain(words)
  })
  it('nothing names a winner, ranks or charts the counts (collapsed and open)', () => {
    for (const h of [html(served()), html(served(), r10().id), html(served(), r10().id, true), html(served(), r7().id, true)]) {
      expect(h.replace(/<[^>]+>/g, ' ')).not.toMatch(/\b(winner|wins|won|better|best|beats|outperform\w*|ahead|leads|leading|loser|worse)\b/i)
      expect(h).not.toMatch(/data-chart|<polyline|<rect|role="meter"|<progress/)
    }
    expect(pcFamilySrc).not.toMatch(/from '\.\.\/charts'|Sparkline|TruthBars|ProgressRing|Meter\b/)
  })
  it('"what failed" marks sentences by their words, never drops or rewrites one', () => {
    for (const r of [r10(), r7()]) expect(claimSentences(r.claim).map((s) => s.text).join('')).toBe(r.claim)
    const marked = claimSentences(r7().claim).filter((s) => s.negative).map((s) => s.text.trim())
    expect(marked).toContain('full bridge validation false and cache-logit gate false, cache disabled.')
    expect(marked).not.toContain('Reported CPU core mechanics pass;')
    const h = html(served(), r7().id, true)
    expect(h).toContain('data-pc-negative')
    expect(h.replace(/<[^>]+>/g, '')).toContain(r7().claim)
    expect(h).toContain(PC_COPY.failuresNote)
  })
})

describe('scope honesty: the source swarm is shown, and the slice is named as Evolve research', () => {
  it('a served view names its source swarm and why, and says the research is general', () => {
    const h = renderToStaticMarkup(createElement(PcFamilyView, { state: served(), teamName: 'Lyra', open: null, failures: false, askNote: null, onToggle: () => undefined }))
    expect(h).toContain('data-pc-source-team="s_lyra"')
    expect(h).toContain('Lyra')
    expect(h).toContain('OmegaEvolve’s first home: the app is set up here')
    expect(h).toContain(PC_COPY.slice)
    expect(h).toContain(esc(PC_COPY.scope))
  })
  it('reports are not labelled as PC studies', () => {
    const h = html(served(), r10().id)
    expect(h.replace(/<[^>]+>/g, ' ')).not.toMatch(/\bPC (report|study|studies|result)s?\b/i)
  })
  it('no swarm is shown while not served', () => {
    expect(html({ kind: 'loading' })).not.toContain('data-pc-source-team')
  })
})

describe('rule 4: never counted anywhere else', () => {
  it('the band never touches the Lab’s runs, scorecard, cases or health, nor History or Compare', () => {
    for (const src of [pcFamilySrc, pcModelSrc]) {
      expect(src).not.toMatch(/\b(labSuites|labScorecard|labCases|labRunLog|labHealth|loadLab|runAllLab|setState)\b/)
      expect(src).not.toMatch(/from '\.\.\/(History|Compare|Drift|Epistemic|RunDetail)'|features\/health/)
    }
  })
  it('History, Compare, the scorecard, the Lab badge and Health never read the family', () => {
    const scorecard = labViewSrc.slice(labViewSrc.indexOf('function Scorecard('), labViewSrc.indexOf('function HealthRing('))
    expect(scorecard.length).toBeGreaterThan(100)
    const readers = { History: historySrc, Compare: compareSrc, reducer: reducerSrc, LabBadge: labBadgeSrc, Scorecard: scorecard, ...HEALTH }
    expect(Object.keys(HEALTH).length).toBeGreaterThan(0)
    for (const [name, src] of Object.entries(readers)) expect([name, /\b[pP]c[A-Z]\w*|\/pc\/|\bpc\.|contribution|omegaevolve/.test(src) || /contribution|omegaevolve/i.test(src)]).toEqual([name, false])
  })
  it('the family mounts once, in the overview, after the scorecard and suites', () => {
    expect(labViewSrc.match(/<PcFamily \/>/g)).toHaveLength(1)
    const overview = labViewSrc.slice(labViewSrc.indexOf('function Overview('), labViewSrc.indexOf('function Scorecard('))
    expect(overview).toContain('<PcFamily />')
    expect(overview.indexOf('<Scorecard')).toBeLessThan(overview.indexOf('<PcFamily />'))
  })
})

describe('rule 5: Program0.1 source status, verbatim; cited is never available', () => {
  it('each status word is shown as the host reports it', () => {
    for (const s of ['cited', 'retrieved', 'inspected', 'unavailable']) expect(sourceRow({ id: s, label: s, status: s }).status).toBe(s)
    expect(sourceRow({ id: 'x', label: 'x' }).status).toBe('not stated')
  })
  it('inspected says only that it was inspected; no actor is inferred', () => {
    expect(sourceRow({ id: 'i', label: 'i', status: 'inspected' }).note).toBe('the source was inspected; not checked here')
    for (const s of ['cited', 'retrieved', 'inspected', 'unavailable']) expect(sourceRow({ id: s, label: s, status: s }).note).not.toMatch(/submitter|author|by /)
  })
  it('cited says the measurement is not available, and never that it is', () => {
    const c = sourceRow({ id: 'c', label: 'Paper', status: 'cited' })
    expect(c.note).toContain('not available')
    const item = contribution('ev_s', { title: 'With sources', claim: 'c', evidence: [] }, { sources: [{ id: 'c', label: 'Paper', status: 'cited' }, { id: 'r', label: 'Data', status: 'retrieved' }] })
    const h = html(served({ runs: [], reports: [reportOf(item)], notes: [] }), 'ev_s')
    const cited = h.slice(h.indexOf('data-pc-source="c"'), h.indexOf('data-pc-source="r"'))
    expect(cited).toContain('>cited<')
    expect(cited).toContain('cited only: the measurement is not available here')
    expect(cited.replace(/not available/g, '')).not.toMatch(/\bavailable\b/)
  })
})

describe('rule 6: honest states, never a fake empty list', () => {
  it('loading, not served and failed each say so, and none draws an empty list', () => {
    const loading = html({ kind: 'loading' })
    expect(loading).toContain('data-pc-state="loading"')
    expect(loading).toContain(PC_COPY.loading)
    expect(loading).not.toContain(PC_COPY.waitingForTab)
    // followups-r7 item 5: a tab that opened hidden, nothing read yet: waiting for the tab, not "reading"
    const waiting = html({ kind: 'loading', waitingForTab: true })
    expect(waiting).toContain('data-pc-state="loading"')
    expect(waiting).toContain('data-pc-waiting-for-tab=""')
    expect(waiting).toContain('Waiting until this tab is shown.')
    expect(waiting).not.toContain(PC_COPY.loading)
    const ns = html({ kind: 'not-served', why: 'No OmegaEvolve here.' })
    expect(ns).toContain(PC_COPY.notServed)
    expect(ns).toContain('No OmegaEvolve here.')
    const failed = html({ kind: 'failed', why: 'boom 500' })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain(PC_COPY.failed)
    expect(failed).toContain('boom 500')
    for (const h of [loading, ns, failed]) {
      expect(h).not.toContain(PC_COPY.reportsNone)
      expect(h).not.toContain(PC_COPY.runsNone)
      expect(h).not.toContain('data-pc-band')
    }
  })
  it('served and empty says so plainly', () => {
    const h = html(served({ runs: [], reports: [], notes: [] }))
    expect(h).toContain(PC_COPY.reportsNone)
    expect(h).toContain(PC_COPY.runsNone)
  })
  it('the app list decides not served / failed / loading before any read', () => {
    const p = (x: Partial<Program>): Program => ({ id: 'omegaevolve', name: 'OmegaEvolve', version: '1', description: '', icon: 'flask', capabilities: [], source: 'built-in', enabled: true, error: null, ...x }) as Program
    expect(programGate(null, null)).toEqual({ kind: 'loading' })
    expect(programGate(null, 'offline')?.kind).toBe('failed')
    expect(programGate([], null)?.kind).toBe('not-served')
    expect(programGate([p({ enabled: false })], null)?.kind).toBe('not-served')
    expect(programGate([p({ error: 'ImportError' })], null)?.kind).toBe('failed')
    expect(programGate([p({})], null)).toBeNull()
  })
  it('a view that fails is not served (no route, off, refused) or failed, never empty', () => {
    expect(viewFailure(new ApiError(404, 'not_found', 'no program')).kind).toBe('not-served')
    expect(viewFailure(new ApiError(409, 'program_disabled', 'off')).kind).toBe('not-served')
    expect(viewFailure(new ApiError(403, 'program_refused', 'refused')).kind).toBe('not-served')
    expect(viewFailure(new ApiError(500, 'program_error', 'it broke'))).toEqual({ kind: 'failed', why: 'it broke' })
  })
})

describe('rule 7: the shared Ask', () => {
  it('registers a conforming fillable field and the page view', () => {
    expect(pcFamilySrc).toContain("useAskFillable('lab.pc.question', PC_COPY.askField, 'search', onWords)")
    expect(pcFamilySrc).toContain("useAskView(\n    'lab.pc',")
    expect(conformingField({ id: 'lab.pc.question', label: PC_COPY.askField, kind: 'search' })).not.toBeNull()
    expect(pcFamilySrc).toContain('data-presence-region="lab-pc"')
  })
  it('"show the R10 report" opens R10; "what failed in this report" marks the open one', () => {
    const rs = bands().reports
    expect(pcIntent('show the R10 report', rs, null)).toEqual({ kind: 'open', id: r10().id, failures: false })
    expect(pcIntent('open r7', rs, null)).toEqual({ kind: 'open', id: r7().id, failures: false })
    expect(pcIntent('what failed in this report', rs, r7().id)).toEqual({ kind: 'open', id: r7().id, failures: true })
    expect(pcIntent('what failed in R10', rs, null)).toEqual({ kind: 'open', id: r10().id, failures: true })
  })
  it('never guesses: an unknown or unnamed report gets a plain reason', () => {
    const rs = bands().reports
    expect(pcIntent('show the R99 report', rs, null)).toEqual({ kind: 'none', why: 'No report here is named R99.' })
    expect(pcIntent('what failed in this report', rs, null).kind).toBe('none')
    expect(pcIntent('show it', [], null).kind).toBe('none')
    expect(html(served(), null, false, 'No report here is named R99.')).toContain('No report here is named R99.')
  })
})

describe('r1.1: R11, Code’s third payload, unmodified', () => {
  const r11 = () => bands().reports.find((r) => shortName(r) === 'R11')!
  const raw = () => JSON.parse(PC_FIXTURE_RAW.r11) as { claim: string; method: string; evidence: { source: string; locator: string; origin: string }[] }
  it('its 8 refs keep their mixed origins, each shown separately, verbatim', () => {
    const h = html(served(), r11().id)
    const refs = raw().evidence
    expect(refs).toHaveLength(8)
    expect(new Set(refs.map((e) => e.origin)).size).toBeGreaterThan(1)
    expect(r11().evidence.map((e) => e.origin)).toEqual(refs.map((e) => e.origin))
    const shown = [...h.matchAll(/data-pc-field="origin"[^]*?<dd[^>]*>([^<]*)<\/dd>/g)].map((m) => m[1])
    expect(shown).toEqual(refs.map((e) => esc(e.origin)))
    for (const e of refs) expect(h).toContain(esc(e.locator))
  })
  it('the claim and method are whole: all 13 arms, every stage, the failures and the limitations', () => {
    const h = html(served(), r11().id)
    expect(h).toContain(esc(raw().claim))
    expect(h).toContain(esc(raw().method))
    const arms = ['frozen', 'gd_sgd', 'Adam', 'pc_sgd', 'PC+Adam', 'Adam matched calls', 'pc_adam_reset', 'gd_adam_reset', 'memory_only', 'gd_adam_memory', 'pc_sgd_memory', 'PC+Adam+MeTTa', 'native_lookup']
    for (const a of arms) expect(raw().claim).toContain(`${a} `)
    expect(h).toContain('No general superiority, host admission, adoption or deployment is established.')
  })
  it('"show the R11 report" opens R11, and R11 naming R10 in its text does not confuse "show the R10 report"', () => {
    expect(pcIntent('show the R11 report', bands().reports, null)).toEqual({ kind: 'open', id: r11().id, failures: false })
    expect(pcIntent('show the R10 report', bands().reports, null)).toEqual({ kind: 'open', id: r10().id, failures: false })
  })
})

describe('r1.5: the stale source line', () => {
  const at = new Date(2026, 9, 12, 9, 5, 0).getTime()
  const st: PcState = { kind: 'served', bands: bands(), source: { ...SOURCE, lastConfirmed: at } }
  const view = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(PcFamilyView, { state: st, open: null, failures: false, askNote: null, onToggle: () => undefined, onRetry: () => undefined, ...props }))
  it('says "Source last confirmed HH:MM; refresh failed." today, and the date when it is not today', () => {
    // r1.6: in the browser's locale (here, the test runner's): the words the view shows are confirmedWords' own
    const today = new Date(2026, 9, 12, 18, 0, 0).getTime()
    const tomorrow = new Date(2026, 9, 13, 8, 0, 0).getTime()
    expect(view({ now: today })).toContain(`Source last confirmed ${confirmedWords(at, today)}; refresh failed.`)
    expect(view({ now: tomorrow })).toContain(`Source last confirmed ${confirmedWords(at, tomorrow)}; refresh failed.`)
    expect(confirmedWords(at, tomorrow)).not.toBe(confirmedWords(at, today))   // another day carries the date
  })
  it('a Retry in flight shows as busy and cannot be pressed', () => {
    const h = view({ now: at, retryBusy: true })
    expect(h).toMatch(/<button[^>]*data-pc-stale-retry[^>]*disabled=""[^>]*aria-busy="true"[^>]*>Retrying…<\/button>/)
    expect(view({ now: at })).toMatch(/<button[^>]*data-pc-stale-retry[^>]*aria-busy="false"[^>]*>Retry<\/button>/)
  })
})

describe('r1.4: a kept, stale source says so', () => {
  it('fresh: "chosen as …"; stale: "Last confirmed HH:MM; refresh failed." with Retry, never "chosen as"', () => {
    const at = new Date(2026, 9, 12, 9, 5, 0).getTime()
    const fresh = renderToStaticMarkup(createElement(PcFamilyView, { state: served(), open: null, failures: false, askNote: null, onToggle: () => undefined, onRetry: () => undefined }))
    expect(fresh).toContain('chosen as')
    expect(fresh).not.toContain('data-pc-stale')
    const st: PcState = { kind: 'served', bands: bands(), source: { ...SOURCE, lastConfirmed: at } }
    const stale = renderToStaticMarkup(createElement(PcFamilyView, { state: st, open: null, failures: false, askNote: null, onToggle: () => undefined, onRetry: () => undefined }))
    expect(stale).toContain(`Source last confirmed ${confirmedWords(at)}; refresh failed.`)   // no `now`: with the date
    expect(stale).toContain('data-pc-stale-retry')
    expect(stale).not.toContain('chosen as')
  })
})

describe('r1.1: the run link is looked up, never counted', () => {
  it('labRuns is read once, only to know which run ids this Lab holds', () => {
    expect(pcModelSrc).not.toMatch(/\blabRuns\b/)
    expect(pcFamilySrc.match(/\blabRuns\b/g)).toHaveLength(4)   // the selector, its value, and the memo's keys + deps
    expect(pcFamilySrc).toContain('const labRuns = useHive((s) => s.labRuns)')
    expect(pcFamilySrc).toContain('const knownRuns = useMemo(() => new Set(Object.keys(labRuns)), [labRuns])')
  })
  const runs = pcBands({ items: [{ id: 'ev_q', kind: 'qualification', label: 'qualification', meta: { lab_run_id: 'run_42', state: 'protocol-qualified' } }], notes: [] })
  it('a run this Lab holds opens; it is labelled a protocol qualification', () => {
    const h = band(html(served(runs), null, false, null, new Set(['run_42'])), 'runs')
    expect(h).toContain('data-pc-run-link')
    expect(h).toContain(PC_COPY.runQualification)
    expect(h).not.toContain('data-pc-run-inert')
  })
  it('a run id this Lab does not hold is inert text, "not in this Lab’s runs"', () => {
    const h = band(html(served(runs)), 'runs')
    expect(h).toContain('data-pc-run-inert')
    expect(h).not.toContain('data-pc-run-link')
    expect(h).not.toMatch(/<button[^>]*>[^]*run_42/)
    expect(h).toContain(esc(PC_COPY.runNotHere))
  })
  it('the runs band never calls its entries PC runs', () => {
    expect(PC_COPY.runsNone).toBe('No host runs yet.')   // r1.6 (Design): its own sentence, apart from reports
    expect(PC_COPY.runsWhat).toContain('not a predictive-coding model')
  })
})

describe('r1.1: authority words fail closed (the body is not trusted)', () => {
  const dressed = contribution('ev_d', {
    title: 'Dressed',
    claim: 'c',
    state: 'host-run',
    adoption_authorized: true,
    evidence: [
      { source: 's1', locator: 'l1', origin: 'imported-report', custody: 'host-verified', verified: true },
      { source: 's2', locator: 'l2', origin: 'imported-report', custody: 'held', verified: 'yes' },
    ],
  })
  const detail = (h: string) => h.slice(h.indexOf('data-pc-report="ev_d"'))
  it('state, adoption, custody and verification other than the host’s forced values are unrecognised or not stated', () => {
    const r = reportOf(dressed)
    expect(r.state).toBe(asRecordSays('host-run'))
    expect(r.state).not.toContain('host-run')
    expect(r.adoption).toBe(asRecordSays(true))
    expect(r.evidence[0]).toMatchObject({ custody: asRecordSays('host-verified'), verification: VERIFICATION_CLAIM_WITHHELD })
    expect(r.evidence[1]).toMatchObject({ custody: 'unrecognised (as the record says: held)', verification: VERIFICATION_CLAIM_WITHHELD })
  })
  it('the rendered report never reads as verified, authorized or a host run', () => {
    const full = detail(html(served({ runs: [], reports: [reportOf(dressed)], notes: [] }), 'ev_d'))
    // the raw values exist only in closed "as submitted" details views
    const views = full.match(/<details data-pc-as-submitted[^>]*>[^]*?<\/details>/g) ?? []
    expect(views).toHaveLength(3)   // the report's state/adoption, and each ref's custody/verified
    for (const v of views) {
      expect(v).not.toMatch(/<details[^>]*\bopen\b/)
      expect(v).toContain(`<summary class="cursor-pointer select-none">${PC_COPY.asSubmitted}</summary>`)
    }
    expect(views.join('')).toContain('host-run')
    const text = full.replace(/<details data-pc-as-submitted[^>]*>[^]*?<\/details>/g, ' ').replace(/<[^>]+>/g, ' ')
    expect(text).toContain('unrecognised')
    expect(text).toContain('withheld: the record claims verification; the host never grants it')
    expect(text.replace(/unverified|not authorized/g, '')).not.toMatch(/\bverified\b|\bauthori[sz]ed\b|host[\s_-]*run|\badopted\b/i)
  })
  it('verified: false is "unverified"; any truthy claim is withheld as a claim; absent or falsy is "not stated (as declared)"', () => {
    expect(evidenceRef({ verified: false }).verification).toBe('unverified')
    for (const v of [true, 'yes', 1, 'true', { by: 'host' }]) expect(evidenceRef({ verified: v }).verification).toBe(VERIFICATION_CLAIM_WITHHELD)
    for (const v of [undefined, null, 0, '']) expect(evidenceRef({ verified: v }).verification).toBe('not stated (as declared)')
    expect(VERIFICATION_CLAIM_WITHHELD).toBe('withheld: the record claims verification; the host never grants it')
  })
  it('a host record has no "as submitted" view', () => {
    expect(r10().asSubmitted).toEqual([])
    expect(r10().evidence.every((e) => e.asSubmitted.length === 0)).toBe(true)
    expect(html(served(), r10().id)).not.toContain('data-pc-as-submitted')
  })
  it('the host’s forced values read plainly', () => {
    const r = r10()
    expect([r.state, r.adoption]).toEqual(['recorded-claim', 'not authorized'])
    expect(r.evidence.every((e) => e.custody === 'unresolved' && e.verification === 'unverified')).toBe(true)
  })
  it('a run state other than protocol-qualified is unrecognised', () => {
    const b = pcBands({ items: [{ id: 'q', kind: 'qualification', label: 'q', meta: { lab_run_id: 'r', state: 'adopted' } }], notes: [] })
    expect(b.runs[0].state).toBe(asRecordSays('adopted'))
    expect(b.runs[0].state).not.toContain('adopted')
  })
})

describe('r1.1: the sim view is the host’s whole view', () => {
  it('lists the two seed subjects, planned and unverified, with subject-of links', () => {
    const g = graph()
    const seeds = g.items.filter((i) => i.kind === 'seed')
    expect(seeds.map((i) => i.id)).toEqual(['seed-omega', 'seed-iter'])
    for (const s of seeds) expect(s.meta).toMatchObject({ phase: 'planned', provisioning: 'unverified', adoption_authorized: false })
    expect(g.links.filter((l) => l.rel === 'subject-of').map((l) => l.from)).toEqual(['seed-omega', 'seed-iter'])
    expect(bands().reports).toHaveLength(3)   // seeds never enter a band
    expect(bands().runs).toHaveLength(0)
  })
  it('derives the assessment as the host does: a correction marks its parent and flags dependents', () => {
    const st = deriveStates([
      { id: 'a', kind: 'contribution', author: 'p', body: {} },
      { id: 'b', kind: 'contribution', author: 'p', body: { predecessor: 'a', relation: 'correction' } },
      { id: 'c', kind: 'contribution', author: 'q', body: { depends_on: ['a'] } },
      { id: 'd', kind: 'contribution', author: 'q', body: { predecessor: 'a', relation: 'retraction' } },
    ])
    expect(st.a).toMatchObject({ status: 'corrected', invalidated_by: ['b'] })
    expect(st.c.flags).toEqual(['needs-review'])
    expect(st.d.flags).toEqual(['invalid-source-lineage'])
    expect(st.b.status).toBe('current')
  })
  it('the sim Ask fills only on a report intent, and says it is simulated', () => {
    expect(simAskSrc).toContain("f.id === 'lab.pc.question') && (/\\br\\s?\\d+\\b/.test(text) || /\\b(fail")
    expect(simAskSrc).not.toContain("f.id === 'lab.pc.question') && /\\breports?\\b/")
    expect(simAskSrc).toContain('(Simulated conductor.)')
  })
})

const SHA = 'a'.repeat(64)
const route = (sha = SHA) => `/api/evolve/swarms/s_x/records/ev_1/figures/${sha}`
const fig = (x: Record<string, unknown> = {}) => ({ sha256: SHA, mime: 'image/png', bytes: 2048, width: 320, height: 200, caption: 'Panel A.\nSecond line, verbatim.', read_url: route(), ...x })
const withFigures = (figures: Record<string, unknown>[]) => contribution('ev_f', { title: 'With figures', claim: 'A claim. Not established.', method: 'm', state: 'recorded-claim', adoption_authorized: false, evidence: [] }, { figures })

describe('r1.6: reported figures (lab-figures r1)', () => {
  it('a figure keeps its identity; only the host’s own route for that very figure is ever read', () => {
    expect(figureOf(fig())).toMatchObject({ sha256: SHA, caption: 'Panel A.\nSecond line, verbatim.', readUrl: route() })
    expect(figureOf(fig({ sha256: 'xyz' }))).toBeNull()
    expect(figureOf(fig({ caption: '' }))).toBeNull()
    expect(figureOf(fig({ read_url: route() + '?token=abc' }))?.readUrl).toBeNull()
    expect(figureOf(fig({ read_url: 'https://elsewhere.example/x.png' }))?.readUrl).toBeNull()
    expect(figureOf(fig({ read_url: route('b'.repeat(64)) }))?.readUrl).toBeNull()   // names another figure
    expect(figureOf(fig({ mime: 'image/svg+xml' }))?.readUrl).toBeNull()
    expect(figureRouteSha(route())).toBe(SHA)
    for (const bad of [route() + '?t=1', route() + '#x', `/api/assets/${SHA}`, `//evil/api/evolve/swarms/s/records/r/figures/${SHA}`]) expect(FIGURE_READ_ROUTE.test(bad)).toBe(false)
  })
  it('the live client reads figures only on that route, with the session in the header (raw), never in the URL', () => {
    const body = liveSrc.slice(liveSrc.indexOf('figureBlob = async'), liveSrc.indexOf('figureBlob = async') + 400)
    expect(body).toContain('if (!figureRouteSha(readUrl))')
    expect(body).toContain("this.raw('GET', readUrl)")
    expect(liveSrc).toMatch(/private async raw\([^]*?headers\.Authorization = `Bearer \$\{this\.token\}`/)
    expect(body).not.toMatch(/token|\?/)
  })
  it('no figures: nothing new is shown', () => {
    const h = html(served({ runs: [], reports: [reportOf(withFigures([]))], notes: [] }), 'ev_f')
    expect(h).not.toContain('data-pc-figures')
    expect(h).not.toContain(FIGURE_COPY.title)
  })
  it('with figures: "Reported figures", one at a time, caption verbatim; unreadable here keeps its identity', () => {
    const h = html(served({ runs: [], reports: [reportOf(withFigures([fig(), fig({ sha256: 'c'.repeat(64), read_url: route('c'.repeat(64)), caption: 'Panel B' })]))], notes: [] }), 'ev_f')
    expect(h).toContain(FIGURE_COPY.title)
    expect(h).toContain('data-pc-figures="2"')
    expect(h).toContain('Figure 1 of 2')
    expect(h.match(/data-pc-figure="/g)).toHaveLength(1)   // one at a time
    expect(h).toContain('Panel A.\nSecond line, verbatim.')
    expect(h).toContain(FIGURE_COPY.unavailable)   // no client here to read it
    expect(h).toContain(SHA.slice(0, 12))
    expect(h).not.toContain('<img')
  })
  it('the report leads with status, finding, limits and source; figures next; the details under a disclosure', () => {
    const h = html(served({ runs: [], reports: [reportOf(withFigures([fig()]))], notes: [] }), 'ev_f')
    const at = (m: string) => h.indexOf(m)
    expect(h).toMatch(/data-pc-status-words="true"[^>]*>Reported<\/span>/)   // r1.6.1: no declared kind, so just "Reported"
    expect(h).toContain(`${PC_COPY.verdict}: unassessed`)
    expect(at('data-pc-lead')).toBeGreaterThan(-1)
    expect(at('data-pc-lead')).toBeLessThan(at('data-pc-figures'))
    expect(at('data-pc-figures')).toBeLessThan(at('data-pc-more'))
    expect(at('data-pc-claim')).toBeLessThan(at('data-pc-figures'))
    expect(at('data-pc-method')).toBeGreaterThan(at('data-pc-more'))
    expect(h).toMatch(/<details data-pc-more[^>]*>/)
    expect(h).not.toMatch(/<details data-pc-more[^>]*\bopen/)
    expect(h).toMatch(/<div data-pc-lead="true" class="[^"]*max-w-\[72ch\]/)   // the lead itself is a readable measure
    expect(h).toContain('line-clamp-4')   // the claim starts short; the whole text is still in the page
    expect(h).toContain(PC_COPY.fullClaim)
  })
  it('the sim fixture: R7 carries two invented figures; the served one is a valid PNG with the recorded sha256', async () => {
    const r7f = bands().reports.find((r) => shortName(r) === 'R7')!.figures
    expect(r7f.map((f) => f.sha256)).toEqual([SIM_FIGURE_SHA, SIM_MISSING_FIGURE_SHA])
    expect(r7f.every((f) => f.caption.startsWith('Sim fixture:'))).toBe(true)
    const bytes = simFigureBytes(r7f[0].readUrl!)!
    expect(await sha256Bytes(bytes)).toBe(SIM_FIGURE_SHA)
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    for (let i = 8; i < bytes.length; ) {   // every chunk's CRC checks out
      const n = new DataView(bytes.buffer, bytes.byteOffset + i).getUint32(0)
      const crc = new DataView(bytes.buffer, bytes.byteOffset + i + 8 + n).getUint32(0)
      expect(crc32(bytes.subarray(i + 4, i + 8 + n))).toBe(crc)
      i += 12 + n
    }
    expect(simFigureBytes(r7f[1].readUrl!)).toBeNull()
    expect(bands().reports.filter((r) => shortName(r) !== 'R7').every((r) => r.figures.length === 0)).toBe(true)
  })
})

describe('r1.6.1: "local developmental analysis" only when the report declares it', () => {
  const one = (meta: Record<string, unknown>) => html(served({ runs: [], reports: [reportOf(contribution('ev_k', { title: 'K', claim: 'A local developmental check.', state: 'recorded-claim', adoption_authorized: false, evidence: [], ...meta }))], notes: [] }), 'ev_k')
  const words = (h: string) => /data-pc-status-words="true"[^>]*>([^<]*)<\/span>/.exec(h)?.[1]
  it('declared analysis_kind "local-developmental": the label shows; the verdict stays unassessed', () => {
    const h = one({ analysis_kind: 'local-developmental' })
    expect(words(h)).toBe('Reported · local developmental analysis')
    expect(h).toContain(`${PC_COPY.verdict}: unassessed`)
  })
  it('nothing declared: just "Reported", even when the claim, title or submitter mention local or developmental work', () => {
    for (const meta of [{}, { title: 'Local developmental v2' }, { claim: 'local developmental analysis, one seed' }, { submitter: 'local-developmental' }, { analysis_kind: 'remote-benchmark' }, { analysis_kind: 7 }]) {
      const h = one(meta)
      expect(words(h)).toBe('Reported')
      expect(h).toContain(`${PC_COPY.verdict}: unassessed`)
    }
    expect(statusWords({ analysisKind: null })).toBe('Reported')
    expect(reportOf(contribution('x', { analysis_kind: 'local-developmental' })).analysisKind).toBe('local-developmental')
  })
  it('the fixtures declare no kind (the host refuses unknown fields today), so they read "Reported"', () => {
    expect(bands().reports.every((r) => r.analysisKind === null && statusWords(r) === 'Reported')).toBe(true)
  })
})

describe('r1.6: empty states name the state; the phone help does not cover content', () => {
  it('no reports and no runs are two different sentences', () => {
    expect(PC_COPY.reportsNone).toBe('No research reports have been contributed here yet.')
    expect(PC_COPY.runsNone).toBe('No host runs yet.')
    const h = html(served({ runs: [], reports: [], notes: [] }))
    expect(h).toContain(PC_COPY.reportsNone)
    expect(h).toContain(PC_COPY.runsNone)
    for (const other of [html({ kind: 'loading' }), html({ kind: 'failed', why: 'x' }), html({ kind: 'not-served', why: 'y' })]) {
      expect(other).not.toContain(PC_COPY.reportsNone)
      expect(other).not.toContain(PC_COPY.runsNone)
    }
  })
  it('below 640 px the first-visit hint is never a floating card (the compact trigger keeps its dot)', () => {
    expect(viewInfoSrc).toContain('export const HINT_MIN_WIDTH = 640')
    expect(viewInfoSrc).toContain('if (!el || window.innerWidth < HINT_MIN_WIDTH) return null')
  })
  it('the Lab help explains the research reports', () => {
    expect(VIEW_HELP.lab.body).toContain('Research reports (Evolve)')
    expect(VIEW_HELP.lab.body).toContain('not runs')
  })
  it('"Source last confirmed …" follows the locale', () => {
    const at = new Date(2026, 9, 12, 9, 5, 0).getTime()
    const later = new Date(2026, 9, 14, 9, 0, 0).getTime()
    expect(confirmedWords(at, later, 'en-GB')).toBe('12 Oct, 09:05')
    expect(confirmedWords(at, later, 'en-US')).toMatch(/^Oct 12, 09:05\sAM$/)
    expect(confirmedWords(at, at, 'en-GB')).toBe('09:05')
  })
})

describe('rule 9: read-only', () => {
  it('the band never acts, confirms or publishes', () => {
    expect(pcFamilySrc).not.toMatch(/programAct|confirmAct|runConfirmed|publish\w*\(|contribute\(|assess\w*\(/)
    const h = html(served(), r10().id)
    expect(h).not.toMatch(/>(Contribute|Assess|Publish|Offer research|Adopt)</)
  })
})
