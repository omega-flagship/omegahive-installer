import { plural } from '../../lib/plural'
import { useEffect, useId, useRef, useState } from 'react'
import type { SwarmArtifact } from '../../api/moneyWork'
import { navigate, openInDesign } from '../../lib/router'
import { Icon } from '../../ui/Icon'
import { current, type Doc, type Revision, type Scene } from './model'
import { ScenePicture } from './Stage'
import type { CanvasState, Notice } from './useCanvas'
import { DELIVER_NOTE, EMPTY_BODY, EMPTY_TITLE, MODES, PICTURE_ACTION, SUGGESTIONS, type Mode } from './words'

/**
 * Everything around the work, kept quiet: the top line (title, the three states of the canvas, zoom, undo), one
 * notice at a time, Compare and Deliver as states of the same canvas, the pull-up drawer, and the empty, loading and
 * error states. No panels: each appears in place and recedes.
 */

// ------------------------------------------------------------------ the top line

export function TopLine({ s, zoom, onFit, onZoom, phone }: { s: CanvasState; zoom: number | null; onFit: () => void; onZoom: (f: number) => void; phone: boolean }) {
  const rev = s.revision
  const groupId = useId()
  return (
    <div className="dc-top dc-recede">
      <div className="dc-title" data-tour="design-title">
        <span className="dc-title-text">{s.scene?.title ?? 'Design'}</span>
        {rev && (
          <span className={s.dirty ? 'dc-state dc-state-dirty' : 'dc-state'}>
            {s.dirty ? 'Changes not kept yet' : `Revision ${rev.revision}`}
          </span>
        )}
      </div>
      <div className="dc-modes" role="radiogroup" aria-labelledby={`${groupId}-label`} data-tour="design-modes">
        <span id={`${groupId}-label`} className="sr-only">What the canvas shows</span>
        {MODES.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={s.mode === m.id} className="dc-mode" title={m.hint} onClick={() => s.setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="dc-tools">
        <button type="button" className="dc-tool" onClick={s.undo} disabled={!s.canUndo} aria-label="Undo" title="Undo (⌘Z)">
          <Icon name="stepBack" size={16} />
        </button>
        {!phone && (
          <button type="button" className="dc-tool" onClick={s.redo} disabled={!s.canRedo} aria-label="Redo" title="Redo (⇧⌘Z)">
            <Icon name="stepFwd" size={16} />
          </button>
        )}
        {!phone && s.mode === 'make' && (
          <>
            <button type="button" className="dc-tool" onClick={() => onZoom(1 / 1.25)} aria-label="Zoom out" title="Zoom out (−)">
              <Icon name="zoomOut" size={16} />
            </button>
            <button type="button" className="dc-tool dc-zoom" onClick={onFit} aria-label={`Fit the design to the screen${zoom ? `, now ${Math.round(zoom * 100)} percent` : ''}`} title="Fit (0)">
              {zoom ? `${Math.round(zoom * 100)}%` : 'Fit'}
            </button>
            <button type="button" className="dc-tool" onClick={() => onZoom(1.25)} aria-label="Zoom in" title="Zoom in (+)">
              <Icon name="zoomIn" size={16} />
            </button>
          </>
        )}
        {phone && s.mode === 'make' && (
          <button type="button" className="dc-tool dc-zoom" onClick={onFit} aria-label="Fit the design to the screen">
            Fit
          </button>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ one notice at a time

export function NoticeLine({ n, onClose }: { n: Notice | null; onClose: () => void }) {
  useEffect(() => {
    if (!n || n.tone !== 'ok') return
    const t = window.setTimeout(onClose, 6000)
    return () => window.clearTimeout(t)
  }, [n, onClose])
  return (
    <div className="dc-notice-wrap" aria-live="polite" role="status">
      {n && (
        <div className="dc-notice" data-tone={n.tone}>
          <span>{n.text}</span>
          {n.action && (
            <button type="button" className="dc-notice-act" onClick={() => (n.action!.run(), onClose())}>
              {n.action.label}
            </button>
          )}
          <button type="button" className="dc-notice-x" aria-label="Dismiss" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ Compare: the directions side by side

export function Compare({ s, ask }: { s: CanvasState; ask: (t: string) => void }) {
  const doc = s.doc!
  const dirs = doc.base.project?.directions ?? []
  const cur = current(doc).scene
  return (
    <div className="dc-compare" role="region" aria-label="Directions side by side">
      <figure className="dc-card dc-card-current">
        <div className="dc-card-art">
          <ScenePicture scene={cur} label={`The design as it is now: ${cur.title}`} />
        </div>
        <figcaption>
          <strong>As it is now</strong>
          <span>Revision {current(doc).revision}{s.dirty ? ', not kept yet' : ''}</span>
        </figcaption>
      </figure>
      {dirs.map((d) => (
        <figure key={d.id} className="dc-card">
          <div className="dc-card-art">
            <ScenePicture scene={d.scene} label={`Direction ${d.label}`} />
          </div>
          <figcaption>
            <strong>{d.label}</strong>
            {d.rationale && <span>{d.rationale}</span>}
            <button type="button" className="dc-card-act" onClick={() => ask(`Continue with the “${d.label}” direction`)}>
              Continue with this one
            </button>
          </figcaption>
        </figure>
      ))}
      <div className="dc-card dc-card-more">
        <p>{dirs.length ? 'Want a different take?' : 'There are no other directions yet.'}</p>
        <button type="button" className="dc-card-act" onClick={() => ask('Suggest another direction for this design, keeping the brief')}>
          Ask for another direction
        </button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ Deliver: one card, every way out behind a confirm

export function Deliver({ s, ask }: { s: CanvasState; ask: (t: string) => void }) {
  const doc = s.doc!
  const rev = current(doc)
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => first.current?.focus(), [])
  return (
    <div className="dc-deliver" role="region" aria-label="Deliver">
      <div className="dc-deliver-card">
        <div className="dc-deliver-art">
          <ScenePicture scene={rev.scene} label={`${rev.scene.title}, revision ${rev.revision}`} />
        </div>
        <div className="dc-deliver-body">
          <h2 className="dc-deliver-title">{rev.scene.title}</h2>
          <p className="dc-deliver-meta">
            {s.dirty ? `Revision ${rev.revision}, with changes the hive does not have yet.` : `Revision ${rev.revision}, as kept in the hive.`}
          </p>
          <div className="dc-deliver-acts">
            <button ref={first} type="button" className="dc-primary" disabled={!s.dirty || !!s.busy} onClick={() => void s.keep()}>
              {s.busy === 'saving' ? 'Keeping…' : s.dirty ? 'Keep this version in the hive' : 'Already kept'}
            </button>
            <button type="button" className="dc-secondary" onClick={() => void s.download()}>
              {PICTURE_ACTION}
            </button>
            <button type="button" className="dc-secondary" onClick={() => ask('Share this design with my swarm')}>
              Share…
            </button>
          </div>
          <p className="dc-deliver-note">{DELIVER_NOTE}</p>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ the pull-up drawer: brief, versions, sources, receipts, tools

export function Drawer({ s, open, onOpen, onClose }: { s: CanvasState; open: boolean; onOpen: () => void; onClose: () => void }) {
  const handle = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number } | null>(null)
  const id = useId()
  const wasOpen = useRef(open)
  useEffect(() => {
    if (open) sheet.current?.focus()
    else if (wasOpen.current) handle.current?.focus()
    wasOpen.current = open
  }, [open])
  if (!s.doc) return null
  const doc = s.doc
  return (
    <>
      <button
        ref={handle}
        type="button"
        className="dc-drawer-handle dc-recede"
        aria-expanded={open}
        aria-controls={`${id}-sheet`}
        onClick={() => (open ? onClose() : onOpen())}
        onPointerDown={(e) => (drag.current = { y: e.clientY })}
        onPointerUp={(e) => {
          if (drag.current && drag.current.y - e.clientY > 24) onOpen()
          drag.current = null
        }}
      >
        <span className="dc-grip" aria-hidden="true" />
        Brief, versions &amp; sources
      </button>
      {open && (
        <div
          ref={sheet}
          id={`${id}-sheet`}
          className="dc-drawer"
          role="region"
          aria-label="Brief, versions and sources"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              onClose()
            }
          }}
        >
          <div className="dc-drawer-head">
            <button type="button" className="dc-grip-btn" aria-label="Close" onClick={onClose}>
              <span className="dc-grip" aria-hidden="true" />
            </button>
          </div>
          <div className="dc-drawer-body">
            <Brief doc={doc} />
            <Versions s={s} />
            <Sources doc={doc} />
            <Receipts s={s} />
            <Tools doc={doc} />
          </div>
        </div>
      )}
    </>
  )
}

function Brief({ doc }: { doc: Doc }) {
  const b = doc.base.project?.brief
  const criteria = current(doc).scene.criteria
  return (
    <section className="dc-sec" aria-labelledby="dc-brief">
      <h3 id="dc-brief">The want</h3>
      {b?.purpose && <p className="dc-lead">{b.purpose}</p>}
      {b?.audience && <p className="dc-quiet">For {b.audience.charAt(0).toLowerCase() + b.audience.slice(1)}</p>}
      {criteria.length > 0 && (
        <ul className="dc-list">
          {criteria.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
      <p className="dc-quiet">The brief and these criteria travel with every version; changing them is a request to Design, not an edit here.</p>
    </section>
  )
}

const short = (d: string) => `${d.slice(0, 15)}…${d.slice(-4)}`
const changesSaid = (r: Revision) => {
  const n = Array.isArray(r.changes) ? r.changes.length : 0
  return r.parent ? `${n} change${n === 1 ? '' : 's'}` : 'first version'
}

function Versions({ s }: { s: CanvasState }) {
  const doc = s.doc!
  const rows = doc.history.map((r, i) => ({ r, i })).reverse()
  return (
    <section className="dc-sec" aria-labelledby="dc-versions">
      <h3 id="dc-versions">Versions</h3>
      <ol className="dc-versions">
        {rows.map(({ r, i }) => (
          <li key={`${r.revision}-${r.digest}-${i}`} aria-current={i === doc.cursor ? 'true' : undefined} data-local={i > doc.floor || undefined}>
            <span className="dc-v-n">r{r.revision}</span>
            <span className="dc-v-what">
              {changesSaid(r)}
              {i === doc.cursor ? ' · on the canvas' : ''}
              {i > doc.floor ? ' · not kept yet' : ''}
            </span>
            <code className="dc-v-d" title={r.digest}>{short(r.digest)}</code>
          </li>
        ))}
      </ol>
      <p className="dc-quiet">Undo and redo move through the versions made here. Earlier versions are kept as Design recorded them.</p>
    </section>
  )
}

function Sources({ doc }: { doc: Doc }) {
  const p = doc.base.provenance
  return (
    <section className="dc-sec" aria-labelledby="dc-sources">
      <h3 id="dc-sources">Where this came from</h3>
      <dl className="dc-facts">
        <dt>Opened from</dt>
        <dd>
          <code>{doc.reference.artifact_id}</code> revision {doc.reference.revision}
        </dd>
        {p?.kind && (
          <>
            <dt>Made by</dt>
            <dd>{p.kind.replace(/-/g, ' ')}</dd>
          </>
        )}
        {p?.source_reference && (
          <>
            <dt>Built on</dt>
            <dd>
              <code>{p.source_reference.artifact_id}</code> revision {p.source_reference.revision}
            </dd>
          </>
        )}
        {p && (
          <>
            <dt>Assessment</dt>
            <dd>{p.assessment ?? 'not stated'}{p.adopted === false ? '; not adopted' : p.adopted ? '; adopted' : ''}</dd>
          </>
        )}
      </dl>
    </section>
  )
}

function Receipts({ s }: { s: CanvasState }) {
  return (
    <section className="dc-sec" aria-labelledby="dc-receipts">
      <h3 id="dc-receipts">Custody receipts</h3>
      {s.receipts.length === 0 ? (
        <p className="dc-quiet">Nothing has left the canvas in this visit. Keeping a version or saving a picture is recorded here.</p>
      ) : (
        <ul className="dc-list">
          {s.receipts.map((r, i) => (
            <li key={i}>
              <strong>{r.outcome === 'kept' ? 'Kept' : r.outcome === 'downloaded' ? 'Saved to this device' : r.outcome === 'unknown' ? 'Outcome not known' : 'Not kept'}</strong> · {r.what}
              {r.reference && (
                <>
                  {' '}
                  · <code title={r.reference.digest}>{r.reference.artifact_id} r{r.reference.revision}</code>
                </>
              )}
              <span className="dc-quiet"> · {new Date(r.at).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Tools({ doc }: { doc: Doc }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const rev = current(doc)
  return (
    <section className="dc-sec dc-tools-sec">
      <button type="button" className="dc-tools-btn" aria-expanded={open} aria-controls={`${id}-tools`} onClick={() => setOpen(!open)}>
        <Icon name="terminal" size={15} /> Tools
      </button>
      {open && (
        <div id={`${id}-tools`} className="dc-tools-body">
          <dl className="dc-facts">
            <dt>Exact reference</dt>
            <dd><code>{JSON.stringify(doc.reference)}</code></dd>
            <dt>Schema</dt>
            <dd><code>{doc.base.schema}</code> · scene <code>{rev.scene.schema}</code></dd>
            <dt>On the canvas</dt>
            <dd>revision {rev.revision} · <code>{rev.digest}</code></dd>
            <dt>Artboard</dt>
            <dd>{rev.scene.width} × {rev.scene.height} · {plural(rev.scene.elements.length, 'element')}</dd>
          </dl>
          <p className="dc-quiet">Design’s Python and developer tools stay in Design’s own Studio (Ω → View → Studio).</p>
        </div>
      )}
    </section>
  )
}

// ------------------------------------------------------------------ states: empty, loading, error

export function Empty({ ask, askReady, recent, scope }: { ask: (t: string) => void; askReady: boolean; recent: SwarmArtifact[] | null; scope?: string }) {
  return (
    <div className="dc-empty">
      <h2 className="dc-empty-title">{EMPTY_TITLE}</h2>
      <p className="dc-empty-body">{askReady ? EMPTY_BODY : 'Start from one of these.'}</p>
      <div className="dc-suggest">
        {SUGGESTIONS.map((x) => (
          <button key={x.label} type="button" className="dc-suggestion" onClick={() => ask(x.ask)}>
            <Icon name="sparkles" size={15} />
            {x.label}
          </button>
        ))}
      </div>
      {scope && recent && recent.length > 0 && (
        <div className="dc-recent" data-tour="design-recent">
          <p className="dc-quiet">Or pick up where you left off</p>
          <ul>
            {recent.map((a) => (
              <li key={a.artifact_id}>
                <button type="button" className="dc-recent-btn" onClick={() => {
                  const r = openInDesign({ artifact_id: a.artifact_id, revision: a.revision, digest: a.digest }, scope)
                  if (r) navigate(r)
                }}>
                  {a.title || a.artifact_id} <span className="dc-quiet">· revision {a.revision}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export function Skeleton({ reduced }: { reduced: boolean }) {
  return (
    <div className="dc-skeleton" data-still={reduced || undefined} role="status" aria-label="Opening the design">
      <div className="dc-skel-board">
        <span className="dc-skel-bar" style={{ width: '22%' }} />
        <span className="dc-skel-bar dc-skel-big" style={{ width: '64%' }} />
        <span className="dc-skel-bar dc-skel-big" style={{ width: '48%' }} />
        <span className="dc-skel-bar" style={{ width: '40%' }} />
      </div>
    </div>
  )
}

export function ErrorState({ text, actions }: { text: string; actions: { label: string; run: () => void }[] }) {
  return (
    <div className="dc-error" role="alert">
      <p>{text}</p>
      <div className="dc-error-acts">
        {actions.map((a) => (
          <button key={a.label} type="button" className="dc-secondary" onClick={a.run}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export type { Mode, Scene }
