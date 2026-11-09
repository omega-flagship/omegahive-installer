import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Agent, Message } from '../../api/types'
import { healthCheck } from '../../lib/healthQuestion'

/**
 * Health's idle question reaches the mind as "[HEALTH-QUESTION hq_…] text"; a person never sees the tag (Jon 3 Nov:
 * "really very ugly"). Peter on omegahive#50: the HIVE hands people a verified Health question untagged and marked
 * health_check (health.people_message; hive/tests/test_health_question_people.py), and the client rewrites nothing:
 * each look shows the hive's words and a "Health check" label for the hive's mark. Invented data only.
 */
vi.mock('zustand', async (orig) => {
  const z = await orig<typeof import('zustand')>()
  const build = (init: never) => {
    const api = z.createStore(init)
    ;(api as { getInitialState: unknown }).getInitialState = api.getState
    return Object.assign((sel?: never) => z.useStore(api, sel as never), api)
  }
  return { ...z, create: ((init?: never) => (init ? build(init) : build)) as never }
})

// Construct writes its words in a layout effect (a decode animation), which a server render never runs: render them plainly
vi.mock('../../experiences/construct/Decode', async () => {
  const { createElement: h } = await import('react')
  return { Decode: ({ text, className }: { text: string; className?: string }) => h('span', { className }, text) }
})

const PLAIN = "You've spent $0.03 over 1.5 hours with no input: sleep, or tell me what you're waiting for?"
const agent = { id: 'a_inv', name: 'Invented Wren', hue: 200, status: 'awake', model: 'm', spent_usd: 0, budget_usd: 0, role: 'r', swarm_ids: [], created_at: '2026-11-01T00:00:00Z' } as unknown as Agent
/** As the hive answers people: Health's question plain and marked; a mind quoting the tag exactly as it wrote it. */
const shown: Message[] = [
  { id: 'm1', agent_id: 'a_inv', conversation_id: 'c_a_inv', direction: 'in', sender: 'user:ada', text: 'Hello Wren', created_at: '2026-11-03T10:00:00Z' },
  { id: 'm2', agent_id: 'a_inv', conversation_id: 'c_a_inv', direction: 'in', sender: 'hive:health', text: PLAIN, created_at: '2026-11-03T11:00:00Z', health_check: true },
  { id: 'm3', agent_id: 'a_inv', conversation_id: 'c_a_inv', direction: 'out', sender: 'agent:a_inv', text: 'Waiting on [HEALTH-QUESTION hq_709c522d] Ada.', created_at: '2026-11-03T11:01:00Z' },
]

describe('the client rewrites nothing (Peter on omegahive#50)', () => {
  it('there is no client-side scrubber or proxy any more', async () => {
    const client = await import('../../api/client')
    const lib = await import('../../lib/healthQuestion')
    expect('forPeople' in client).toBe(false)
    expect(Object.keys(lib)).toEqual(['healthCheck'])
    expect(healthCheck(shown[1])).toBe(true)
    expect(healthCheck({ ...shown[1], health_check: undefined })).toBe(false)   // the text never earns the mark
    expect(healthCheck(shown[2])).toBe(false)
  })

  it('a Code file read through codeProxy round-trips byte for byte, tag and all', async () => {
    const SOURCE = 'const QUESTION = "[HEALTH-QUESTION hq_709c522d] Sleep?"\n// [HEALTH-QUESTION hq_0000beef] kept\n'
    const stored: Record<string, string> = { 'hive/tests/fixture.py': SOURCE }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const path = 'hive/tests/fixture.py'
      if ((init.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ path, content: stored[path] }), { status: 200, headers: { 'content-type': 'application/json' } })
      stored[path] = (JSON.parse(String(init.body)) as { content: string }).content
      return new Response(JSON.stringify({ ok: true, url }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    try {
      const { LiveClient } = await import('../../api/live')
      const live = new LiveClient('http://hive.invalid')
      const opened = await live.codeProxy<{ content: string }>('GET', '/v1/files', { task_id: 't', grant_id: 'g', repository_id: 'r' })
      expect(opened.content).toBe(SOURCE)
      await live.codeProxy('POST', '/v1/files', { task_id: 't', grant_id: 'g', repository_id: 'r' }, { content: opened.content + 'x = 1\n' })
      expect(stored['hive/tests/fixture.py']).toBe(SOURCE + 'x = 1\n')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('an ordinary Health alert never hides the question\'s label (Copilot on omegahive#50)', async () => {
  const { useHive } = await import('../../store/store')
  const alert: Message = { id: 'm0', agent_id: 'a_inv', conversation_id: 'c_a_inv', direction: 'in', sender: 'hive:health',
    text: 'Health alert: spend is climbing.', created_at: '2026-11-03T11:00:00Z' }
  const question: Message = { ...shown[1], created_at: '2026-11-03T11:00:30Z' }   // same sender, 30 s later
  const { Chat } = await import('../dot/Chat')
  const { ChatCard } = await import('../../experiences/canvas/chat')
  const looks: [string, () => ReactElement][] = [
    ['classic chat', () => createElement(Chat, { agent })],
    ['canvas', () => createElement(ChatCard, { r: { x: 0, y: 0, w: 400, h: 600 } as never, agent, phase: undefined, now: Date.parse('2026-11-03T12:00:00Z'), reduced: true, onCloseX: () => undefined, onDismiss: () => undefined })],
  ]
  for (const [look, view] of looks) {
    it(look, () => {
      useHive.setState({ agents: { a_inv: agent }, messages: { a_inv: [alert, question] } } as never)
      const html = renderToStaticMarkup(view())
      expect(html).toContain('spend is climbing')
      expect(html).toMatch(/health.check/i)
    })
  }
})

describe('each look shows a Health check label, never the tag', async () => {
  const { useHive } = await import('../../store/store')
  const seed = (messages: Message[]) => useHive.setState({ agents: { a_inv: agent }, messages: { a_inv: messages } } as never)

  const { Chat } = await import('../dot/Chat')
  const { Conversation } = await import('../../experiences/professional/Conversation')
  const flux = await import('../../experiences/flux/panels')
  const { FluxCtx } = await import('../../experiences/flux/ctx')
  const noop = () => undefined
  const fluxApi = { world: {}, gpu: false, reduced: true, desktop: true, view: {}, openSwarm: noop, openMind: noop, openDecision: noop, closeDecision: noop, home: noop, sheet: null, openSheet: noop }
  const cosmos = await import('../../experiences/cosmos/Panels')
  const { ChatCard } = await import('../../experiences/canvas/chat')
  const { Reading } = await import('../../experiences/still/Reading')
  const { Session } = await import('../../experiences/construct/Panes')
  const looks: [string, () => ReactElement][] = [
    ['classic chat', () => createElement(Chat, { agent })],
    ['professional', () => createElement(Conversation, { agent, ctx: 'x' })],
    ['flux', () => createElement(FluxCtx.Provider, { value: fluxApi as never }, createElement(flux.MindPanel, { id: 'a_inv' }))],
    ['cosmos', () => createElement(cosmos.MindPanel, { id: 'a_inv', desktop: true })],
    ['canvas', () => createElement(ChatCard, { r: { x: 0, y: 0, w: 400, h: 600 } as never, agent, phase: undefined, now: Date.parse('2026-11-03T12:00:00Z'), reduced: true, onCloseX: () => undefined, onDismiss: () => undefined })],
    ['still', () => createElement(Reading, { id: 'a_inv', onClose: () => undefined })],
    ['construct', () => createElement(Session, { agent, phone: false })],
  ]
  for (const [look, view] of looks) {
    it(look, () => {
      seed(shown)
      const html = renderToStaticMarkup(view())
      expect(html).toContain("over 1.5 hours with no input")
      expect(html).not.toContain('[HEALTH-QUESTION hq_709c522d] You')   // Health's question: the hive's plain words
      expect(html).toContain('Waiting on [HEALTH-QUESTION hq_709c522d] Ada.')  // a mind quoting the tag: as it wrote it
      expect(html).toMatch(/health.check/i)
      // and the check bites: the mark, not the text, earns the label; unmarked, the same words get none
      seed(shown.map((m) => ({ ...m, health_check: undefined })))
      expect(renderToStaticMarkup(view())).not.toMatch(/health.check/i)
    })
  }
})

describe('the simulator answers with the people contract (sol and Kimi on 7cf0ca57)', () => {
  it('no idle record, list or Remind ever carries the tag: the question is the plain words, as the hive sends it', async () => {
    const { SimClient } = await import('../../api/sim/SimClient')
    const sim = new SimClient({ seed: 11, latency: false, autoStart: false, historyDays: 1 })
    const list = await sim.idleMinds!()
    const ids = list.minds.map((m: { id: string }) => m.id)
    expect(ids.length).toBeGreaterThan(0)
    const details = await Promise.all(ids.map((id: string) => sim.idleMind!(id)))
    const reminded = await sim.remindIdle!(ids[0]).catch(() => null)
    const all = JSON.stringify([list, details, reminded])
    expect(all).toContain('question')
    expect(all).not.toContain('[HEALTH-QUESTION')
    sim.disconnect()
  })
})
