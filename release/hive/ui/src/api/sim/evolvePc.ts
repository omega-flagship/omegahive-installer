/**
 * SIM ONLY, opt-in by URL (`?sim=1&pcreports=fixture`): OmegaEvolve's research view holding Code's two prepared
 * contribution payloads, R10 (sha256 ddd3ab93…), R7 (sha256 ad67a584…) and R11 (sha256 7c64a455…, r1.1), byte-identical in ./fixtures
 * (R11 but for its three workspace locators, shortened to drop an internal-notes path). They are
 * recorded here the way the host's `contribute` records them (hive/core/evolve.py contribute(): each evidence ref gains
 * custody "unresolved" and verified false; state "recorded-claim"; adoption not authorized) and viewed the way the
 * host's plugin views them (hive/plugins/omegaevolve/program.py view()). Nothing here was contributed to any hive.
 *
 * r1.1 (Kimi #4): the view is the host's whole view: the objective, the records with their assessment derived as
 * hive/core/evolve_state.py derive() derives it, and the two seed subjects (seed_plan() members, planned, provisioning
 * unverified) with their `subject-of` links, in the plugin's order. One difference on purpose: the fixture declares no
 * actions (a read-only specimen). Record ids are invented. `?pcreports=fail` plays a view that fails.
 */
import { ApiError } from '../client'
import type { ProgramDescription, WorkGraph, WorkItem } from '../types'
import type { SimProgram } from './programs'
import { simTestPattern } from './pngFixture'
import r10Raw from './fixtures/CODE_R10_EVOLVE_CONTRIBUTION_PAYLOAD_R1.json?raw'
import r7Raw from './fixtures/CODE_R7_EVOLVE_CONTRIBUTION_PAYLOAD_R2.json?raw'
import r11Raw from './fixtures/CODE_R11_EVOLVE_CONTRIBUTION_PAYLOAD_R1.json?raw'

type Json = Record<string, unknown>

export const PC_FIXTURE_RAW = { r10: r10Raw, r7: r7Raw, r11: r11Raw }
const OBJECTIVE = 'RSI toward Beneficial General Intelligence and beneficial superintelligence'

/** hive/plugins/omegaevolve/program.py describe(), kinds and relations as written; no actions in the sim fixture. */
export function evolveDescribe(): ProgramDescription {
  return {
    contract: '0.1',
    kinds: [
      { id: 'objective', label: 'Objective', role: 'question' },
      { id: 'seed', label: 'Initial evolving subject', role: 'other' },
      { id: 'contribution', label: 'Contribution', role: 'claim' },
      { id: 'experiment', label: 'Experiment', role: 'hypothesis' },
      { id: 'qualification', label: 'Qualification', role: 'assessment' },
      { id: 'benchmark', label: 'Benchmark registration', role: 'hypothesis' },
      { id: 'benchmark-assessment', label: 'Imported benchmark assessment', role: 'assessment' },
    ],
    relations: [
      { id: 'advances', label: 'advances', polarity: 'neutral' },
      { id: 'subject-of', label: 'evolves toward', polarity: 'neutral' },
      { id: 'depends_on', label: 'depends on', polarity: 'neutral' },
      { id: 'revises', label: 'revises', polarity: 'qualify' },
      { id: 'references', label: 'references', polarity: 'neutral' },
    ],
    actions: [],
  } as ProgramDescription
}

/** hive/core/evolve.py contribute(): the stored body for a payload with no predecessor or dependencies. */
export function recordedBody(payload: Json): Json {
  const evidence = (payload.evidence as Json[]).map((e) => ({ ...e, custody: 'unresolved', verified: false }))
  return { ...payload, evidence, relation: 'assertion', depends_on: [], state: 'recorded-claim', adoption_authorized: false }
}

type Assessment = { status: string; flags: string[]; invalidated_by: string[]; evidence_custody: string; adoption_authorized: boolean }
type Row = { id: string; kind: string; author: string; body: Json }

/** hive/core/evolve_state.py derive(), ported: lifecycle per contribution from corrections, retractions and dependencies. */
export function deriveStates(rows: Row[]): Record<string, Assessment> {
  const contributions = new Map(rows.filter((r) => r.kind === 'contribution').map((r) => [r.id, r]))
  const states: Record<string, Assessment> = {}
  const dependents: Record<string, string[]> = {}
  for (const id of contributions.keys()) {
    states[id] = { status: 'current', flags: [], invalidated_by: [], evidence_custody: 'unresolved', adoption_authorized: false }
    dependents[id] = []
  }
  for (const [id, row] of contributions) {
    for (const dep of (row.body.depends_on as string[] | undefined) ?? []) if (dep in dependents) dependents[dep].push(id)
    const parent = row.body.predecessor as string | undefined
    const relation = (row.body.relation as string | undefined) ?? (parent ? 'reference' : 'assertion')
    if (parent && contributions.has(parent) && (relation === 'correction' || relation === 'retraction')) {
      if (contributions.get(parent)!.author !== row.author) {
        states[id].flags.push('invalid-source-lineage')
        continue
      }
      states[parent].status = relation === 'correction' ? 'corrected' : 'retracted'
      states[parent].invalidated_by.push(id)
    }
  }
  for (const [source, state] of Object.entries(states)) {
    if (state.status === 'current') continue
    const todo = [...dependents[source]]
    const seen = new Set([source])
    while (todo.length) {
      const id = todo.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      const affected = states[id]
      if (!affected.flags.includes('needs-review')) affected.flags.push('needs-review')
      affected.invalidated_by.push(...state.invalidated_by)
      todo.push(...dependents[id])
    }
  }
  for (const st of Object.values(states)) {
    st.flags = [...new Set(st.flags)].sort()
    st.invalidated_by = [...new Set(st.invalidated_by)].sort()
  }
  return states
}

/** hive/plugins/omegaevolve/program.py view(): one record item, with its derived assessment. */
export function contributionItem(id: string, body: Json, assessment: Assessment = deriveStates([{ id, kind: 'contribution', author: 'sim', body }])[id]): WorkItem {
  return {
    id,
    kind: 'contribution',
    label: String(body.title ?? 'contribution'),
    status: assessment.status,
    text: String(body.claim ?? body.state),
    flags: assessment.flags,
    uncertainty: { method: 'qualitative', status: 'unverified' },
    meta: { ...body, assessment: (body.assessment as Json | undefined) ?? assessment, lineage_assessment: assessment },
  }
}

/** hive/core/evolve_seed.py seed_plan(): the members and budget the view lists (persona text is not in the view). */
const SEEDS = [
  { kind: 'omega', name: 'OmegaEvolve Omega' },
  { kind: 'iter', name: 'OmegaEvolve Iter' },
]
const SEED_BUDGET = { swarm_day_usd: 10.0, bootstrap_agent_total_usd: 0.5, bootstrap_combined_usd: 1.0 }

/**
 * lab-figures r1, SIM ONLY: two INVENTED figures on R7 (never producer content; R7 has no figures). The first is the
 * generated test pattern (api/sim/pngFixture, sha256 below; a test recomputes it); the second names bytes the sim
 * does not hold, so its read answers 404 as the host would and the band shows it as not available here.
 */
export const SIM_FIGURE_SHA = '84d789e3d123f0841bace212f6320c4df9109029054a10fa7cc7e25c7a5f0c1e'
export const SIM_MISSING_FIGURE_SHA = 'f'.repeat(64)
const figureRoute = (record: string, sha: string) => `/api/evolve/swarms/s_lyra/records/${record}/figures/${sha}`
let pattern: Uint8Array | null = null
/** The sim's figure bytes by read URL (only the test pattern is held). */
export function simFigureBytes(readUrl: string): Uint8Array | null {
  if (!readUrl.endsWith(`/figures/${SIM_FIGURE_SHA}`) || !readUrl.startsWith('/api/evolve/swarms/')) return null
  pattern ??= simTestPattern()
  return pattern
}
function simFigures(record: string) {
  return [
    { sha256: SIM_FIGURE_SHA, mime: 'image/png', bytes: 17408, width: 96, height: 60, caption: 'Sim fixture: an invented test pattern (four colour bands and a diagonal).\nNot part of the R7 report and not producer content.', source_locator: 'sim:api/sim/pngFixture.ts', read_url: figureRoute(record, SIM_FIGURE_SHA) },
    { sha256: SIM_MISSING_FIGURE_SHA, mime: 'image/png', bytes: 1234, width: 640, height: 480, caption: 'Sim fixture: a figure whose bytes this sim does not hold (its read answers 404).', read_url: figureRoute(record, SIM_MISSING_FIGURE_SHA) },
  ]
}

export function evolvePcGraph(): WorkGraph {
  const rows: Row[] = [
    { id: 'ev_sim_r7', kind: 'contribution', author: 'sim-submitter', body: recordedBody(JSON.parse(r7Raw) as Json) },
    { id: 'ev_sim_r10', kind: 'contribution', author: 'sim-submitter', body: recordedBody(JSON.parse(r10Raw) as Json) },
    { id: 'ev_sim_r11', kind: 'contribution', author: 'sim-submitter', body: recordedBody(JSON.parse(r11Raw) as Json) },
  ]
  const states = deriveStates(rows)
  const items: WorkItem[] = [
    { id: 'objective', kind: 'objective', label: OBJECTIVE },
    ...rows.map((r) => (r.id === 'ev_sim_r7' ? { ...contributionItem(r.id, r.body, states[r.id]), figures: simFigures(r.id) } : contributionItem(r.id, r.body, states[r.id]))),
    ...SEEDS.map((seed) => ({
      id: `seed-${seed.kind}`,
      kind: 'seed',
      label: seed.name,
      status: 'current',
      text: 'Initial evolving subject; runtime binding not recorded by this app.',
      meta: { runtime_kind: seed.kind, phase: 'planned', provisioning: 'unverified', budget: SEED_BUDGET, adoption_authorized: false },
    })),
  ]
  return {
    revision: 'sim-pc-fixture-2',
    title: 'OmegaEvolve',
    focus: 'objective',
    suggested_stage: 'unfold',
    items,
    links: [
      ...rows.map((r) => ({ id: `${r.id}-objective`, from: r.id, to: 'objective', rel: 'advances' })),
      ...SEEDS.map((seed) => ({ id: `seed-${seed.kind}-objective`, from: `seed-${seed.kind}`, to: 'objective', rel: 'subject-of' })),
    ],
    groups: [],
    notes: [
      'Recorded claims confer no authority. Evidence custody is unresolved.',
      'Protocol qualification is not measured improvement, independent review or adoption.',
      'Native shared AtomSpace publication is not enabled by this candidate.',
      'Omega and Iter are both initial evolving subjects. Planned subjects do not prove live provisioning.',
    ],
  }
}

function app(fail: boolean): SimProgram {
  return {
    manifest: { id: 'omegaevolve', name: 'OmegaEvolve', version: '0.0.0-sim', description: 'SIM ONLY: OmegaEvolve’s research view (objective, two seed subjects, three prepared PC contribution payloads; not contributed anywhere).', icon: 'flask', capabilities: [] },
    describe: evolveDescribe,
    view: () => {
      if (fail) throw new ApiError(500, 'program_error', 'omegaevolve: the research view could not be built (sim fixture failure)')
      return evolvePcGraph()
    },
    act: () => ({ status: 'refused', message: 'The sim fixture is read-only' }),
  }
}

export const evolvePcFixture = (): SimProgram => app(false)
export const evolvePcFailing = (): SimProgram => app(true)
