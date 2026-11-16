import { plural } from '../../lib/plural'
import { useId } from 'react'
import type { ProgramDescription, WorkItem } from '../../api/types'
import { COVERAGE_CAVEAT, kindLabel, roleOf, tiltDeg, type Balance, type Pan, type Piece } from './model'
import { ActionRow, ActionSheet, CustodyChain, ExhibitMarks, ItemPanel, OriginNote, Outcomes, Proposal, Scales, StatusMarks, U } from './parts'
import type { CaseState } from './useCase'

/** Classic: the case file in the hive's own glass, the balance as a luminous beam. */

const W = 1000
const PX = 500
const PY = 78
const HALF = 372
const DROP = 92

function Orbs({ pan, cx, side }: { pan: Pan; cx: number; side: 'for' | 'against' }) {
  const counted = pan.pieces.filter((p) => p.counted)
  const r = (p: Piece) => 9 + 13 * Math.min(1, p.weight)
  const total = counted.reduce((a, p) => a + r(p) * 2 + 6, 0)
  const groupSize = new Map<number, number>()
  for (const p of counted) groupSize.set(p.group, (groupSize.get(p.group) ?? 0) + 1)
  const sorted = [...counted].sort((a, b) => a.group - b.group)
  // left edge of each orb's slot: running sum of the slot widths before it, in sorted order
  const sortedWidths = sorted.map((p) => r(p) * 2 + 6)
  const lefts = sortedWidths.map((_, i) => cx - total / 2 + sortedWidths.slice(0, i).reduce((a, b) => a + b, 0))
  return (
    <g className="cfc-orbs" data-side={side}>
      {sorted.map((p, i) => {
        const rr = r(p)
        const ox = lefts[i] + rr + 3
        const linked = (groupSize.get(p.group) ?? 0) > 1
        return (
          <g key={p.item.id}>
            {linked && i > 0 && sorted[i - 1].group === p.group && <line x1={ox - rr - 6} x2={ox - rr} y1={PY + DROP - rr - 2} y2={PY + DROP - rr - 2} className="cfc-orb-link" />}
            <circle cx={ox} cy={PY + DROP - rr - 2} r={rr} className="cfc-orb" data-assessed={p.item.uncertainty ? 'y' : 'n'} data-linked={linked || undefined}>
              <title>{`${p.item.label} — weight ${p.weight.toFixed(2)}${p.item.uncertainty ? '' : ', unassessed'}${linked ? ', shares an origin: counts once with its group' : ''}`}</title>
            </circle>
          </g>
        )
      })}
    </g>
  )
}

function Beam({ b }: { b: Balance }) {
  const deg = tiltDeg(b.tilt)
  const rad = (deg * Math.PI) / 180
  const dxL = -HALF * Math.cos(rad) + HALF
  const dyL = -HALF * Math.sin(rad)
  const dxR = HALF * Math.cos(rad) - HALF
  const dyR = HALF * Math.sin(rad)
  const gid = 'cfc' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const lean = Math.abs(b.tilt) < 0.08 ? 'level' : b.tilt > 0 ? 'leans for' : 'leans against'
  const pan = (side: 'for' | 'against', pan: Pan, x: number, dx: number, dy: number) => (
    <g className="cfc-pan" style={{ ['--tx' as string]: `${dx}px`, ['--ty' as string]: `${dy}px` }}>
      <line x1={x} x2={x - 92} y1={PY} y2={PY + DROP} className="cfc-string" />
      <line x1={x} x2={x + 92} y1={PY} y2={PY + DROP} className="cfc-string" />
      <path d={`M${x - 112} ${PY + DROP} Q ${x} ${PY + DROP + 46} ${x + 112} ${PY + DROP}`} className="cfc-dish" data-side={side} />
      <line x1={x - 116} x2={x + 116} y1={PY + DROP} y2={PY + DROP} className="cfc-rim" data-side={side} />
      <Orbs pan={pan} cx={x} side={side} />
    </g>
  )
  return (
    <svg viewBox={`0 0 ${W} 300`} className="cfc-beam" role="img" aria-label={`The balance ${lean}: for, ${plural(b.pro.count, 'piece')} from ${b.pro.independent} independent origins, weight ${b.pro.weight.toFixed(2)}; against, ${plural(b.con.count, 'piece')} from ${b.con.independent} independent origins, weight ${b.con.weight.toFixed(2)}.`}>
      <defs>
        <linearGradient id={`${gid}-g`} gradientUnits="userSpaceOnUse" x1={PX - HALF} x2={PX + HALF} y1={PY} y2={PY}>
          <stop offset="0" stopColor="#7fd8c8" />
          <stop offset="0.5" stopColor="#e8c27a" />
          <stop offset="1" stopColor="#f4a28c" />
        </linearGradient>
        <radialGradient id={`${gid}-h`}>
          <stop offset="0" stopColor="#e8c27a" stopOpacity="0.32" />
          <stop offset="1" stopColor="#e8c27a" stopOpacity="0" />
        </radialGradient>
        <filter id={`${gid}-b`} filterUnits="userSpaceOnUse" x={PX - HALF - 40} y={PY - 40} width={HALF * 2 + 80} height={80}>
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>
      <ellipse cx={PX} cy={PY} rx={180} ry={70} fill={`url(#${gid}-h)`} />
      {/* the ruled dial: a ledger of ticks the needle reads against */}
      <g className="cfc-dial">
        {Array.from({ length: 15 }, (_, i) => {
          const a = ((i - 7) * 2 * Math.PI) / 180
          const long = i % 7 === 0
          return <line key={i} x1={PX + Math.sin(a) * 52} y1={PY - Math.cos(a) * 52} x2={PX + Math.sin(a) * (long ? 40 : 45)} y2={PY - Math.cos(a) * (long ? 40 : 45)} />
        })}
      </g>
      <line x1={PX} x2={PX} y1={PY} y2={262} className="cfc-pillar" />
      <path d={`M${PX - 70} 270 Q ${PX} 252 ${PX + 70} 270 Z`} className="cfc-base" />
      <g className="cfc-tilt" style={{ ['--deg' as string]: `${deg}deg`, transformOrigin: `${PX}px ${PY}px` }}>
        <line x1={PX - HALF} x2={PX + HALF} y1={PY} y2={PY} stroke={`url(#${gid}-g)`} strokeWidth={9} strokeLinecap="round" filter={`url(#${gid}-b)`} opacity={0.8} />
        <line x1={PX - HALF} x2={PX + HALF} y1={PY} y2={PY} stroke={`url(#${gid}-g)`} strokeWidth={3} strokeLinecap="round" />
        <line x1={PX} x2={PX} y1={PY} y2={PY - 38} className="cfc-needle" />
        <circle cx={PX - HALF} cy={PY} r={4.5} fill="#7fd8c8" />
        <circle cx={PX + HALF} cy={PY} r={4.5} fill="#f4a28c" />
      </g>
      <path d={`M${PX} ${PY - 9} l9 9 l-9 9 l-9 -9 z`} className="cfc-pivot" />
      {pan('for', b.pro, PX - HALF, dxL, dyL)}
      {pan('against', b.con, PX + HALF, dxR, dyR)}
    </svg>
  )
}

function PieceCard({ p, cs, describe }: { p: Piece; cs: CaseState; describe: ProgramDescription | null }) {
  const pan = p.side === 'for' ? cs.model.balances.get(cs.target!)?.pro : cs.model.balances.get(cs.target!)?.con
  const sharers = pan?.pieces.filter((o) => o !== p && o.counted && p.counted && o.group === p.group) ?? []
  const sel = cs.selected === p.item.id
  return (
    <li className="cfc-piece" data-side={p.side} data-counted={p.counted || undefined} data-selected={sel || undefined} style={{ ['--w' as string]: Math.min(1, p.weight) }} onClick={() => cs.select(p.item.id)}>
      <div className="cfc-piece-weight" aria-hidden="true" />
      <button type="button" className="cfc-piece-t" aria-pressed={sel} onClick={(e) => (e.stopPropagation(), cs.select(p.item.id))}>
        {p.item.label}
      </button>
      <div className="cfc-piece-meta">
        <U u={p.item.uncertainty} m="glass" />
        <ExhibitMarks marks={p.exhibits} exhibits={cs.model.exhibits} m="glass" onOpen={(mk) => document.getElementById(`cf-ex-${mk}`)?.focus()} />
        <span className="cfc-w" title="Link weight as given by the program">
          w {p.weight.toFixed(2)}
        </span>
        <StatusMarks item={p.item} m="glass" />
      </div>
      {!p.counted && <p className="cfc-nocount">Kept for the record. Adds no weight.</p>}
      {sharers.length > 0 && (
        <p className="cfc-shared">
          <span aria-hidden="true">⛓</span> Same origin as {sharers.map((s) => s.item.id).join(', ')}: counted once together.
        </p>
      )}
      <span className="sr-only">{kindLabel(p.item.kind, describe)}</span>
    </li>
  )
}

function SideColumn({ side, pan, cs, describe }: { side: 'for' | 'against'; pan: Pan; cs: CaseState; describe: ProgramDescription | null }) {
  return (
    <section className="cfc-side" data-side={side} aria-label={side === 'for' ? 'Evidence for' : 'Evidence against'}>
      <header className="cfc-side-h">
        <h3>{side === 'for' ? 'For' : 'Against'}</h3>
        <span className="cfc-side-n">
          {pan.count} {pan.count === 1 ? 'piece' : 'pieces'} · {pan.independent} independent {pan.independent === 1 ? 'origin' : 'origins'} · weight {pan.weight.toFixed(2)}
          {pan.unassessed > 0 && ` · ${pan.unassessed} unassessed`}
        </span>
      </header>
      {pan.pieces.length ? (
        <ul className="cfc-pieces">
          {pan.pieces.map((p) => (
            <PieceCard key={p.item.id} p={p} cs={cs} describe={describe} />
          ))}
        </ul>
      ) : (
        <p className="cfc-empty">Nothing recorded on this side yet. That is a search gap, not evidence.</p>
      )}
    </section>
  )
}

function MiniTally({ b }: { b: Balance | undefined }) {
  if (!b) return null
  const deg = tiltDeg(b.tilt, 18)
  return (
    <span className="cfc-mini" title={`For ${b.pro.count} · against ${b.con.count}`}>
      <svg width="34" height="16" viewBox="0 0 34 16" aria-hidden="true">
        <line x1="17" x2="17" y1="6" y2="15" stroke="currentColor" strokeOpacity=".5" />
        <g style={{ transform: `rotate(${deg}deg)`, transformOrigin: '17px 6px' }}>
          <line x1="3" x2="31" y1="6" y2="6" stroke="#e8c27a" strokeWidth="1.6" strokeLinecap="round" />
        </g>
      </svg>
      <span className="cfc-mini-for">{b.pro.count} for</span>
      <span className="cfc-mini-against">{b.con.count} against</span>
    </span>
  )
}

function Card({ item, cs, describe, children, limit = 2 }: { item: WorkItem; cs: CaseState; describe: ProgramDescription | null; children?: React.ReactNode; limit?: number }) {
  const sel = cs.selected === item.id
  return (
    <li className="cfc-card" data-role={roleOf(item.kind, describe)} data-selected={sel || undefined} data-status={item.status ?? 'current'}>
      <button type="button" className="cfc-card-t" aria-pressed={sel} onClick={() => cs.select(item.id)}>
        {item.label}
      </button>
      <div className="cfc-piece-meta">
        <U u={item.uncertainty} m="glass" />
        <StatusMarks item={item} m="glass" />
        <Proposal item={item} m="glass" />
        {children}
      </div>
      <ActionRow item={item} cs={cs} describe={describe} m="glass" limit={limit} />
    </li>
  )
}

export function Classic({ cs, describe, brand = 'This app' }: { cs: CaseState; describe: ProgramDescription | null; brand?: string }) {
  const { model } = cs
  const b = cs.target ? model.balances.get(cs.target) : undefined
  const q = model.question
  const sel = cs.selected ? cs.byId.get(cs.selected) : undefined
  const explanations = [...model.hypotheses, ...model.explanations]
  return (
    <div className="cfc">
      <div className="cfc-main">
        <header className="cfc-head">
          <div className="cfc-eyebrow">
            <Scales size={16} className="cfc-glyph" />
            <span>{brand}</span>
            <span className="cfc-dot" aria-hidden="true" />
            <span>Case file</span>
            <span className="cfc-rev">revision {model.revision}</span>
          </div>
          <h1 className="cfc-q">{q?.label ?? model.title}</h1>
          {q?.text && <p className="cfc-qtext">{q.text}</p>}
          {q && <ActionRow item={q} cs={cs} describe={describe} m="glass" limit={3} />}
        </header>

        {b && (
          <section className="cfc-balance" aria-labelledby="cfc-claim-h">
            <div className="cfc-tabs" role="tablist" aria-label="What is on the balance">
              {model.weighable.map((w) => (
                <button key={w.id} role="tab" type="button" aria-selected={w.id === cs.target} className="cfc-tab" data-role={roleOf(w.kind, describe)} onClick={() => cs.setTarget(w.id)}>
                  <span className="cfc-tab-k">{kindLabel(w.kind, describe)}</span>
                  <span className="cfc-tab-l">{w.label}</span>
                </button>
              ))}
            </div>
            <div className="cfc-claim-row">
              <h2 id="cfc-claim-h" className="cfc-claim">
                {b.target.label}
              </h2>
              <div className="cfc-claim-meta">
                <U u={b.target.uncertainty} m="glass" />
                <StatusMarks item={b.target} m="glass" />
              </div>
            </div>
            <Beam b={b} />
            <p className="cfc-caveat">{COVERAGE_CAVEAT}</p>
            <div className="cfc-sides">
              <SideColumn side="for" pan={b.pro} cs={cs} describe={describe} />
              <SideColumn side="against" pan={b.con} cs={cs} describe={describe} />
            </div>
            {b.qualify.length > 0 && (
              <div className="cfc-qual">
                <h3>Qualified by</h3>
                <ul>
                  {b.qualify.map((p) => (
                    <li key={p.item.id}>
                      <button type="button" className="cfc-link" onClick={() => cs.select(p.item.id)}>
                        {p.item.label}
                      </button>
                      <U u={p.item.uncertainty} m="glass" />
                      <ExhibitMarks marks={p.exhibits} exhibits={model.exhibits} m="glass" onOpen={(mk) => document.getElementById(`cf-ex-${mk}`)?.focus()} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <ActionRow item={b.target} cs={cs} describe={describe} m="glass" />
          </section>
        )}

        <div className="cfc-grid">
          <div className="cfc-col">
            <section className="cfc-sec">
              <h2 className="cfc-h">Competing explanations</h2>
              <ul className="cfc-cards">
                {explanations.map((h) => (
                  <Card key={h.id} item={h} cs={cs} describe={describe}>
                    <MiniTally b={model.balances.get(h.id)} />
                  </Card>
                ))}
              </ul>
            </section>
            <section className="cfc-sec">
              <h2 className="cfc-h">Assessments</h2>
              <ul className="cfc-cards">
                {model.assessments.map((a) => (
                  <Card key={a.id} item={a} cs={cs} describe={describe} />
                ))}
              </ul>
            </section>
            <section className="cfc-sec">
              <h2 className="cfc-h">Open questions</h2>
              <ul className="cfc-gaps">
                {model.gaps.map((g) => (
                  <li key={g.id} className="cfc-gap">
                    <span className="cfc-gap-q" aria-hidden="true">?</span>
                    <button type="button" className="cfc-card-t" onClick={() => cs.select(g.id)}>
                      {g.label}
                    </button>
                    <ActionRow item={g} cs={cs} describe={describe} m="glass" limit={1} />
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <div className="cfc-col">
            <section className="cfc-sec">
              <h2 className="cfc-h">Exhibits</h2>
              <ul className="cfc-exhibits">
                {model.exhibits.map((ex) => (
                  <li key={ex.key} id={`cf-ex-${ex.mark}`} tabIndex={-1} className="cfc-exhibit" data-shared={ex.sameOrigin.length ? true : undefined}>
                    <span className="cfc-ex-mark" data-custody={ex.custody}>
                      {ex.mark}
                    </span>
                    <div className="cfc-ex-body">
                      <span className="cfc-ex-l">{ex.source.label}</span>
                      <CustodyChain status={ex.source.status} m="glass" />
                      <OriginNote ex={ex} m="glass" />
                      <span className="cfc-ex-cite">Cited by {ex.citedBy.map((c) => c.id).join(', ')}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
            <section className="cfc-sec">
              <h2 className="cfc-h">Errata</h2>
              <ol className="cfc-ledger">
                {model.errata.map((e) => (
                  <li key={e.item.id} data-kind={e.kind}>
                    <span className="cfc-led-k">{e.kind}</span>
                    <span className="cfc-led-r">{e.revision ?? '—'}</span>
                    <div className="cfc-led-b">
                      {e.kind === 'corrected' && e.was ? (
                        <>
                          <s>{e.was}</s>
                          <span className="cfc-led-now">{e.now}</span>
                        </>
                      ) : (
                        <s>{e.now}</s>
                      )}
                      {e.note && <span className="cfc-led-n">{e.note}</span>}
                    </div>
                  </li>
                ))}
              </ol>
              {model.affected.length > 0 && (
                <p className="cfc-affected">
                  Needs review after a correction:{' '}
                  {model.affected.map((a, i) => (
                    <span key={a.id}>
                      {i ? ', ' : ''}
                      <button type="button" className="cfc-link" onClick={() => cs.select(a.id)}>
                        {a.label}
                      </button>
                    </span>
                  ))}
                </p>
              )}
            </section>
            {model.notes.length > 0 && (
              <section className="cfc-notes" aria-label="Notes from the program">
                {model.notes.map((n, i) => (
                  <p key={i}>{n}</p>
                ))}
              </section>
            )}
          </div>
        </div>
      </div>
      {sel && (
        <aside className="cfc-drawer">
          <ItemPanel item={sel} cs={cs} describe={describe} m="glass" onClose={() => cs.select(null)} />
        </aside>
      )}
      <Outcomes cs={cs} m="glass" />
      {cs.sheet && <ActionSheet key={cs.sheet.seq} sheet={cs.sheet} cs={cs} revision={model.revision} m="glass" />}
    </div>
  )
}
