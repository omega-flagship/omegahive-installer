// Purpose: verify the Ask answers as the mind whose chat or card is open (Jon, 16 Nov: "the ask will auto route to
// whichever mind you're interacting with"): the signal's order, the context that carries it, the one plan that routes
// and names it as the host does, and every look's chat marking it.
import { afterEach, describe, expect, it, vi } from 'vitest'

const loc = { hash: '#/', search: '', pathname: '/' }
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })

const { mindInUse } = await import('./mindInUse')
const { inUseOf, planAsk, planRecipient, speaker, chipWords, threadInfo } = await import('./answerer')
const { askContext, routingContext } = await import('./context')
const { answererChoice } = await import('./answererChoice')
const { parse } = await import('../../lib/router')
type AskSettings = import('../../api/ask').AskSettings
type MyMind = import('../../api/ask').MyMind

/** Invented lives only: Ada's own mind Taiga, the swarm Home (coordinator Orchestra, and Worker), and Elsewhere. */
const TAIGA = { id: 'a_taiga01', name: 'Taiga', swarm_id: 's_taiga', status: 'awake' } as unknown as MyMind
const WORKER = { id: 'a_worker01', name: 'Worker', swarm_id: 's_home', status: 'awake', personal_of: null, kind: 'omega' }
const STRANGER = { id: 'a_strange1', name: 'Stranger', swarm_id: 's_elsewhere', status: 'awake', personal_of: null, kind: 'omega' }
const OUTSIDE = { id: 'a_module01', name: 'Outside', swarm_id: 's_home', status: 'awake', personal_of: null, kind: 'module' }
const home = { id: 's_home', name: 'Home', orchestrator: { id: 'a_orch0001', name: 'Orchestra', status: 'awake' } }
const settings: AskSettings = { swarm_id: null, thread_budget_usd: 0.25, eligible: [home], capabilities: { conductor: true, memory: false } }
const minds = [WORKER, STRANGER, OUTSIDE, { ...TAIGA, personal_of: 'user:p_ada', kind: 'omega' }]
const base = { settings, personal: TAIGA, swarmOf: () => undefined, through: { minds }, thread: null, carry: null, threadOpen: false }
const ctx = { route: 'hive', experience: 'classic' }

afterEach(() => {
  mindInUse.clear()
  answererChoice.clear()
})

describe('the mind in use is the chat opened last that is still open', () => {
  it('orders by opening, counts a mind open twice once, and falls back as each closes', () => {
    expect(mindInUse.get()).toBeNull()
    const closeWorker = mindInUse.open(WORKER.id)
    const closeTaiga = mindInUse.open(TAIGA.id)
    const closeWorkerAgain = mindInUse.open(WORKER.id)
    expect(mindInUse.get()).toBe(WORKER.id)
    closeWorkerAgain()
    expect(mindInUse.get()).toBe(WORKER.id)          // its first chat is still open
    closeWorker()
    expect(mindInUse.get()).toBe(TAIGA.id)
    closeWorker()                                    // a release counts once
    closeTaiga()
    expect(mindInUse.get()).toBeNull()
  })
})

describe('the Ask carries it, and the one plan answers as it the way the host routes', () => {
  it('the context names the open chat\'s mind; a private app\'s page never does', () => {
    const close = mindInUse.open(WORKER.id)
    expect(askContext(parse('#/'), 'canvas', 'in Canvas')).toMatchObject({ with: WORKER.id })
    expect(routingContext(parse('#/'), 'canvas')).toMatchObject({ with: WORKER.id })
    expect(askContext(parse('#/program/atlas'), 'canvas', 'in the app')).toEqual({ private: true })
    close()
    expect(routingContext(parse('#/'), 'canvas')).not.toHaveProperty('with')
  })

  it('Worker in use answers, named on the chip, routed to its coordinator, in Worker\'s voice', () => {
    const plan = planAsk({ ...ctx, swarm_id: 's_somewhere_else', with: WORKER.id }, base)
    expect(plan.inUse).toEqual({ id: WORKER.id, name: 'Worker' })
    expect(plan.context).toMatchObject({ with: WORKER.id })
    expect(chipWords(plan.chip!)).toBe('Answering: Worker')
    const facts = { agents: { [WORKER.id]: WORKER, a_orch0001: { id: 'a_orch0001', name: 'Orchestra' } }, swarms: { s_home: { coordinator_id: 'a_orch0001', name: 'Home' } }, personal: TAIGA, settings }
    expect(planRecipient(plan, facts)).toEqual({ id: 'a_orch0001', name: 'Orchestra' })
    expect(speaker({ conductor: true, personal: TAIGA, reaches: 'Orchestra', reachesId: 'a_orch0001', inUse: plan.inUse })).toEqual({ name: 'Worker', id: WORKER.id })
    // without one in use, the person's own mind speaks, as before
    expect(speaker({ conductor: true, personal: TAIGA, reaches: 'Orchestra', reachesId: 'a_orch0001' })).toEqual({ name: 'Taiga', id: TAIGA.id })
    // the thread is Orchestra's and the voice Worker's (the hive's speaks_as): its line says so, never Orchestra's knowledge
    expect(threadInfo({ mind: { id: 'a_orch0001', name: 'Orchestra' }, swarm: { id: 's_home', name: 'Home' } }, TAIGA, (n) => n, () => undefined, { mind_id: WORKER.id, name: 'Worker' }))
      .toBe('Worker answers here, working with Orchestra. Admins can review this in the audit log.')
  })

  it('her own mind in use is her own mind; one the Ask can\'t use is never sent', () => {
    const own = planAsk({ ...ctx, with: TAIGA.id }, base)
    expect(own.inUse).toEqual({ id: TAIGA.id, name: 'Taiga' })
    expect(chipWords(own.chip!)).toBe('Answering: Taiga')
    for (const m of [STRANGER, OUTSIDE]) {
      const plan = planAsk({ ...ctx, with: m.id }, base)
      expect(plan.inUse).toBeUndefined()
      expect(plan.context).not.toHaveProperty('with')
    }
  })

  it('without the hive\'s conductor nothing can speak as it, so the Ask routes as if no chat were open', () => {
    const plain = { ...base, settings: { ...settings, capabilities: { conductor: false, memory: false } } }
    const plan = planAsk({ ...ctx, with: WORKER.id }, plain)
    expect(plan.inUse).toBeUndefined()
    expect(plan.context).not.toHaveProperty('with')
    expect(inUseOf({ ...ctx, with: WORKER.id }, { ...base, settings: { ...settings, capabilities: undefined } })).toBeNull()
  })

  it('a mind named in the words, or the person\'s explicit choice, still wins', () => {
    expect(inUseOf({ ...ctx, mind: STRANGER.id, with: WORKER.id }, base)).toBeNull()
    expect(inUseOf({ ...ctx, with: WORKER.id }, { ...base, explicitChoice: true })).toBeNull()
    answererChoice.select({ kind: 'swarm', swarm: 's_home', name: 'Home' }, () => true)
    expect(answererChoice.apply({ ...ctx, with: WORKER.id })).not.toHaveProperty('with')
  })
})

describe('every look\'s mind chat marks its mind in use while it is open', () => {
  const chats: [string, string][] = [
    ['../dot/Chat.tsx', 'export function Chat('],
    ['../../experiences/canvas/chat.tsx', 'export function ChatCard('],
    ['../../experiences/flux/panels.tsx', 'function Talk('],
    ['../../experiences/construct/Panes.tsx', 'export function Session('],
    ['../../experiences/professional/Conversation.tsx', 'export function Conversation('],
    ['../../experiences/cosmos/Panels.tsx', 'function Comms('],
  ]
  // vite's own raw glob (no node fs in the app's types), keyed by the paths as written
  const sources = import.meta.glob(['../dot/Chat.tsx', '../../experiences/canvas/chat.tsx', '../../experiences/flux/panels.tsx', '../../experiences/construct/Panes.tsx', '../../experiences/professional/Conversation.tsx', '../../experiences/cosmos/Panels.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  it.each(chats)('%s', (file, component) => {
    const text = sources[file]
    const body = text.slice(text.indexOf(component))
    expect(body.slice(0, body.indexOf('\n}\n'))).toContain('useMindInUse(agent.id)')
  })
})
