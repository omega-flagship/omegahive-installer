import { describe, expect, it, vi } from 'vitest'
import type { HiveClient } from '../api/client'
import type { Agent, HiveEvent } from '../api/types'
import { canRemindNow, readIdleMind, readIdleOverview, showRemind, showSleep } from '../api/idleMinds'
import { cardView, sleepFlow } from '../features/health/idleCard'
import { storeIdentity, useHive } from './store'

/**
 * Health idle r1.4 (stand-in r1.3 FIX-FIRST), INVENTED minds:
 * - P1: Sleep's confirmation, and Remind, are bound to the identity they were STARTED under; a person change while the
 *   confirmation is open sends nothing (no GET, no Sleep), whatever the next person's flags say;
 * - freshness: a card's flags come from whichever source was read later; Remind is withheld unless the mind is awake.
 */
const agent = (over: Partial<Agent> = {}) => ({ id: 'a_lyra01', name: 'Lyra', status: 'awake', swarm_id: null, ...over }) as Agent
const getAgent = vi.fn(async (id: string) => agent({ id, may_remind: true, may_sleep: true }))
const agentAction = vi.fn(async (id: string) => agent({ id, status: 'asleep' }))
const remindIdle = vi.fn(async () => ({}))
let n = 0
function start() {
  getAgent.mockClear()
  agentAction.mockClear()
  remindIdle.mockClear()
  useHive.setState({ client: { getAgent, agentAction, remindIdle } as unknown as HiveClient, session: `r14-${++n}`, inits: n, agents: { a_lyra01: agent({ may_remind: true, may_sleep: true }) }, flagsAt: {}, remindedAt: {} })
}
function openConfirm() {
  let answer!: (yes: boolean) => void
  const p = new Promise<boolean>((r) => (answer = r))
  return { confirm: () => p, answer }
}

describe('P1: the identity is the one the action started under', () => {
  for (const [label, change] of [
    ['a new session (sign-out, sign-in as B)', () => useHive.setState({ session: 'person-b' })],
    ['a re-login on the same client (inits moves)', () => useHive.setState({ inits: useHive.getState().inits + 1000 })],
  ] as const) {
    it(`person changes while the Sleep confirm is open (${label}): Confirm sends nothing, reads nothing`, async () => {
      start()
      const who = storeIdentity(useHive.getState())
      const c = openConfirm()
      const job = sleepFlow(who, c.confirm, (w) => useHive.getState().sleepChecked('a_lyra01', 'Lyra', w))
      change()
      // B's own flags would allow it: still nothing, because it was A's confirmation
      c.answer(true)
      expect(await job).toBeNull()
      expect(getAgent).not.toHaveBeenCalled()
      expect(agentAction).not.toHaveBeenCalled()
    })
  }

  it('Remind started as A, the person changes before it runs: nothing read or sent', async () => {
    start()
    const who = storeIdentity(useHive.getState())
    useHive.setState({ session: 'person-b' })
    expect(await useHive.getState().remindIdle('a_lyra01', 'Lyra', who)).toBeNull()
    expect(getAgent).not.toHaveBeenCalled()
    expect(remindIdle).not.toHaveBeenCalled()
  })

  it('no change: Confirm sends once', async () => {
    start()
    const r = await sleepFlow(storeIdentity(useHive.getState()), async () => true, (w) => useHive.getState().sleepChecked('a_lyra01', 'Lyra', w))
    expect(r).toMatchObject({ ok: true })
    expect(agentAction).toHaveBeenCalledTimes(1)
  })
})

describe('freshness: the later read wins; Remind needs an awake mind', () => {
  const row = (over: Record<string, unknown> = {}) => readIdleMind({ id: 'a_lyra01', name: 'Lyra', mind_status: 'awake', may_remind: false, may_sleep: false, ...over })!

  it('a newer idle row beats older store flags (and older store flags lose even after a flagless event)', () => {
    const stored = agent({ may_remind: true, may_sleep: true })
    const v = cardView(row(), 2_000, stored, 1_000)
    expect(v.may_remind).toBe(false)
    expect(showRemind(v)).toBe(false)
    expect(showSleep(v)).toBe(false)
  })

  it('newer store flags beat an older row; no fetch time never wins', () => {
    const stored = agent({ may_remind: true, may_sleep: true })
    expect(cardView(row(), 1_000, stored, 2_000).may_remind).toBe(true)
    expect(cardView(row(), 1_000, stored, undefined).may_remind).toBe(false)
  })

  it('an asleep status hides Remind even when a flag says true', () => {
    // a flagless asleep event kept may_remind: true; the status from the event wins
    const v = cardView(row({ may_remind: true }), 1_000, agent({ status: 'asleep', may_remind: true, may_sleep: true }), 2_000)
    expect(v.mind_status).toBe('asleep')
    expect(showRemind(v)).toBe(false)
    expect(canRemindNow({ may_remind: true, status: 'asleep' })).toBe(false)
    expect(canRemindNow({ may_remind: true, status: 'awake' })).toBe(true)
  })

  it('the reducer path: an asleep event without flags, then the card hides Remind at once', () => {
    start()
    useHive.setState({ flagsAt: { a_lyra01: 5_000 } })
    useHive.getState().apply({ type: 'agent.updated', at: '2026-10-11T00:00:00Z', agent: agent({ status: 'asleep' }) } as HiveEvent)
    const a = useHive.getState().agents.a_lyra01
    expect(a.may_remind).toBe(true) // kept
    expect(showRemind(cardView(row({ may_remind: true }), 1_000, a, useHive.getState().flagsAt.a_lyra01))).toBe(false)
  })

  it('a fresh read stamps flagsAt; an idle read stamps read_at', async () => {
    start()
    const before = Date.now()
    await useHive.getState().refreshAgentFlags('a_lyra01')
    expect(useHive.getState().flagsAt.a_lyra01).toBeGreaterThanOrEqual(before)
    expect(readIdleOverview({ minds: [] }, 1234).read_at).toBe(1234)
  })
})
