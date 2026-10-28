import { gapWords } from './model'
import { useMedia } from './hooks'
import { AskDialog, Glyph, Panel, Toolbar, TruthLine } from './parts'
import type { CommonsState } from './useCommons'
import { plural } from '../../lib/plural'

/**
 * Canvas: the commons as a board. Each constellation is an island on the dotted paper; each belief a card with its
 * reading, statement, truth and standing. A card unfolds into the inspector (beside the board when wide, over it on
 * phones); its rivals are marked on the board while it is open.
 */
export function Canvas({ cs }: { cs: CommonsState }) {
  const wide = useMedia('(min-width: 1100px)')
  const overlay = !wide && !!cs.openId
  const rivals = new Set(cs.unfolded && cs.openId ? cs.unfolded.rivals.map((r) => r.id) : [])
  const shown = cs.sky.constellations.map((c) => ({ c, stars: c.stars.filter((s) => cs.visible.has(s.id)) })).filter((x) => x.stars.length)
  return (
    <div className="cm-layout" data-open={cs.openId ? '' : undefined}>
      <div className="cm-main" inert={overlay || undefined}>
        <header className="cm-board-head">
          <span className="cm-badge" aria-hidden="true">
            <Glyph size={18} />
          </span>
          <div className="cm-board-titles">
            <p className="cm-eyebrow">The commons{cs.swarmName ? ` · ${cs.swarmName}` : ''}</p>
            <h2 className="cm-title">{cs.sky.question}</h2>
            <p className="cm-lede">
              {plural(cs.sky.stars.length, 'belief')} · <span data-tone="cyan">{cs.sky.well} well supported</span> · <span data-tone="warn">{new Set(cs.sky.gaps.map((g) => g.belief)).size} missing research</span>
            </p>
          </div>
        </header>
        <Toolbar cs={cs} />
        {cs.sky.stars.length === 0 ? (
          <div className="cm-empty">
            {cs.sky.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        ) : shown.length === 0 ? (
          <p className="cm-empty">No belief matches. Clear the search or choose All.</p>
        ) : (
          <div className="cm-islands">
            {shown.map(({ c, stars }) => (
              <section key={c.id} className="cm-island" aria-labelledby={`cm-i-${c.id}`}>
                <h3 className="cm-island-title" id={`cm-i-${c.id}`}>
                  {c.name}
                  <span className="cm-const-n">{stars.length}</span>
                </h3>
                <ul className="cm-cards">
                  {stars.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className="cm-card"
                        aria-expanded={cs.openId === s.id}
                        data-open={cs.openId === s.id || undefined}
                        data-rival={rivals.has(s.id) || undefined}
                        onClick={(e) => cs.openBelief(s.id, e.currentTarget)}
                      >
                        <span className="cm-card-top">
                          <span className="cm-card-reading">{s.reading}</span>
                          {rivals.has(s.id) && <span className="cm-chip" data-tone="against">Rival of the open belief</span>}
                        </span>
                        <TruthLine truth={s.truth} compact />
                        <span className="cm-chips">
                          <span className="cm-chip">
                            {s.independent} {s.independent === 1 ? 'source' : 'sources'}
                          </span>
                          {s.well && (
                            <span className="cm-chip" data-tone="cyan">
                              Well supported
                            </span>
                          )}
                          {s.gaps.map((g) => (
                            <span key={g.id} className="cm-chip" data-tone="warn">
                              {gapWords(g.reason)}
                            </span>
                          ))}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        {cs.sky.stars.length > 0 && cs.sky.notes.length > 0 && (
          <aside className="cm-notes" aria-label="Notes from the app">
            {cs.sky.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </aside>
        )}
      </div>
      <Panel cs={cs} overlay={overlay} />
      <AskDialog cs={cs} />
    </div>
  )
}
