import { Fragment, useMemo, type ReactNode } from 'react'
import type { WorkItem } from '../../api/types'
import { BODY_PATH, ORGANS } from './anatomy'
import {
  evidenceOf,
  fmtDate,
  fmtNum,
  KIND_WORD,
  lowerFirst,
  provenanceOf,
  readingOf,
  restingName,
  silentSpans,
  STRUCTURES,
  TERRITORIES,
  uncertaintyText,
  type Territory,
} from './model'
import { AskModal, CaptureModal, DISCLAIMER, EmptyState, LedgerModal, SampleBanner } from './panels'
import { AtlasMark, ConsentDialog, Outcomes, Reading, RequestList, RevealControl, Sealed, ZoomRail } from './parts'
import { SAMPLE_SUBJECT } from './sample'
import type { Atlas } from './useAtlas'
import { READING_NAMES, VIEWS, type Level, type View } from './types'

/** Still: a biography. Calm paper, chapters by territory, values as sentences, ideas as gentle questions. */

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']
const STILL_VIEW: Record<View, string> = { today: 'Preface', map: 'Chapters', timeline: 'Chronology', plan: 'Open questions' }

const plural = (n: number, one: string, many = one + 's') => `${n === 0 ? 'no' : n === 1 ? 'one' : n < 10 ? ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][n - 2] : n} ${n === 1 ? one : many}`
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export default function Still({ atlas }: { atlas: Atlas }) {
  const { mode, view } = atlas
  const name = mode === 'sample' ? SAMPLE_SUBJECT : String(atlas.summary.subject?.meta?.display_name ?? atlas.summary.subject?.label ?? 'You')
  const openItem = (id: string) => atlas.select(id)
  return (
    <div className="lm lm-still lm-paper" data-view={view} data-mode={mode} data-sheet={atlas.selected ? 'y' : undefined}>
      <header className="lm-still-head">
        <div className="lm-brand">
          <AtlasMark size={24} />
          <span className="lm-brand-name">Atlas</span>
          {mode === 'sample' && <span className="lm-sample-chip">SAMPLE</span>}
        </div>
        {mode !== 'empty' && (
          <div className="lm-header-tools">
            <RevealControl reveal={atlas.revealer} sample={mode === 'sample'} />
            <button type="button" className="lm-btn" onClick={() => atlas.setPanel('ledger')}>
              Ledger
            </button>
            <button type="button" className="lm-btn" onClick={() => atlas.setPanel('ask')}>
              Ask Atlas
            </button>
          </div>
        )}
      </header>
      <SampleBanner atlas={atlas} />
      {mode === 'empty' ? (
        <EmptyState atlas={atlas} paper />
      ) : (
        <div className="lm-book">
          <nav className="lm-contents" aria-label="Contents">
            <p className="lm-eyebrow">Contents</p>
            <ul>
              {VIEWS.map((v) => (
                <li key={v}>
                  <button type="button" aria-current={view === v ? 'page' : undefined} onClick={() => atlas.setView(v)}>
                    {STILL_VIEW[v]}
                  </button>
                  {v === 'map' && view === 'map' && (
                    <ul>
                      {TERRITORIES.map((t, i) => (
                        <li key={t.id}>
                          <a href={`#lm-ch-${t.id}`} style={{ ['--t-ink' as string]: t.ink }}>
                            {ROMAN[i]}. {t.label}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            {view === 'map' && (
              <div className="lm-depth">
                <p className="lm-eyebrow">Reading depth</p>
                <ZoomRail level={atlas.level} onLevel={atlas.setLevel} names={READING_NAMES} />
              </div>
            )}
          </nav>
          <main className="lm-page">
            {view === 'today' && <Preface atlas={atlas} name={name} open={openItem} />}
            {view === 'map' && (
              <>
                <h1 className="lm-book-title">
                  {name}
                  <span>a biography of the body, from its own records</span>
                </h1>
                {TERRITORIES.map((t, i) => (
                  <Chapter key={t.id} atlas={atlas} t={t} n={i} level={atlas.level} open={openItem} />
                ))}
              </>
            )}
            {view === 'timeline' && <Chronology atlas={atlas} open={openItem} />}
            {view === 'plan' && <Afterword atlas={atlas} open={openItem} />}
            <p className="lm-colophon">{DISCLAIMER}</p>
          </main>
          {atlas.selected ? (
            <aside className="lm-margin" aria-label="Margin note" key={atlas.selected}>
              <Reading atlas={atlas} id={atlas.selected} onClose={() => atlas.select(null)} />
            </aside>
          ) : (
            <Frontispiece />
          )}
        </div>
      )}
      {atlas.panel === 'ask' && (
        <AskModal
          atlas={atlas}
          openMap={(id) => {
            if (id) atlas.select(id)
          }}
        />
      )}
      {atlas.panel === 'ledger' && <LedgerModal atlas={atlas} />}
      {atlas.panel === 'capture' && <CaptureModal atlas={atlas} />}
      <ConsentDialog atlas={atlas} />
      <Outcomes atlas={atlas} />
    </div>
  )
}

/* ================================================================ a link inside prose */

function Ref({ id, open, children }: { id: string; open: (id: string) => void; children: ReactNode }) {
  return (
    <a
      href={`#${encodeURIComponent(id)}`}
      className="lm-ref"
      onClick={(e) => {
        e.preventDefault()
        open(id)
      }}
    >
      {children}
    </a>
  )
}

/* ================================================================ preface */

function Preface({ atlas, name, open }: { atlas: Atlas; name: string; open: (id: string) => void }) {
  const s = atlas.summary
  const obs = atlas.graph.items.filter((i) => i.kind === 'observation')
  const first = obs.reduce<string | null>((a, o) => (o.at && (!a || o.at < a) ? o.at : a), null)
  const spans = silentSpans(atlas.gaps.silentMonths)
  const corrected = s.corrections.filter((c) => c.status === 'corrected' || c.status === 'superseded')
  return (
    <article className="lm-chapter">
      <p className="lm-eyebrow">Preface</p>
      <h1 className="lm-book-title">
        {name}
        <span>a biography of the body, from its own records</span>
      </h1>
      <p className="lm-dropcap">
        This book is written from {plural(obs.length, 'observation')} recorded between {fmtDate(first)} and {fmtDate(s.latestAt)}. It is not a diagnosis. It keeps what was measured apart from what
        is wondered about, and it says how sure each idea is in that idea’s own terms.
      </p>
      {s.question && (
        <blockquote className="lm-epigraph">
          <p>{s.question.label}</p>
          <cite>the question this Atlas keeps</cite>
        </blockquote>
      )}
      {s.recent.length > 0 && (
        <p>
          Lately, {s.recent.length === 1 ? 'one record arrived' : `${plural(s.recent.length, 'record')} arrived`} in the three weeks to {fmtDate(s.latestAt)}:{' '}
          {s.recent.slice(0, 4).map((o, i, a) => (
            <Fragment key={o.id}>
              <Ref id={o.id} open={open}>
                {lowerFirst(restingName(o))}
              </Ref>
              {i < a.length - 2 ? ', ' : i === a.length - 2 ? ' and ' : '.'}
            </Fragment>
          ))}
        </p>
      )}
      {spans.length > 0 && (
        <p>
          There are silences. Nothing was recorded {spans.map((x) => x.label).join('; ')}. A silent month is not a good month; it is an unknown one.
        </p>
      )}
      {corrected.length > 0 && (
        <p>
          {cap(plural(corrected.length, 'record'))} {corrected.length === 1 ? 'was' : 'were'} later corrected or superseded. They stay in the ledger, struck through, and the ideas that leaned on them say so.
        </p>
      )}
      <p className="lm-note">Values in this book are sealed. Press one, or “Reveal values”, to read it; they seal again when you pause.</p>
    </article>
  )
}

/* ================================================================ a chapter: one territory */

function Chapter({ atlas, t, n, level, open }: { atlas: Atlas; t: Territory; n: number; level: Level; open: (id: string) => void }) {
  const items = useMemo(() => atlas.graph.items.filter((i) => atlas.place.get(i.id)?.territory === t.id), [atlas.graph, atlas.place, t.id])
  const obs = items.filter((i) => i.kind === 'observation' && (!i.status || i.status === 'current'))
  const hyps = items.filter((i) => i.kind === 'hypothesis' && (!i.status || i.status === 'current'))
  const structs = STRUCTURES.filter((s) => s.territory === t.id)
  const dates = obs.map((o) => o.at ?? '').filter(Boolean).sort()
  const notes: { n: number; id: string; text: string }[] = []
  const fn = (id: string, text: string) => {
    const k = notes.length + 1
    notes.push({ n: k, id, text })
    return <sup className="lm-fn">{k}</sup>
  }
  return (
    <section className="lm-chapter" id={`lm-ch-${t.id}`} style={{ ['--t-ink' as string]: t.ink, ['--tc' as string]: t.color }}>
      <header className="lm-chapter-head">
        <span className="lm-roman">{ROMAN[n]}</span>
        <h2>{t.label}</h2>
        <p className="lm-gist">{t.gist}</p>
      </header>
      <Plate t={t} />
      {obs.length === 0 && hyps.length === 0 ? (
        <p>Nothing has been recorded here yet. That is a blank page, not a clean bill.</p>
      ) : (
        <p className="lm-dropcap">
          {cap(plural(obs.length, 'current observation'))} {dates.length ? `from ${fmtDate(dates[0])} to ${fmtDate(dates[dates.length - 1])}` : ''}, across {plural(structs.filter((s) => obs.some((o) => atlas.place.get(o.id)?.structure === s.id)).length, 'structure')}, and{' '}
          {plural(hyps.length, 'open idea')}.
        </p>
      )}
      {level >= 1 &&
        structs.map((s) => {
          const so = obs.filter((o) => atlas.place.get(o.id)?.structure === s.id).sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
          if (!so.length) return null
          const markers = new Map<string, WorkItem[]>()
          for (const o of so) {
            const k = restingName(o)
            if (!markers.has(k)) markers.set(k, [])
            markers.get(k)!.push(o)
          }
          return (
            <div key={s.id} className="lm-structure">
              <h3>{s.label}</h3>
              <p>
                {cap(plural(so.length, 'record'))}, the latest on {fmtDate(so[0].at)}.
              </p>
              {level >= 2 &&
                [...markers.entries()].slice(0, 6).map(([m, list]) => {
                  const latest = list[0]
                  const prov = provenanceOf(atlas.ix, latest.id)
                  return (
                    <p key={m} className="lm-valueline">
                      <Ref id={latest.id} open={open}>
                        {m}
                      </Ref>{' '}
                      was last recorded on {fmtDate(latest.at)}: <Sealed id={latest.id} reading={readingOf(latest)} reveal={atlas.revealer} size="sm" sentence />
                      {list.length > 1 && <> ({plural(list.length - 1, 'earlier reading')})</>}
                      {list.length > 2 && atlas.revealer.shown(latest.id) && <Spark list={list} />}
                      {level >= 3 && prov.extracted[0] && fn(latest.id, `Extracted from ${prov.extracted[0].label}${prov.extracted[0].status !== 'current' ? ` (${prov.extracted[0].status})` : ''}.`)}
                      .
                    </p>
                  )
                })}
            </div>
          )
        })}
      {hyps.map((h) => {
        const ev = evidenceOf(atlas.ix, h.id)
        const u = uncertaintyText(h.uncertainty)
        return (
          <aside key={h.id} className="lm-wonder">
            <p className="lm-wonder-q">
              <Ref id={h.id} open={open}>
                Could it be that {lowerFirst(h.label)}?
              </Ref>
            </p>
            <p>
              {cap(plural(ev.support.length, 'record'))} {ev.support.length === 1 ? 'leans' : 'lean'} toward it; {plural(ev.oppose.length, 'leans', 'lean')} against
              {ev.qualify.length ? `; ${plural(ev.qualify.length, 'qualifies', 'qualify')} it` : ''}. {u.assessed ? u.long : 'It has not been assessed, which is not the same as unlikely.'}
              {(h.flags ?? []).includes('affected-by-correction') && ' One of the records it rests on was later corrected.'}
              {level >= 3 && ev.support.concat(ev.oppose).filter(({ item }) => item.kind === 'literature').length > 0 && fn(h.id, `Literature: ${ev.support.concat(ev.oppose, ev.qualify).filter(({ item }) => item.kind === 'literature').map(({ item }) => item.label).join('; ')}.`)}
            </p>
            <RequestList atlas={atlas} itemId={h.id} />
          </aside>
        )
      })}
      {level >= 3 && notes.length > 0 && (
        <ol className="lm-footnotes">
          {notes.map((x) => (
            <li key={x.n} value={x.n}>
              <button type="button" className="lm-ref" onClick={() => open(x.id)}>
                {x.text}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** The frontispiece: the whole figure in ink, every territory's sites in its own colour. */
function Frontispiece() {
  return (
    <figure className="lm-frontis" aria-hidden="true">
      <svg viewBox="-30 -10 460 920">
        <path d={BODY_PATH} className="lm-ink-body" />
        {ORGANS.map((o) => (
          <path key={o.id} d={o.d} className="lm-ink-organ" fillRule="evenodd" />
        ))}
        {STRUCTURES.map((s) => {
          const t = TERRITORIES.find((x) => x.id === s.territory)!
          return (
            <g key={s.id} transform={`translate(${s.x} ${s.y})`}>
              <circle r={22} fill={t.color} opacity={0.2} />
              <circle r={5} fill={t.ink} />
            </g>
          )
        })}
      </svg>
      <figcaption>
        {TERRITORIES.map((t) => (
          <span key={t.id} style={{ ['--t-ink' as string]: t.ink }}>
            {t.label}
          </span>
        ))}
      </figcaption>
    </figure>
  )
}

/** A small ink plate of the figure with this territory's structures marked. */
function Plate({ t }: { t: Territory }) {
  const ss = STRUCTURES.filter((s) => s.territory === t.id)
  return (
    <figure className="lm-plate-ink" aria-hidden="true">
      <svg viewBox="-20 0 440 900">
        <path d={BODY_PATH} className="lm-ink-body" />
        {ORGANS.map((o) => (
          <path key={o.id} d={o.d} className="lm-ink-organ" fillRule="evenodd" />
        ))}
        {ss.map((s) => (
          <g key={s.id} transform={`translate(${s.x} ${s.y})`}>
            <circle r={30} className="lm-ink-halo" />
            <circle r={7} className="lm-ink-site" />
          </g>
        ))}
      </svg>
      <figcaption>Plate {t.label.toLowerCase()}</figcaption>
    </figure>
  )
}

/** A sparkline in ink. Drawn only once the newest value is revealed: its shape is the history. */
function Spark({ list }: { list: WorkItem[] }) {
  const pts = list
    .slice(0, 24)
    .reverse()
    .map((o) => o.meta?.value)
    .filter((v): v is number => typeof v === 'number')
  if (pts.length < 3) return null
  const lo = Math.min(...pts)
  const hi = Math.max(...pts)
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${((i / (pts.length - 1)) * 64).toFixed(1)} ${(14 - ((v - lo) / (hi - lo || 1)) * 12).toFixed(1)}`).join(' ')
  return (
    <svg className="lm-spark" width="66" height="16" viewBox="-1 0 66 16" role="img" aria-label={`${pts.length} readings from ${fmtNum(pts[0])} to ${fmtNum(pts[pts.length - 1])}`}>
      <path d={d} />
    </svg>
  )
}

/* ================================================================ chronology */

function Chronology({ atlas, open }: { atlas: Atlas; open: (id: string) => void }) {
  const years = useMemo(() => {
    const by = new Map<string, WorkItem[]>()
    for (const it of atlas.graph.items) {
      if (it.kind !== 'event' || !it.at) continue
      const y = it.at.slice(0, 4)
      if (!by.has(y)) by.set(y, [])
      by.get(y)!.push(it)
    }
    return [...by.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([y, l]) => [y, l.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))] as const)
  }, [atlas.graph])
  const silent = silentSpans(atlas.gaps.silentMonths)
  return (
    <article className="lm-chapter">
      <p className="lm-eyebrow">Chronology</p>
      <h1 className="lm-book-title">
        An almanac<span>every recorded event, newest first</span>
      </h1>
      {years.map(([y, list]) => (
        <section key={y} className="lm-year">
          <h2>{y}</h2>
          {silent
            .filter((s) => s.from.startsWith(y))
            .map((s) => (
              <p key={s.from} className="lm-silence">
                {s.label}: nothing recorded.
              </p>
            ))}
          <ul className="lm-almanac">
            {list.map((e) => {
              const extracted = (atlas.ix.into.get(e.id) ?? []).filter((l) => l.rel === 'extracted-from').length
              return (
                <li key={e.id} data-status={e.status ?? 'current'}>
                  <span className="lm-almanac-date">{fmtDate(e.at).replace(/ \d{4}$/, '')}</span>
                  <Ref id={e.id} open={open}>
                    {e.label}
                  </Ref>
                  <span className="lm-chain-meta">
                    {' '}
                    {extracted ? `· ${plural(extracted, 'observation')}` : ''}
                    {e.status && e.status !== 'current' ? ` · ${e.status}` : ''}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </article>
  )
}

/* ================================================================ afterword: open questions */

function Afterword({ atlas, open }: { atlas: Atlas; open: (id: string) => void }) {
  const s = atlas.summary
  const exps = atlas.graph.items.filter((i) => i.kind === 'experiment')
  return (
    <article className="lm-chapter">
      <p className="lm-eyebrow">Afterword</p>
      <h1 className="lm-book-title">
        Open questions<span>what is wondered, and how it could be tested</span>
      </h1>
      {s.openHypotheses.map((h) => {
        const ev = evidenceOf(atlas.ix, h.id)
        const tests = exps.filter((e) => (atlas.ix.out.get(e.id) ?? []).some((l) => l.to === h.id))
        const preds = (atlas.ix.out.get(h.id) ?? []).filter((l) => l.rel === 'predicts').map((l) => atlas.ix.byId.get(l.to)!).filter(Boolean)
        return (
          <aside key={h.id} className="lm-wonder">
            <p className="lm-wonder-q">
              <Ref id={h.id} open={open}>
                Could it be that {lowerFirst(h.label)}?
              </Ref>
            </p>
            <p>
              {cap(plural(ev.support.length, 'record'))} toward, {plural(ev.oppose.length, 'record')} against. {uncertaintyText(h.uncertainty).long}
            </p>
            {(tests.length > 0 || preds.length > 0) && (
              <ul className="lm-plain">
                {preds.map((p) => (
                  <li key={p.id}>
                    <i>{KIND_WORD.prediction}:</i>{' '}
                    <Ref id={p.id} open={open}>
                      {p.label}
                    </Ref>{' '}
                    ({String(p.meta?.domain_status ?? 'open')}
                    {p.meta?.due ? `, due ${fmtDate(String(p.meta.due))}` : ''})
                  </li>
                ))}
                {tests.map((e) => (
                  <li key={e.id}>
                    <i>{KIND_WORD.experiment}:</i>{' '}
                    <Ref id={e.id} open={open}>
                      {e.label}
                    </Ref>{' '}
                    ({String(e.meta?.domain_status ?? 'planned')})
                  </li>
                ))}
              </ul>
            )}
            <RequestList atlas={atlas} itemId={h.id} />
          </aside>
        )
      })}
      <p className="lm-note">Ideas here are not findings. Support is counted by recorded links, which are heuristics, not probabilities.</p>
    </article>
  )
}
