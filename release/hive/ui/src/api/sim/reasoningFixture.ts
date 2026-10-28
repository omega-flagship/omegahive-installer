import { ApiError } from '../client'
import { omegaTools } from './omegaTools'
import type { SimProgram } from './programs'

/**
 * SIM ONLY, INVENTED CONTENT, NOT EVIDENCE OF REAL STATE. A stand-in Omega Tools app that DECLARES the
 * `reasoning-module` read in Root's flat typed carrier (v3 proposal), so the six reasoning viewers can be seen in the
 * simulator. No hive declares this read today: the plain simulator (`?sim=1`) keeps the catalogue without it, exactly
 * as on a hive, and every viewer says "Unavailable: no reader yet". This fixture is installed only with BOTH
 * `?sim=1&reasoning=invented` (SimOptions.reasoning). Every label, number and time here is made up; nothing is copied
 * from any mind, corpus or record. Its "current" answers stand in for a host snapshot inside the simulator only; the
 * qualification says so on every one.
 *
 * Each module answers in a different state, so every viewer state can be seen: attention, self and energy current;
 * scratch "nothing held right now"; Assume withheld; temporal stale. A malformed ref is refused as the host would.
 */
const QUAL = 'invented simulator fixture; not evidence of real state'
const MODULES = ['attention', 'self', 'energy', 'scratch', 'assume', 'temporal'] as const
type M = (typeof MODULES)[number]
const WHY = 'Invented for the simulator.'

const common = (mind: string, module: M) => ({ module, mind_id: mind, qualification: QUAL })
// unavailable: the common envelope only; observed_at and revision null, read_path none (v3)
const unavailable = (mind: string, module: M, reason: 'withheld' | 'stale') => ({
  ...common(mind, module), revision: null, observed_at: null, available: false, state: 'unavailable', unavailable_reason: reason, items: [],
  provenance: { source_revision: null, evidence_refs: [], read_path: 'none', authority: 'none' }, explain: 'Invented: nothing is read for this module here.',
})

export function inventedReasoningEnvelope(mind: string, module: M, at: string, soon: string): Record<string, unknown> {
  const cur = {
    ...common(mind, module), revision: 'sim-1', observed_at: at, available: true, state: 'current', unavailable_reason: null, items: [],
    provenance: { source_revision: 'sim-invented-1', evidence_refs: [], read_path: 'host-consent-filtered-snapshot', authority: 'none' }, explain: WHY,
  }
  switch (module) {
    case 'attention':
      return {
        ...cur,
        explain: 'Invented: importance spread over three made-up items.',
        focus_ref: 'sim-a',
        ranked_items: [
          { id: 'sim-a', label: 'Invented item A', score: 0.62, reason_codes: ['freshness-contribution'], explain: 'Made up: marked salient.' },
          { id: 'sim-b', label: 'Invented item B', score: 0.24, reason_codes: [], explain: WHY },
          { id: 'sim-c', label: 'Invented item C', score: 0.14, reason_codes: ['sti-contribution'], explain: WHY },
        ],
        spread_edges: [{ from: 'sim-a', to: 'sim-b', weight: 0.3, explain: WHY }],
      }
    case 'self':
      return {
        ...cur,
        skills: [
          { id: 'sim-skill-1', version: '0.1', label: 'Invented skill: tidy notes', availability: 'available', source_digest: 'a1'.repeat(32), explain: 'Made up for the simulator.' },
          { id: 'sim-skill-2', version: '0.2', label: 'Invented skill: sort files', availability: 'inactive', source_digest: 'b2'.repeat(32), explain: WHY },
        ],
        selected_skill: { id: 'sim-skill-1', selected_at: at },
        selection_reason_codes: ['prerequisites-present'],
      }
    case 'energy':
      return { ...cur, mode: 'observe', budget: { unit: 'invented effort', limit: 10, reserved: 4, spent: 3 }, next_wake_at: soon, sleep_until: null }
    case 'scratch':
      return { ...cur, items: [], promotion_reasons: [], demotion_reasons: [] }
    case 'assume':
      return unavailable(mind, module, 'withheld')
    case 'temporal':
      return unavailable(mind, module, 'stale')
  }
}

const REF = /^mind:([\w-]{1,128}):(attention|self|energy|scratch|assume|temporal)$/

/** The sim catalogue plus the invented read. Same app id, so it stands in for the catalogue when installed. */
export function omegaToolsWithInventedReasoning(): SimProgram {
  const p = omegaTools()
  return {
    ...p,
    manifest: { ...p.manifest, name: 'Omega Tools catalogue (sim, invented reasoning reads)', description: `${p.manifest.description} Invented reasoning-module reads, not evidence of real state.` },
    describe: () => ({ ...p.describe(), reads: [{ id: 'reasoning-module', label: 'Reasoning module (invented)' }] }),
    read(_ctx, query, params) {
      if (query !== 'reasoning-module') return null
      const m = typeof params.ref === 'string' ? REF.exec(params.ref) : null
      if (!m || Object.keys(params).some((k) => k !== 'ref')) throw new ApiError(400, 'bad_request', 'params is {ref: "mind:<id>:<module>"}')
      // whole seconds, UTC (v3 times)
      const iso = (t: number) => new Date(Math.floor(t / 1000) * 1000).toISOString().replace('.000Z', 'Z')
      const now = Date.now()
      return inventedReasoningEnvelope(m[1], m[2] as M, iso(now - 90_000), iso(now + 3_600_000))
    },
  }
}
export { MODULES as INVENTED_REASONING_MODULES }
