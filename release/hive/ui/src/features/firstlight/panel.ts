import { DEMO_PEOPLE } from './demo'
import { guestBand } from './honest'
import type { Run } from './store'

/**
 * What the panel always carries, whatever the step: the "simulated" label in demo mode, and a guest's amber band (whose
 * hive, whose key, their limit) on every beat, the hello included, so the journey never hides whose key pays.
 */
export function panelParts(run: Run): { sim: string | null; band: string | null } {
  return {
    sim: run.mode === 'demo' ? `${run.persona ? `${DEMO_PEOPLE[run.persona].name} is invented. ` : ''}Nothing here is real, and nothing is sent or spent.` : null,
    band: run.path === 'guest' && run.status !== 'loading' && !run.loadError ? guestBand(run.facts.limit, run.facts.host) : null,
  }
}
