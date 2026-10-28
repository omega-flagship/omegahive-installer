import { beforeEach, describe, expect, it, vi } from 'vitest'

// the page's location, played in node (as store/askBoundaries.test.ts)
const loc = { hash: '#/', search: '', pathname: '/' }
const kept = new Map<string, string>()
vi.stubGlobal('window', {
  location: loc,
  matchMedia: () => ({ matches: false }),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) },
})
vi.mock('../lib/router', async (orig) => {
  const real = await orig<typeof import('../lib/router')>()
  return { ...real, navigate: (r: import('../lib/router').Route) => void (loc.hash = real.href(r)) }
})

const { useHive } = await import('./store')
const { threadRows, useAskStore } = await import('./ask')
const { runIntent } = await import('../features/ask/run')
type HiveClient = import('../api/client').HiveClient
type Agent = import('../api/types').Agent
type IntentAct = import('../lib/intent').IntentAct

/**
 * Health idle r1.1 / r1.3 (stand-in P1, Kimi #1): the Ask's run sends only after the store re-reads the host's
 * may_remind / may_sleep and the mind's status FRESH at the press (GET /api/agents/{id}). False, missing, unreadable,
 * or (Sleep) not awake: nothing is sent, and the Ask says why. INVENTED minds.
 */
const remindIdle = vi.fn(async () => ({}))
const agentAction = vi.fn(async () => ({ id: 'a_pip003', status: 'asleep' }))
let host: Partial<Agent> | 'fail' = {}
const getAgent = vi.fn(async (id: string) => {
  if (host === 'fail') throw new Error('unreadable')
  return { id, name: 'Pip', status: 'awake', ...host } as Agent
})
let n = 0
function start(agent: Partial<Agent> | 'fail', cached: Partial<Agent> = {}) {
  remindIdle.mockClear()
  agentAction.mockClear()
  getAgent.mockClear()
  host = agent
  useHive.setState({
    client: { mode: 'sim', remindIdle, agentAction, getAgent } as unknown as HiveClient,
    session: `flags-${++n}`,
    inits: n,
    remindedAt: {},
    agents: { a_pip003: { id: 'a_pip003', name: 'Pip', status: 'awake', ...cached } as Agent },
  })
  useAskStore.getState().bind(useHive.getState().session, 'user:operator')
}
const pip = { id: 'a_pip003', name: 'Pip' }
const said = () => threadRows(useAskStore.getState()).filter((r) => r.kind === 'local').map((r) => r.text)
const both = async () => {
  await runIntent({ do: 'remind', mind: pip } as unknown as IntentAct, { you: 'remind pip' })
  await runIntent({ do: 'sleep', mind: pip } as unknown as IntentAct, { you: 'put pip to sleep' })
}
beforeEach(() => useAskStore.getState().reset())

describe('the Ask re-checks the host’s flags, fresh, at the press', () => {
  for (const [label, flags] of [['false', { may_remind: false, may_sleep: false, is_mine: false }], ['missing', {}]] as const) {
    it(`Remind and Sleep with the flag ${label}: nothing is sent, and the Ask says so`, async () => {
      start(flags)
      await both()
      expect(remindIdle).not.toHaveBeenCalled()
      expect(agentAction).not.toHaveBeenCalled()
      expect(said()).toEqual(['The hive does not let you remind Pip. Only its owner or an admin can.', 'The hive does not let you put Pip to sleep. Only its owner or an admin can.'])
    })
  }

  it('flags true (the viewer’s own personal mind): both go to the hive, each after a fresh read', async () => {
    start({ may_remind: true, may_sleep: true, is_mine: true })
    await both()
    expect(getAgent).toHaveBeenCalledTimes(2)
    expect(remindIdle).toHaveBeenCalledTimes(1)
    expect(agentAction).toHaveBeenCalledTimes(1)
  })

  it('Kimi #1: the cache says yes, the fresh read says no: nothing is sent', async () => {
    start({ may_remind: false, may_sleep: false }, { may_remind: true, may_sleep: true })
    await both()
    expect(remindIdle).not.toHaveBeenCalled()
    expect(agentAction).not.toHaveBeenCalled()
  })

  it('the fresh read fails: fail closed, nothing is sent', async () => {
    start('fail', { may_remind: true, may_sleep: true })
    await both()
    expect(remindIdle).not.toHaveBeenCalled()
    expect(agentAction).not.toHaveBeenCalled()
    expect(said()).toEqual(['Could not check with the hive whether you may remind Pip, so nothing was sent.', 'Could not check with the hive whether you may put Pip to sleep, so nothing was sent.'])
  })

  it('Sleep for a mind already asleep (may_sleep true, r2.4): nothing is sent, and the Ask says it is asleep', async () => {
    start({ status: 'asleep', may_sleep: true })
    await runIntent({ do: 'sleep', mind: pip } as unknown as IntentAct, { you: 'put pip to sleep' })
    expect(agentAction).not.toHaveBeenCalled()
    expect(said()).toEqual(['Pip is already asleep.'])
  })

  it('P2, one awake rule: Sleep for a starting mind is not sent', async () => {
    start({ status: 'starting', may_sleep: true })
    await runIntent({ do: 'sleep', mind: pip } as unknown as IntentAct, { you: 'put pip to sleep' })
    expect(agentAction).not.toHaveBeenCalled()
    expect(said()[0]).toMatch(/^Pip is not awake \(starting\)/)
  })
})
