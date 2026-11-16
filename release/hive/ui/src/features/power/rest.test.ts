import { describe, expect, it } from 'vitest'
import { alertLine, awaySummary, isUrgent, restAlertFor, restInitial, restReducer, type RestAction, type RestView } from './rest'

const IDLE = 120_000
const run = (actions: RestAction[], from: RestView = restInitial(0)) => actions.reduce(restReducer, from)

const goalDone = (id: string, title: string, detail = 'SECRET BODY') => ({ type: 'goal.updated', at: 'x', goal: { id, title, detail, status: 'done' } })
const askWaiting = (id: string) => ({ type: 'person_request.created', at: 'x', request: { id, kind: 'mind', note: 'PRIVATE NOTE', status: 'pending' } })
const answer = (op: string) => ({ type: 'ask', operation_id: op, turn_id: 't', seq: 3, at: 'x', phase: 'answer', text: 'PRIVATE ANSWER TEXT' })

describe('Quiet: idle -> rest -> alert -> wake', () => {
  it('rests only after the idle time, and not while blocked (a dialog open)', () => {
    expect(run([{ type: 'tick', at: IDLE - 1, idleMs: IDLE }]).resting).toBe(false)
    expect(run([{ type: 'tick', at: IDLE, idleMs: IDLE, blocked: true }]).resting).toBe(false)
    expect(run([{ type: 'tick', at: IDLE, idleMs: IDLE }]).resting).toBe(true)
    // input the page tracked outside the state counts
    expect(run([{ type: 'tick', at: IDLE + 10, idleMs: IDLE, lastInput: 50 }]).resting).toBe(false)
    // "never"
    expect(run([{ type: 'tick', at: 10 * IDLE, idleMs: 0 }]).resting).toBe(false)
  })

  it('shows alerts one at a time, oldest first, and wakes on any input with a summary', () => {
    let v = run([{ type: 'tick', at: IDLE, idleMs: IDLE }])
    v = run([
      { type: 'alert', ctx: '', admin: true, alert: restAlertFor(goalDone('g1', 'Ship the map'))! },
      { type: 'alert', ctx: '', admin: true, alert: restAlertFor(askWaiting('r1'))! },
      { type: 'alert', ctx: '', admin: true, alert: restAlertFor(answer('op1'))! },
    ], v)
    expect(v.showing && alertLine(v.showing)).toBe('Task done: Ship the map')
    expect(v.queue).toHaveLength(2)
    v = run([{ type: 'next' }], v)
    expect(v.showing && alertLine(v.showing)).toBe('An ask is waiting for you')
    v = run([{ type: 'input', at: IDLE + 5000 }], v)
    expect(v.resting).toBe(false)
    expect(v.showing).toBeNull()
    expect(v.summary).toBe('While you were away: 1 task done (“Ship the map”), 1 ask waiting, 1 thread answered.')
  })

  it('a budget refusal or a pending decision ends the rest at once (approved Quiet design); a settled one does not', () => {
    const v = run([{ type: 'tick', at: IDLE, idleMs: IDLE }, { type: 'urgent', at: IDLE + 1 }])
    expect(v.resting).toBe(false)
    expect(isUrgent({ type: 'approval.created', approval: { status: 'pending' } })).toBe(true)
    expect(restAlertFor({ type: 'approval.created', approval: { id: 'ap1', status: 'pending', command: 'PRIVATE' } })).toEqual({ kind: 'decision', title: null, key: 'decision:ap1' })
    expect(isUrgent({ type: 'budget.refused', agent_id: 'a', code: 'c', count: 1 })).toBe(true)
    expect(isUrgent({ type: 'approval.created', approval: { status: 'approved' } })).toBe(false)
  })
})

describe('"While you were away" is built only from what this page received while resting', () => {
  it('nothing received: no summary at all', () => {
    expect(run([{ type: 'tick', at: IDLE, idleMs: IDLE }, { type: 'input', at: IDLE + 1 }]).summary).toBeNull()
  })

  it('events before the rest, or after waking, are never in it', () => {
    let v = run([{ type: 'alert', ctx: '', admin: true, alert: restAlertFor(goalDone('g0', 'Before'))! }])
    v = run([{ type: 'tick', at: IDLE, idleMs: IDLE }, { type: 'alert', ctx: '', admin: true, alert: restAlertFor(goalDone('g1', 'During'))! }, { type: 'input', at: IDLE + 1 }], v)
    v = run([{ type: 'alert', ctx: '', admin: true, alert: restAlertFor(goalDone('g2', 'After'))! }], v)
    expect(v.summary).toBe('While you were away: 1 task done (“During”).')
  })

  it('counts and titles only: no goal detail, ask note or answer text ever reaches it', () => {
    let v = run([{ type: 'tick', at: IDLE, idleMs: IDLE }])
    for (const e of [goalDone('g1', 'A'), goalDone('g2', 'B'), goalDone('g3', 'C'), goalDone('g1', 'A'), askWaiting('r1'), answer('op1'), answer('op1'), answer('op2')]) {
      const a = restAlertFor(e)
      if (a) v = run([{ type: 'alert', ctx: '', admin: true, alert: a }], v)
    }
    v = run([{ type: 'input', at: IDLE + 1 }], v)
    expect(v.summary).toBe('While you were away: 3 tasks done (“A”, “B” and 1 more), 1 ask waiting, 2 threads answered.')
    expect(v.summary).not.toMatch(/SECRET|PRIVATE/)
  })

  it('ignores what is not an alert: unfinished goals, decided asks, malformed frames', () => {
    expect(restAlertFor({ type: 'goal.updated', goal: { id: 'g', title: 't', status: 'claimed' } })).toBeNull()
    expect(restAlertFor({ type: 'person_request.created', request: { id: 'r', status: 'granted' } })).toBeNull()
    expect(restAlertFor({ type: 'ask', phase: 'thinking', operation_id: 'o' })).toBeNull()
    expect(restAlertFor(null)).toBeNull()
    expect(awaySummary([])).toBeNull()
  })
})
