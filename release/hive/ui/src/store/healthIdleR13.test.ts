import { describe, expect, it, vi } from 'vitest'
import type { HiveClient } from '../api/client'
import type { Agent, HiveEvent } from '../api/types'
import { canSleepNow, isAwakeForAction, keepHostFlags, readIdleMind, showSleep } from '../api/idleMinds'
import { cardView, sleepFlow } from '../features/health/idleCard'
import { reduce } from './reducer'
import { FLAG_REFRESH_MS, storeIdentity, useHive } from './store'

/**
 * Health idle r1.3, INVENTED minds:
 * - stand-in P1: Health's own Sleep re-reads the host's flags and status after the confirmation;
 * - stand-in P2: one awake rule (exactly `awake`);
 * - Kimi #1: agent.updated carries no flags: they are kept until a fresh GET, which a shown mind triggers.
 */
const agent = (over: Partial<Agent> = {}) => ({ id: 'a_lyra01', name: 'Lyra', status: 'awake', swarm_id: null, ...over }) as Agent
let host: Partial<Agent> = {}
const getAgent = vi.fn(async (id: string) => agent({ id, ...host }))
const agentAction = vi.fn(async (id: string) => agent({ id, status: 'asleep' }))
let n = 0
function start(h: Partial<Agent>, cached: Partial<Agent> = { may_remind: true, may_sleep: true }) {
  host = h
  getAgent.mockClear()
  agentAction.mockClear()
  useHive.setState({ client: { getAgent, agentAction } as unknown as HiveClient, session: `r13-${++n}`, agents: { a_lyra01: agent(cached) }, flagWatch: {}, flagsAt: {} })
}
/** a confirmation the test answers later, after changing the host */
function openConfirm() {
  let answer!: (yes: boolean) => void
  const p = new Promise<boolean>((r) => (answer = r))
  return { confirm: () => p, answer }
}
const sleepFromHealth = (confirm: () => Promise<boolean>) => sleepFlow(storeIdentity(useHive.getState()), confirm, (w) => useHive.getState().sleepChecked('a_lyra01', 'Lyra', w))

describe('P1: Health’s Sleep re-checks after the confirmation', () => {
  it('may_sleep revoked while the confirm is open: Confirm sends nothing', async () => {
    start({ may_remind: true, may_sleep: true })
    const c = openConfirm()
    const job = sleepFromHealth(c.confirm)
    host = { may_remind: false, may_sleep: false }
    c.answer(true)
    expect(await job).toMatchObject({ ok: false })
    expect(agentAction).not.toHaveBeenCalled()
  })

  it('the mind falls asleep while the confirm is open: Confirm sends nothing, and says so', async () => {
    start({ may_sleep: true })
    const c = openConfirm()
    const job = sleepFromHealth(c.confirm)
    host = { may_sleep: true, status: 'asleep' }
    c.answer(true)
    expect(await job).toEqual({ ok: false, text: 'Lyra is already asleep.' })
    expect(agentAction).not.toHaveBeenCalled()
  })

  it('still allowed and awake at Confirm: sent once; Cancel sends nothing and reads nothing', async () => {
    start({ may_sleep: true })
    expect(await sleepFromHealth(async () => true)).toMatchObject({ ok: true })
    expect(agentAction).toHaveBeenCalledTimes(1)
    agentAction.mockClear()
    getAgent.mockClear()
    expect(await sleepFromHealth(async () => false)).toBeNull()
    expect(agentAction).not.toHaveBeenCalled()
    expect(getAgent).not.toHaveBeenCalled()
  })

  it('a session that moved on during the check hears nothing and sends nothing', async () => {
    start({ may_sleep: true })
    let release!: () => void
    getAgent.mockImplementationOnce(() => new Promise((r) => (release = () => r(agent({ may_sleep: true })))))
    const job = useHive.getState().sleepChecked('a_lyra01', 'Lyra')
    useHive.setState({ session: 'someone-else' })
    release()
    expect(await job).toBeNull()
    expect(agentAction).not.toHaveBeenCalled()
  })
})

describe('P2: one awake rule', () => {
  it('exactly awake, for Health and the store alike', () => {
    for (const s of ['starting', 'asleep', 'stopped', 'created', 'error', '', undefined]) expect(isAwakeForAction(s)).toBe(false)
    expect(isAwakeForAction('awake')).toBe(true)
    expect(canSleepNow({ may_sleep: true, status: 'starting' })).toBe(false)
    expect(showSleep(readIdleMind({ id: 'a_1', mind_status: 'starting', may_sleep: true })!)).toBe(false)
  })
})

describe('Kimi #1: agent.updated carries no flags', () => {
  const event = (a: Agent) => ({ type: 'agent.updated', at: '2026-10-11T00:00:00Z', agent: a }) as HiveEvent

  it('an event without flags keeps the old flags (until the fresh read lands); a flag the event carries wins', () => {
    const before = { ...useHive.getState(), agents: { a_lyra01: agent({ may_remind: true, may_sleep: true, is_mine: true }) } }
    const after = reduce(before, event(agent({ status: 'asleep' })))
    expect(after.agents.a_lyra01).toMatchObject({ status: 'asleep', may_remind: true, may_sleep: true, is_mine: true })
    expect(keepHostFlags({ may_sleep: true }, { may_sleep: false }).may_sleep).toBe(false)
  })

  it('for a shown mind, the event triggers one debounced fresh read; a read that says no hides the button', async () => {
    vi.useFakeTimers()
    try {
      start({ may_remind: false, may_sleep: false })
      const unwatch = useHive.getState().watchAgentFlags('a_lyra01')
      useHive.getState().apply(event(agent({ status: 'awake' })))
      useHive.getState().apply(event(agent({ status: 'awake' })))
      expect(useHive.getState().agents.a_lyra01.may_sleep).toBe(true) // kept until the read lands
      await vi.advanceTimersByTimeAsync(FLAG_REFRESH_MS + 10)
      expect(getAgent).toHaveBeenCalledTimes(1)
      expect(useHive.getState().agents.a_lyra01.may_sleep).toBe(false)
      const row = readIdleMind({ id: 'a_lyra01', name: 'Lyra', mind_status: 'awake', may_remind: true, may_sleep: true })!
      const view = cardView(row, 0, useHive.getState().agents.a_lyra01, useHive.getState().flagsAt.a_lyra01)
      expect(view.may_remind).toBe(false)
      expect(showSleep(view)).toBe(false)
      // not shown any more: no read
      unwatch()
      getAgent.mockClear()
      useHive.getState().apply(event(agent()))
      await vi.advanceTimersByTimeAsync(FLAG_REFRESH_MS + 10)
      expect(getAgent).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a read scheduled under one session is dropped after an identity change', async () => {
    vi.useFakeTimers()
    try {
      start({ may_sleep: false })
      useHive.getState().watchAgentFlags('a_lyra01')
      useHive.getState().apply(event(agent()))
      useHive.setState({ session: 'next-person' })
      await vi.advanceTimersByTimeAsync(FLAG_REFRESH_MS + 10)
      expect(getAgent).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
