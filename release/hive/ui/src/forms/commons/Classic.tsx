import { plural } from '../../lib/plural'
import { useMemo } from 'react'
import { brightnessOf, labelBox, labelled, placeStars, radiusOf, starLabel, type Constellation as C, type Star } from './model'
import { useMedia, useRoving, useWidth } from './hooks'
import { AskDialog, Glyph, Legend, Panel, Toolbar } from './parts'
import type { CommonsState } from './useCommons'

/**
 * Classic: the commons as a living sky in the hive's own night. Constellations are beliefs that share a term; a star's
 * size is its independent sources, its brightness its NAL expectation; a cyan ring is "well supported", a dashed
 * halo is missing research. Unfolding a star opens it beside the sky (wide) or over it (phone), where its rivals are
 * drawn back into the sky as opposed pairs.
 */

function StarMark({ s, open, rival }: { s: Star; open: boolean; rival: boolean }) {
  const r = radiusOf(s)
  const b = brightnessOf(s)
  return (
    <svg className="cm-starmark" width="44" height="44" viewBox="-22 -22 44 44" aria-hidden="true" focusable="false" data-open={open || undefined} data-rival={rival || undefined}>
      {s.gaps.length > 0 && <circle r={r + 7} className="cm-halo" />}
      <circle r={r + 6} className="cm-glowdisc" style={{ opacity: 0.18 + 0.4 * b }} />
      {s.well && <circle r={r + 3.5} className="cm-ring" />}
      <circle r={r} className="cm-core" style={{ opacity: b }} />
      <path d={`M0 ${-r - 4}V${r + 4}M${-r - 4} 0H${r + 4}`} className="cm-spike" style={{ opacity: 0.25 + 0.5 * b }} />
    </svg>
  )
}

function Constellation({ c, cs, roving }: { c: C; cs: CommonsState; roving: ReturnType<typeof useRoving> }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const stars = c.stars.filter((s) => cs.visible.has(s.id))
  const sp = labelled(width || 320)
  const lb = labelBox(sp)
  const { at, height } = useMemo(() => placeStars(stars.map((s) => s.id), width || 320, sp), [stars, width, sp])
  const pos = new Map(stars.map((s, i) => [s.id, at[i]]))
  const rivals = new Set(cs.unfolded && cs.openId ? cs.unfolded.rivals.map((r) => r.id) : [])
  const open = cs.openId && pos.has(cs.openId) ? cs.openId : null
  if (!stars.length) return null
  const path = at.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  return (
    <section className="cm-const" data-large={stars.length > 4 || undefined} aria-labelledby={`cm-c-${c.id}`}>
      <h3 className="cm-const-name" id={`cm-c-${c.id}`}>
        {c.name}
        <span className="cm-const-n">
          {stars.length} {stars.length === 1 ? 'belief' : 'beliefs'}
        </span>
      </h3>
      <div ref={ref} className="cm-field" style={{ height }}>
        <svg className="cm-lines" width="100%" height={height} aria-hidden="true" focusable="false">
          {stars.length > 1 && <path d={path} className="cm-line" />}
          {open &&
            [...rivals].filter((id) => pos.has(id)).map((id) => {
              const a = pos.get(open)!
              const b = pos.get(id)!
              return <line key={id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="cm-rivalline" />
            })}
        </svg>
        {stars.map((s) => {
          const p = pos.get(s.id)!
          const w = Math.max(44, lb.w)
          return (
            <button
              key={s.id}
              ref={roving.ref(s.id)}
              type="button"
              className="cm-star"
              tabIndex={roving.tabIndex(s.id)}
              onFocus={() => roving.setActive(s.id)}
              aria-label={starLabel(s)}
              aria-expanded={cs.openId === s.id}
              data-open={cs.openId === s.id || undefined}
              data-rival={rivals.has(s.id) || undefined}
              style={{ left: p.x - w / 2, top: p.y - 22, width: w }}
              onClick={(e) => cs.openBelief(s.id, e.currentTarget)}
            >
              <StarMark s={s} open={cs.openId === s.id} rival={rivals.has(s.id)} />
              <span className="cm-star-label" aria-hidden="true" style={{ maxHeight: lb.h }}>
                {s.reading}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

export function Classic({ cs }: { cs: CommonsState }) {
  const wide = useMedia('(min-width: 1100px)')
  const order = useMemo(() => cs.sky.constellations.flatMap((c) => c.stars.filter((s) => cs.visible.has(s.id)).map((s) => s.id)), [cs.sky, cs.visible])
  const roving = useRoving(order)
  const overlay = !wide && !!cs.openId
  return (
    <div className="cm-layout" data-open={cs.openId ? '' : undefined}>
      <div className="cm-main" inert={overlay || undefined}>
        <header className="cm-head">
          <p className="cm-eyebrow">
            <Glyph /> The commons{cs.swarmName ? ` · ${cs.swarmName}` : ''}
          </p>
          <h2 className="cm-title">{cs.sky.question}</h2>
          <p className="cm-lede">
            <span>{plural(cs.sky.stars.length, 'shared belief')}</span>
            <span aria-hidden="true"> · </span>
            <span data-tone="cyan">{cs.sky.well} well supported</span>
            <span aria-hidden="true"> · </span>
            <span data-tone="warn">{new Set(cs.sky.gaps.map((g) => g.belief)).size} missing research</span>
          </p>
          <Legend />
        </header>
        <Toolbar cs={cs} />
        {cs.sky.stars.length === 0 ? (
          <div className="cm-empty">
            <p className="cm-title-s">An empty sky</p>
            {cs.sky.notes.map((n) => (
              <p key={n} className="cm-muted">
                {n}
              </p>
            ))}
          </div>
        ) : order.length === 0 ? (
          <p className="cm-empty cm-muted">No belief matches. Clear the search or choose All.</p>
        ) : (
          <div className="cm-sky" role="group" aria-label="The sky of shared beliefs. Arrow keys move between stars; Enter unfolds one." onKeyDown={roving.onKeyDown}>
            {cs.sky.constellations.map((c) => (
              <Constellation key={c.id} c={c} cs={cs} roving={roving} />
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
