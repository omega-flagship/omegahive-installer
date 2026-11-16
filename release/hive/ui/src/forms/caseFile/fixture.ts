import type { ActionResult, Program, ProgramDescription, WorkGraph } from '../../api/types'

/**
 * A SYNTHETIC investigation for developing and screenshotting the case file. Invented library, invented numbers,
 * example.org references. No real data. The describe() below mirrors OmegaTruth's declared interface (kinds,
 * relation polarities, action ids) so the form is exercised against the real vocabulary.
 */

const ACTIONS: [string, string[], Record<string, string>?][] = [
  ['set-question', ['question'], { text: 'Question to investigate', note: 'Why this question is being set or revised' }],
  ['add-claim', ['question'], { text: 'Claim to test; it will start unassessed' }],
  ['add-hypothesis', ['question'], { text: 'Competing explanation to test; it will start unassessed' }],
  ['add-gap', ['question'], { text: 'Missing observation or unresolved research question' }],
  ['ask-scientist', ['question', 'claim', 'hypothesis', 'gap']],
  ['prepare-bias-pilot', ['question'], { suite: 'label-quality (six trials) or identity-unknown (three trials)' }],
  ['dispatch-bias-trial', ['question'], { pilot_id: 'Private preregistered pilot ID' }],
  ['add-support', ['claim', 'hypothesis'], { text: 'Observation or extract, separate from your interpretation', source_label: 'Source title', locator: 'Page, paragraph, post or timestamp', origin: 'Original reporting origin; use unknown if independence is unknown' }],
  ['add-counterevidence', ['claim', 'hypothesis'], { text: 'Observation or extract, separate from your interpretation', source_label: 'Source title', locator: 'Page, paragraph, post or timestamp', origin: 'Original reporting origin; use unknown if independence is unknown' }],
  ['add-qualification', ['claim', 'hypothesis'], { text: 'Observation or extract, separate from your interpretation', source_label: 'Source title' }],
  ['verify-claim', ['claim']],
  ['audit-symmetry', ['claim', 'hypothesis']],
  ['compare', ['claim', 'hypothesis', 'assessment']],
  ['challenge', ['claim', 'hypothesis', 'assessment']],
  ['ask-challenger', ['assessment']],
  ['record-outcome', ['assessment'], { observed: 'Observed numeric measurement in the predicted unit' }],
  ['inspect-source', ['evidence', 'source']],
  ['retrieve-source', ['evidence', 'source'], { source_id: 'Source ID on the selected record' }],
  ['review-source', ['evidence', 'source'], { source_id: 'Source ID on the selected record', dimension: 'identity, primary-provenance, method, independence, conflicts or corrections', judgment: 'unknown, supported or contested' }],
  ['correct', ['evidence'], { text: 'Corrected wording', note: 'Reason for correction' }],
  ['investigate-gap', ['gap']],
  ['collect-proposal', ['question', 'claim', 'hypothesis', 'assessment', 'gap']],
  ['cancel-analysis', ['question', 'claim', 'hypothesis', 'assessment', 'gap']],
]

const title = (id: string) => id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())

export const fixtureDescribe: ProgramDescription = {
  contract: '0.1',
  kinds: ['question', 'claim', 'evidence', 'hypothesis', 'assessment', 'explanation', 'gap', 'source'].map((k) => ({ id: k, label: k[0].toUpperCase() + k.slice(1), role: k as never })),
  relations: [
    { id: 'answers', label: 'answers', polarity: 'neutral' },
    { id: 'supports', label: 'supports', polarity: 'support' },
    { id: 'contradicts', label: 'contradicts', polarity: 'oppose' },
    { id: 'qualifies', label: 'qualifies', polarity: 'qualify' },
    { id: 'depends_on', label: 'depends on', polarity: 'neutral' },
  ],
  actions: ACTIONS.map(([id, applies_to, params]) => ({ id, label: title(id), applies_to, ...(params ? { params } : {}) })),
}

export const fixtureProgram: Program = {
  id: 'omegatruth',
  name: 'OmegaTruth',
  version: 'synthetic',
  description: 'Synthetic case file fixture.',
  icon: 'flask',
  capabilities: [],
  source: 'built-in',
  enabled: true,
  error: null,
  app: { tagline: 'Follow the evidence. Keep the freedom to decide.' },
}

const src = (id: string, label: string, status: string, origin: string, extra: Record<string, string> = {}) => ({
  id,
  label,
  status,
  origin,
  kind: 'document',
  url: `https://example.org/kestrel/${id}`,
  ...extra,
})

export const fixtureGraph: WorkGraph = {
  contract: '0.1',
  program: 'omegatruth',
  revision: 'r7',
  focus: 'q1',
  title: 'Kestrel Lane library lighting retrofit (synthetic)',
  items: [
    {
      id: 'q1',
      kind: 'question',
      label: 'Did the Kestrel Lane library use less electricity after its lighting retrofit?',
      text: 'The branch replaced its fluorescent fittings with LED panels in September. The board wants to know whether the change, and not something else, lowered the winter bill.',
    },
    {
      id: 'c1',
      kind: 'claim',
      label: 'Winter electricity use fell by about a fifth after the retrofit.',
      uncertainty: { method: 'nal', f: 0.74, c: 0.62 },
    },
    {
      id: 'c2',
      kind: 'claim',
      label: 'The saving came from the lighting, not from shorter opening hours.',
      uncertainty: { method: 'pln', strength: 0.46, confidence: 0.31 },
    },
    {
      id: 'h1',
      kind: 'hypothesis',
      label: 'The LED panels cut the lighting load.',
      uncertainty: { method: 'nal', f: 0.81, c: 0.55 },
    },
    {
      id: 'h2',
      kind: 'hypothesis',
      label: 'Fewer opening hours explain most of the drop.',
      uncertainty: { method: 'qualitative', status: 'plausible' },
    },
    { id: 'h3', kind: 'hypothesis', label: 'A milder winter lowered the heat-pump load.' },
    {
      id: 'x1',
      kind: 'explanation',
      label: 'Both: the retrofit and the shorter week together, in a share not yet measured.',
      uncertainty: { method: 'pln', strength: 0.58, confidence: 0.28 },
    },
    {
      id: 'e1',
      kind: 'evidence',
      label: 'Utility bills: 41,200 kWh from October to March, against 52,900 kWh a year earlier.',
      uncertainty: { method: 'nal', f: 0.9, c: 0.8 },
      sources: [src('s-bills', 'Utility statements, two winters', 'inspected', 'gridco-billing', { locator: 'statements 10/24–03/25 and 10/25–03/26', date: '2026-04-02' })],
    },
    {
      id: 'e2',
      kind: 'evidence',
      label: 'The council energy dashboard shows the same 22% fall.',
      uncertainty: { method: 'qualitative', status: 'consistent' },
      sources: [src('s-dash', 'Council energy dashboard export', 'retrieved', 'gridco-billing', { locator: 'branch 14, monthly kWh' })],
    },
    {
      id: 'e3',
      kind: 'evidence',
      label: 'Lighting sub-meter: 9.1 kWh a day after the retrofit, 15.4 before.',
      uncertainty: { method: 'pln', strength: 0.83, confidence: 0.57 },
      sources: [src('s-submeter', 'Facilities sub-meter log', 'inspected', 'facilities-log', { locator: 'circuit L2, daily totals' })],
    },
    {
      id: 'e4',
      kind: 'evidence',
      label: 'Opening hours were cut from 62 to 54 a week in the same month.',
      sources: [src('s-notice', 'Board notice on opening hours', 'cited', 'library-board', { date: '2025-09-01' })],
    },
    {
      id: 'e5',
      kind: 'evidence',
      label: 'Heating degree days were 14% below the previous winter.',
      uncertainty: { method: 'nal', f: 0.86, c: 0.7 },
      sources: [src('s-weather', 'Regional degree-day series', 'retrieved', 'met-office-synthetic')],
    },
    {
      id: 'e6',
      kind: 'evidence',
      label: 'The main meter was replaced in November, so readings before and after may not be comparable.',
      status: 'corrected',
      flags: [],
      uncertainty: { method: 'qualitative', status: 'unverified' },
      sources: [src('s-ticket', 'Meter exchange ticket', 'unavailable', 'gridco-billing')],
      revisions: [{ revision: 'r5', label: 'The main meter was replaced in October.', note: 'The ticket date was misread; the exchange was on 14 November.', at: '2026-04-11T10:20:00Z' }],
    },
    {
      id: 'e7',
      kind: 'evidence',
      label: 'The retrofit covered only the ground floor, about 60% of the fittings.',
      uncertainty: { method: 'nal', f: 0.95, c: 0.72 },
      sources: [src('s-contract', 'Contractor scope of works', 'inspected', 'brightway-contractor', { locator: 'schedule B' })],
    },
    {
      id: 'e8',
      kind: 'evidence',
      label: 'Press release: the retrofit “cut the bill by 40%”.',
      status: 'retracted',
      sources: [src('s-press', 'Contractor press release', 'cited', 'brightway-contractor')],
      revisions: [{ revision: 'r6', label: 'Press release: the retrofit cut the bill by 40%.', note: 'Retracted: the figure was a projection, not a measurement.', at: '2026-04-12T08:05:00Z' }],
    },
    {
      id: 'a1',
      kind: 'assessment',
      label: 'Electricity use fell. How much of the fall is due to the lighting is unresolved.',
      uncertainty: { method: 'qualitative', status: 'contested' },
      flags: ['affected-by-correction'],
      meta: { proposal: { goal_id: 'g_7f3a21', binding_digest: 'b3c1…9e', transport: 'validated', review: 'pending' } },
    },
    {
      id: 'a2',
      kind: 'assessment',
      label: 'The lighting explains the whole drop.',
      status: 'superseded',
      revisions: [{ revision: 'r4', label: 'The lighting explains the whole drop.', note: 'Superseded once the opening-hours notice was found.', at: '2026-04-09T16:40:00Z' }],
      meta: { proposal: { goal_id: 'g_51c0d2', transport: 'stale', review: 'superseded' } },
    },
    { id: 'g1', kind: 'gap', label: 'No sub-meter data for the heat pump.' },
    { id: 'g2', kind: 'gap', label: 'Were the old and new main meters calibrated against each other?' },
    { id: 'g3', kind: 'gap', label: 'Visitor counts for both winters, to separate use from hours.' },
  ],
  links: [
    { id: 'l1', from: 'c1', to: 'q1', rel: 'answers' },
    { id: 'l2', from: 'c2', to: 'q1', rel: 'answers' },
    { id: 'l3', from: 'e1', to: 'c1', rel: 'supports', weight: 0.8 },
    { id: 'l4', from: 'e2', to: 'c1', rel: 'supports', weight: 0.5 },
    { id: 'l5', from: 'e3', to: 'c1', rel: 'supports', weight: 0.7 },
    { id: 'l6', from: 'e8', to: 'c1', rel: 'supports', weight: 0.9 },
    { id: 'l7', from: 'e6', to: 'c1', rel: 'contradicts', weight: 0.45 },
    { id: 'l8', from: 'e5', to: 'c1', rel: 'contradicts', weight: 0.35 },
    { id: 'l9', from: 'e7', to: 'c1', rel: 'qualifies', weight: 0.5 },
    { id: 'l10', from: 'e3', to: 'c2', rel: 'supports', weight: 0.6 },
    { id: 'l11', from: 'e4', to: 'c2', rel: 'contradicts', weight: 0.6 },
    { id: 'l12', from: 'e5', to: 'c2', rel: 'contradicts', weight: 0.4 },
    { id: 'l13', from: 'e3', to: 'h1', rel: 'supports', weight: 0.7 },
    { id: 'l14', from: 'e7', to: 'h1', rel: 'qualifies', weight: 0.4 },
    { id: 'l15', from: 'e4', to: 'h2', rel: 'supports', weight: 0.6 },
    { id: 'l16', from: 'e3', to: 'h2', rel: 'contradicts', weight: 0.4 },
    { id: 'l17', from: 'e5', to: 'h3', rel: 'supports', weight: 0.4 },
    { id: 'l18', from: 'a1', to: 'c1', rel: 'depends_on' },
    { id: 'l19', from: 'a1', to: 'c2', rel: 'depends_on' },
    { id: 'l20', from: 'g1', to: 'a1', rel: 'qualifies' },
    { id: 'l21', from: 'x1', to: 'q1', rel: 'answers' },
    { id: 'l22', from: 'g2', to: 'c1', rel: 'depends_on' },
  ],
  groups: [{ id: 'common-origin', label: 'Same origin: GridCo billing', items: ['e1', 'e2', 'e6'] }],
  notes: ['Synthetic investigation for interface development. Invented library, invented numbers; references are example.org placeholders.', 'Sources remain assertions and references. No finding admitted.'],
}

/** A stand-in act() for the harness: plausible results, nothing leaves the page. */
export async function fixtureAct(action: string, items: string[], params?: Record<string, unknown>): Promise<ActionResult> {
  await new Promise((r) => setTimeout(r, 450))
  const at = new Date().toISOString()
  if (action === 'inspect-source') {
    const it = fixtureGraph.items.find((i) => i.id === items[0])
    return { status: 'done', detail: { sources: it?.sources ?? [] }, message: 'References only: opening a URL is up to you.' }
  }
  if (['ask-scientist', 'verify-claim', 'ask-challenger', 'challenge', 'investigate-gap', 'dispatch-bias-trial'].includes(action))
    return { status: 'started', task: { id: `g_${Math.random().toString(16).slice(2, 8)}`, kind: 'goal', status: 'open' }, receipt: { id: 'rc_demo', state: 'pending', at }, message: 'Request bound to r7 and posted. Results arrive as a proposal for review.' }
  if (action === 'correct' && !String(params?.text ?? '').trim()) return { status: 'needs_input', needs: { text: 'Corrected wording' }, message: 'Provide the correction.' }
  return { status: 'done', receipt: { id: 'rc_demo', state: 'committed', at }, message: `${title(action)} recorded (synthetic harness: nothing was changed).` }
}
