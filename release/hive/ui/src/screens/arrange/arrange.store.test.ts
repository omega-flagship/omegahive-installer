// Purpose: the stage's store (screens/arrange/arrange.ts): what a person taught the stage (dragged shares, interest per
// task) is kept for them alone in this browser and back when they return, interest is credited once per statement, a
// change of person empties the stage, and a full browser storage lets go of the tasks credited longest ago first.
// INVENTED people, ids and tasks.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bindPerson, credit, learn, say } from './arrange'

const g = globalThis as unknown as Record<string, unknown>
let kept: unknown
let store: Map<string, string>
let quota = Infinity
beforeEach(() => {
  kept = g.window
  store = new Map()
  quota = Infinity
  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > quota) throw new Error('QuotaExceededError')
        store.set(k, v)
      },
    },
  }
  bindPerson(null)
})
afterEach(() => {
  bindPerson(null)
  g.window = kept
})

const saved = (who: string) => JSON.parse(store.get(`omegahive.arrange.v1:${who}`) ?? 'null')

describe('what a person teaches the stage', () => {
  it('is kept for that person alone, and back when they return', () => {
    bindPerson('p_ada')
    learn({ dir: 'row', kinds: ['image', 'text'], shares: [1 / 3, 2 / 3] })
    expect(saved('p_ada').shares).toEqual([{ dir: 'row', kinds: ['image', 'text'], shares: [1 / 3, 2 / 3] }])
    bindPerson('p_bo')
    learn({ dir: 'row', kinds: ['image', 'text'], shares: [0.5, 0.5] })
    expect(saved('p_ada').shares[0].shares).toEqual([1 / 3, 2 / 3])
    // the newest drag of the same kinds replaces the last one
    bindPerson('p_ada')
    learn({ dir: 'row', kinds: ['image', 'text'], shares: [0.25, 0.75] })
    expect(saved('p_ada').shares).toEqual([{ dir: 'row', kinds: ['image', 'text'], shares: [0.25, 0.75] }])
  })

  it('credits interest once per statement, and only in a task', () => {
    bindPerson('p_ada')
    say({ say: 'show', key: 'ar_photo01', task: 'g_tip01' })
    credit(1, 'g_tip01', ['ar_photo01', 'a_vega01'])
    credit(1, 'g_tip01', ['ar_photo01', 'a_vega01'])
    expect(saved('p_ada').interest).toEqual({ g_tip01: { ar_photo01: 1, a_vega01: 1 } })
    say({ say: 'recall', key: 'ar_text01' })
    credit(2, null, ['ar_photo01'])
    expect(saved('p_ada').interest).toEqual({ g_tip01: { ar_photo01: 1, a_vega01: 1 } })
  })

  it('drops what storage holds that is not a stage memory', () => {
    store.set('omegahive.arrange.v1:p_ada', JSON.stringify({ shares: [{ dir: 'diagonal', kinds: ['a'], shares: [1] }, 'x'], interest: { g_tip01: { ar_a01: 2, ar_b01: -1, ar_c01: 'many' } } }))
    bindPerson('p_ada')
    learn({ dir: 'column', kinds: ['image', 'text'], shares: [0.5, 0.5] })
    expect(saved('p_ada')).toEqual({ shares: [{ dir: 'column', kinds: ['image', 'text'], shares: [0.5, 0.5] }], interest: { g_tip01: { ar_a01: 2 } } })
  })

  it('lets go of the tasks credited longest ago when the browser’s storage is full', () => {
    bindPerson('p_ada')
    for (let i = 1; i <= 8; i++) {
      say({ say: 'show', key: `ar_item${i}`, task: `g_task${i}` })
      credit(i, `g_task${i}`, [`ar_item${i}`])
    }
    // storage now takes about half of what is kept
    quota = JSON.stringify(saved('p_ada')).length * 0.6
    say({ say: 'show', key: 'ar_item9', task: 'g_task9' })
    credit(9, 'g_task9', ['ar_item9'])
    const tasks = Object.keys(saved('p_ada').interest)
    expect(tasks).toContain('g_task9')
    expect(tasks).not.toContain('g_task1')
  })
})
