import type { ReactNode } from 'react'
import type { ProgramDescription } from '../../api/types'
import { COVERAGE_CAVEAT, CUSTODY_WORDS, kindLabel, leanSentence, plural as n, roleOf, tiltDeg, type Balance, type Pan, type Piece } from './model'
import { ActionRow, ActionSheet, CustodyChain, ExhibitMarks, ItemPanel, OriginNote, Outcomes, Proposal, Scales, StatusMarks, U } from './parts'
import type { CaseState } from './useCase'

/** Still: the case file as a legal brief on warm paper. Two facing columns, footnoted exhibits, errata. */

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']
/** A sentence's closing stop, dropped where the brief supplies its own punctuation after a quotation. */
const bare = (t: string) => t.replace(/[.;:]+$/, '')

/**
 * Prose that selects its item. A real <button> is inline-block, which would push the footnote marks onto their
 * own line; this stays inline text, operable by keyboard like a button.
 */
function Prose({ className, onPick, children }: { className: string; onPick: () => void; children: ReactNode }) {
  return (
    <span
      role="button"
      tabIndex={0}
      className={className}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPick()
        }
      }}
    >
      {children}
    </span>
  )
}

function Engraving({ b }: { b: Balance }) {
  const deg = tiltDeg(b.tilt, 10)
  const rad = (deg * Math.PI) / 180
  const H = 120
  const ends = [-1, 1].map((s) => ({ x: 160 + s * H * Math.cos(rad), y: 34 + s * H * Math.sin(rad) }))
  return (
    <svg viewBox="0 0 320 120" className="cfs-engr" aria-hidden="true">
      <path d="M160 34 V104 M128 108 H192 M140 104 H180" className="cfs-engr-ink" />
      <g className="cfs-engr-tilt" style={{ ['--deg' as string]: `${deg}deg`, transformOrigin: '160px 34px' }}>
        <line x1={40} x2={280} y1={34} y2={34} className="cfs-engr-beam" />
      </g>
      {ends.map((e, i) => (
        <g key={i} className="cfs-engr-pan" style={{ ['--tx' as string]: `${e.x - (i ? 280 : 40)}px`, ['--ty' as string]: `${e.y - 34}px` }}>
          <path d={`M${i ? 280 : 40} 34 L${(i ? 280 : 40) - 26} 74 M${i ? 280 : 40} 34 L${(i ? 280 : 40) + 26} 74`} className="cfs-engr-thin" />
          <path d={`M${(i ? 280 : 40) - 32} 74 Q ${i ? 280 : 40} 94 ${(i ? 280 : 40) + 32} 74 Z`} className="cfs-engr-ink" />
        </g>
      ))}
      <circle cx="160" cy="34" r="3.2" className="cfs-engr-pivot" />
    </svg>
  )
}

function Para({ p, cs }: { p: Piece; cs: CaseState }) {
  const open = (mk: string) => {
    const el = document.getElementById(`cfs-ex-${mk}`)
    el?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    el?.focus({ preventScroll: true })
  }
  return (
    <li className="cfs-para" data-counted={p.counted || undefined} data-selected={cs.selected === p.item.id || undefined}>
      <Prose className="cfs-para-t" onPick={() => cs.select(p.item.id)}>
        {p.item.label}
      </Prose>
      <ExhibitMarks marks={p.exhibits} exhibits={cs.model.exhibits} m="paper" onOpen={open} />
      <span className="cfs-para-u">
        {' '}
        <U u={p.item.uncertainty} m="paper" />
        <StatusMarks item={p.item} m="paper" />
      </span>
      {!p.counted && <span className="cfs-nocount"> Withdrawn from the weighing; kept for the record.</span>}
    </li>
  )
}

function Column({ title, pan, cs }: { title: string; pan: Pan; cs: CaseState }) {
  return (
    <section className="cfs-col" aria-label={title}>
      <h3 className="cfs-col-h">{title}</h3>
      <p className="cfs-col-n">
        {n(pan.count, 'piece', 'pieces')}, {n(pan.independent, 'independent origin', 'independent origins')}
        {pan.shared.length > 0 && <>; shared origin: {pan.shared.join(', ')}</>}
      </p>
      {pan.pieces.length ? (
        <ol className="cfs-paras">
          {pan.pieces.map((p) => (
            <Para key={p.item.id} p={p} cs={cs} />
          ))}
        </ol>
      ) : (
        <p className="cfs-empty">Nothing is recorded here. An empty column is a gap in the search, not evidence.</p>
      )}
    </section>
  )
}

export function Still({ cs, describe, brand = 'This app' }: { cs: CaseState; describe: ProgramDescription | null; brand?: string }) {
  const { model } = cs
  const b = cs.target ? model.balances.get(cs.target) : undefined
  const q = model.question
  const sel = cs.selected ? cs.byId.get(cs.selected) : undefined
  const explanations = [...model.hypotheses, ...model.explanations]
  return (
    <div className="cfs">
      <div className="cfs-paper" aria-hidden="true" />
      <article className="cfs-brief">
        <header className="cfs-mast">
          <div className="cfs-kicker">
            <Scales size={15} />
            <span>{brand}</span>
            <span aria-hidden="true">·</span>
            <span>Case file</span>
            <span aria-hidden="true">·</span>
            <span>Revision {model.revision}</span>
          </div>
          <p className="cfs-matter">In the matter of</p>
          <h1 className="cfs-q">{q?.label ?? model.title}</h1>
          {q?.text && <p className="cfs-lede">{q.text}</p>}
          {q && <ActionRow item={q} cs={cs} describe={describe} m="paper" limit={3} />}
        </header>

        {b && (
          <section className="cfs-balance" aria-labelledby="cfs-claim">
            <nav className="cfs-claims" aria-label="Claims and explanations on the balance" role="tablist">
              {model.weighable.map((w, i) => (
                <button key={w.id} type="button" role="tab" aria-selected={w.id === cs.target} className="cfs-claim-tab" onClick={() => cs.setTarget(w.id)}>
                  <span className="cfs-claim-n">{ROMAN[i] ?? i + 1}.</span> {w.label}
                  <span className="cfs-claim-k"> {kindLabel(w.kind, describe).toLowerCase()}</span>
                </button>
              ))}
            </nav>
            <h2 id="cfs-claim" className="cfs-claim">
              <span className="cfs-claim-pre">The claim before us</span>“{b.target.label}”
            </h2>
            <p className="cfs-claim-u">
              Stated uncertainty: <U u={b.target.uncertainty} m="paper" />
            </p>
            <Engraving b={b} />
            <p className="cfs-lean">{leanSentence(b)}</p>
            <div className="cfs-facing">
              <Column title="For" pan={b.pro} cs={cs} />
              <div className="cfs-gutter" aria-hidden="true">
                <span>⚖</span>
              </div>
              <Column title="Against" pan={b.con} cs={cs} />
            </div>
            {b.qualify.length > 0 && (
              <p className="cfs-qual">
                <em>Qualified by: </em>
                {b.qualify.map((p, i) => (
                  <span key={p.item.id}>
                    {i ? '; ' : ''}
                    <Prose className="cfs-inline" onPick={() => cs.select(p.item.id)}>
                      {p.item.label}
                    </Prose>
                    <ExhibitMarks marks={p.exhibits} exhibits={model.exhibits} m="paper" onOpen={(mk) => document.getElementById(`cfs-ex-${mk}`)?.focus()} />
                  </span>
                ))}
              </p>
            )}
            <p className="cfs-caveat">{COVERAGE_CAVEAT}</p>
            <ActionRow item={b.target} cs={cs} describe={describe} m="paper" />
          </section>
        )}

        <section className="cfs-sec">
          <h2 className="cfs-h">Competing explanations</h2>
          <ol className="cfs-roman">
            {explanations.map((h, i) => {
              const hb = model.balances.get(h.id)
              return (
                <li key={h.id} data-selected={cs.selected === h.id || undefined}>
                  <span className="cfs-roman-n">{ROMAN[i]}.</span>
                  <div>
                    <button type="button" className="cfs-inline cfs-strong" onClick={() => cs.select(h.id)}>
                      {h.label}
                    </button>{' '}
                    <span className="cfs-small">
                      {roleOf(h.kind, describe) === 'explanation' ? 'Explanation. ' : ''}
                      {hb ? `${n(hb.pro.count, 'piece', 'pieces')} for, ${hb.con.count} against. ` : ''}
                      <U u={h.uncertainty} m="paper" />.
                    </span>
                    <ActionRow item={h} cs={cs} describe={describe} m="paper" limit={2} />
                  </div>
                </li>
              )
            })}
          </ol>
        </section>

        <section className="cfs-sec">
          <h2 className="cfs-h">Assessment</h2>
          {model.assessments.map((a) => (
            <div key={a.id} className="cfs-assess" data-status={a.status ?? 'current'}>
              <button type="button" className="cfs-inline cfs-strong" onClick={() => cs.select(a.id)}>
                {a.label}
              </button>
              <p className="cfs-small">
                <U u={a.uncertainty} m="paper" /> <StatusMarks item={a} m="paper" />
              </p>
              <Proposal item={a} m="paper" />
              <ActionRow item={a} cs={cs} describe={describe} m="paper" limit={2} />
            </div>
          ))}
        </section>

        <section className="cfs-sec">
          <h2 className="cfs-h">Open questions</h2>
          <ul className="cfs-gaps">
            {model.gaps.map((g) => (
              <li key={g.id}>
                <button type="button" className="cfs-inline" onClick={() => cs.select(g.id)}>
                  {g.label}
                </button>
                <ActionRow item={g} cs={cs} describe={describe} m="paper" limit={1} />
              </li>
            ))}
          </ul>
        </section>

        <section className="cfs-sec cfs-exhibits">
          <h2 className="cfs-h">Exhibits</h2>
          <ol>
            {model.exhibits.map((ex) => (
              <li key={ex.key} id={`cfs-ex-${ex.mark}`} tabIndex={-1} className="cfs-ex">
                <span className="cfs-ex-mark">{ex.mark}</span>
                <div>
                  <span className="cfs-ex-l">{ex.source.label}</span>
                  {ex.source.locator && <span className="cfs-small">, {ex.source.locator}</span>}
                  {ex.source.date && <span className="cfs-small">, {ex.source.date}</span>}.{' '}
                  <span className="cfs-small">{CUSTODY_WORDS[ex.custody].why}</span>
                  <div className="cfs-ex-chain">
                    <CustodyChain status={ex.source.status} m="paper" />
                    <OriginNote ex={ex} m="paper" />
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="cfs-sec cfs-errata">
          <h2 className="cfs-h">Errata</h2>
          <ol>
            {model.errata.map((e) => (
              <li key={e.item.id}>
                <span className="cfs-err-r">{e.revision ?? '—'}</span>
                <p>
                  {e.kind === 'corrected' && e.was ? (
                    <>
                      For <q className="cfs-was">{bare(e.was)}</q> read <q>{bare(e.now)}</q>.
                    </>
                  ) : e.kind === 'retracted' ? (
                    <>
                      Withdrawn: <q className="cfs-was">{bare(e.now)}</q>.
                    </>
                  ) : (
                    <>
                      Superseded: <q className="cfs-was">{bare(e.now)}</q>.
                    </>
                  )}
                  {e.note && <span className="cfs-small"> {e.note}</span>}
                </p>
              </li>
            ))}
          </ol>
          {model.affected.length > 0 && <p className="cfs-small cfs-affected">To be reviewed in the light of these corrections: {model.affected.map((a) => `“${bare(a.label)}”`).join('; ')}.</p>}
        </section>

        {model.notes.length > 0 && (
          <footer className="cfs-notes">
            {model.notes.map((x, i) => (
              <p key={i}>{x}</p>
            ))}
          </footer>
        )}
      </article>
      {sel && (
        <aside className="cfs-margin">
          <ItemPanel item={sel} cs={cs} describe={describe} m="paper" onClose={() => cs.select(null)} />
        </aside>
      )}
      <Outcomes cs={cs} m="paper" />
      {cs.sheet && <ActionSheet key={cs.sheet.seq} sheet={cs.sheet} cs={cs} revision={model.revision} m="paper" />}
    </div>
  )
}
