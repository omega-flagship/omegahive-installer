// @vitest-environment node
// Purpose: verify on real ReactDOM, in every look, what MeTTa composes under an Ask answer (answer.metta): the source
// line, and for research held back by an asleep Research swarm the press that wakes the swarm's coordinator and then sends
// the same request (store/askResearchWake), offered only where it can go through and otherwise saying who can wake it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useEffect, useSyncExternalStore } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, type MiniNode } from '../../ui/miniDom.testkit'
import { Screen } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import type { AskRow } from '../../store/ask'
import { askResearchWake, type ResearchWakeClient } from '../../store/askResearchWake'
import { answerScreen } from './answerFacts'
import answerPartsSource from './AnswerParts.tsx?raw'
import loaderSource from './answerPartsLoader.ts?raw'
import threadSource from './Thread.tsx?raw'

// each file opens a real MeTTa space: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const LOOKS = ['classic', 'cosmos', 'flux', 'canvas', 'still', 'construct', 'professional']
const space = ScreensSpace.open()
const HALEY = 'user:u_haley'
let container: MiniNode, root: Root
let saved: Record<string, unknown>
let n = 0

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  saved = {}
  for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[key] = g[key]
  const doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  container = doc.createElement('div'); doc.body.appendChild(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as Element)
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v
})

/**
 * A hive whose Research coordinator is `status` (stopped unless said); `role` is the signed-in person's, `held` what the
 * intent reads as now, and `unread` makes every intent read fail. `wakeUp` wakes the coordinator as someone else would.
 */
function hive(o: { role: 'admin' | 'member'; held?: 'refused' | 'linked'; status?: string; unread?: boolean }) {
  const calls: string[] = []
  let status = o.status ?? 'stopped'
  const state = o.held ?? 'refused'
  // each read or effect is noted, in order, then answered as the hive would
  const noted = <V>(call: string, answer: V) => {
    calls.push(call)
    return Promise.resolve(answer)
  }
  const client = {
    me: () => noted('me', { principal: HALEY, role: o.role }),
    askSettings: () => Promise.resolve({}),
    myMind: () => Promise.resolve(null),
    getSwarm: (id: string) => noted(`swarm ${id}`, { id, name: 'Research', coordinator_id: 'a_resctl', owner: 'user:u_owner' }),
    getAgent: (id: string) => noted(`agent ${id}`, { id, name: 'Research controller', swarm_id: 's_research', kind: 'omega', status, may_sleep: o.role === 'admin', personal_of: null }),
    agentAction: (id: string, action: string) => {
      status = 'awake'
      return noted(`${action} ${id}`, { id, status })
    },
    askIntent: (id: string) => o.unread ? (calls.push(`read ${id}`), Promise.reject(new Error('offline'))) : noted(`read ${id}`, {
      intent_id: id, kind: 'research.request', state, destination: { to_swarm: 's_research' },
      last_refusal: state === 'refused' ? { code: 'not_available', reason: 'researcher_asleep', status: 409 } : null,
    }),
    askSubmitIntent: (id: string) => noted(`submit ${id}`, { intent_id: id, state: 'linked' }),
  }
  return { calls, client: client as unknown as ResearchWakeClient, wakeUp: () => { status = 'awake' } }
}

/**
 * The parts under one answer, as AnswerParts draws them, with this test's hive behind the check and the press: `live` is
 * the coordinator's status as the page holds it (the hive's live minds in AnswerParts).
 */
function Parts({ look, r, client, live }: { look: string; r: AskRow; client: ResearchWakeClient; live?: string }) {
  const intent = r.wait?.intent
  const wake = useSyncExternalStore(askResearchWake.subscribe, () => (intent ? askResearchWake.view(intent) : null))
  const stands = wake?.status
  useEffect(() => {
    if (intent) void askResearchWake.check(intent, client, HALEY, live)
  }, [intent, client, live, stands])
  const { data, facts } = answerScreen(r, wake)
  const plan = space.compose('ask-answer', look, facts)
  return createElement(Screen, { plan, host: { data, onAction: (action: string) => { if (action === 'wake-research' && intent) void askResearchWake.press(intent, client, HALEY) } } })
}

async function mount(look: string, client: ResearchWakeClient, live?: string) {
  // each case its own intent, so the module's views never carry over
  const r: AskRow = { id: 'op#6', op: 'op', seq: 6, kind: 'answer', text: 'Here is what I can tell you myself.', who: 'Vega', source: { kind: 'model', of: 'mind' }, wait: { intent: `ai_res${++n}`, state: 'refused' } }
  const draw = (now?: string) => act(async () => root.render(createElement(Parts, { look, r, client, live: now })))
  await draw(live)
  await settle()
  const buttons = () => container.findAll((x) => x.tagName === 'BUTTON')
  const button = (label = 'Wake Research and send') => buttons().find((b) => b.textContent === label)
  return { r, button, buttons, draw, text: () => container.textContent }
}

async function settle() {
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((ok) => setTimeout(ok, 5)) })
}

describe('under an answer whose research waits on an asleep Research swarm, mounted in every look', () => {
  it.each(LOOKS)('%s: the source line and, once checked, one press, which wakes the coordinator and then sends the same request', async (look) => {
    const { calls, client } = hive({ role: 'admin' })
    const { r, button, text } = await mount(look, client)
    expect(text()).toContain('From Vega’s model alone, without a web search.')
    expect(button()).toBeDefined()
    // the check read the request and the coordinator, and woke and sent nothing
    const intent = r.wait!.intent
    expect(calls).toEqual([`read ${intent}`, 'me', 'swarm s_research', 'agent a_resctl'])
    await act(async () => { press(button()!) })
    await settle()
    expect(calls).toContain('wake a_resctl')
    expect(calls.indexOf('wake a_resctl')).toBeLessThan(calls.indexOf(`submit ${intent}`))
    expect(calls.filter((c) => c.startsWith('submit'))).toEqual([`submit ${intent}`])
    expect(text()).toContain('Sent to Research controller. Its report comes back to this conversation.')
    expect(button()).toBeUndefined()
  })
  it.each(LOOKS)('%s: a person who may not wake it is offered no press and told who can, and nothing is woken or sent', async (look) => {
    const { calls, client } = hive({ role: 'member' })
    const { buttons, text } = await mount(look, client)
    expect(buttons()).toEqual([])
    expect(text()).toContain('Only Research controller’s owner or a hive admin can wake it, so the research wasn’t sent.')
    expect(calls.some((c) => c.startsWith('wake') || c.startsWith('submit'))).toBe(false)
  })
  it.each(LOOKS)('%s: with the coordinator awake already, anyone is offered Send, which sends without waking', async (look) => {
    const { calls, client } = hive({ role: 'member', status: 'awake' })
    const { r, button, text } = await mount(look, client)
    expect(button()).toBeUndefined()
    await act(async () => { press(button('Send the research')!) })
    await settle()
    expect(calls.some((c) => c.startsWith('wake'))).toBe(false)
    expect(calls.filter((c) => c.startsWith('submit'))).toEqual([`submit ${r.wait!.intent}`])
    expect(text()).toContain('Sent to Research controller. Its report comes back to this conversation.')
  })
  it.each(LOOKS)('%s: a request already sent from elsewhere is never woken for or sent again', async (look) => {
    const { calls, client } = hive({ role: 'admin', held: 'linked' })
    const { buttons, text } = await mount(look, client)
    expect(buttons()).toEqual([])
    expect(calls.some((c) => c.startsWith('wake') || c.startsWith('submit'))).toBe(false)
    expect(text()).toContain('This research can’t be sent from here any more. Ask again to send it.')
  })
})

describe('the check runs again when what it read moves on', () => {
  it('a person told who can wake it is offered Send once someone else wakes the coordinator', async () => {
    const { calls, client, wakeUp } = hive({ role: 'member' })
    const { button, draw, text } = await mount('classic', client, 'stopped')
    expect(button('Send the research')).toBeUndefined()
    expect(text()).toContain('Only Research controller’s owner or a hive admin can wake it')
    const reads = calls.length
    // the page's minds hear the coordinator wake (agent.updated): one more read, no wake and no send
    wakeUp()
    await draw('awake')
    await settle()
    expect(calls.length).toBe(reads + 4)
    expect(button('Send the research')).toBeDefined()
    expect(text()).not.toContain('Only Research controller’s owner')
    expect(calls.some((c) => c.startsWith('wake') || c.startsWith('submit'))).toBe(false)
    // the same status again reads nothing more
    await draw('awake')
    await settle()
    expect(calls.length).toBe(reads + 4)
  })
  it('a page out of step with the hive reads once more, not again and again', async () => {
    // the page still holds the coordinator as stopped while the hive has it awake
    const { calls, client } = hive({ role: 'member', status: 'awake' })
    const { button } = await mount('classic', client, 'asleep')
    expect(button('Send the research')).toBeDefined()
    expect(calls.filter((c) => c.startsWith('read'))).toHaveLength(1)
  })
  it('a request whose read fails is offered as before, and the press reads it again', async () => {
    const { calls, client } = hive({ role: 'admin', unread: true })
    const { button } = await mount('classic', client)
    expect(button()).toBeDefined()
    expect(calls.filter((c) => c.startsWith('read'))).toHaveLength(1)
    await act(async () => { press(button()!) })
    await settle()
    expect(calls.filter((c) => c.startsWith('read'))).toHaveLength(2)
    expect(calls.some((c) => c.startsWith('wake') || c.startsWith('submit'))).toBe(false)
  })
})

describe('the thread draws these parts under every answer', () => {
  it('AnswerRow draws the slot, which loads AnswerParts lazily; AnswerParts composes ask-answer, has it checked and carries out the press', () => {
    expect(threadSource).toMatch(/export function AnswerRow[\s\S]*?<AnswerPartsSlot r=\{r\} \/>[\s\S]*?\n}/)
    // the screen engine stays out of the thread's first paint: only the slot is imported, and it imports AnswerParts lazily
    expect(threadSource).not.toMatch(/from '\.\/AnswerParts'/)
    expect(loaderSource).toContain("import('./AnswerParts')")
    expect(answerPartsSource).toContain("compose('ask-answer', facts)")
    expect(answerPartsSource).toMatch(/action === 'wake-research' && intent\) void askResearchWake\.press\(intent, useHive\.getState\(\)\.client, useAskStore\.getState\(\)\.bound\?\.principal\)/)
    // checked as this test's Parts checks it: on the request, and again once the coordinator's live status moves on
    expect(answerPartsSource).toMatch(/const live = useHive\(\(s\) => \(mind \? s\.agents\[mind\]\?\.status : undefined\)\)/)
    expect(answerPartsSource).toMatch(/useEffect\(\(\) => \{\s*if \(intent\) void askResearchWake\.check\(intent, client, principal, live\)\s*\}, \[intent, client, principal, live, stands\]\)/)
  })
})
