import { describe, expect, it } from 'vitest'
import type { WorkSession } from '../../api/types'
import { planName, planRecipient } from './answerer'
import { isAskSession, openThreadsOf } from './threadList'

/**
 * j0-fixes r1.4: the r1.3 reviewers' findings. INVENTED people, minds and swarms; no host.
 * - stand-in P1: while a turn is open the words steer THAT turn, so the row names the open thread's mind (source pin
 *   below, the hook's one naming expression);
 * - stand-in P2: "Your open threads" lists Ask sessions only, never ordinary work sessions;
 * - Kimi 1: a swarm whose coordinator the page doesn't know never yields a nameless row.
 */


// stand-in P1 is now pinned behaviourally in j0Target.mounted.test.ts (Kimi r1.4 a): no source-order pin here.

const session = (o: Partial<WorkSession>): WorkSession => ({
  id: 's1', room_id: 'r1', agent_id: 'm_vega', goal_id: null, owner: 'user:pip', title: 'Ask thread', status: 'active',
  budget_usd: 5, spent_usd: 0, created_at: '2026-10-17T10:00:00Z', ended_at: null, workspace: null,
  mind: { id: 'm_vega', name: 'Vega' }, goal: null, ...o,
})

describe('stand-in P2: only Ask threads are listed (End is never offered on other work)', () => {
  it('purpose "ask" is listed; another purpose is not, even if it is titled "Ask thread"', () => {
    expect(isAskSession({ purpose: 'ask', title: 'anything' })).toBe(true)
    expect(isAskSession({ purpose: 'work', title: 'Ask thread' })).toBe(false)
  })
  it('an older host (no purpose): only the Ask\'s own title counts', () => {
    expect(isAskSession({ purpose: undefined, title: 'Ask thread' })).toBe(true)
    expect(isAskSession({ purpose: null, title: 'Fix the deploy script' })).toBe(false)
  })
  it('the list keeps the person\'s Ask threads and drops their ordinary work session on the same mind', () => {
    const list = openThreadsOf([
      session({ id: 'a', purpose: 'ask' }),
      session({ id: 'w', purpose: 'work', title: 'Refactor the reader' }),
      session({ id: 'legacy', purpose: undefined, title: 'Refactor the reader' }),
    ], 'user:pip', { mind: 'm_vega' })
    expect(list.map((s) => s.id)).toEqual(['a'])
  })
})

describe('Kimi 1: a coordinator the page doesn\'t know never leaves the paid row nameless', () => {
  const base = { agents: {}, personal: null }
  it('falls back to the swarm\'s own name when neither the coordinator nor an eligible orchestrator is known', () => {
    const settings = { swarm_id: 's_kelp', eligible: [{ id: 's_kelp', name: 'Kelp Commons', orchestrator: null }] } as never
    const swarms = { s_kelp: { coordinator_id: 'm_hidden', name: 'Kelp Commons' } }
    const n = planName({ context: { swarm_id: 's_kelp' } as never, through: null } as never, { ...base, swarms, settings })
    expect(n).toBe('Kelp Commons')
  })
  it('and to a plain "this swarm’s coordinator" when even the swarm\'s name is unknown: never null for a swarm send', () => {
    const n = planName({ context: { swarm_id: 's_unknown' } as never, through: null } as never, { ...base, swarms: {}, settings: null })
    expect(n).toBe('this swarm’s coordinator')
  })
})

describe('r1.6 (stand-in r1.5 P1, Kimi r1.5): one recipient decision, by identity', () => {
  it('planRecipient: the chosen swarm\'s coordinator by id, even when its name equals the personal mind\'s', () => {
    const personal = { id: 'a_my_ember', name: 'Ember' } as never
    const agents = { a_other_ember: { id: 'a_other_ember', name: 'Ember', swarm_id: 's_b' } }
    const swarms = { s_b: { coordinator_id: 'a_other_ember', name: 'B' } }
    const plan = { context: { swarm_id: 's_b' } as never, through: null } as never
    expect(planRecipient(plan, { agents, swarms, personal, settings: null })).toEqual({ id: 'a_other_ember', name: 'Ember' })
    expect(planName(plan, { agents, swarms, personal, settings: null })).toBe('Ember')
    expect(planRecipient({ context: {} as never, through: null } as never, { agents: {}, swarms: {}, personal, settings: null })).toEqual({ id: 'a_my_ember', name: 'Ember' })
  })
  it('a coordinator the page doesn\'t know has no id (never "you"), but still a name for the row', () => {
    const personal = { id: 'a_my_ember', name: 'Ember' } as never
    const r = planRecipient({ context: { swarm_id: 's_x' } as never, through: null } as never, { agents: {}, swarms: {}, personal, settings: null })
    expect(r.id).toBeNull()
    expect(r.name).toBe('this swarm’s coordinator')
  })
  it('Classic reads the hook\'s one decision; no comparison of its own', () => {
    const fsN = 'node:fs'
    return import(/* @vite-ignore */ fsN).then((fs: { readFileSync: (p: string, e: 'utf8') => string }) => {
      const src = fs.readFileSync(decodeURIComponent(new URL('./ClassicAsk.tsx', import.meta.url).pathname), 'utf8')
      expect(src).toMatch(/const answeringYou = f\.answeringYou/)
      expect(src).not.toMatch(/lastActingAs|isMyMind|shownMind\(\w+\) === shownMind/)
    })
  })
})
