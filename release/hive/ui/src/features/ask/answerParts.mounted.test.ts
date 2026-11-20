// @vitest-environment node
// Purpose: verify on real ReactDOM, in every look, what MeTTa composes under an Ask answer (answer.metta): the source
// line, and for research held back by an asleep Research swarm the press that wakes the swarm's coordinator and then sends
// the same request (store/askResearchWake), the person told why when they may not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useSyncExternalStore } from 'react'
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

/** A hive whose Research coordinator is stopped; `role` is the signed-in person's, `held` what the intent reads as now. */
function hive(o: { role: 'admin' | 'member'; held?: 'refused' | 'linked' }) {
  const calls: string[] = []
  let status = 'stopped'
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
    askIntent: (id: string) => noted(`read ${id}`, {
      intent_id: id, kind: 'research.request', state, destination: { to_swarm: 's_research' },
      last_refusal: state === 'refused' ? { code: 'not_available', reason: 'researcher_asleep', status: 409 } : null,
    }),
    askSubmitIntent: (id: string) => noted(`submit ${id}`, { intent_id: id, state: 'linked' }),
  }
  return { calls, client: client as unknown as ResearchWakeClient }
}

/** The parts under one answer, as AnswerParts draws them, with this test's hive behind the press. */
function Parts({ look, r, client }: { look: string; r: AskRow; client: ResearchWakeClient }) {
  const intent = r.wait?.intent
  const wake = useSyncExternalStore(askResearchWake.subscribe, () => (intent ? askResearchWake.view(intent) : null))
  const { data, facts } = answerScreen(r, wake)
  const plan = space.compose('ask-answer', look, facts)
  return createElement(Screen, { plan, host: { data, onAction: (action: string) => { if (action === 'wake-research' && intent) void askResearchWake.press(intent, client, HALEY) } } })
}

async function mount(look: string, client: ResearchWakeClient) {
  // each case its own intent, so the module's views never carry over
  const r: AskRow = { id: 'op#6', op: 'op', seq: 6, kind: 'answer', text: 'Here is what I can tell you myself.', who: 'Vega', source: { kind: 'model', of: 'mind' }, wait: { intent: `ai_res${++n}`, state: 'refused' } }
  await act(async () => root.render(createElement(Parts, { look, r, client })))
  const button = () => container.findAll((x) => x.tagName === 'BUTTON').find((b) => b.textContent === 'Wake Research and send')
  return { r, button, text: () => container.textContent }
}

async function settle() {
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((ok) => setTimeout(ok, 5)) })
}

describe('under an answer whose research waits on an asleep Research swarm, mounted in every look', () => {
  it.each(LOOKS)('%s: the source line and one press, which wakes the coordinator and then sends the same request', async (look) => {
    const { calls, client } = hive({ role: 'admin' })
    const { r, button, text } = await mount(look, client)
    expect(text()).toContain('From Vega’s model alone, without a web search.')
    expect(button()).toBeDefined()
    await act(async () => { press(button()!) })
    await settle()
    const intent = r.wait!.intent
    expect(calls).toContain('wake a_resctl')
    expect(calls.indexOf('wake a_resctl')).toBeLessThan(calls.indexOf(`submit ${intent}`))
    expect(calls.filter((c) => c.startsWith('submit'))).toEqual([`submit ${intent}`])
    expect(text()).toContain('Sent to Research controller. Its report comes back to this conversation.')
    expect(button()).toBeUndefined()
  })
  it.each(LOOKS)('%s: a person who may not wake it is told so, and nothing is woken or sent', async (look) => {
    const { calls, client } = hive({ role: 'member' })
    const { button, text } = await mount(look, client)
    await act(async () => { press(button()!) })
    await settle()
    expect(calls.some((c) => c.startsWith('wake') || c.startsWith('submit'))).toBe(false)
    expect(text()).toContain('You can’t wake Research controller with your current access, so the research wasn’t sent.')
    expect(button()).toBeUndefined()
  })
  it.each(LOOKS)('%s: a request already sent from elsewhere is never woken for or sent again', async (look) => {
    const { calls, client } = hive({ role: 'admin', held: 'linked' })
    const { button, text } = await mount(look, client)
    await act(async () => { press(button()!) })
    await settle()
    expect(calls.some((c) => c.startsWith('wake') || c.startsWith('submit'))).toBe(false)
    expect(text()).toContain('This research can’t be sent from here any more. Ask again to send it.')
  })
})

describe('the thread draws these parts under every answer', () => {
  it('AnswerRow draws the slot, which loads AnswerParts lazily; AnswerParts composes ask-answer and carries out the press', () => {
    expect(threadSource).toMatch(/export function AnswerRow[\s\S]*?<AnswerPartsSlot r=\{r\} \/>[\s\S]*?\n}/)
    // the screen engine stays out of the thread's first paint: only the slot is imported, and it imports AnswerParts lazily
    expect(threadSource).not.toMatch(/from '\.\/AnswerParts'/)
    expect(loaderSource).toContain("import('./AnswerParts')")
    expect(answerPartsSource).toContain("compose('ask-answer', facts)")
    expect(answerPartsSource).toMatch(/action === 'wake-research' && intent\) void askResearchWake\.press\(intent, useHive\.getState\(\)\.client, useAskStore\.getState\(\)\.bound\?\.principal\)/)
  })
})
