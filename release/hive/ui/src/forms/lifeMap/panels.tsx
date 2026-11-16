import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { WorkItem } from '../../api/types'
import { ask, PROMPTS, type Answer, type Prompt } from './ask'
import { evidenceOf, fmtDate, greeting, KIND_WORD, monthLabel, readingOf, restingName, silentSpans, strata, TERRITORIES, TERRITORY, type TerritoryId } from './model'
import { AtlasMark, RequestList, RevealControl, Sealed, UncertaintyChip } from './parts'
import { SAMPLE_SUBJECT } from './sample'
import type { Atlas } from './useAtlas'
import { VIEW_NAMES, VIEWS } from './types'
import { useModalContainment } from '../../ui/useModalContainment'

/* ================================================================ icons (legacy set: 20px grid, 1.5 strokes) */

const ICON: Record<string, ReactNode> = {
  today: <path d="M3 9.5 10 3.5l7 6V17h-4.5v-4.5h-5V17H3z" />,
  map: (
    <>
      <path d="M10 2.5l6.5 3.75v7.5L10 17.5l-6.5-3.75v-7.5z" />
      <circle cx="10" cy="10" r="2.2" fill="currentColor" stroke="none" />
    </>
  ),
  timeline: (
    <>
      <path d="M2.5 10h15" />
      <circle cx="5" cy="10" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="10" cy="10" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="15" cy="10" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
  plan: <path d="M4 10.5l4 4 8-9" />,
  ask: (
    <>
      <path d="M4 4h12v9H9.5L5.5 16v-3H4z" />
      <path d="M8.3 7.4a1.7 1.7 0 1 1 2.4 1.6c-.5.2-.7.6-.7 1.1" />
    </>
  ),
  ledger: <path d="M3 6h14M3 10h14M3 14h14" />,
  plus: <path d="M10 4v12M4 10h12" />,
}
export const Icon = ({ name, size = 20 }: { name: keyof typeof ICON | string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {ICON[name]}
  </svg>
)

/* ================================================================ header, banner, view bar */

export function Header({ atlas, children }: { atlas: Atlas; children?: ReactNode }) {
  return (
    <header className="lm-header">
      <div className="lm-brand">
        <AtlasMark size={26} />
        <span className="lm-brand-name">Atlas</span>
        {atlas.mode === 'sample' && <span className="lm-sample-chip" title="Every record here is invented">SAMPLE</span>}
      </div>
      <div className="lm-header-tools">
        {children}
        {atlas.mode !== 'empty' && <RevealControl reveal={atlas.revealer} sample={atlas.mode === 'sample'} />}
        {atlas.mode !== 'empty' && (
          <>
            <button type="button" className="lm-btn lm-btn-icon" onClick={() => atlas.setPanel('ledger')} aria-label="Ledger" title="Ledger">
              <Icon name="ledger" />
            </button>
            <button type="button" className="lm-btn lm-btn-ask" onClick={() => atlas.setPanel('ask')}>
              <Icon name="ask" size={18} />
              <span>Ask Atlas</span>
            </button>
          </>
        )}
      </div>
    </header>
  )
}

/** Persistent while the sample is open: the data is invented, and real actions are simulated. */
export function SampleBanner({ atlas }: { atlas: Atlas }) {
  if (atlas.mode !== 'sample') return null
  return (
    <div className="lm-banner" role="note">
      <b>SAMPLE</b>
      <span className="lm-banner-long">{SAMPLE_SUBJECT} is fictional. Every record is invented; actions are simulated and nothing leaves this page.</span>
      <span className="lm-banner-short">Fictional records. Actions are simulated.</span>
      <button type="button" className="lm-btn lm-btn-sm" onClick={atlas.leaveSample}>
        {atlas.canLeaveSample ? 'Back to my Atlas' : 'Leave sample'}
      </button>
    </div>
  )
}

export function ViewBar({ atlas }: { atlas: Atlas }) {
  return (
    <nav className="lm-viewbar" aria-label="Atlas views">
      {VIEWS.map((v) => (
        <button key={v} type="button" aria-current={atlas.view === v ? 'page' : undefined} data-on={atlas.view === v ? 'y' : undefined} onClick={() => atlas.setView(v)}>
          <Icon name={v === 'plan' ? 'plan' : v} />
          <span>{VIEW_NAMES[v]}</span>
        </button>
      ))}
    </nav>
  )
}

export const DISCLAIMER = 'Not medical advice. Do not change medication on your own. Discuss what you see here with your clinician.'

/* ================================================================ empty: the Atlas other people see */

export function EmptyState({ atlas, paper }: { atlas: Atlas; paper?: boolean }) {
  const notOwner = atlas.reason === 'not-owner'
  return (
    <section className={`lm-empty ${paper ? 'lm-empty-paper' : ''}`} aria-labelledby="lm-empty-h">
      <div className="lm-empty-inner">
        <AtlasMark size={44} />
        <p className="lm-eyebrow">{notOwner ? 'A private Atlas' : 'Atlas'}</p>
        <h1 id="lm-empty-h" className="lm-display">
          {notOwner ? 'This Atlas belongs to someone else.' : 'A living map of one body, kept by its owner.'}
        </h1>
        <p className="lm-lead">
          {notOwner
            ? 'Its records are only ever drawn for the person they describe. Nothing of theirs is shown here, not even a count.'
            : 'Atlas gathers your own records (lab results, sleep, mood, the places you travel) into a luminous map of your body. It keeps ideas about what is going on apart from the evidence for them, and it never pretends to be sure.'}
        </p>
        {!notOwner && (
          <ol className="lm-steps">
            <li>
              <b>Keep it local.</b> Atlas runs on your own device; its ledger never leaves it.
            </li>
            <li>
              <b>Record a few things.</b> A lab report, a week of sleep, a line about your mornings.
            </li>
            <li>
              <b>Open it here.</b> The map lights up territory by territory, values sealed until you ask.
            </li>
          </ol>
        )}
        <div className="lm-actions lm-empty-actions">
          <button type="button" className="lm-btn lm-btn-primary" onClick={atlas.enterSample}>
            Explore a sample
          </button>
        </div>
        <p className="lm-note">The sample is {SAMPLE_SUBJECT}, a fictional person. Every record in it is invented.</p>
      </div>
    </section>
  )
}

/* ================================================================ Today */

function Insight({ tone, title, children, onOpen }: { tone: string; title: string; children: ReactNode; onOpen?: () => void }) {
  const Tag = onOpen ? 'button' : 'div'
  return (
    <Tag type={onOpen ? 'button' : undefined} className="lm-insight" data-tone={tone} onClick={onOpen}>
      <i aria-hidden="true" />
      <span className="lm-insight-txt">
        <b>{title}</b>
        <span>{children}</span>
      </span>
      {onOpen && (
        <svg className="lm-chev" width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M8 4l6 6-6 6" />
        </svg>
      )}
    </Tag>
  )
}


export function TodayPanel({ atlas, openMap }: { atlas: Atlas; openMap: (id?: string, t?: TerritoryId) => void }) {
  const s = atlas.summary
  const strongest = useMemo(
    () => s.openHypotheses.map((h) => ({ h, ev: evidenceOf(atlas.ix, h.id) })).sort((a, b) => b.ev.support.length - a.ev.support.length || a.h.id.localeCompare(b.h.id))[0],
    [s, atlas.ix],
  )
  const next = s.activeExperiments.find((e) => /active/.test(String(e.meta?.domain_status))) ?? s.activeExperiments[0]
  const spans = silentSpans(atlas.gaps.silentMonths)
  const name = atlas.mode === 'sample' ? `, ${SAMPLE_SUBJECT}` : ''
  return (
    <div className="lm-today">
      <h1 className="lm-display">
        {greeting()}
        {name}.
      </h1>
      <p className="lm-lead">{s.latestAt ? `The latest record is from ${fmtDate(s.latestAt)}.` : 'Your map is waiting for its first record.'}</p>
      <p className="lm-privacy">{atlas.mode === 'sample' ? 'Invented records, sealed like real ones so you can feel how it works.' : 'Values are sealed until you reveal them, and re-seal when you go quiet.'}</p>
      {s.question && (
        <div className="lm-question">
          <span className="lm-eyebrow">The question</span>
          <p>{s.question.label}</p>
        </div>
      )}
      {s.recent.length > 0 && (
        <div className="lm-card">
          <div className="lm-cardhead">
            <b>New values</b>
            <span>three weeks to {fmtDate(s.latestAt)}</span>
          </div>
          <ul className="lm-values">
            {s.recent.slice(0, 4).map((o) => (
              <ValueRow key={o.id} atlas={atlas} item={o} onOpen={() => openMap(o.id)} />
            ))}
          </ul>
        </div>
      )}
      {strongest && (
        <Insight tone="hypothesis" title="Most supported idea" onOpen={() => openMap(strongest.h.id)}>
          {strongest.h.label} · {strongest.ev.support.length} lean toward, {strongest.ev.oppose.length} against
        </Insight>
      )}
      {next && (
        <Insight tone="experiment" title={`Experiment ${String(next.meta?.domain_status ?? 'planned')}`} onOpen={() => openMap(next.id)}>
          {next.label}
        </Insight>
      )}
      {s.corrections.length > 0 && (
        <Insight tone="qualify" title="Corrections on record" onOpen={() => openMap(s.corrections[0].id)}>
          {s.corrections.length} record{s.corrections.length === 1 ? ' was' : 's were'} corrected or superseded; what rested on them is marked.
        </Insight>
      )}
      {spans.length > 0 && (
        <Insight tone="gap" title="Silence in the record">
          Nothing recorded {spans.map((x) => x.label).join('; ')}. A silent month is not a good month.
        </Insight>
      )}
      <p className="lm-disclaimer-inline">{DISCLAIMER}</p>
      <div className="lm-territories" aria-label="Territories">
        {s.perTerritory.map((t) => (
          <button key={t.territory} type="button" className="lm-terr" style={{ ['--tc' as string]: TERRITORY[t.territory].color }} onClick={() => openMap(undefined, t.territory)}>
            <i aria-hidden="true" />
            <b>{TERRITORY[t.territory].label}</b>
            <span>
              {t.observations} obs · {t.hypotheses} idea{t.hypotheses === 1 ? '' : 's'}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function ValueRow({ atlas, item, onOpen }: { atlas: Atlas; item: WorkItem; onOpen?: () => void }) {
  const t = TERRITORY[atlas.place.get(item.id)?.territory ?? 'context']
  return (
    <li className="lm-valuerow" style={{ ['--tc' as string]: t.color }}>
      <i aria-hidden="true" />
      <button type="button" className="lm-link lm-valuerow-name" onClick={onOpen}>
        {restingName(item)}
      </button>
      <span className="lm-valuerow-date">{fmtDate(item.at)}</span>
      <Sealed id={item.id} reading={readingOf(item)} reveal={atlas.revealer} size="sm" />
    </li>
  )
}

/* ================================================================ Timeline */

export function TimelinePanel({ atlas, openMap }: { atlas: Atlas; openMap: (id?: string) => void }) {
  const layers = useMemo(() => strata(atlas.ix, atlas.place), [atlas.ix, atlas.place])
  const [more, setMore] = useState(false)
  const months = useMemo(() => [...layers].reverse().map((l) => l.month), [layers])
  const silent = new Set(atlas.gaps.silentMonths)
  const all = useMemo(() => {
    if (!months.length) return []
    const out: string[] = []
    let [y, m] = months[0].split('-').map(Number)
    const last = months[months.length - 1]
    for (;;) {
      const ym = `${y}-${String(m).padStart(2, '0')}`
      out.push(ym)
      if (ym >= last) break
      m++
      if (m > 12) {
        m = 1
        y++
      }
    }
    return out
  }, [months])
  const counts = useMemo(() => {
    const c = new Map<string, Record<TerritoryId, number>>()
    for (const l of layers) {
      const r = Object.fromEntries(TERRITORIES.map((t) => [t.id, 0])) as Record<TerritoryId, number>
      for (const row of l.rows) r[row.territory] = row.items.length
      c.set(l.month, r)
    }
    return c
  }, [layers])
  const idx = atlas.asOf ? Math.max(0, all.indexOf(atlas.asOf.slice(0, 7))) : all.length - 1
  const W = 520
  const rowH = 30
  const H = rowH * 6 + 26
  const x = (i: number) => 76 + ((W - 84) * i) / Math.max(1, all.length - 1)
  return (
    <div className="lm-timeline">
      <h1 className="lm-display">Timeline</h1>
      <p className="lm-lead">Everything recorded, month by month. Drag to see the map as it stood on a date.</p>
      {all.length > 1 && (
        <div className="lm-card lm-tl-card">
          <svg className="lm-tl-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Records per territory per month, ${monthLabel(all[0])} to ${monthLabel(all[all.length - 1])}. Silent months are hatched.`}>
            <defs>
              <pattern id="lm-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" stroke="color-mix(in oklab, var(--color-ink) 14%, transparent)" strokeWidth="2" />
              </pattern>
            </defs>
            {all.map((ym, i) =>
              silent.has(ym) ? <rect key={ym} x={x(i) - (W - 84) / all.length / 2} y={4} width={(W - 84) / all.length} height={rowH * 6} fill="url(#lm-hatch)" /> : null,
            )}
            {TERRITORIES.map((t, r) => {
              const base = 4 + rowH * (r + 0.9)
              const vals = all.map((ym) => counts.get(ym)?.[t.id] ?? 0)
              const peak = Math.max(1, ...vals)
              const pts = vals.map((v, i) => [x(i), base - (v / peak) * rowH * 0.8] as const)
              const d = `M${x(0)} ${base} ` + pts.map(([px, py]) => `L${px.toFixed(1)} ${py.toFixed(1)}`).join(' ') + ` L${x(all.length - 1)} ${base} Z`
              return (
                <g key={t.id}>
                  <text x={6} y={base - 6} className="lm-tl-label">
                    {t.label}
                  </text>
                  <path d={d} fill={t.color} fillOpacity={0.22} stroke={t.color} strokeOpacity={0.9} strokeWidth={1.4} strokeLinejoin="round" />
                </g>
              )
            })}
            {all.map((ym, i) =>
              ym.endsWith('-01') ? (
                <text key={ym} x={x(i)} y={H - 4} className="lm-tl-year" textAnchor="middle">
                  {ym.slice(0, 4)}
                </text>
              ) : null,
            )}
            <rect x={x(idx)} y={2} width={1.6} height={rowH * 6 + 4} fill={atlas.asOf ? '#ffffff' : '#7fd3ff'} />
            {atlas.asOf && <rect x={x(idx) + 2} y={2} width={W - x(idx)} height={rowH * 6 + 4} fill="color-mix(in oklab, var(--color-void) 62%, transparent)" />}
          </svg>
          <label className="lm-scrub">
            <span>Show the map up to</span>
            <input
              type="range"
              min={0}
              max={all.length - 1}
              value={idx}
              onChange={(e) => {
                const i = +e.target.value
                atlas.setAsOf(i >= all.length - 1 ? null : `${all[i]}-31`)
              }}
              aria-valuetext={idx >= all.length - 1 ? 'now' : monthLabel(all[idx])}
            />
            <b>{idx >= all.length - 1 ? 'now' : monthLabel(all[idx])}</b>
          </label>
          {atlas.asOf && <p className="lm-note">Later records are hidden from the map. What Atlas could infer about this time from evidence found later is not shown.</p>}
        </div>
      )}
      {(more ? layers : layers.slice(0, 6)).map((l) => (
        <section key={l.month} className="lm-month">
          <h2>{l.label}</h2>
          {l.rows.map((r) => (
            <ul key={r.territory} className="lm-values">
              {r.items.slice(0, 6).map((it) => (it.kind === 'observation' ? <ValueRow key={it.id} atlas={atlas} item={it} onOpen={() => openMap(it.id)} /> : <EventRow key={it.id} atlas={atlas} item={it} />))}
              {r.items.length > 6 && <li className="lm-note">and {r.items.length - 6} more in {TERRITORY[r.territory].label}</li>}
            </ul>
          ))}
        </section>
      ))}
      {layers.length > 6 && !more && (
        <button type="button" className="lm-btn" onClick={() => setMore(true)}>
          Show {layers.length - 6} earlier months
        </button>
      )}
    </div>
  )
}

function EventRow({ atlas, item }: { atlas: Atlas; item: WorkItem }) {
  return (
    <li className="lm-valuerow lm-eventrow" data-status={item.status ?? 'current'}>
      <i aria-hidden="true" />
      <button type="button" className="lm-link lm-valuerow-name" onClick={() => atlas.select(item.id)}>
        {item.label}
      </button>
      <span className="lm-valuerow-date">{item.status && item.status !== 'current' ? item.status : 'event'}</span>
    </li>
  )
}

/* ================================================================ Plan */

export function PlanPanel({ atlas, openMap }: { atlas: Atlas; openMap: (id?: string) => void }) {
  const s = atlas.summary
  const exps = atlas.graph.items.filter((i) => i.kind === 'experiment')
  const groups: [string, WorkItem[]][] = [
    ['Active', exps.filter((e) => /active|running/.test(String(e.meta?.domain_status)))],
    ['Planned', exps.filter((e) => /planned/.test(String(e.meta?.domain_status ?? 'planned')))],
    ['Done', exps.filter((e) => /completed|abandoned|closed/.test(String(e.meta?.domain_status)))],
  ]
  const [tab, setTab] = useState(groups[0][1].length ? 0 : 1)
  return (
    <div className="lm-plan">
      <h1 className="lm-display">Plan</h1>
      <p className="lm-lead">Open ideas, the experiments that test them, and what is predicted. Ideas are not findings.</p>
      <h2 className="lm-eyebrow">Open ideas</h2>
      {s.openHypotheses.map((h) => {
        const ev = evidenceOf(atlas.ix, h.id)
        const t = TERRITORY[atlas.place.get(h.id)?.territory ?? 'context']
        return (
          <button key={h.id} type="button" className="lm-listrow" style={{ ['--tc' as string]: t.color }} onClick={() => openMap(h.id)}>
            <i aria-hidden="true" />
            <span className="lm-listrow-txt">
              <b>{h.label}</b>
              <span>
                {t.label} · {ev.support.length} toward · {ev.oppose.length} against · {ev.qualify.length} qualifying
                {(h.flags ?? []).includes('affected-by-correction') ? ' · rests on a corrected record' : ''}
              </span>
            </span>
            <UncertaintyChip item={h} />
          </button>
        )
      })}
      <h2 className="lm-eyebrow">Experiments</h2>
      <div className="lm-tabs" role="tablist" aria-label="Experiments">
        {groups.map(([n, l], i) => (
          <button key={n} type="button" role="tab" aria-selected={tab === i} data-on={tab === i ? 'y' : undefined} onClick={() => setTab(i)}>
            {n} ({l.length})
          </button>
        ))}
      </div>
      {groups[tab][1].length === 0 && <p className="lm-note">None.</p>}
      {groups[tab][1].map((e, i) => (
        <button key={e.id} type="button" className="lm-listrow" onClick={() => openMap(e.id)}>
          <span className="lm-num">{i + 1}</span>
          <span className="lm-listrow-txt">
            <b>{e.label}</b>
            <span>
              {String(e.meta?.domain_status ?? 'planned')}
              {e.meta?.started ? ` · from ${fmtDate(String(e.meta.started))}` : ''}
            </span>
          </span>
        </button>
      ))}
      <h2 className="lm-eyebrow">Predictions</h2>
      {s.duePredictions.map((p) => (
        <button key={p.id} type="button" className="lm-listrow" onClick={() => openMap(p.id)}>
          <span className="lm-listrow-txt">
            <b>{p.label}</b>
            <span>
              {p.meta?.due ? `due ${fmtDate(String(p.meta.due))}` : 'no date'} · {String(p.meta?.domain_status ?? 'open')}
            </span>
          </span>
          <UncertaintyChip item={p} />
        </button>
      ))}
      {atlas.requests.length > 0 && (
        <>
          <h2 className="lm-eyebrow">Scientist requests</h2>
          <RequestList atlas={atlas} />
        </>
      )}
    </div>
  )
}

/* ================================================================ modals: Ask, Ledger, Capture */

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  useModalContainment(box)
  return (
    <div className="lm-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div ref={box} className="lm-modal" data-wide={wide ? 'y' : undefined} role="dialog" aria-modal="true" aria-label={title}>
        <button type="button" className="lm-close" onClick={onClose} aria-label="Close" autoFocus>
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M5 5l10 10M15 5 5 15" />
          </svg>
        </button>
        {children}
      </div>
    </div>
  )
}

export function AskModal({ atlas, openMap }: { atlas: Atlas; openMap: (id?: string) => void }) {
  const [answer, setAnswer] = useState<{ p: Prompt; a: Answer } | null>(null)
  return (
    <Modal title="Ask Atlas" onClose={() => atlas.setPanel(null)}>
      <div className="lm-askmark">
        <AtlasMark size={64} />
      </div>
      <h2 className="lm-modal-h lm-center">Ask Atlas</h2>
      <p className="lm-note lm-center">Quick questions, answered from your map on this device. Not medical advice.</p>
      <div className="lm-prompts">
        {PROMPTS.map((p) => (
          <button key={p.id} type="button" className="lm-prompt" data-on={answer?.p === p.id ? 'y' : undefined} onClick={() => setAnswer({ p: p.id, a: ask(atlas.ix, atlas.place, p.id) })}>
            {p.text}
          </button>
        ))}
      </div>
      {answer && (
        <div className="lm-answer" role="status">
          <p>{answer.a.lead}</p>
          <ul>
            {answer.a.lines.map((l, i) => (
              <li key={i}>
                {l.item ? (
                  <button
                    type="button"
                    className="lm-link"
                    onClick={() => {
                      atlas.setPanel(null)
                      openMap(l.item)
                    }}
                  >
                    {l.text}
                  </button>
                ) : (
                  l.text
                )}
              </li>
            ))}
          </ul>
          <p className="lm-note">{answer.a.caveat}</p>
        </div>
      )}
    </Modal>
  )
}

export function LedgerModal({ atlas }: { atlas: Atlas }) {
  const events = useMemo(() => atlas.graph.items.filter((i) => i.kind === 'event').sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')), [atlas.graph])
  const [n, setN] = useState(40)
  return (
    <Modal title="Ledger" onClose={() => atlas.setPanel(null)} wide>
      <h2 className="lm-modal-h">Ledger</h2>
      <p className="lm-note">
        Every recorded event, newest first. Nothing is ever edited in place: a correction is a new event that points at the old one. {events.length} events.
      </p>
      <ol className="lm-ledger">
        {events.slice(0, n).map((e) => (
          <li key={e.id} data-status={e.status ?? 'current'}>
            <span className="lm-ledger-date">{fmtDate(e.at)}</span>
            <button
              type="button"
              className="lm-link"
              onClick={() => {
                atlas.setPanel(null)
                atlas.select(e.id)
              }}
            >
              {e.label}
            </button>
            <span className="lm-chain-meta">
              {String(e.meta?.source ?? '')}
              {e.status && e.status !== 'current' ? ` · ${e.status}` : ''}
            </span>
          </li>
        ))}
      </ol>
      {events.length > n && (
        <button type="button" className="lm-btn" onClick={() => setN((x) => x + 60)}>
          Show older
        </button>
      )}
    </Modal>
  )
}

const CAPTURE = ['Anything', 'Symptom', 'Lab result', 'Morning', 'Wonder'] as const

export function CaptureModal({ atlas }: { atlas: Atlas }) {
  const [kind, setKind] = useState<(typeof CAPTURE)[number]>('Anything')
  const [text, setText] = useState('')
  const sample = atlas.mode === 'sample'
  return (
    <Modal title="Add to your record" onClose={() => atlas.setPanel(null)}>
      <h2 className="lm-modal-h">Add to your record</h2>
      <div className="lm-tabs" role="tablist" aria-label="What to add">
        {CAPTURE.map((c) => (
          <button key={c} type="button" role="tab" aria-selected={kind === c} data-on={kind === c ? 'y' : undefined} onClick={() => setKind(c)}>
            {c}
          </button>
        ))}
      </div>
      <label className="lm-fields">
        <span>{kind === 'Wonder' ? 'What are you wondering?' : kind === 'Morning' ? 'One line about the morning' : 'What happened'}</span>
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} disabled={!sample} />
      </label>
      <p className="lm-note">
        {sample
          ? 'SAMPLE: this is a rehearsal. Nothing is saved.'
          : 'Capture writes to the ledger on your own device, so it happens in Atlas itself. This view reads the ledger and never writes to it.'}
      </p>
      <div className="lm-actions">
        <button
          type="button"
          className="lm-btn lm-btn-primary"
          disabled={!sample || !text.trim()}
          onClick={() => {
            atlas.say('info', `SAMPLE: “${kind}” rehearsed. Nothing was saved.`)
            atlas.setPanel(null)
          }}
        >
          {sample ? 'Rehearse saving' : 'Open Atlas to record'}
        </button>
      </div>
    </Modal>
  )
}

/** Every mark on the map as a plain list: the keyboard and screen-reader route through any grammar. */
export function MarkIndex({ atlas, ids, label }: { atlas: Atlas; ids: string[]; label: string }) {
  return (
    <nav className="lm-index" aria-label={label}>
      <ul>
        {ids.map((id) => {
          const it = atlas.ix.byId.get(id)
          if (!it) return null
          return (
            <li key={id}>
              <button type="button" onClick={() => atlas.select(id)}>
                {KIND_WORD[it.kind] ?? it.kind}: {restingName(it)}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

