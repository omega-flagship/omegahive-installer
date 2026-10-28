/**
 * r3 (stand-in Review FIX-FIRST on 0215895, coordination/omegareview/standin/STANDIN_canvas_VERDICT_20261006.md):
 * behavioural tests for its witnesses, through the code paths the canvas actually runs (VibeSession is what useVibe
 * renders; CapabilityReader is what useCodeFeatures renders; handleAskKey / handlePaletteKey are what AskHost and the
 * shell bind; fenceLayers is what the Editor draws). Each was shown to fail with its fix removed (receipts p3-*).
 */
import { describe, expect, it, vi } from 'vitest'
import type { CodeContext } from '../../../api/client'
import { SimCodeService } from '../../../api/sim/codeService'
import { handleAskKey } from '../../ask/summon'
import { handlePaletteKey } from '../../../shell/shortcuts'
import type { WorkspaceHead } from '../suggestions/contract'
import { CapabilityReader, DEPENDENT_GROUPS, groupsProblem, PLAIN_SUMMARY, type Caps } from './features'
import { fenceLayers, fitInk, NO_LAYERS } from './layers'
import { scopeWords } from './vibe'
import { VibeSession, type SavedFile } from './vibeSession'
import { intentsKit, until } from './vibeIntents.testkit'

const WS = 'ws_r3'
const CTX: CodeContext = { task_id: 'g_r3', grant_id: 'grant_r3', repository_id: 'sim-suggestions' }
const READY: Caps = { status: 'ready', key: 'k', features: new Set([DEPENDENT_GROUPS, PLAIN_SUMMARY]) }

function deferred() {
  let open!: () => void
  const p = new Promise<void>((r) => (open = r))
  return { p, open }
}

/** A client over the simulator's invented service and its intents mirror; each mind answer waits for its own gate. */
async function setup() {
  const svc = new SimCodeService({ workspace_id: WS, task_id: CTX.task_id })
  const ws = (await svc.proxy('GET', `/v1/workspaces/${WS}`, {}, null)) as WorkspaceHead
  const kit = intentsKit(svc, { ctx: CTX, gated: true })
  const f = (await svc.proxy('GET', `/v1/workspaces/${WS}/files`, { path: 'src/greeting.py' }, null)) as { content: string; digest: string }
  const greeting: SavedFile = { path: 'src/greeting.py', content: f.content, digest: f.digest }
  const t = (await svc.proxy('GET', `/v1/workspaces/${WS}/files`, { path: 'tests/test_greeting.py' }, null)) as { content: string; digest: string }
  const tests: SavedFile = { path: 'tests/test_greeting.py', content: t.content, digest: t.digest }
  const session = new VibeSession({ set: () => 0 as unknown as ReturnType<typeof setTimeout>, clear: () => undefined }, { pollMs: [5] })
  session.deps = { client: kit.client, ctx: CTX, ws, onWorkspace: async () => undefined, turn: kit.turn }
  return { svc, session, gates: kit.gates, greeting, tests }
}
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5))
}
const who = () => 'Anvil'

describe('P1-1: overlapping requests never pair one request’s scope with another’s proposal', () => {
  it('A (lines 4–7) answered after B (whole file): what is shown, summarised and confirmed is B, all of it', async () => {
    const { session, gates, greeting } = await setup()
    const lines = { from: greeting.content.indexOf('def greet'), to: greeting.content.indexOf('return message') + 'return message'.length }
    const a = session.ask('add type hints', lines, greeting, false, who, true)
    await until(() => gates.length === 1)
    const b = session.ask('use an f-string', null, greeting, false, who, true)
    await until(() => gates.length === 2)
    expect(gates).toHaveLength(2)
    gates[1].open() // B answers first
    await b
    gates[0].open() // then A, late
    await a
    await settle()
    const r = session.getState().result!
    expect(r.instruction).toBe('use an f-string')
    expect(r.scope).toEqual({ path: 'src/greeting.py', lines: null })
    // the proposal shown is the one minted under B's scope (the whole file), not A's lines
    expect(r.read.content.scope['src/greeting.py']).toEqual([[0, new TextEncoder().encode(greeting.content).length]])
    session.review(greeting, false, READY)
    const p = session.getState().reviewing!
    expect(p.request.suggestion_id).toBe(r.read.record.id)
    const facts = Object.fromEntries(session.facts(p, 'x'))
    expect(facts['You allowed']).toBe(`${scopeWords({ path: 'src/greeting.py', lines: null })} (the mind could change nothing outside it)`)
    expect(facts['You asked']).toBe('“use an f-string”')
  })
  it('a reset (Later) while a request is in flight: its late answer shows nothing', async () => {
    const { session, gates, greeting } = await setup()
    const a = session.ask('add type hints', null, greeting, false, who, true)
    await until(() => gates.length === 1)
    session.reset()
    gates[0].open()
    await a
    await settle()
    expect(session.getState().result).toBeNull()
    expect(session.getState().phase.kind).toBe('idle')
  })
})

describe('P1-2: a proposal stays on the file it was placed on', () => {
  it('opening another file draws none of it, cannot decide it, and the summary still names its own file', async () => {
    const { session, gates, greeting, tests } = await setup()
    const a = session.ask('add type hints and use an f-string', null, greeting, false, who, true)
    await until(() => gates.length === 1)
    gates[0].open()
    await a
    expect(session.changeViews(greeting, false).length).toBeGreaterThan(0)
    expect(session.changeViews(tests, false)).toEqual([])
    expect(session.changeViews(greeting, true)).toEqual([]) // unsaved edits: offsets no longer fit
    expect(session.changeViews({ ...greeting, digest: 'f'.repeat(64) }, false)).toEqual([]) // another version
    expect(session.blockedWhy(tests, false, READY)).toBe('This proposal is for src/greeting.py. Open it to decide.')
    session.review(tests, false, READY)
    expect(session.getState().reviewing).toBeNull()
    expect(session.summary('Anvil', READY)!.headline).toContain('greeting.py')
  })
  it('the editor draws changes and presence only for the exact file and text they were placed on', () => {
    const l = { ...NO_LAYERS, changes: [{ id: 'h', n: 1, from: 0, to: 3, after: 'x', state: 'keep' as const }], for: { path: 'a.py', text: 'abc' } }
    expect(fenceLayers(l, 'a.py', 'abc').changes).toHaveLength(1)
    expect(fenceLayers(l, 'b.py', 'abc').changes).toEqual([])
    expect(fenceLayers(l, 'a.py', 'abcd').changes).toEqual([])
    expect(fenceLayers({ ...l, for: undefined }, 'a.py', 'abc').changes).toEqual([])
  })
})

describe('P2-3: every read that replaces the shown proposal is verified itself', () => {
  it('a refreshed read that fails integrity is never shown as checked, and cannot be decided', async () => {
    const { svc, session, gates, greeting } = await setup()
    const a = session.ask('use an f-string', null, greeting, false, who, true)
    await until(() => gates.length === 1)
    gates[0].open()
    await a
    expect(session.getState().result!.integrity.ok).toBe(true)
    // the retained content changes under the same record (a corrupted refresh)
    const id = session.getState().result!.read.record.id
    ;(svc as unknown as { suggestions: Map<string, { content: { hunks: { replacement: string }[] } }> }).suggestions.get(id)!.content.hunks[0].replacement = 'print("not what was retained")'
    await session.refresh()
    const r = session.getState().result!
    expect(r.read.content.hunks[0].replacement).toBe('print("not what was retained")')
    expect(r.integrity.ok).toBe(false)
    expect(r.integrity.digest).toBe(r.read.record.digest)
    expect(session.blockedWhy(greeting, false, READY)).toMatch(/integrity/)
  })
})

describe('P2-4: capabilities belong to their context and fail closed', () => {
  it('A declared groups → switching to B is “checking” at once, B failing is “failed”, A’s late answer is dropped', async () => {
    const reader = new CapabilityReader()
    await reader.load('A', async () => ({ features: [DEPENDENT_GROUPS] }))
    expect(reader.stateFor('A')).toMatchObject({ status: 'ready' })
    expect(groupsProblem([['x', 'y']], reader.stateFor('A'))).toBeNull()
    // a new context before its answer: nothing is lent from A
    expect(reader.stateFor('B')).toMatchObject({ status: 'checking' })
    expect(reader.stateFor('B').features.size).toBe(0)
    expect(groupsProblem([['x', 'y']], reader.stateFor('B'))).toMatch(/Checking/)
    const late = deferred()
    const aAgain = reader.load('A', () => late.p.then(() => ({ features: [DEPENDENT_GROUPS] })))
    await reader.load('B', async () => {
      throw new Error('503 service_unavailable')
    })
    late.open()
    await aAgain
    expect(reader.getState()).toMatchObject({ status: 'failed', key: 'B' })
    expect(reader.getState().features.size).toBe(0)
    expect(groupsProblem([['x', 'y']], reader.getState())).toMatch(/Couldn’t check/)
  })
  it('the session will not decide a grouped proposal while capabilities are unknown, and picks no “why” wording until known', async () => {
    const { session, gates, greeting } = await setup()
    const a = session.ask('add type hints and use an f-string', null, greeting, false, who, true)
    await until(() => gates.length === 1)
    gates[0].open()
    await a
    expect(session.getState().result!.read.content.hunk_groups?.length).toBeGreaterThan(0)
    const checking = { status: 'checking' as const, features: new Set<string>() }
    expect(session.blockedWhy(greeting, false, checking)).toMatch(/Checking/)
    expect(session.blockedWhy(greeting, false, { status: 'failed', features: new Set() })).toMatch(/Couldn’t check/)
    expect(session.blockedWhy(greeting, false, READY)).toBeNull()
    expect(session.summary('Anvil', checking)!.why).toBe('')
    expect(session.summary('Anvil', READY)!.why).toMatch(/^Anvil says:/)
  })
})

describe('the keys: both global ⌘K handlers yield inside the code, and work everywhere else', () => {
  const target = (owner: string | null) => ({ closest: (sel: string) => (owner !== null && sel === '[data-owns-shortcut]' ? { getAttribute: () => owner } : null) })
  const ev = (owner: string | null, mods: { meta?: boolean; ctrl?: boolean } = { meta: true }) => ({ key: 'k', metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: false, target: target(owner), preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() })
  it('the Ask’s capture handler leaves ⌘K in the code alone (no preventDefault, no stop, no focus)', () => {
    const input = { focus: vi.fn() }
    const e = ev('mod+k')
    expect(handleAskKey(e, { stillBox: null, input: () => input, modalOpen: () => false }, true)).toBe(false)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(e.stopImmediatePropagation).not.toHaveBeenCalled()
    expect(input.focus).not.toHaveBeenCalled()
  })
  it('the Ask’s capture handler takes ⌘K elsewhere, and Ctrl+K on a Mac even in the code', () => {
    for (const e of [ev(null), ev('mod+k', { ctrl: true })]) {
      const input = { focus: vi.fn() }
      expect(handleAskKey(e, { stillBox: null, input: () => input, modalOpen: () => false }, true)).toBe(true)
      expect(e.preventDefault).toHaveBeenCalled()
      expect(e.stopImmediatePropagation).toHaveBeenCalled()
      expect(input.focus).toHaveBeenCalled()
    }
    const blocked = ev(null)
    expect(handleAskKey(blocked, { stillBox: null, input: () => ({ focus: vi.fn() }), modalOpen: () => true }, true)).toBe(false)
  })
  it('the palette leaves ⌘K in the code alone and toggles elsewhere', () => {
    const toggle = vi.fn()
    const inCode = ev('mod+k')
    expect(handlePaletteKey(inCode, toggle, true)).toBe(false)
    expect(toggle).not.toHaveBeenCalled()
    expect(inCode.preventDefault).not.toHaveBeenCalled()
    const out = ev(null)
    expect(handlePaletteKey(out, toggle, true)).toBe(true)
    expect(toggle).toHaveBeenCalledTimes(1)
  })
})

describe('Kimi r2 follow-up: ink near the edge is never squeezed to its floor', () => {
  it('an arrow, tick or circle with no room falls back to a mark that stays on its lines', () => {
    expect(fitInk('arrow', 100, 400, 1000)).toEqual({ ink: 'arrow', width: 300 })
    expect(fitInk('arrow', 960, 990, 1000).ink).toBe('bracket')
    expect(fitInk('tick', 960, 995, 1000).ink).toBe('bracket')
    expect(fitInk('circle', 980, 999, 1000).ink).toBe('underline')
    expect(fitInk('underline', 990, 1200, 1000).ink).toBe('underline')
  })
})
