import type { ReactNode } from 'react'
import { ago, clockTime, tvText, until } from '../../../lib/format'
import { BANKED_QUALIFICATION } from '../../guided/banked'
import { MODULE_TITLES, type Envelope, type Item, type ModuleBody, type ModuleId, type Truth } from './contract'
import type { ViewState } from './load'
import { EMPTY_TEXT, plainCode, plainWords, UNAVAILABLE_TEXT } from './words'

/**
 * One reasoning-module viewer (attention, self, energy, scratch, Assume, temporal), in the one viewer frame, for
 * Root's flat typed carrier (v3). Drawn only in the experience's tokens (text-ink-*, border-line), no colour literals.
 *
 * What is never drawn: ids and refs (focus, targets, model refs, relation ends), temporal terms, rule premises and
 * conclusions, evidence and explanation links (counts only), revisions, and scratch text (the carrier has none).
 * Labels are the host's consent-filtered ones; without one a thing is "Item 1". Every host string shown (labels,
 * explanations, units, kinds, qualification) goes through the wording filter; codes from the published closed lists
 * (reasons, modes, states, relations) are said in plain words. Temporal times are the carrier's seconds, said as such.
 *
 * `context`: 'current' is the mind's current-state area (only an actual read reaches it); 'tour' is a guided tour,
 * the one place synthetic and banked are drawn, always under the banked / synthetic label.
 */

/** A validated 64-hex digest, shortened for the eye (the whole one stays in the title). */
const shortDigest = (d: string) => `${d.slice(0, 12)}…`
const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
const when = (iso: string | null) => (iso ? `${clockTime(iso)} (${Date.parse(iso) > Date.now() ? until(iso) : ago(iso)})` : 'none')
const secs = (t: number) => `t=${t}s`
const tv = (t: Truth | null) => (t ? tvText(t.f, t.c) : 'truth unknown')
const reasons = (cs: string[]) => (cs.length ? cs.map(plainCode).join(', ') : 'no reasons given')
const Row = ({ children }: { children: ReactNode }) => <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm text-ink-2">{children}</li>
const Note = ({ children }: { children: ReactNode }) => <p className="text-xs text-ink-3">{children}</p>
const Explain = ({ text }: { text?: string }) => (text ? <span className="basis-full text-xs text-ink-3">{plainWords(text)}</span> : null)
const H = ({ children }: { children: ReactNode }) => <h4 className="text-xs font-medium text-ink-3">{children}</h4>

function General({ items }: { items: Item[] }) {
  if (!items.length) return null
  return <ul className="space-y-1">{items.map((it, i) => <Row key={i}><span>{it.label ? plainWords(it.label) : `Item ${i + 1}`}</span><span className="text-xs text-ink-3">{plainCode(it.kind)}</span><Explain text={it.explain} /></Row>)}</ul>
}

function Body({ env, body }: { env: Envelope; body: ModuleBody }) {
  switch (body.module) {
    case 'attention':
      return <>
        <Note>Focus: {body.focus_ref ? 'held' : 'none'} · {n(body.spread_edges.length, 'spread link')}</Note>
        <ol className="space-y-1">{body.ranked_items.map((r, i) => <Row key={i}><span>{plainWords(r.label)}</span><span className="text-xs text-ink-3">importance {r.score.toFixed(2)} · {reasons(r.reason_codes)}</span><Explain text={r.explain} /></Row>)}</ol>
        <General items={env.items} />
      </>
    case 'energy':
      return <>
        <Note>Mode: {body.mode ? plainCode(body.mode) : 'none'} · next wake: {when(body.next_wake_at)} · asleep until: {when(body.sleep_until)}</Note>
        <ul className="space-y-1"><Row><span>{plainWords(body.budget.unit)}</span><span className="text-xs text-ink-3">spent {body.budget.spent} of {body.budget.limit} · reserved {body.budget.reserved}</span></Row></ul>
        <General items={env.items} />
      </>
    case 'self': {
      const sel = body.selected_skill ? body.skills.find((s) => s.id === body.selected_skill!.id) : undefined
      return <>
        <Note>Latest selection: {sel && body.selected_skill ? `${plainWords(sel.label)}, ${when(body.selected_skill.selected_at)}` : 'none'} · {reasons(body.selection_reason_codes)}</Note>
        <ul className="space-y-1">{body.skills.map((s, i) => <Row key={i}><span>{plainWords(s.label)} <span className="text-xs text-ink-3">v{s.version}</span></span><span className="text-xs text-ink-3">{plainCode(s.availability)}</span><Explain text={s.explain} />
          <details className="basis-full text-xs text-ink-4"><summary>Source digest</summary><code className="break-all" title={s.source_digest}>{shortDigest(s.source_digest)}</code></details></Row>)}</ul>
        <General items={env.items} />
      </>
    }
    case 'scratch':
      return <>
        <Note>No scratch text is read or shown: kind, state and expiry only. Promotion: {reasons(body.promotion_reasons)} · demotion: {reasons(body.demotion_reasons)}</Note>
        <ul className="space-y-1">{body.items.map((it, i) => <Row key={i}><span>{`${plainWords(it.kind)} ${i + 1}`}</span><span className="text-xs text-ink-3">{plainCode(it.promotion_state)} · expires {when(it.expiry)}</span><Explain text={it.explain} /></Row>)}</ul>
      </>
    case 'assume':
      return <>
        <Note>Model: {body.model_ref ? 'held' : 'none'} · {n(body.nodes.length, 'node')} · {n(body.edges.length, 'link')}</Note>
        <ul className="space-y-1">{body.nodes.map((x, i) => <Row key={i}><span>{plainWords(x.label)}</span><span className="text-xs text-ink-3">{plainWords(x.kind)}</span><Explain text={x.explain} /></Row>)}</ul>
        <ul className="space-y-1">
          <Row><span>Prediction</span><span className="text-xs text-ink-3">{body.prediction ? `${body.prediction.value} ${plainWords(body.prediction.unit)}` : 'none'}</span><Explain text={body.prediction?.explain} /></Row>
          <Row><span>Observed outcome</span><span className="text-xs text-ink-3">{body.observed_target ? `${body.observed_target.value} ${plainWords(body.observed_target.unit)}, ${when(body.observed_target.observed_at)}` : 'none'}</span><Explain text={body.observed_target?.explain} /></Row>
          <Row><span>Update</span><span className="text-xs text-ink-3">{body.update_delta ? `${body.update_delta.before} → ${body.update_delta.after} (${body.update_delta.delta}) ${plainWords(body.update_delta.unit)}` : 'none'}</span><Explain text={body.update_delta?.explain} /></Row>
        </ul>
        <General items={env.items} />
      </>
    case 'temporal':
      return <>
        <H>Events</H>
        <ol className="space-y-1">{body.events.map((e, i) => <Row key={i}><span>{`Event ${i + 1}`}</span><span className="text-xs text-ink-3">{tv(e.truth)} · at {secs(e.occurrence_time)} · valid {secs(e.valid_interval[0])}–{secs(e.valid_interval[1])} · {n(e.evidence_refs.length, 'evidence link')}</span><Explain text={e.explain} /></Row>)}</ol>
        <H>Rules</H>
        <ol className="space-y-1">{body.rules.map((r, i) => <Row key={i}><span>{`Rule ${i + 1}`}</span><span className="text-xs text-ink-3">{tv(r.truth)} · lag {r.lag}s · {n(r.evidence_refs.length, 'evidence link')}</span><Explain text={r.explain} /></Row>)}</ol>
        <H>Expectations</H>
        <ol className="space-y-1">{body.expectations.map((x, i) => <Row key={i}><span>{`Expectation ${i + 1}`}</span><span className="text-xs text-ink-3">{plainCode(x.state)}{x.late ? ' (late evidence)' : ''} · due {secs(x.due_interval[0])}–{secs(x.due_interval[1])}</span><Explain text={x.explain} /></Row>)}</ol>
        <ul className="space-y-1">
          <Row><span>Projection</span><span className="text-xs text-ink-3">{body.projection ? `${secs(body.projection.source_time)} → ${secs(body.projection.target_time)} · ${tv(body.projection.truth_before)} → ${tv(body.projection.truth_after)}` : 'none'}</span><Explain text={body.projection?.explain} /></Row>
        </ul>
        <Note>{body.interval_relations.length ? body.interval_relations.map((r) => plainCode(r.relation)).join(', ') : 'No interval relations'} · {n(body.explanation_refs.length, 'explanation link')}</Note>
        <General items={env.items} />
      </>
  }
}

const STATE_WORD: Record<ViewState['kind'], string> = { loading: 'Reading', current: 'Current', empty: 'Current', unavailable: 'Unavailable', synthetic: 'Synthetic', banked: 'Banked' }

export function ModuleViewer({ module, state, context = 'current' }: { module: ModuleId; state: ViewState; context?: 'current' | 'tour' }) {
  // synthetic and banked are never current state: outside a tour they are not drawn at all
  const s: ViewState = context === 'current' && (state.kind === 'synthetic' || state.kind === 'banked') ? { kind: 'unavailable', why: 'unreadable' } : state
  const env = 'envelope' in s ? s.envelope : null
  return <article className="space-y-2 rounded-xl border border-line p-4" data-tour={`module-${module}`} data-state={s.kind} aria-label={`${MODULE_TITLES[module]} viewer`}>
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="font-medium">{MODULE_TITLES[module]}</h3>
      <span className="text-xs text-ink-3">{STATE_WORD[s.kind]}{env && (s.kind === 'current' || s.kind === 'empty') ? ` · observed ${ago(env.observed_at)}` : ''}</span>
    </header>
    {s.kind === 'loading' && <Note>Reading this mind’s {MODULE_TITLES[module].toLowerCase()}…</Note>}
    {s.kind === 'unavailable' && <p className="text-sm text-ink-2" role="status">{UNAVAILABLE_TEXT[s.why]}</p>}
    {(s.kind === 'synthetic' || s.kind === 'banked') && <p className="text-xs text-ink-2">{BANKED_QUALIFICATION}</p>}
    {s.kind === 'empty' && <p className="text-sm text-ink-2" role="status">{EMPTY_TEXT}</p>}
    {env?.body && s.kind !== 'empty' && <Body env={env} body={env.body} />}
    {env?.explain && s.kind !== 'empty' && <Note>{plainWords(env.explain)}</Note>}
    {env && <Note>{plainWords(env.qualification)} · provenance: {n(env.provenance.evidence_refs.length, 'evidence reference')}</Note>}
  </article>
}
