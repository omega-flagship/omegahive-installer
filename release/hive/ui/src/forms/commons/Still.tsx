import { plural } from '../../lib/plural'
import { useEffect, useRef } from 'react'
import { gapWords, truthShort, truthWords } from './model'
import { AskDialog, BeliefBody, Toolbar } from './parts'
import { AsWritten } from '../../ui/Belief'
import type { CommonsState } from './useCommons'

/**
 * Still: "what the swarm believes", written down. Calm paper, a serif reading of each belief grouped under the term it
 * shares, its standing in words; "Read what lies behind it" unfolds the reports (as numbered notes), the rivals and the
 * missing research in place, in the flow of the page.
 */
export function Still({ cs }: { cs: CommonsState }) {
  const head = useRef<HTMLHeadingElement>(null)
  const openId = cs.openId
  useEffect(() => {
    if (openId) head.current?.focus()
  }, [openId])
  const shown = cs.sky.constellations.map((c) => ({ c, stars: c.stars.filter((s) => cs.visible.has(s.id)) })).filter((x) => x.stars.length)
  return (
    <div className="cm-still">
      <header className="cm-still-head">
        <p className="cm-eyebrow">The commons{cs.swarmName ? ` of ${cs.swarmName}` : ''}</p>
        <h2 className="cm-title">{cs.sky.question}</h2>
        <p className="cm-lede">
          {cs.sky.lede ?? `${plural(cs.sky.stars.length, 'shared belief')}.`} {cs.sky.well} {cs.sky.well === 1 ? 'is' : 'are'} well supported by two or more independent minds;{' '}
          {new Set(cs.sky.gaps.map((g) => g.belief)).size} still {new Set(cs.sky.gaps.map((g) => g.belief)).size === 1 ? 'wants' : 'want'} research.
        </p>
      </header>
      <Toolbar cs={cs} variant="text" />
      {cs.sky.stars.length === 0 ? (
        <div className="cm-empty">
          {cs.sky.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <p className="cm-empty">No belief matches. Clear the search or choose All.</p>
      ) : (
        shown.map(({ c, stars }) => (
          <section key={c.id} className="cm-chapter" aria-labelledby={`cm-s-${c.id}`}>
            <h3 className="cm-chapter-title" id={`cm-s-${c.id}`}>
              {c.id === '~lone' ? 'And on their own' : <>On {c.name}</>}
            </h3>
            {stars.map((s) => {
              const open = openId === s.id
              const panel = `cm-sp-${encodeURIComponent(s.id).replace(/%/g, '')}`
              return (
                <article key={s.id} className="cm-entry" data-open={open || undefined}>
                  <p className="cm-entry-reading">{s.reading}.</p>
                  <p className="cm-entry-meta">
                    <span>{truthWords(s.truth)}</span>
                    <span aria-hidden="true"> · </span>
                    <span>{truthShort(s.truth)}</span>
                    <span aria-hidden="true"> · </span>
                    <span>
                      {s.independent} independent {s.independent === 1 ? 'source' : 'sources'}
                    </span>
                    {s.well && (
                      <>
                        <span aria-hidden="true"> · </span>
                        <span data-tone="cyan">well supported</span>
                      </>
                    )}
                    {s.gaps.length > 0 && (
                      <>
                        <span aria-hidden="true"> · </span>
                        <span data-tone="warn">{s.gaps.map((g) => gapWords(g.reason).toLowerCase()).join('; ')}</span>
                      </>
                    )}
                  </p>
                  <AsWritten text={s.statement} className="cm-raw" />
                  <button
                    type="button"
                    className="cm-disclose"
                    aria-expanded={open}
                    aria-controls={open ? panel : undefined}
                    onClick={(e) => (open ? cs.closeBelief() : cs.openBelief(s.id, e.currentTarget))}
                  >
                    {open ? 'Fold it away' : 'Read what lies behind it'}
                    <span className="sr-only">: {s.reading}</span>
                  </button>
                  {open && (
                    <div id={panel} className="cm-unfold">
                      <BeliefBody cs={cs} level="h4" headingRef={head} onClose={cs.closeBelief} />
                    </div>
                  )}
                </article>
              )
            })}
          </section>
        ))
      )}
      {cs.sky.stars.length > 0 && cs.sky.notes.length > 0 && (
        <aside className="cm-notes" aria-label="Notes from the app">
          {cs.sky.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </aside>
      )}
      <AskDialog cs={cs} />
    </div>
  )
}
