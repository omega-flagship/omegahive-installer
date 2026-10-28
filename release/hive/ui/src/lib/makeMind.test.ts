import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimClient } from '../api/sim/SimClient'
import type { CreateAgentBody, CreatedAgent } from '../api/types'
import { useHive } from '../store/store'
import { makeMind } from './makeMind'

/**
 * Review O-B2 (and its Construct extension): a mind made from Cosmos, Flux or Construct is bound to the session it was
 * dispatched in. A switch while createAgent is in flight shows nothing and navigates nowhere; a switch during the
 * reveal timer (A→B, and A→B→A) shows no token. Two real SimClients, real init, invented data and invented tokens only.
 */

const sim = (seed: number) => new SimClient({ seed, latency: false, autoStart: false, historyDays: 1 })
const clients: SimClient[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function defer<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const BODY: CreateAgentBody = { name: 'Invented Wren', kind: 'omega', swarm_id: null, model: 'invented-model', hue: 200, budget_usd: 1 }
const MADE: CreatedAgent = { id: 'agent_invented_a', name: 'Invented Wren', kind: 'omega', status: 'awake', hue: 200, token: 'hvt_synthetic_A_token' } as unknown as CreatedAgent

async function source(rel: string): Promise<string> {
  const fsName = 'node:fs'
  const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string | URL, e: string) => string }
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
}

beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }))
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect()
  useHive.setState({ reveal: null })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function pair() {
  const a = sim(31)
  const b = sim(32)
  clients.push(a, b)
  await useHive.getState().init(a)
  return { a, b }
}

describe('makeMind (O-B2)', () => {
  it('a switch to B while A is making the mind: refused, nothing navigates, no token is shown in B', async () => {
    const { a, b } = await pair()
    const late = defer<CreatedAgent>()
    vi.spyOn(a, 'createAgent').mockImplementationOnce(() => late.promise)
    const then = vi.fn()
    const made = makeMind(BODY, then, null)
    await useHive.getState().init(b)
    late.resolve(MADE)
    await expect(made).rejects.toThrow(/connection to the hive changed/)
    expect(then).not.toHaveBeenCalled()
    expect(useHive.getState().reveal).toBeNull()
    expect(useHive.getState().agents[MADE.id]).toBeUndefined()
  })

  it('a switch to B during the reveal timer: the mind was opened in A, but no token is shown in B', async () => {
    const { a, b } = await pair()
    vi.spyOn(a, 'createAgent').mockResolvedValueOnce(MADE)
    const then = vi.fn()
    await makeMind(BODY, then, 30)
    expect(then).toHaveBeenCalledOnce()
    await useHive.getState().init(b)
    await sleep(60)
    expect(useHive.getState().reveal).toBeNull()
  })

  it('A → B → A during the timer is a new session: still no token', async () => {
    const { a, b } = await pair()
    vi.spyOn(a, 'createAgent').mockResolvedValueOnce(MADE)
    await makeMind(BODY, () => undefined, 30)
    await useHive.getState().init(b)
    await useHive.getState().init(a)
    await sleep(60)
    expect(useHive.getState().reveal).toBeNull()
  })

  it('the same session throughout: navigates, then shows the token once (at once, or after the delay)', async () => {
    const { a } = await pair()
    vi.spyOn(a, 'createAgent').mockResolvedValue(MADE)
    const then = vi.fn()
    const agent = await makeMind(BODY, then, null)
    expect(agent).not.toHaveProperty('token')
    expect(then).toHaveBeenCalledWith(expect.objectContaining({ id: MADE.id }))
    expect(useHive.getState().reveal).toEqual({ agent: expect.objectContaining({ id: MADE.id }), token: MADE.token })
    useHive.setState({ reveal: null })
    await makeMind(BODY, () => undefined, 20)
    expect(useHive.getState().reveal).toBeNull()
    await sleep(50)
    expect(useHive.getState().reveal?.token).toBe(MADE.token)
  })

  it('Cosmos, Flux and Construct make minds only through makeMind, and set no reveal themselves', async () => {
    for (const f of ['../experiences/cosmos/Deck.tsx', '../experiences/flux/sheets.tsx', '../experiences/construct/commands.ts']) {
      const text = await source(f)
      expect(text, f).toMatch(/await makeMind\(/)
      expect(text, f).not.toMatch(/\.createAgent\(|createAgent\s*=\s*useHive/)
      expect(text, f).not.toMatch(/reveal:\s*\{\s*agent/)
    }
  })
})
