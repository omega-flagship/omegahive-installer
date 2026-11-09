import { describe, expect, it } from 'vitest'
import type { AskContext, AskSettings, MyMind } from '../../api/ask'
import { answerMindFor, cannotAnswer, routeAround, threadInfo } from './answerer'

/**
 * ask-fix r1 (Jon, live 044fad4): near Evolve Omega (no coordinator) every plain question was refused "That swarm
 * has no coordinator to answer". The page's swarm is sent as context.swarm_id, which the host routes to; a swarm the
 * Ask cannot use is now never targeted. INVENTED ids and names.
 */
const names: Record<string, string> = { s_evo: 'Evolve Omega', s_lyra: 'Lyra', s_kelp: 'Kelp Commons' }
const name = (id: string) => (names[id] ? { name: names[id], ...(id === 's_evo' ? { coordinator_id: null } : { coordinator_id: 'a_x' }) } : undefined)
const ctx = (swarm_id?: string, extra: Partial<AskContext> = {}): AskContext => ({ route: '#/swarms/' + (swarm_id ?? ''), experience: 'classic', ...(swarm_id ? { swarm_id } : {}), ...extra }) as AskContext
const settings = (swarm_id: string | null, ...ids: string[]): AskSettings => ({ swarm_id, thread_budget_usd: 1, eligible: ids.map((id) => ({ id, name: names[id] })) })
const me: MyMind = { id: 'a_me', name: 'Ada', swarm_id: 's_me' }

describe('routeAround: a page swarm the Ask cannot use is never the target', () => {
  it('an eligible page swarm is still targeted, unchanged', () => {
    const c = ctx('s_lyra')
    expect(routeAround(c, settings(null, 's_lyra', 's_kelp'), me, name)).toEqual({ context: c, note: null })
  })
  it('not eligible, with the person’s own mind: the page swarm is left out (the host routes to their mind) and a quiet note says so', () => {
    const r = routeAround(ctx('s_evo', { view: undefined }), settings(null, 's_lyra', 's_kelp'), me, name)
    expect('swarm_id' in r.context).toBe(false)
    expect(r.note).toBe('Answering: you')
    expect(r.why).toBe('Evolve Omega has no coordinator')
  })
  it('not eligible, with a usable saved default: the default answers (an explicit default wins, as on the host)', () => {
    const r = routeAround(ctx('s_evo'), settings('s_kelp', 's_lyra', 's_kelp'), me, name)
    expect(r.context).toMatchObject({ swarm_id: 's_kelp' })
    expect(r.note).toBe('Answering: Kelp Commons')
    expect(r.why).toBe('Evolve Omega has no coordinator')
  })
  it('not eligible, a saved default the Ask cannot use, and the person’s own mind: their own swarm is named', () => {
    expect(routeAround(ctx('s_evo'), settings('s_gone', 's_lyra'), me, name).context).toMatchObject({ swarm_id: 's_me' })
  })
  it('not eligible, no own mind, no default: the one usable swarm, else the page swarm is left out for the host', () => {
    expect(routeAround(ctx('s_evo'), settings(null, 's_lyra'), null, name).context).toMatchObject({ swarm_id: 's_lyra' })
    const r = routeAround(ctx('s_evo'), settings(null, 's_lyra', 's_kelp'), null, name)
    expect('swarm_id' in r.context).toBe(false)
    expect(r.note).toBeNull()
  })
  it('an explicit choice is honoured: an addressed mind is never changed; a private page and unknown settings neither', () => {
    const addressed = ctx('s_evo', { mind: 'a_vega' })
    expect(routeAround(addressed, settings(null, 's_lyra'), me, name).context).toBe(addressed)
    const priv = { private: true } as AskContext
    expect(routeAround(priv, settings(null, 's_lyra'), me, name).context).toBe(priv)
    const c = ctx('s_evo')
    expect(routeAround(c, null, me, name).context).toBe(c)
    expect(routeAround(c, { swarm_id: null, thread_budget_usd: 1 }, me, name).context).toBe(c)
  })
})

describe('threadInfo: the audit sentence only where it is true', () => {
  it('followups r4: the mind is called the orchestrator only when it is the coordinator', () => {
    const swarm = { id: 's_lyra', name: 'Lyra' }
    const facts = (f: { name: string; coordinator_id?: string | null } | undefined) => () => f
    // no coordinator: the mind answers directly through the answer-through route, and the line says so
    expect(threadInfo({ mind: { id: 'a_vega', name: 'Vega' }, swarm }, me, shown, facts({ name: 'Lyra', coordinator_id: null }))).toBe('Answers come from Vega’s own knowledge. Vega answers directly, because Lyra has no coordinator. Admins can review this in the audit log.')
    expect(threadInfo({ mind: { id: 'a_vega', name: 'Vega' }, swarm }, me, shown, facts({ name: 'Lyra', coordinator_id: '' }))).not.toMatch(/orchestrator/)
    // another mind coordinates: this one is not the orchestrator
    expect(threadInfo({ mind: { id: 'a_vega', name: 'Vega' }, swarm }, me, shown, facts({ name: 'Lyra', coordinator_id: 'a_orion' }))).toBe('Answers come from Vega’s own knowledge, in Lyra. Admins can review this in the audit log.')
    // not known who coordinates: nothing claimed
    expect(threadInfo({ mind: { id: 'a_vega', name: 'Vega' }, swarm }, me, shown)).not.toMatch(/orchestrator|no coordinator/)
    expect(threadInfo({ mind: { id: 'a_vega', name: 'Vega' }, swarm }, me, shown, facts({ name: 'Lyra' }))).not.toMatch(/orchestrator|no coordinator/)
  })
  const shown = (n: string) => n
  it('a personal-mind thread never says admins can review it', () => {
    const words = threadInfo({ mind: { id: 'a_me', name: 'Jon Grove' }, swarm: { id: 's_me', name: 'Jon Grove' } }, me, shown)
    expect(words).toBe('Answers come from Jon Grove’s own knowledge.')
    // another mind in the same swarm is not the person's own: its thread keeps the sentence
    expect(threadInfo({ mind: { id: 'a_other', name: 'Vega' }, swarm: { id: 's_me', name: 'Lyra' } }, me, shown)).toMatch(/Admins can review this in the audit log\.$/)
  })
  it('a swarm thread keeps it', () => {
    const lyra = (coordinator_id: string | null) => (id: string) => (id === 's_lyra' ? { name: 'Lyra', coordinator_id } : undefined)
    expect(threadInfo({ mind: { id: 'a_vega', name: 'Vega' }, swarm: { id: 's_lyra', name: 'Lyra' } }, me, shown, lyra('a_vega'))).toBe('Answers come from Vega’s own knowledge, as Lyra’s orchestrator. Admins can review this in the audit log.')
    expect(threadInfo({ mind: { id: 'a_vega', name: 'Vega' }, swarm: null }, null, shown)).toMatch(/Admins can review this in the audit log\.$/)
  })
})

/**
 * ask-fix r2 (Jon, live a37082e): on Design (OmegaDesign, no coordinator) "Make a poster…" fell back to his own mind
 * with "has no coordinator to answer", and nothing pointed an admin at the fix. INVENTED ids and names.
 */
describe('ask-fix r2: the words, the admin’s fix, and the mind it would answer through', () => {
  const settingsNone: AskSettings = { swarm_id: null, thread_budget_usd: 1, eligible: [{ id: 's_lyra', name: 'Lyra' }, { id: 's_kelp', name: 'Kelp Commons' }] }
  const design = (coordinator?: string | null) => (id: string) => (id === 's_des' ? { name: 'OmegaDesign', ...(coordinator === undefined ? {} : { coordinator_id: coordinator }) } : undefined)
  const page = ctx('s_des')
  it('"has no coordinator" only when the coordinator is known to be empty; otherwise "can’t answer here"', () => {
    expect(routeAround(page, settingsNone, me, design(null))).toMatchObject({ note: 'Answering: you', why: 'OmegaDesign has no coordinator' })
    expect(routeAround(page, settingsNone, me, design('a_coord'))).toMatchObject({ note: 'Answering: you', why: "OmegaDesign can't answer here" })
    expect(routeAround(page, settingsNone, me, design())).toMatchObject({ note: 'Answering: you', why: "OmegaDesign can't answer here" })
    expect(cannotAnswer(undefined)).toBe("This swarm can't answer here")
  })
  it('a make/draw request that falls back to the person’s own mind names the swarm for the admin’s fix; other requests do not', () => {
    expect(routeAround(page, settingsNone, me, design(null), 'Make a poster inviting neighbours to a small community event').fixSwarm).toBe('s_des')
    expect(routeAround(page, settingsNone, me, design(null), 'draw me a lantern').fixSwarm).toBe('s_des')
    expect(routeAround(page, settingsNone, me, design(null), 'what is this swarm working on?').fixSwarm).toBeUndefined()
    // not a fall back to the person's own mind (a usable default answers): no fix offered
    expect(routeAround(page, { ...settingsNone, swarm_id: 's_lyra' }, me, design(null), 'make a poster').fixSwarm).toBeUndefined()
  })
  it('answerMindFor: the mind that names the app, awake first; else the first addressable, awake first; never personal or stopped', () => {
    const minds = [
      { id: 'a_luke', name: 'Luke core mind', swarm_id: 's_des', status: 'awake' },
      { id: 'a_bench', name: 'Design benchmark maker', swarm_id: 's_des', status: 'created' },
      { id: 'a_deck', name: 'Design deck maker (native)', swarm_id: 's_des', status: 'asleep' },
      { id: 'a_mine', name: 'Design notes', swarm_id: 's_des', status: 'awake', personal_of: 'user:p_x' },
      { id: 'a_far', name: 'Design elsewhere', swarm_id: 's_other', status: 'awake' },
    ]
    expect(answerMindFor('s_des', minds, { id: 'omegadesign', name: 'OmegaDesign' })?.name).toMatch(/^Design /)
    expect(answerMindFor('s_des', minds, { id: 'omegadesign', name: 'OmegaDesign' })?.id).not.toBe('a_mine')
    expect(answerMindFor('s_des', minds, null)?.id).toBe('a_luke')
    expect(answerMindFor('s_des', [{ id: 'a_s', name: 'Stopped', swarm_id: 's_des', status: 'stopped' }], null)).toBeNull()
    // a module mind is refused by the host (not_allowed): never chosen, even awake and named for the app
    expect(answerMindFor('s_des', [{ id: 'a_mod', name: 'Design module', swarm_id: 's_des', status: 'awake', kind: 'module' }], { id: 'omegadesign', name: 'OmegaDesign' })).toBeNull()
    // the thread's mind is kept for follow-ups while it is still there
    expect(answerMindFor('s_des', minds, { id: 'omegadesign', name: 'OmegaDesign' }, 'a_luke')?.id).toBe('a_luke')
    expect(answerMindFor('s_des', minds, { id: 'omegadesign', name: 'OmegaDesign' }, 'a_gone')?.id).toBe('a_deck')
  })
})

describe('ask-fix r2: answering through a mind of a swarm with no coordinator', () => {
  const settingsNone: AskSettings = { swarm_id: null, thread_budget_usd: 1, eligible: [{ id: 's_lyra', name: 'Lyra' }] }
  const minds = [{ id: 'a_luke', name: 'Luke core mind', swarm_id: 's_des', status: 'awake' }, { id: 'a_deck', name: 'Design deck maker (native)', swarm_id: 's_des', status: 'asleep' }]
  const app = { id: 'omegadesign', name: 'OmegaDesign' }
  const page = ctx('s_des', { program: 'omegadesign' })
  const swarm = (coordinator_id?: string | null) => (id: string) => (id === 's_des' ? { name: 'OmegaDesign', ...(coordinator_id === undefined ? {} : { coordinator_id }) } : undefined)
  it('no coordinator (known): the app’s mind is addressed with the swarm kept; the r1 fallback rides along as compat', () => {
    const r = routeAround(page, settingsNone, me, swarm(null), 'make a poster', { minds, app })
    expect(r.context).toMatchObject({ swarm_id: 's_des', mind: 'a_deck' })
    expect(r.note).toBe('Answering: Design deck maker (native)')
    expect(r.why).toBe('OmegaDesign has no coordinator, so Design deck maker (native) answers directly')
    expect(r.compat?.context).not.toHaveProperty('swarm_id')
    expect(r.compat?.fixSwarm).toBe('s_des')
  })
  it('a coordinator that exists, or one not known: no mind is addressed (the coordinator path, or the r1 fallback)', () => {
    expect(routeAround(page, settingsNone, me, swarm('a_c'), 'make a poster', { minds, app }).context).not.toHaveProperty('mind')
    expect(routeAround(page, settingsNone, me, swarm(), 'make a poster', { minds, app }).context).not.toHaveProperty('mind')
  })
  it('no mind there: the r1 fallback and the admin fix', () => {
    const r = routeAround(page, settingsNone, me, swarm(null), 'make a poster', { minds: [], app })
    expect(r.context).not.toHaveProperty('mind')
    expect(r.fixSwarm).toBe('s_des')
  })
})
