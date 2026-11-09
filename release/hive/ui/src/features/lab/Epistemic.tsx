import { plural } from '../../lib/plural'
import type { LabCase } from '../../api/types'
import { freqColor } from '../../lib/color'
import { cx } from '../../lib/cx'
import { SeriesChart } from './charts'
import { BETTER_ARROW, BETTER_TEXT, caseKey, findMetric, fmtValue, labText, parseVerdicts, SLOTS } from './labUtil'
import { Card, StatusIcon } from './parts'
import { EPISTEMIC_METRICS as METRICS, epistemicVerdict } from './epistemicCompare'

const OURS = 'omegadots-commons'
const BACKENDS = [OURS, 'mock-provenance', 'mock-perfect-resolve', 'mock-bypass']
const BLURB: Record<string, string> = {
  [OURS]: 'our swarm commons',
  'mock-provenance': 'tracks provenance (the paper’s reference)',
  'mock-perfect-resolve': 'an oracle: the ceiling',
  'mock-bypass': 'believes the latest thing it heard',
}

/** accept = the claim holds (cool pole), reject = it does not (warm pole), anything else is undecided (neutral). */
const verdictColor = (v: string) => (v === 'accept' ? freqColor(1) : v === 'reject' ? freqColor(0) : freqColor(0.5))

export function EpistemicBoard({ cases }: { cases: LabCase[] }) {
  const suite = BACKENDS.map((b) => cases.find((c) => caseKey(c) === b)).filter((c): c is LabCase => !!c)
  const scenarios = cases.filter((c) => c.group === 'epistemic scenarios')
  if (!suite.length && !scenarios.length) return null
  return (
    <div className="space-y-3">
      {suite.length > 0 && <Comparison suite={suite} />}
      {scenarios.length > 0 && (
        <Card title="Verdicts step by step" subtitle="What the commons concluded at each step of each scenario, against what the benchmark wanted. Rings mark a mismatch.">
          <div className="space-y-3">
            {scenarios.map((c) => (
              <Scenario key={c.id} c={c} />
            ))}
          </div>
          <Legend />
        </Card>
      )}
    </div>
  )
}

function Comparison({ suite }: { suite: LabCase[] }) {
  const ours = suite.find((c) => caseKey(c) === OURS)
  const ref = suite.find((c) => caseKey(c) === 'mock-provenance')
  // lab-compare r1.1: only evaluated metrics are judged; unknown and not-comparable ones are named (epistemicCompare.ts)
  const verdict = epistemicVerdict(ours, ref)
  return (
    <Card
      title="Epistemic Resolve: suite score"
      subtitle={
        <>
          Crawford &amp; Hammer, AGI-26. Our commons next to the harness’s calibration mocks, which reproduce Table 1 of the paper. <span className="text-ink-2">{verdict}</span>
        </>
      }
      tone={ours?.status === 'failed' ? '#fb7185' : undefined}
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {METRICS.map((m) => {
          const rows = suite.map((c) => ({ c, b: caseKey(c), v: findMetric(c, m.name) }))
          const max = Math.max(1, ...rows.map((r) => r.v?.value ?? 0))
          return (
            <figure key={m.name} className="rounded-xl border border-line bg-shade/20 p-3">
              <figcaption className="mb-2 flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold text-ink">{m.short}</span>
                <span className="text-[11px] text-ink-3">
                  <span className="font-mono">{BETTER_ARROW[m.better]}</span> {BETTER_TEXT[m.better]}
                </span>
              </figcaption>
              <ul className="space-y-2">
                {rows.map(({ c, b, v }) => {
                  const mine = b === OURS
                  const val = v?.value
                  return (
                    <li key={c.id}>
                      <div className="flex items-baseline gap-2 text-[11.5px]">
                        <span className={cx('min-w-0 flex-1 truncate', mine ? 'font-semibold text-ink' : 'text-ink-3')} title={BLURB[b]}>
                          {mine ? 'OmegaHive commons' : b}
                        </span>
                        <span className={cx('tabular-nums', mine ? 'font-semibold text-ink' : 'text-ink-2')}>{val == null ? '–' : fmtValue(val, m.name === 'correction latency' ? 'steps' : '')}</span>
                      </div>
                      <div className="relative mt-1 h-2 rounded-full bg-tint/[0.05]">
                        {val != null && (
                          <div
                            className="absolute inset-y-0 left-0 rounded-full"
                            style={{ width: `${Math.max(val > 0 ? 1.5 : 0, (val / max) * 100)}%`, background: mine ? SLOTS[0] : '#5f5e7c' }}
                          />
                        )}
                        {mine && v?.target != null && (
                          <span className="absolute -inset-y-1 w-0.5 rounded-full bg-ink/70" style={{ left: `${(v.target / max) * 100}%` }} title={`target ${fmtValue(v.target)}`} />
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </figure>
          )
        })}
      </div>
      <p className="mt-2 text-[11.5px] text-ink-4">The white tick on our bar is its target: the mock-provenance value. Correction latency is in steps.</p>
    </Card>
  )
}

function Scenario({ c }: { c: LabCase }) {
  const steps = parseVerdicts(c.notes)
  const [family, ...rest] = c.name.split(':')
  const claim = rest.join(':').trim() || c.name
  const matched = steps?.filter((s) => s.ok).length ?? 0
  const freq = c.series[0]
  return (
    <article className="rounded-xl border border-line bg-shade/20 p-3">
      <header className="flex items-start gap-2.5">
        <StatusIcon status={c.status} size={20} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="rounded-md border border-line-2 bg-tint/[0.04] px-1.5 py-px text-[10.5px] font-semibold tracking-wide text-ink-2 uppercase">{family}</span>
            <span className="text-[13px] text-ink">{claim}</span>
          </div>
          {steps && (
            <p className="mt-0.5 text-[12px] text-ink-3">
              Matched the wanted verdict at {matched} of {plural(steps.length, 'step')} and ended {steps[steps.length - 1].ok ? 'right' : 'wrong'}.
            </p>
          )}
        </div>
        <dl className="hidden shrink-0 gap-3 text-right text-[11px] sm:flex">
          {['retention', 'corruption', 'recovery'].map((n) => {
            const m = findMetric(c, n)
            return (
              <div key={n}>
                <dt className="text-ink-4">{n}</dt>
                <dd className="font-semibold text-ink-2 tabular-nums">{m ? fmtValue(m.value) : '–'}</dd>
              </div>
            )
          })}
        </dl>
      </header>
      <div className="mt-2.5 grid items-center gap-x-3 md:grid-cols-[minmax(0,1fr)_240px]">
        {steps ? (
          <div className="thin-scroll overflow-x-auto">
            <table className="border-separate border-spacing-x-1 border-spacing-y-1 text-[11.5px]">
              <thead>
                <tr>
                  <th className="pr-1 text-left font-normal text-ink-4" />
                  {steps.map((_, i) => (
                    <th key={i} className="font-mono font-normal text-ink-4">
                      t{i}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(['actual', 'want'] as const).map((row) => (
                  <tr key={row}>
                    <th scope="row" className="pr-1 text-left font-normal whitespace-nowrap text-ink-3">
                      {row === 'actual' ? 'commons' : 'wanted'}
                    </th>
                    {steps.map((s, i) => (
                      <td key={i}>
                        <VerdictChip v={s[row]} miss={row === 'actual' && !s.ok} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[12px] text-ink-3">{labText(c.notes)}</p>
        )}
        {freq && (
          <div className="mt-2 md:mt-0">
            <SeriesChart series={[{ ...freq, name: 'commons frequency' }]} height={96} yDomain={[0, 1]} label={`${labText(c.name)}: commons frequency per step, 1 means the claim is true`} />
          </div>
        )}
      </div>
    </article>
  )
}

function VerdictChip({ v, miss }: { v: string; miss: boolean }) {
  const color = verdictColor(v)
  const undecided = v !== 'accept' && v !== 'reject'
  return (
    <span
      className={cx('inline-flex min-w-[78px] items-center justify-center gap-1 rounded-md border px-1.5 py-0.5 font-medium whitespace-nowrap', miss && 'ring-2 ring-warn/70')}
      style={{ color, borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, borderStyle: undecided ? 'dashed' : 'solid', background: `color-mix(in srgb, ${color} 12%, transparent)` }}
      title={miss ? `${v}: not what the benchmark wanted` : v}
    >
      {v}
      {miss && <span className="text-warn" aria-label="mismatch">≠</span>}
    </span>
  )
}

function Legend() {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-3" aria-label="Verdict legend">
      <li className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px]" style={{ background: verdictColor('accept') }} /> accept: the claim holds
      </li>
      <li className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px]" style={{ background: verdictColor('reject') }} /> reject: it does not
      </li>
      <li className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px] border border-dashed" style={{ borderColor: verdictColor('quarantine') }} /> quarantine: not enough trusted evidence yet
      </li>
      <li className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px] ring-2 ring-warn/70" /> mismatch
      </li>
    </ul>
  )
}
