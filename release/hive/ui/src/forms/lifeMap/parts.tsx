import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Polarity, WorkItem } from '../../api/types'
import { MIN_DWELL_MS, REFUSAL_TEXT } from './consent'
import {
  actionsFor,
  evidenceOf,
  fmtDate,
  KIND_WORD,
  lowerFirst,
  POLARITY_WORD,
  provenanceOf,
  readingOf,
  readingSentence,
  restingName,
  STRUCTURE,
  structuresSpanned,
  TERRITORY,
  uncertaintyText,
  weightText,
  type Reading,
} from './model'
import { BUDGETS, EXPIRIES, pendingFor, snapshotScope, untilText } from './requests'
import { paramsSummary } from '../../lib/hostConfirm'
import { consentParams, draftMissing, type Atlas, type Reveal } from './useAtlas'
import { LEVEL_NAMES, type Level } from './types'
import { useModalContainment } from '../../ui/useModalContainment'

/* ================================================================ identity */

/** ◎ — the Atlas mark: coral core, sky ring, dotted horizon (the legacy mark, in the hive's coral and sky). */
export function AtlasMark({ size = 26, title }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg className="lm-mark" width={size} height={size} viewBox="0 0 32 32" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff8a7a" />
          <stop offset="1" stopColor="#7fd3ff" />
        </linearGradient>
        <radialGradient id={`c${id}`}>
          <stop offset="0" stopColor="#ffd2c8" />
          <stop offset="1" stopColor="#ff8a7a" />
        </radialGradient>
      </defs>
      <circle cx="16" cy="16" r="4.2" fill={`url(#c${id})`} />
      <circle cx="16" cy="16" r="9.5" fill="none" stroke={`url(#g${id})`} strokeWidth="1.7" />
      <circle cx="16" cy="16" r="14" fill="none" stroke="#7fd3ff" strokeOpacity=".75" strokeWidth="1.2" strokeDasharray="2.2 3.6" />
    </svg>
  )
}

/* ================================================================ sealed values */

/** A value is sealed until the person asks to see it. Sealed, the real figures are not in the DOM at all. */
export function Sealed({ id, reading, reveal, size = 'md', sentence }: { id: string; reading: Reading | null; reveal: Reveal; size?: 'sm' | 'md' | 'lg'; sentence?: boolean }) {
  if (!reading) return <span className="lm-noval">no value recorded</span>
  if (!reveal.shown(id))
    return (
      <button type="button" className="lm-seal" data-size={size} onClick={() => reveal.reveal(id)} aria-label="Sealed value. Press to reveal it for a few seconds.">
        <span className="lm-seal-glyphs" aria-hidden="true">
          {size === 'lg' ? '00.0' : '0.0'}
        </span>
        <span className="lm-seal-hint" aria-hidden="true">
          reveal
        </span>
      </button>
    )
  return (
    <span className="lm-val" data-size={size} data-state={reading.state ?? 'none'}>
      {sentence ? (
        readingSentence(reading)
      ) : (
        <>
          {reading.value}
          {reading.unit && <small>{reading.unit}</small>}
        </>
      )}
    </span>
  )
}

/** The value against its range. Only drawn once revealed: where a mark sits on the bar is itself the value. */
export function RangeBar({ reading }: { reading: Reading }) {
  if (reading.pos == null) return <div className="lm-range lm-range-none">No comparable reference range</div>
  const lo = reading.low != null ? 0.35 / 1.7 : null
  const hi = reading.high != null ? 1 - 0.35 / 1.7 : null
  return (
    <div className="lm-range" role="img" aria-label={readingSentence(reading)}>
      <div className="lm-range-track">
        {lo != null && hi != null && <i className="lm-range-band" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />}
        {lo != null && hi == null && <i className="lm-range-band" style={{ left: `${lo * 100}%`, right: 0 }} />}
        {lo == null && hi != null && <i className="lm-range-band" style={{ left: 0, width: `${hi * 100}%` }} />}
        <b className="lm-range-dot" data-state={reading.state ?? 'none'} style={{ left: `${reading.pos * 100}%` }} />
      </div>
      <div className="lm-range-legend">
        <span>{reading.generic ? 'General range, not the laboratory’s own' : (reading.rangeSource ?? 'Reference interval')}</span>
        <span>
          {reading.low ?? '–'} to {reading.high ?? '–'} {reading.unit}
        </span>
      </div>
    </div>
  )
}

/** The page-wide reveal control: reveal on intent, a visible countdown, re-seal now. */
export function RevealControl({ reveal, sample }: { reveal: Reveal; sample?: boolean }) {
  if (reveal.state.all)
    return (
      <button type="button" className="lm-btn lm-btn-reveal" data-on="y" onClick={() => reveal.conceal()} aria-live="polite">
        <EyeIcon open /> <span className="lm-reveal-long">Sealing in {reveal.seconds ?? 0}s · Seal now</span>
        <span className="lm-reveal-short">{reveal.seconds ?? 0}s</span>
      </button>
    )
  return (
    <button type="button" className="lm-btn lm-btn-reveal" onClick={() => reveal.reveal('*')} title={sample ? 'Reveal the sample values' : 'Reveal values in view; they re-seal when you go quiet'}>
      <EyeIcon /> Reveal values
    </button>
  )
}

export function EyeIcon({ open }: { open?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" />
      {open ? <circle cx="10" cy="10" r="2.4" /> : <path d="M4 16 16 4" />}
    </svg>
  )
}

/* ================================================================ uncertainty, provenance, evidence */

export function UncertaintyChip({ item }: { item: WorkItem }) {
  const u = uncertaintyText(item.uncertainty)
  return (
    <span className="lm-unc" data-assessed={u.assessed ? 'y' : 'n'} title={u.long}>
      <span className="lm-unc-method">{u.assessed ? u.method : 'unassessed'}</span>
      {u.assessed ? u.short.replace(/^[A-Za-z-]+\s/, '') : 'not zero'}
    </span>
  )
}

export function UncertaintyBlock({ item }: { item: WorkItem }) {
  const u = uncertaintyText(item.uncertainty)
  return (
    <div className="lm-unc-block" data-assessed={u.assessed ? 'y' : 'n'}>
      <div className="lm-eyebrow">Uncertainty · by method, never combined</div>
      <p>{u.long}</p>
    </div>
  )
}

function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <section className="lm-sec">
      <h3 className="lm-eyebrow">{title}</h3>
      {note && <p className="lm-note">{note}</p>}
      {children}
    </section>
  )
}

export function ProvenanceChain({ atlas, id }: { atlas: Atlas; id: string }) {
  const p = provenanceOf(atlas.ix, id)
  const item = atlas.ix.byId.get(id)
  const src = item?.sources ?? []
  if (!p.extracted.length && !p.corrects.length && !p.correctedBy.length && !src.length) return <p className="lm-note">No provenance is recorded for this item.</p>
  return (
    <ol className="lm-chain">
      {p.extracted.map((s) => (
        <li key={'e' + s.id} data-status={s.status}>
          <span className="lm-chain-rel">extracted from</span>
          <button type="button" className="lm-link" onClick={() => atlas.select(s.id)}>
            {s.label}
          </button>
          <span className="lm-chain-meta">
            {fmtDate(s.at)} · {s.status}
          </span>
        </li>
      ))}
      {!p.extracted.length &&
        src.map((s) => (
          <li key={'s' + s.id} data-status={String(s.status ?? 'cited')}>
            <span className="lm-chain-rel">cites</span>
            <span>{s.label}</span>
            <span className="lm-chain-meta">{[s.locator, s.date ? fmtDate(String(s.date)) : null, s.status].filter(Boolean).join(' · ')}</span>
          </li>
        ))}
      {p.corrects.map((s) => (
        <li key={'c' + s.id} data-status="retired">
          <span className="lm-chain-rel lm-soft">{s.rel === 'corrects' ? 'corrects' : 'supersedes'}</span>
          <button type="button" className="lm-link" onClick={() => atlas.select(s.id)}>
            {restingName(atlas.ix.byId.get(s.id)!)}
          </button>
          <span className="lm-chain-meta">{fmtDate(s.at)} · now {s.status}</span>
        </li>
      ))}
      {p.correctedBy.map((s) => (
        <li key={'b' + s.id} data-status="broken">
          <span className="lm-chain-rel lm-broken">{s.rel === 'corrects' ? 'corrected by' : 'superseded by'}</span>
          <button type="button" className="lm-link" onClick={() => atlas.select(s.id)}>
            {restingName(atlas.ix.byId.get(s.id)!)}
          </button>
          <span className="lm-chain-meta">{fmtDate(s.at)}</span>
        </li>
      ))}
    </ol>
  )
}

const POLS: Polarity[] = ['support', 'oppose', 'qualify']

/** Support, opposition and qualification side by side, counted separately. Never a single score. */
export function EvidenceColumns({ atlas, id }: { atlas: Atlas; id: string }) {
  const ev = evidenceOf(atlas.ix, id)
  return (
    <div className="lm-evidence">
      {POLS.map((p) => (
        <div key={p} className="lm-evcol" data-pol={p}>
          <div className="lm-evhead">
            <b>{POLARITY_WORD[p]}</b>
            <span>{ev[p].length}</span>
          </div>
          {ev[p].length === 0 && <p className="lm-note">None recorded.</p>}
          <ul>
            {ev[p].slice(0, 8).map(({ item, link }) => (
              <li key={link.id} data-status={item.status ?? 'current'}>
                <button type="button" className="lm-link" onClick={() => atlas.select(item.id)}>
                  {restingName(item)}
                </button>
                <span className="lm-chain-meta">
                  {KIND_WORD[item.kind] ?? item.kind}
                  {item.at ? ` · ${fmtDate(item.at)}` : ''}
                  {item.status && item.status !== 'current' ? ` · ${item.status}` : ''}
                  {weightText(link.weight) ? ` · ${weightText(link.weight)}` : ''}
                </span>
              </li>
            ))}
            {ev[p].length > 8 && <li className="lm-note">and {ev[p].length - 8} more</li>}
          </ul>
        </div>
      ))}
    </div>
  )
}

/* ================================================================ requests */

export function RequestList({ atlas, itemId }: { atlas: Atlas; itemId?: string }) {
  const list = itemId ? atlas.requests.filter((r) => r.items.includes(itemId)) : atlas.requests
  if (!list.length) return null
  const now = atlas.now
  return (
    <ul className="lm-requests">
      {list.map((r) => (
        <li key={r.digest} data-state={r.state}>
          <div className="lm-req-top">
            <span className="lm-req-state">{r.state}</span>
            <code title="Request digest">{r.digest.slice(0, 12)}</code>
            {r.simulated && <span className="lm-sample-chip">simulated</span>}
          </div>
          <div className="lm-req-meta">
            {r.items.map((i) => restingName(atlas.ix.byId.get(i) ?? ({ id: i, kind: '?', label: i } as WorkItem))).join(', ')} · to {r.worker} · budget {Math.round(r.budgetSeconds / 60)} min · {r.state === 'pending' ? `expires ${untilText(r.expiresAt - now)}` : `sent ${new Date(r.sentAt).toLocaleDateString()}`}
          </div>
          {r.state === 'pending' && (
            <div className="lm-actions">
              <button type="button" className="lm-btn lm-btn-sm" onClick={() => void atlas.request('inspect-request', r.items, { request_digest: r.digest })}>
                Inspect
              </button>
              <button type="button" className="lm-btn lm-btn-sm lm-btn-danger" onClick={(e) => void atlas.request('revoke-request', r.items, { request_digest: r.digest }, e.detail === 0)}>
                Revoke access
              </button>
              <button type="button" className="lm-btn lm-btn-sm lm-btn-danger" onClick={(e) => void atlas.request('cancel-request', r.items, { request_digest: r.digest }, e.detail === 0)}>
                Cancel task
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

/* ================================================================ the consent dialog */

const ACTION_HEAD: Record<string, string> = {
  investigate: 'Send a sealed request to a Scientist?',
  'revoke-request': 'Revoke the Scientist’s snapshot access?',
  'cancel-request': 'Cancel the Scientist’s task?',
}

/**
 * The full-context confirm. Focus lands on the heading (never on Confirm); Confirm arms only after the envelope has
 * been on screen for a moment; a held key is refused; a key press must begin inside the dialog; editing anything
 * restarts the review. One opening sends one envelope.
 */
export function ConsentDialog({ atlas }: { atlas: Atlas }) {
  const { draft, gate } = atlas
  const head = useRef<HTMLHeadingElement>(null)
  const box = useRef<HTMLDivElement>(null)
  // Tab and Shift-Tab (from the heading too) stay in the dialog; the map behind is inert until it closes
  useModalContainment(box, { active: !!draft && !!gate })
  // the confirm arms (visibly) once this opening has been on screen for the dwell; any edit restarts it
  const [armedFor, setArmedFor] = useState<number | null>(null)
  const openedAt = gate?.openedAt
  const armed = openedAt != null && armedFor === openedAt
  useEffect(() => {
    head.current?.focus()
  }, [draft?.action])
  useEffect(() => {
    if (openedAt == null) return
    const t = window.setTimeout(() => setArmedFor(openedAt), MIN_DWELL_MS)
    return () => window.clearTimeout(t)
  }, [openedAt])
  if (!draft || !gate) return null
  const items = draft.items.map((i) => atlas.ix.byId.get(i)).filter((x): x is WorkItem => !!x)
  const scope = draft.action === 'investigate' ? snapshotScope(atlas.graph, draft.items) : null
  const missing = draftMissing(draft)
  const sample = atlas.mode === 'sample'
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      atlas.closeConsent()
      return
    }
    atlas.armKey({ key: e.key, repeat: e.repeat })
  }
  const busy = gate.phase === 'submitting'
  return (
    <div className="lm-scrim" onPointerDown={(e) => e.target === e.currentTarget && atlas.closeConsent()}>
      <div ref={box} className="lm-dialog lm-paper" role="dialog" aria-modal="true" aria-labelledby="lm-consent-h" aria-describedby="lm-consent-d" onKeyDown={onKey}>
        {sample && <div className="lm-dialog-sample">SAMPLE · simulated: nothing will be sent</div>}
        <h2 id="lm-consent-h" ref={head} tabIndex={-1}>
          {ACTION_HEAD[draft.action]}
        </h2>
        <p id="lm-consent-d" className="lm-note">
          {draft.action === 'investigate'
            ? 'A Scientist reads a sealed, read-only copy of these records and may stage a proposal. Nothing is admitted to your Atlas without you. You can revoke access or cancel at any time.'
            : draft.action === 'revoke-request'
              ? 'The sealed snapshot becomes unreadable to the Scientist. Work already staged stays unadmitted.'
              : 'The Scientist’s task is cancelled. Stopping a worker that already started is not guaranteed; revoke access as well if it matters.'}
        </p>
        <dl className="lm-envelope">
          <dt>About</dt>
          <dd>
            {items.map((i) => (
              <div key={i.id}>
                <span className="lm-kind" data-kind={i.kind}>
                  {KIND_WORD[i.kind]}
                </span>{' '}
                {i.label}
              </div>
            ))}
          </dd>
          {scope && (
            <>
              <dt>Sealed snapshot</dt>
              <dd>
                {scope.ids.size} records, values included:{' '}
                {Object.entries(scope.byKind)
                  .map(([k, n]) => `${n} ${(KIND_WORD[k] ?? k).toLowerCase()}${n === 1 ? '' : 's'}`)
                  .join(', ')}
                . The premises of these records and the events they cite; nothing else.
              </dd>
              <dt>Allowed</dt>
              <dd>Read the snapshot; stage one proposal to the local exchange. No tools, no other destinations.</dd>
            </>
          )}
          {draft.action !== 'investigate' && (
            <>
              <dt>Request</dt>
              <dd>
                <code>{draft.digest}</code>
              </dd>
            </>
          )}
          {/* Kimi r2 #2: this is the one confirm for the act; it shows what the host's token binds */}
          <dt>Action</dt>
          <dd>
            <code>{draft.action}</code>
            {draft.source ? ` · as of revision ${draft.source.revision}` : ''}
          </dd>
          {draft.action === 'investigate' && (
            <>
              <dt>Access ends</dt>
              <dd>{new Date(gate.openedAt + draft.expiryMs).toLocaleString()}</dd>
            </>
          )}
          <dt>Sends</dt>
          <dd className="lm-sends">{paramsSummary(consentParams(draft, gate))}</dd>
          <dt>What happens</dt>
          <dd>{sample ? 'Nothing leaves this page: the sample only simulates it.' : 'Atlas carries this out as you once you confirm here. The hive checks it is exactly what this envelope shows; you are not asked a second time.'}</dd>
        </dl>
        {draft.action === 'investigate' ? (
          <div className="lm-fields">
            <label>
              <span>Scientist worker</span>
              <input value={draft.worker} onChange={(e) => atlas.editDraft({ worker: e.target.value })} placeholder="Provisioned local worker id" autoComplete="off" spellCheck={false} />
            </label>
            <label>
              <span>Research question</span>
              <textarea value={draft.question} onChange={(e) => atlas.editDraft({ question: e.target.value })} rows={3} />
            </label>
            <div className="lm-fieldrow">
              <label>
                <span>Time budget</span>
                <select value={draft.budget} onChange={(e) => atlas.editDraft({ budget: +e.target.value })}>
                  {BUDGETS.map((b) => (
                    <option key={b.seconds} value={b.seconds}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Access expires after</span>
                <select value={draft.expiryMs} onChange={(e) => atlas.editDraft({ expiryMs: +e.target.value })}>
                  {EXPIRIES.map((x) => (
                    <option key={x.ms} value={x.ms}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        ) : (
          <div className="lm-fields">
            <label>
              <span>Why</span>
              <input value={draft.reason} onChange={(e) => atlas.editDraft({ reason: e.target.value })} placeholder="A few words, kept in the exchange log" />
            </label>
          </div>
        )}
        <div className="lm-dialog-foot">
          <p className="lm-refusal" role="status" aria-live="assertive">
            {atlas.refusal ? REFUSAL_TEXT[atlas.refusal] : missing ? missing : armed ? `Envelope ${gate.digest}. Confirm sends exactly this.` : 'Read the envelope; confirm arms in a moment.'}
          </p>
          <div className="lm-actions">
            <button type="button" className="lm-btn" onClick={atlas.closeConsent}>
              Not now
            </button>
            <button
              type="button"
              className="lm-btn lm-btn-confirm"
              data-armed={armed && !missing && !atlas.stale ? 'y' : 'n'}
              data-danger={draft.action !== 'investigate' ? 'y' : undefined}
              aria-disabled={!armed || !!missing || busy || atlas.stale}
              onKeyDown={(e) => {
                if (e.repeat && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  atlas.setRefusal('repeat')
                }
              }}
              onClick={(e) => void atlas.submitConsent({ kind: e.detail === 0 ? 'key' : 'pointer', digest: gate.digest })}
            >
              {busy ? 'Sending…' : draft.action === 'investigate' ? (sample ? 'Simulate sending' : 'Send sealed request') : draft.action === 'revoke-request' ? 'Revoke access' : 'Cancel task'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ================================================================ the reading sheet (paper) */

function itemTerritory(atlas: Atlas, id: string) {
  const p = atlas.place.get(id)
  return p ? TERRITORY[p.territory] : null
}

/** A record as a page: what it is, its value (sealed), how sure, where it came from, what it bears on. */
export function Reading({ atlas, id, onClose }: { atlas: Atlas; id: string; onClose?: () => void }) {
  const item = atlas.ix.byId.get(id)
  if (!item) return null
  const t = itemTerritory(atlas, id)
  const p = atlas.place.get(id)
  const reading = readingOf(item)
  const acts = actionsFor(atlas.describe, item.kind)
  const isReasoning = item.kind === 'hypothesis' || item.kind === 'prediction' || item.kind === 'experiment'
  const pending = pendingFor(atlas.requests, id)
  const retired = item.status && item.status !== 'current'
  const spanned = isReasoning ? structuresSpanned(atlas.ix, atlas.place, id) : []
  const linkedReasoning = [...(atlas.ix.out.get(id) ?? []), ...(atlas.ix.into.get(id) ?? [])]
    .map((l) => ({ l, it: atlas.ix.byId.get(l.from === id ? l.to : l.from) }))
    .filter((x): x is { l: (typeof x)['l']; it: WorkItem } => !!x.it && ['hypothesis', 'prediction', 'experiment'].includes(x.it.kind) && x.it.id !== id)
  return (
    <article className="lm-reading" style={{ ['--t-ink' as string]: t?.ink ?? '#2b3445' }}>
      <header className="lm-reading-head">
        <div>
          <div className="lm-eyebrow lm-tink">
            {KIND_WORD[item.kind] ?? item.kind}
            {t ? ` · ${t.label}` : ''}
            {p?.structure ? ` · ${STRUCTURE[p.structure].label}` : ''}
          </div>
          <h2 className="lm-reading-title">{item.kind === 'hypothesis' ? `Could it be that ${lowerFirst(item.label)}?` : restingName(item)}</h2>
          <div className="lm-reading-sub">
            {item.at && fmtDate(item.at)}
            {retired && <span className="lm-retired"> · {item.status}</span>}
            {(item.flags ?? []).includes('affected-by-correction') && <span className="lm-retired"> · rests on a corrected record</span>}
            {atlas.mode === 'sample' && <span className="lm-sample-chip">SAMPLE</span>}
          </div>
        </div>
        {onClose && (
          <button type="button" className="lm-close" onClick={onClose} aria-label="Close the reading">
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M5 5l10 10M15 5 5 15" />
            </svg>
          </button>
        )}
      </header>

      {(item.kind === 'observation' || reading) && (
        <section className="lm-hero">
          <Sealed id={id} reading={reading} reveal={atlas.revealer} size="lg" />
          {reading && atlas.revealer.shown(id) && (
            <>
              <p className="lm-hero-line">{readingSentence(reading)}.</p>
              <RangeBar reading={reading} />
            </>
          )}
          {reading && !atlas.revealer.shown(id) && <p className="lm-note">Sealed. Its place against the range is sealed too.</p>}
        </section>
      )}

      {item.text && <p className="lm-body">{item.text}</p>}

      {item.kind !== 'event' && item.kind !== 'subject' && item.kind !== 'question' && (
        <Section title="How sure">
          <UncertaintyBlock item={item} />
        </Section>
      )}

      {isReasoning && (
        <Section title="The evidence, kept apart" note="Counted by recorded links. Link weights are heuristics, never probabilities.">
          <EvidenceColumns atlas={atlas} id={id} />
          {spanned.length > 0 && <p className="lm-note">Spans {spanned.map((s) => STRUCTURE[s].label.toLowerCase()).join(', ')}.</p>}
        </Section>
      )}

      {linkedReasoning.length > 0 && (
        <Section title={isReasoning ? 'Connected reasoning' : 'Bears on'}>
          <ul className="lm-plain">
            {linkedReasoning.slice(0, 8).map(({ l, it }) => (
              <li key={l.id}>
                <span className="lm-rel">{l.rel}</span>{' '}
                <button type="button" className="lm-link" onClick={() => atlas.select(it.id)}>
                  {restingName(it)}
                </button>
                {it.meta?.domain_status ? <span className="lm-chain-meta"> · {String(it.meta.domain_status)}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Provenance">
        <ProvenanceChain atlas={atlas} id={id} />
      </Section>

      {pending.length + atlas.requests.filter((r) => r.items.includes(id) && r.state !== 'pending').length > 0 && (
        <Section title="Scientist requests">
          <RequestList atlas={atlas} itemId={id} />
        </Section>
      )}

      {acts.length > 0 && atlas.mode !== 'empty' && (
        <div className="lm-actions lm-reading-actions">
          {acts
            .filter((a) => a.id === 'inspect-source' || a.id === 'compare' || a.id === 'investigate')
            .map((a) => (
              <button
                key={a.id}
                type="button"
                className={`lm-btn ${a.id === 'investigate' ? 'lm-btn-primary' : ''}`}
                disabled={atlas.busy}
                onClick={(e) => {
                  const ids = a.id === 'compare' ? [id, ...atlas.summary.openHypotheses.map((h) => h.id).filter((h) => h !== id)].slice(0, 4) : [id]
                  void atlas.request(a.id, ids, undefined, e.detail === 0)
                }}
              >
                {a.id === 'investigate' ? 'Ask a Scientist…' : a.id === 'compare' ? 'Compare with open ideas' : (a.label ?? a.id)}
              </button>
            ))}
        </div>
      )}
    </article>
  )
}


/* ================================================================ chrome */

export function ZoomRail({ level, onLevel, names = LEVEL_NAMES }: { level: Level; onLevel: (l: Level) => void; names?: readonly string[] }) {
  return (
    <div className="lm-rail" role="radiogroup" aria-label="Depth">
      {names.map((n, i) => (
        <button key={n} type="button" role="radio" aria-checked={level === i} className="lm-rail-step" data-on={level === i ? 'y' : undefined} onClick={() => onLevel(i as Level)}>
          <i aria-hidden="true" />
          <span>{n}</span>
        </button>
      ))}
    </div>
  )
}

export function Outcomes({ atlas }: { atlas: Atlas }) {
  return (
    <div className="lm-outcomes" role="status" aria-live="polite">
      {atlas.outcomes.map((o) => (
        <div key={o.id} className="lm-outcome" data-tone={o.tone}>
          {o.text}
        </div>
      ))}
    </div>
  )
}
