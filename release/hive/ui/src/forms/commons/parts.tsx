import { plural } from '../../lib/plural'
import { createElement, useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { ago } from '../../lib/format'
import { navigate } from '../../lib/router'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { AsWritten } from '../../ui/Belief'
import { plainText, truthPhrase } from '../../lib/beliefSentence'
import { gapWords, readStatement, truthNumbers, truthShort, truthWords, type Star, type Truth } from './model'
import type { CommonsState } from './useCommons'
import { FILTERS } from './model'

/* ================================================================ small marks */

/** The commons' glyph (✶), drawn. */
export function Glyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="cm-glyph">
      <path d="M12 2.5 13.6 9l6.4-2.6L15.4 12l4.6 5.6L13.6 15 12 21.5 10.4 15 4 17.6 8.6 12 4 6.4 10.4 9Z" fill="currentColor" />
    </svg>
  )
}

/** A truth value as two quiet bars (what it says, how firmly) plus the words; the numbers are always there in text. */
export function TruthLine({ truth, label, compact = false }: { truth: Truth | null; label?: string; compact?: boolean }) {
  return (
    <div className="cm-truth" data-compact={compact || undefined}>
      {truth ? (
        <span className="cm-truth-bars" aria-hidden="true">
          <span className="cm-bar" data-k="f">
            <span style={{ width: `${Math.round(truth.f * 100)}%` }} />
          </span>
          <span className="cm-bar" data-k="c">
            <span style={{ width: `${Math.round(truth.c * 100)}%` }} />
          </span>
        </span>
      ) : null}
      <span className="cm-truth-words">
        <span className="cm-truth-say">{label ?? truthWords(truth)}</span>
        <span className="cm-truth-num">{truthShort(truth)}</span>
      </span>
    </div>
  )
}

export function Chips({ star, rival = false }: { star: Star; rival?: boolean }) {
  return (
    <span className="cm-chips">
      {rival && <span className="cm-chip" data-tone="against">Rival</span>}
      <span className="cm-chip">
        {star.independent} {star.independent === 1 ? 'source' : 'sources'}
      </span>
      {star.well && (
        <span className="cm-chip" data-tone="cyan">
          Well supported
        </span>
      )}
      {star.gaps.length > 0 && (
        <span className="cm-chip" data-tone="warn">
          {star.gaps.length === 1 ? gapWords(star.gaps[0].reason) : `${star.gaps.length} research gaps`}
        </span>
      )}
    </span>
  )
}

export function Legend() {
  return (
    <ul className="cm-legend" aria-label="How to read the sky">
      <li>
        <span className="cm-key" data-k="size" aria-hidden="true" />
        Size: independent sources
      </li>
      <li>
        <span className="cm-key" data-k="bright" aria-hidden="true" />
        Brightness: how strongly it is expected to hold
      </li>
      <li>
        <span className="cm-key" data-k="well" aria-hidden="true" />
        Ring: well supported
      </li>
      <li>
        <span className="cm-key" data-k="gap" aria-hidden="true" />
        Dashed halo: missing research
      </li>
    </ul>
  )
}

/* ================================================================ toolbar */

export function Toolbar({ cs, variant = 'pills' }: { cs: CommonsState; variant?: 'pills' | 'text' }) {
  const id = useId()
  const total = cs.sky.stars.length
  const shown = cs.visible.size
  return (
    <div className="cm-toolbar" data-variant={variant}>
      <div className="cm-filters" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className="cm-filter" aria-pressed={cs.filter === f.id} onClick={() => cs.setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="cm-search">
        <label htmlFor={`${id}-q`} className="cm-search-label">
          Find a belief
        </label>
        <input id={`${id}-q`} className="cm-input" type="search" value={cs.query} onChange={(e) => cs.setQuery(e.target.value)} placeholder="a term, a mind, a word" autoComplete="off" spellCheck={false} aria-describedby={`${id}-n`} />
      </div>
      <p id={`${id}-n`} className="cm-count" role="status" aria-live="polite">
        {shown === total ? `${total} ${total === 1 ? 'belief' : 'beliefs'}` : `Showing ${shown} of ${total}`}
      </p>
    </div>
  )
}

/* ================================================================ one belief, unfolded */

type H = 'h2' | 'h3' | 'h4' | 'h5'
const lower = (h: H): H => (h === 'h2' ? 'h3' : h === 'h3' ? 'h4' : 'h5')

/** A heading at the level the rendering needs (h2 in a panel, h4 inside Still's flow). */
function Heading({ level, children, ...rest }: { level: H; children: ReactNode; id?: string; className?: string; tabIndex?: number; ref?: RefObject<HTMLHeadingElement | null> }) {
  return createElement(level, rest, children)
}

/**
 * Everything behind one belief: its truth and sources, the reports (for and against, echoes marked), its rivals
 * (compare side by side), the research it is missing, and its two acts. The heading takes focus when it opens.
 */
export function BeliefBody({ cs, level = 'h2', headingRef, onClose }: { cs: CommonsState; level?: H; headingRef?: RefObject<HTMLHeadingElement | null>; onClose?: () => void }) {
  const u = cs.unfolded
  const id = useId()
  const sub = lower(level)
  const challenge = cs.declared('challenge')
  const research = cs.declared('investigate-gap')
  const openSrc = cs.declared('inspect-source')
  const compareA = cs.declared('compare')
  const star = u?.star ?? cs.sky.stars.find((s) => s.id === cs.openId) ?? null
  if (!star) {
    return (
      <div className="cm-body">
        <Heading level={level} ref={headingRef} tabIndex={-1} className="cm-b-title">
          {cs.detail.status === 'loading' ? 'Opening the belief…' : 'This belief is no longer in the commons'}
        </Heading>
        {cs.detail.status !== 'loading' && <p className="cm-muted">It may have been revised away since the sky was drawn. Nothing was changed here.</p>}
        {onClose && (
          <button type="button" className="cm-btn" onClick={onClose}>
            Back to the sky
          </button>
        )}
      </div>
    )
  }
  const busy = (k: string) => cs.running === k || cs.running === 'busy'
  return (
    <div className="cm-body" aria-busy={cs.detail.status === 'loading' || cs.detail.refreshing || undefined}>
      <header className="cm-b-head">
        <p className="cm-eyebrow">
          <Glyph size={13} /> Shared belief
        </p>
        <Heading level={level} ref={headingRef} tabIndex={-1} className="cm-b-title" id={`${id}-t`}>
          {star.reading}
        </Heading>
        <AsWritten text={star.statement} className="cm-raw" />
      </header>

      <div className="cm-b-facts">
        <TruthLine truth={star.truth} />
        <p className="cm-b-line">
          <span className="cm-strong">{star.independent}</span> independent {star.independent === 1 ? 'source' : 'sources'}
          {star.sources.length > 0 && <>: {star.sources.map((s) => s.label).join(', ')}</>}
          {star.at && <span className="cm-muted"> · updated {ago(star.at)}</span>}
        </p>
        <p className="cm-b-line cm-muted">{truthNumbers(star.truth, star.uncertainty)}</p>
        <Chips star={u ? { ...star, gaps: u.gaps } : star} />
      </div>

      {challenge && (
        <div className="cm-b-acts">
          <button type="button" className="cm-btn cm-btn-primary" onClick={() => cs.requestAsk('challenge', star.id)} disabled={!u || cs.partial || !!cs.running} aria-describedby={`${id}-ch`}>
            {challenge.label ?? 'Look for counterevidence'}
          </button>
          <p id={`${id}-ch`} className="cm-hint">
            Posts a task to the swarm. You see everything it involves before anything is sent.
          </p>
        </div>
      )}

      <Outcomes cs={cs} />

      {cs.detail.status === 'loading' && <p className="cm-muted" role="status">Reading the reports behind it…</p>}
      {cs.detail.status === 'error' && (
        <p className="cm-note" data-tone="bad" role="alert">
          Could not read this belief&rsquo;s reports. <button type="button" className="cm-link" onClick={cs.reload}>Try again</button>
        </p>
      )}
      {cs.partial && <p className="cm-note">This hive does not let the app read one belief on its own here, so its reports and rivals are not shown. Its truth, sources and gaps above are from the overview.</p>}

      {u && !cs.partial && (
        <>
          <section className="cm-sec" aria-labelledby={`${id}-r`}>
            <Heading level={sub} id={`${id}-r`} className="cm-sec-title">
              The reports behind it <span className="cm-count-n">{u.reports.length}</span>
            </Heading>
            {u.reports.length ? (
              <>
                <p className="cm-b-line">
                  <span data-tone="cyan" className="cm-tone">{u.forCount} for</span> · <span data-tone="against" className="cm-tone">{u.againstCount} against</span> · from {u.origins} independent {u.origins === 1 ? 'origin' : 'origins'}
                </p>
                <ol className="cm-reports">
                  {u.reports.map((r) => {
                    const src = cs.sources[r.id]
                    return (
                      <li key={r.id} className="cm-report" data-stance={r.stance} data-superseded={r.superseded || undefined}>
                        <div className="cm-report-head">
                          <span className="cm-chip" data-tone={r.stance === 'for' ? 'cyan' : r.stance === 'against' ? 'against' : undefined}>
                            {r.stance === 'for' ? 'For' : r.stance === 'against' ? 'Against' : 'Other'}
                          </span>
                          <span className="cm-strong">{r.who}</span>
                          <span className="cm-muted">{truthShort(r.truth)}</span>
                          {r.at && <span className="cm-muted">· {ago(r.at)}</span>}
                        </div>
                        <p className="cm-report-text">
                          {r.outcome ? <>Outcome in the commons: {r.outcome}.</> : null}
                          {r.superseded ? ' Not the value the commons holds now.' : ''}
                        </p>
                        {r.echoes > 0 && (
                          <p className="cm-echo">
                            Shares evidence with {r.echoes} other {r.echoes === 1 ? 'report' : 'reports'}: an echo, not independent support.
                          </p>
                        )}
                        {openSrc && !src && (
                          <button type="button" className="cm-btn cm-btn-quiet" onClick={() => void cs.inspect(r.id)} disabled={!!cs.running} aria-label={`${openSrc.label ?? 'Open source'}: ${r.who}`}>
                            {busy(`inspect-source:${r.id}`) ? 'Opening…' : (openSrc.label ?? 'Open source')}
                          </button>
                        )}
                        {src && <SourceRecord src={src} />}
                      </li>
                    )
                  })}
                </ol>
              </>
            ) : (
              <p className="cm-muted">No reports are on record for it.</p>
            )}
          </section>

          <section className="cm-sec" aria-labelledby={`${id}-v`}>
            <Heading level={sub} id={`${id}-v`} className="cm-sec-title">
              Rivals: saying otherwise about the same subject <span className="cm-count-n">{u.rivals.length}</span>
            </Heading>
            {u.rivals.length ? (
              <ul className="cm-rivals">
                {u.rivals.map((r) => (
                  <li key={r.id} className="cm-rival">
                    <p className="cm-rival-reading">{r.reading}</p>
                    <AsWritten text={r.statement} className="cm-raw" />
                    <TruthLine truth={r.truth} compact />
                    <div className="cm-row">
                      <button type="button" className="cm-btn" onClick={() => cs.openBelief(r.id)} aria-label={`Unfold the rival: ${r.reading}`}>
                        Unfold
                      </button>
                      {compareA && (
                        <button type="button" className="cm-btn" onClick={() => void cs.compare([star.id, r.id])} disabled={!!cs.running} aria-label={`${compareA.label ?? 'Compare'} side by side with: ${r.reading}`}>
                          {busy(`compare:${star.id},${r.id}`) ? 'Comparing…' : `${compareA.label ?? 'Compare'} side by side`}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cm-muted">Nothing in the commons says otherwise about its subject.</p>
            )}
            {cs.compared && <Compared cs={cs} level={lower(sub)} />}
          </section>

          <section className="cm-sec" aria-labelledby={`${id}-g`}>
            <Heading level={sub} id={`${id}-g`} className="cm-sec-title">
              Missing research <span className="cm-count-n">{u.gaps.length}</span>
            </Heading>
            {u.gaps.length ? (
              <ul className="cm-gaps">
                {u.gaps.map((g) => (
                  <li key={g.id} className="cm-gap">
                    <p className="cm-strong">{gapWords(g.reason)}</p>
                    <p className="cm-muted">{plainText(g.label)}</p>
                    {research && (
                      <button type="button" className="cm-btn" onClick={() => cs.requestAsk('investigate-gap', g.id)} disabled={!!cs.running} aria-label={`${research.label ?? 'Research this'}: ${gapWords(g.reason)}`}>
                        {research.label ?? 'Research this'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cm-muted">The app sees no research missing for it.</p>
            )}
          </section>

          {u.notes.length > 0 && (
            <aside className="cm-notes" aria-label="Notes from the app">
              {u.notes.map((n) => (
                <p key={n}>{n}</p>
              ))}
            </aside>
          )}
        </>
      )}
    </div>
  )
}

function SourceRecord({ src }: { src: Record<string, unknown> & { label: string } }) {
  const rec = (src.record ?? null) as { statement?: string; tv?: { f?: number; c?: number }; outcome?: string } | null
  const rows: [string, ReactNode][] = [
    ['Mind', src.label],
    ['Status', String(src.status ?? 'inspected')],
    ...(src.date ? [['When', String(src.date)] as [string, ReactNode]] : []),
    ...(src.locator ? [['Evidence', String(src.locator)] as [string, ReactNode]] : []),
    ...(src.origin ? [['Origin', String(src.origin)] as [string, ReactNode]] : []),
    ...(rec?.statement ? [['Asserted', <span key="s">{readStatement(rec.statement)} <AsWritten text={rec.statement} className="cm-raw" /></span>] as [string, ReactNode]] : []),
    ...(rec?.tv && typeof rec.tv.f === 'number' && typeof rec.tv.c === 'number' ? [['Truth', truthPhrase({ f: rec.tv.f, c: rec.tv.c })] as [string, ReactNode]] : []),
    ...(rec?.outcome ? [['Outcome', rec.outcome] as [string, ReactNode]] : []),
  ]
  return (
    <dl className="cm-src" aria-label={`Source record from ${src.label}`}>
      {rows.map(([k, v]) => (
        <div key={k} className="cm-src-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function Compared({ cs, level }: { cs: CommonsState; level: H }) {
  const c = cs.compared!
  return (
    <div className="cm-compare" role="group" aria-label={plainText(c.title)}>
      <div className="cm-compare-head">
        <Heading level={level} className="cm-sec-title">Side by side</Heading>
        <button type="button" className="cm-btn cm-btn-quiet" onClick={cs.clearCompare}>
          Close comparison
        </button>
      </div>
      <div className="cm-compare-cols">
        {c.sides.map((s) => (
          <div key={s.star.id} className="cm-side">
            <p className="cm-strong">{s.star.reading}</p>
            <AsWritten text={s.star.statement} className="cm-raw" />
            <TruthLine truth={s.star.truth} compact />
            <ul className="cm-side-facts">
              <li>{s.star.independent} independent {s.star.independent === 1 ? 'source' : 'sources'}</li>
              <li>
                {plural(s.forCount, 'report')} for, {s.againstCount} against
              </li>
              <li>{s.rivals} {s.rivals === 1 ? 'rival' : 'rivals'}</li>
              <li>{s.gaps.length ? s.gaps.map((g) => gapWords(g.reason)).join('; ') : 'No research gaps'}</li>
            </ul>
          </div>
        ))}
      </div>
      {c.notes.map((n) => (
        <p key={n} className="cm-muted">
          {n}
        </p>
      ))}
    </div>
  )
}

/* ================================================================ results */

export function Outcomes({ cs }: { cs: CommonsState }) {
  return (
    <div className="cm-outcomes" role="status" aria-live="polite">
      {cs.outcomes.map((o) => (
        <div key={o.at} className="cm-outcome" data-tone={o.tone}>
          <p>{plainText(o.text)}</p>
          <div className="cm-row">
            {o.goal && cs.scope && (
              <button type="button" className="cm-btn cm-btn-quiet" onClick={() => navigate({ name: 'tasks', swarm: cs.scope!, task: o.goal })}>
                Open the task
              </button>
            )}
            {!o.goal && o.goals && cs.scope && (
              <button type="button" className="cm-btn cm-btn-quiet" onClick={() => navigate({ name: 'tasks', swarm: cs.scope! })}>
                Open the swarm’s tasks
              </button>
            )}
            <button type="button" className="cm-btn cm-btn-quiet" onClick={() => cs.dismiss(o.at)} aria-label="Dismiss this message">
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ================================================================ the decision */

/** The host DecisionDialog with everything the decision involves, bound to what was read. */
export function AskDialog({ cs }: { cs: CommonsState }) {
  const ask = cs.ask
  if (!ask || !cs.bound) return null
  const def = cs.declared(ask.action)
  const label = def?.label ?? (ask.action === 'challenge' ? 'Look for counterevidence' : 'Research this')
  const where = cs.swarmName ? `the ${cs.swarmName} swarm` : 'this swarm'
  const reading = readStatement(ask.seen.statement)
  const facts: [string, ReactNode][] = [
    ['Belief', <span key="b"><span className="cm-dlg-reading">{reading}</span><br /><AsWritten text={ask.seen.statement} /></span>],
    ['Truth now', ask.seen.truth],
    ['Independent sources', `${ask.seen['independent sources']}${ask.sources.length ? `: ${ask.sources.join(', ')}` : ''}`],
    ...(ask.gap ? [['Missing research', `${gapWords(ask.gap.reason)}. ${plainText(ask.gap.label)}`] as [string, ReactNode]] : [['Missing research', ask.seen['missing research']] as [string, ReactNode]]),
    [
      'What happens',
      ask.action === 'challenge'
        ? `${cs.program.name} posts a task to ${where}: find counterevidence for this belief. Minds there can take it up and may spend their budget on it.`
        : `${cs.program.name} posts a task to ${where}: research this belief until it has more independent evidence. Minds there can take it up and may spend their budget on it.`,
    ],
    ['What does not', 'Nothing in the commons changes now. The belief moves only when minds publish what they find.'],
    ['Bound to', `Commons revision ${ask.seen['commons revision']}. If the commons changes before you decide, this turns off and nothing is sent.`],
  ]
  return (
    <DecisionDialog
      key={ask.seq}
      icon="flask"
      eyebrow={`${cs.program.name} · posts a task`}
      title={ask.action === 'challenge' ? 'Ask the swarm to look for counterevidence?' : 'Ask the swarm to research this?'}
      facts={facts}
      bound={cs.bound}
      thing="This belief"
      dismissLabel="Not now"
      onClose={cs.closeAsk}
      actions={[{ label, busyLabel: 'Posting', tone: 'primary', run: cs.decide }]}
    />
  )
}

/* ================================================================ the side panel / sheet (classic and canvas) */

/**
 * The unfolded belief beside the sky (wide screens) or over it (phones, short landscape). Over the sky it makes the
 * sky inert, so focus and the screen reader stay in it; the heading takes focus on open; Escape and Close return
 * focus to the star or card that opened it.
 */
export function Panel({ cs, overlay }: { cs: CommonsState; overlay: boolean }) {
  const head = useRef<HTMLHeadingElement>(null)
  const id = useId()
  const openId = cs.openId
  useEffect(() => {
    if (openId) head.current?.focus({ preventScroll: false })
  }, [openId])
  if (!openId) return null
  return (
    <aside className="cm-panel" data-overlay={overlay || undefined} aria-labelledby={`${id}-x`} role={overlay ? 'dialog' : 'region'} aria-modal={overlay ? 'true' : undefined}>
      <span id={`${id}-x`} className="sr-only">
        Belief unfolded
      </span>
      <div className="cm-panel-bar">
        <span className="cm-eyebrow">
          <Glyph size={13} /> The commons{cs.swarmName ? ` · ${cs.swarmName}` : ''}
        </span>
        <button type="button" className="cm-btn cm-close" onClick={cs.closeBelief} aria-label="Close the belief and return to the sky">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <span className="cm-close-label">Close</span>
        </button>
      </div>
      <div className="cm-panel-scroll">
        <BeliefBody cs={cs} headingRef={head} onClose={cs.closeBelief} />
      </div>
    </aside>
  )
}
