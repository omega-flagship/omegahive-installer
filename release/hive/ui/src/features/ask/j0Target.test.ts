import { describe, expect, it } from 'vitest'
import type { AskContext, AskSettings, MyMind } from '../../api/ask'
import { chipWords, planAsk, planName, type Carry, type PlanInputs } from './answerer'

/**
 * j0-fixes r1 item 1 (J0 live 14:38, Design's source repro ONBOARDING_ASK_RECIPIENT_SOURCE_REPRO_20261017): the chip
 * said "Answering: you (Jon's Mind)" while the paid row said "Ask Product Design: …", and choosing under Change moved
 * neither. Design's reproducer cases, as tests of the ONE decision the chip, the row and the send now share
 * (answerer.planAsk / planName). INVENTED people and minds, as in the reproducer; no host, no request.
 */
const personal: MyMind = { id: 'a_fixture_own', name: 'Ember', swarm_id: 's_fixture_own', status: 'awake' } as MyMind
const oldThread = { mind: { id: 'a_fixture_studio', name: 'Studio Maker' } }
const carry: Carry = { mind: 'a_fixture_studio', swarm: 's_fixture_studio' }
const settings: AskSettings = { swarm_id: null, thread_budget_usd: 0.25, eligible: [{ id: 's_fixture_own', name: 'Your mind' }] }
const swarms: Record<string, { name: string; coordinator_id?: string | null }> = { s_fixture_studio: { name: 'Studio', coordinator_id: null }, s_fixture_own: { name: 'Your mind', coordinator_id: 'a_fixture_own' } }
const agents = { a_fixture_studio: { id: 'a_fixture_studio', name: 'Studio Maker', swarm_id: 's_fixture_studio' }, a_fixture_own: { id: 'a_fixture_own', name: 'Ember', swarm_id: 's_fixture_own' } }
const plain: AskContext = { route: 'hive', experience: 'classic' }

function decide(ctx: AskContext, o: Partial<PlanInputs>) {
  const inputs: PlanInputs = { settings, personal, swarmOf: (id) => swarms[id], thread: oldThread, carry, threadOpen: false, ...o }
  const plan = planAsk(ctx, inputs)
  const row = planName(plan, { agents, swarms, personal, settings: inputs.settings })
  const sent = 'private' in plan.context ? null : plan.context.mind ?? null
  return { plan, row, sent, chip: plan.chip ? chipWords(plan.chip) : null }
}

describe("Design's reproducer cases (both mismatches now agree; both controls hold)", () => {
  it('case 1: a new Hive page after the Studio thread was closed: chip, row and send all name the person’s own mind', () => {
    const d = decide(plain, { threadOpen: false })
    expect(d.sent).toBeNull() // no old mind injected
    expect(d.row).toBe('Ember')
    expect(d.chip).toBe('Answering: you (Ember)')
  })
  it('case 2: the own-mind default saved after that thread: the old recipient is neither shown nor sent', () => {
    // the store drops the carry when a choice is saved (store/ask setDefaultSwarm); even with the thread still showing
    const chosen = { ...settings, swarm_id: 's_fixture_own' }
    const d = decide(plain, { settings: chosen, carry: null, threadOpen: true })
    expect(d.sent).toBeNull()
    expect(d.plan.context).toMatchObject({ swarm_id: 's_fixture_own' }) // the context names the chosen swarm
    expect(d.row).toBe('Ember')
  })
  it('control: no earlier thread or binding: nothing injected, the fresh name stays', () => {
    const d = decide(plain, { thread: null, carry: null, threadOpen: false })
    expect(d.sent).toBeNull()
    expect(d.row).toBe('Ember')
  })
  it('control: an explicitly addressed own mind is kept, in the context and the row', () => {
    const d = decide({ ...plain, mind: personal.id }, { threadOpen: true })
    expect(d.sent).toBe(personal.id)
    expect(d.row).toBe('Ember')
  })
})

describe('one decision for the chip, the row and the send', () => {
  it('a showing thread that answers through a mind: a plain follow-up continues it, and the chip says so (with Change)', () => {
    const d = decide(plain, { threadOpen: true })
    expect(d.sent).toBe('a_fixture_studio')
    expect(d.row).toBe('Studio Maker')
    expect(d.chip).toBe('Answering: Studio Maker (this thread) · change')
  })
  it('closing the thread ends the continuity at once (the live "closing did not move it")', () => {
    expect(decide(plain, { threadOpen: true }).row).toBe('Studio Maker')
    expect(decide(plain, { threadOpen: false }).row).toBe('Ember')
  })
  it('a different thread on the page (another mind) never inherits the carry', () => {
    const d = decide(plain, { threadOpen: true, thread: { mind: { id: 'a_other', name: 'Other' } } })
    expect(d.sent).toBeNull()
    expect(d.row).toBe('Ember')
  })
  it('a page swarm or a private page is never retargeted by a carried thread', () => {
    expect(decide({ ...plain, swarm_id: 's_fixture_own' }, { threadOpen: true }).sent).toBeNull()
    expect(decide({ private: true }, { threadOpen: true }).plan.context).toEqual({ private: true })
  })
  it('a saved default the Ask may not use is never named in the context', () => {
    const d = decide(plain, { settings: { ...settings, swarm_id: 's_gone' }, carry: null })
    expect(d.plan.context).not.toHaveProperty('swarm_id')
  })
})
