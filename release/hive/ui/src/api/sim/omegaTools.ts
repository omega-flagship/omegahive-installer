import { ApiError } from '../client'
import type { WorkItem, WorkLink, WorkSource } from '../types'
import type { SimProgram } from './programs'
import { CATALOGUE_ITEMS, CATALOGUE_LINKS, compositionPreview } from './toolsCatalogue'

/**
 * SIM ONLY, INVENTED CONTENT: a stand-in shaped like the Omega Tools catalogue view (Root, 2026-10-06: catalogue
 * contract 0.2 over the host's POST /api/programs/{id}/view and /act; typed tool / set / foundation / component /
 * source nodes; inspect-tool, inspect-set, inspect-foundation, show-examples, foundation-examples). The real catalogue
 * is not mounted on any hive; nothing here is copied from it. Every tool, set, foundation and example is made up.
 *
 * Inspection only: there is no execution action, and any other action is refused. Examples are BANKED (recorded
 * earlier), always labelled so, with `executed_now: false`.
 */

const SRC = (id: string, label: string): WorkSource => ({ id, label, kind: 'reference', status: 'cited', origin: `https://example.org/${id}` })

const ITEMS: WorkItem[] = [
  { id: 'f-order', kind: 'foundation', label: 'Ordering (invented foundation)', text: 'Putting things in a sensible order by a stated key.', sources: [SRC('src-order', 'Example note on ordering')] },
  { id: 'f-shape', kind: 'foundation', label: 'Text shaping (invented foundation)', text: 'Turning loose text into a list, a table or a summary.', sources: [SRC('src-shape', 'Example note on text shaping')] },
  { id: 's-plan', kind: 'set', label: 'Planning kit (invented set)', text: 'Tools that compose into a small planning flow.' },
  { id: 's-read', kind: 'set', label: 'Reading kit (invented set)', text: 'Tools for reading and condensing a thread.' },
  { id: 't-urgency', kind: 'tool', label: 'sort-by-urgency (invented tool)', text: 'Orders a list of tasks by a stated urgency.', flags: ['inspection-only'] },
  { id: 't-checklist', kind: 'tool', label: 'draft-checklist (invented tool)', text: 'Drafts a checklist from a one-line task.', flags: ['inspection-only'] },
  { id: 't-summary', kind: 'tool', label: 'summarise-thread (invented tool)', text: 'Condenses a thread into three lines.', flags: ['inspection-only'] },
  { id: 'c-key', kind: 'component', label: 'key extractor (invented component)', text: 'Reads the ordering key out of a request.' },
  { id: 'c-lines', kind: 'component', label: 'line splitter (invented component)', text: 'Splits text into lines.' },
  { id: 'x-urgency', kind: 'example', label: 'Banked example · executed now: false', text: 'Recorded earlier: three invented tasks ordered by urgency. Shown as recorded; nothing runs.', flags: ['banked', 'executed_now:false'] },
  { id: 'x-order', kind: 'example', label: 'Banked foundation example · executed now: false', text: 'Recorded earlier: invented numbers sorted ascending. Shown as recorded; nothing runs.', flags: ['banked', 'executed_now:false'] },
  { id: 'src-order', kind: 'source', label: 'Example note on ordering (placeholder)' },
  { id: 'src-shape', kind: 'source', label: 'Example note on text shaping (placeholder)' },
  ...CATALOGUE_ITEMS, // demo D3: the rest of the invented catalogue (80 tools, sets, foundations and components)
]
const LINKS: Omit<WorkLink, 'id'>[] = [
  { from: 't-urgency', to: 's-plan', rel: 'in_set' },
  { from: 't-checklist', to: 's-plan', rel: 'in_set' },
  { from: 't-summary', to: 's-read', rel: 'in_set' },
  { from: 't-urgency', to: 'f-order', rel: 'built_on' },
  { from: 't-checklist', to: 'f-shape', rel: 'built_on' },
  { from: 't-summary', to: 'f-shape', rel: 'built_on' },
  { from: 't-urgency', to: 'c-key', rel: 'uses' },
  { from: 't-summary', to: 'c-lines', rel: 'uses' },
  { from: 'f-order', to: 'src-order', rel: 'cites' },
  { from: 'f-shape', to: 'src-shape', rel: 'cites' },
  { from: 'x-urgency', to: 't-urgency', rel: 'example_of' },
  { from: 'x-order', to: 'f-order', rel: 'example_of' },
  ...CATALOGUE_LINKS,
]

/**
 * INVENTED guided demonstrations, in the shape of Root's demo catalogue (2026-10-06): four ready hooks with a banked
 * synthetic script each, and the two temporal demos explicitly unavailable. Every tool, argument and output here is
 * made up for the simulator; none is copied from the catalogue. The page reads them through the view (focus
 * `demo:<id>`) or `inspect-demo`, as on a hive; nothing runs.
 */
const step = (id: string, explain: string, tool: string, args: unknown[], out: { expected?: unknown[]; contains?: unknown[] }) => ({
  id,
  explain,
  tool,
  skill: `${tool} (invented)`,
  arguments: args,
  expected_native: out.expected ?? null,
  contains_native: out.contains ?? null,
  qualification: 'synthetic',
  state_origin: 'invented fixture state (simulator)',
})
const demo = (id: string, module: string, title: string, steps: ReturnType<typeof step>[]) => ({
  id,
  module,
  title,
  available: steps.length > 0,
  qualification: steps.length ? 'banked synthetic steps (invented for the simulator); not run now' : 'not implemented',
  steps,
  authority: 'none',
  persistent_writes: false,
})
export const SIM_DEMOS = [
  demo('attention-demo-focus', 'attention', 'Attention: where focus goes (invented)', [
    step('baseline', 'First, every invented memory item starts with the same importance: nothing stands out yet.', 'sim-focus-baseline', [['item-a', 'item-b', 'item-c']], { expected: [{ 'item-a': 0.3, 'item-b': 0.3, 'item-c': 0.3 }] }),
    step('salience', 'Then one item is marked salient, and importance spreads towards it within a fixed budget.', 'sim-focus-spread', ['item-b', { budget: 1 }], { contains: ['item-b'] }),
    step('recall', 'Finally a recall admits the most important item first: the focus decides what comes back.', 'sim-focus-recall', [{ limit: 1 }], { contains: ['item-b'] }),
  ]),
  demo('skill-demo-nominate', 'self', 'Self-knowledge: nominating a skill (invented)', [
    step('fulfilled', 'A skill whose prerequisites are all met is nominated, with the reason why.', 'sim-skill-nominate', ['tidy-notes', ['has-notes']], { expected: ['nominated: tidy-notes'] }),
    step('missing', 'A skill missing a prerequisite is not nominated, and the missing piece is named. Nominating never installs anything.', 'sim-skill-nominate', ['sort-files', []], { expected: ['not nominated: needs has-files'] }),
  ]),
  demo('energy-demo-reserve', 'energy', 'Energy: reserving effort (invented)', [
    step('reserve', 'A task reserves part of an invented energy budget before it starts.', 'sim-energy-reserve', [{ budget: 10, reserve: 4 }], { contains: ['reserved 4'] }),
    step('overspend', 'Asking for more than is left is refused, not borrowed.', 'sim-energy-reserve', [{ budget: 6, reserve: 9 }], { contains: ['refused'] }),
    step('settle', 'When the task ends, its receipt settles what it used and refunds the rest.', 'sim-energy-settle', [{ reserved: 4, used: 3 }], { contains: ['refund 1'] }),
  ]),
  demo('scratch-demo-promotion', 'scratch', 'Scratch: promoting a draft (invented)', [
    step('shareable', 'A shareable scratch note can be promoted to durable memory.', 'sim-scratch-promote', [{ note: 'draft-1', scope: 'shareable' }], { contains: ['promoted'] }),
    step('private', 'A private note is not promoted for others.', 'sim-scratch-promote', [{ note: 'draft-2', scope: 'private' }], { contains: ['kept private'] }),
    step('mismatch', 'A promotion into the wrong scope is refused.', 'sim-scratch-promote', [{ note: 'draft-3', scope: 'shareable', into: 'private' }], { contains: ['scope mismatch'] }),
    step('expiry', 'And a note past its time expires instead of being promoted.', 'sim-scratch-promote', [{ note: 'draft-4', expired: true }], { contains: ['expired'] }),
  ]),
  demo('temporal-demo-sequence', 'temporal', 'Temporal: ordering events', []),
  demo('temporal-demo-anticipation', 'temporal', 'Temporal: anticipation', []),
]
/** SIM: the invented catalogue entry for a demo (the sim Ask plans its tour from it, as the page reads it). */
export const simBankedDemo = (id: string): unknown => structuredClone(SIM_DEMOS.find((d) => d.id === id) ?? null)
const DEMO_ITEMS: WorkItem[] = SIM_DEMOS.map((d) => ({ id: `demo:${d.id}`, kind: 'demo', label: d.title, text: `${d.qualification}\nReading the script does not execute its steps or read current mind state.`, meta: structuredClone(d) as unknown as Record<string, unknown> }))

const banked = (id: string) => {
  const x = ITEMS.find((i) => i.id === id)!
  return { id: x.id, label: x.label, text: x.text, banked: true, executed_now: false }
}

/**
 * INVENTED values in the SHAPE the real Tools app returns (0.6.3 read-only outputs, Root 2026-10-08): `inspect-tool`
 * answers tools / authority / executed_now / input_contract / execution_binding / sources / wire_examples, and
 * `show-examples` answers scope / recorded_at / executed_now / examples (call, expected, actual, passed) / authority /
 * installation. Every name, call and value below is made up for the simulator; nothing is copied from the app.
 */
const skillOf = (id: string) => `sim-${id.replace(/^t-/, '')}`
const inspectTool = (t: WorkItem) => ({
  tools: [{ id: t.id, name: t.label, category: 'thought', adds: t.text, claim_ceiling: 'Invented simulator sample; not evidence of any real tool.', stage: 'sim-sample', skills: [skillOf(t.id)], example_count: 2 }],
  authority: 'none',
  executed_now: false,
  input_contract: {
    schema: 'sim-inert-input-v1',
    limits: { max_input_bytes: 1024, max_input_nodes: 64, max_input_depth: 4 },
    skills: { [skillOf(t.id)]: { arguments: ['ref', { kind: 'list', max: 8, item: 'word' }] } },
    types: { ref: { kind: 'symbol' }, word: { kind: 'symbol' } },
  },
  execution_binding: { program: 'omega-tools', action: 'run-native (not offered in the simulator)', review_receipt: 'sim-receipt-0000', module_selection: [`sim.tools.${skillOf(t.id)}@0.0.1`], requires: 'host app grant plus exact selected module (invented)' },
  sources: (t.sources ?? []).map((x) => structuredClone(x)),
  wire_examples: [
    { tool: t.id, name: 'sim-first-case', skill: skillOf(t.id), arguments: ['r1', ['alpha', 'beta']], expected_native: [`(SimDecision r1 (alpha) authority-none)`], contains_native: null, authority: 'none', qualification: 'banked synthetic (invented); not executed by reading this example' },
  ],
})
const showExamples = (t: WorkItem) => [
  { tool: t.id, name: 'sim-first-case', call: `(${skillOf(t.id)} r1 (alpha beta))`, expected: ['(SimDecision r1 (alpha) authority-none)'], actual: ['(SimDecision r1 (alpha) authority-none)'], passed: true, banked: true, executed_now: false },
  { tool: t.id, name: 'sim-empty-case', call: `(${skillOf(t.id)} r2 ())`, expected: ['(SimDecision r2 () authority-none)'], actual: ['(SimDecision r2 () authority-none)'], passed: true, banked: true, executed_now: false },
]

export function omegaTools(): SimProgram {
  const graph = (focus: string | null) => {
    // a demo focus reads that demo's card only (as the host does): no links or groups outside it; otherwise the whole
    // catalogue with its demos
    const one = focus?.startsWith('demo:') ? DEMO_ITEMS.filter((i) => i.id === focus) : null
    const groups = [
      { id: 'tools', label: 'Tools', items: ITEMS.filter((i) => i.kind === 'tool').map((i) => i.id) },
      { id: 'sets', label: 'Sets', items: ITEMS.filter((i) => i.kind === 'set').map((i) => i.id) },
      { id: 'foundations', label: 'Foundations', items: ITEMS.filter((i) => i.kind === 'foundation').map((i) => i.id) },
      { id: 'demos', label: 'Guided demonstrations', items: DEMO_ITEMS.map((i) => i.id) },
    ]
    return {
      revision: 'cat-r1',
      focus: one ? (one.length ? focus : null) : focus && ITEMS.some((i) => i.id === focus) ? focus : 's-plan',
      title: 'Omega Tools catalogue (invented stand-in)',
      suggested_stage: 'map',
      items: structuredClone(one ?? [...ITEMS, ...DEMO_ITEMS]),
      links: one ? [] : LINKS.map((l) => ({ ...l, id: `${l.from}|${l.rel}|${l.to}` })),
      groups: one ? [{ id: 'demos', label: 'Guided demonstrations', items: one.map((i) => i.id) }] : groups,
      notes: ['Invented stand-in for the simulator. Inspection only: nothing here runs. Examples are banked (executed now: false).'],
    }
  }
  return {
    manifest: { id: 'omega-tools', name: 'Omega Tools catalogue (sim)', version: '0.5.0-inspection-sim', description: 'An invented stand-in for the tools catalogue: tools, sets and foundations, inspection only.', icon: 'flask', capabilities: [] },
    describe: () => ({
      contract: '0.2',
      kinds: [
        { id: 'tool', label: 'Tool', role: 'other' },
        { id: 'set', label: 'Set', role: 'other' },
        { id: 'foundation', label: 'Foundation', role: 'explanation' },
        { id: 'component', label: 'Component', role: 'other' },
        { id: 'example', label: 'Banked example', role: 'evidence' },
        { id: 'source', label: 'Source', role: 'source' },
        { id: 'demo', label: 'Guided synthetic demonstration', role: 'other' },
      ],
      relations: [
        { id: 'in_set', label: 'in set', polarity: 'neutral' },
        { id: 'built_on', label: 'built on', polarity: 'neutral' },
        { id: 'uses', label: 'uses', polarity: 'neutral' },
        { id: 'cites', label: 'cites', polarity: 'neutral' },
        { id: 'example_of', label: 'example of', polarity: 'neutral' },
      ],
      actions: [
        { id: 'inspect-tool', label: 'Inspect', applies_to: ['tool'] },
        { id: 'inspect-set', label: 'Inspect', applies_to: ['set'] },
        { id: 'inspect-foundation', label: 'Inspect', applies_to: ['foundation'] },
        { id: 'show-examples', label: 'Banked examples', applies_to: ['tool'] },
        { id: 'foundation-examples', label: 'Banked examples', applies_to: ['foundation'] },
        { id: 'inspect-demo', label: 'Inspect guided demonstration steps', applies_to: ['demo'] },
        { id: 'compose-set', label: 'Preview composition', applies_to: ['set'] },
      ],
    }),
    // POST /api/programs/omega-tools/view {swarm_id, focus, stage}. A module-state focus ("mind:<agent_id>:<module>")
    // for a mind this stand-in has never seen answers as the host does (Platform r16): one identical 404 not_found,
    // which the UI says as "not available"
    view: (_ctx, focus) => {
      if (focus?.startsWith('mind:')) throw new ApiError(404, 'not_found', 'not found')
      return graph(focus)
    },
    act(_ctx, action, items) {
      if (action === 'inspect-demo') {
        const picked = SIM_DEMOS.filter((d) => items.includes(`demo:${d.id}`))
        if (!picked.length || picked.length !== new Set(items).size) return { status: 'refused', message: 'choose distinct known guided demonstrations' }
        return { status: 'done', detail: { demos: structuredClone(picked), authority: 'none', executed_now: false }, message: 'read only: reading a script executes none of its steps' }
      }
      if (action === 'compose-set') {
        // demo D3: a composition preview in the Tools app's shape; nothing is executed, registered or granted
        const set = ITEMS.find((i) => i.kind === 'set' && items.length === 1 && i.id === items[0])
        const preview = set ? compositionPreview(set.id) : null
        if (!preview) return { status: 'refused', message: 'choose one set from this catalogue' }
        return { status: 'done', detail: preview, message: `Composition preview only (${preview.status}): nothing ran and nothing was registered; executed: false` }
      }
      const byId = new Map(ITEMS.map((i) => [i.id, i]))
      const t = items.map((i) => byId.get(i)).filter((x): x is WorkItem => !!x)
      if (!t.length) return { status: 'refused', message: 'choose an item from this catalogue' }
      const kinds: Record<string, string> = { 'inspect-tool': 'tool', 'inspect-set': 'set', 'inspect-foundation': 'foundation', 'show-examples': 'tool', 'foundation-examples': 'foundation' }
      const kind = kinds[action]
      if (!kind) return { status: 'refused', message: 'this catalogue is inspection only: it offers no way to run a tool' }
      if (t[0].kind !== kind) return { status: 'refused', message: `${action} applies to a ${kind}` }
      if (action === 'inspect-tool') return { status: 'done', detail: inspectTool(t[0]) }
      if (action.startsWith('inspect-')) {
        const linked = LINKS.filter((l) => l.from === t[0].id || l.to === t[0].id).map((l) => ({ rel: l.rel, other: l.from === t[0].id ? l.to : l.from }))
        return { status: 'done', detail: { item: { id: t[0].id, kind: t[0].kind, label: t[0].label, text: t[0].text }, linked, executed_now: false }, message: 'read only' }
      }
      if (action === 'show-examples') {
        return { status: 'done', detail: { scope: 'banked synthetic examples (invented for the simulator), not installed runtime acceptance', recorded_at: '2026-01-01T00:00:00+00:00', executed_now: false, examples: showExamples(t[0]), authority: 'none', installation: 'not installed' } }
      }
      const ex = LINKS.filter((l) => l.rel === 'example_of' && l.to === t[0].id).map((l) => banked(l.from))
      return { status: 'done', detail: { examples: ex, banked: true, executed_now: false }, message: `${ex.length} banked example(s), shown as recorded; executed now: false` }
    },
  }
}
