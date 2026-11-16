import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import { presenceOf, readActingAs, readInboxPage, readPersonalMind, readVersions } from '../../api/personalMind'
import { SimPersonalMind } from '../../api/sim/personalMind'
import type { LogEntry, TurnMeta } from '../../store/ask'
import { handedOn, handsOf, lastActingAs } from './hands'

/** Personal mind r1: the host shapes as read (Platform P1 308727d/0dbd550), the sim's invented answers, and its hands. */

describe('reading the host’s answers', () => {
  it('GET /api/me/mind as P1 sends it (version null until P3/P4)', () => {
    const p1 = { mind: { id: 'a_inv01', name: 'Ada', swarm_id: 's_inv01', status: 'asleep', budget_usd: 0, allowance_usd: 20, allowance_origin: 'person', version: null, adopted_at: null, previous_version_id: null, created_at: '2026-10-08T21:00:00Z' } }
    expect(readPersonalMind(p1)).toEqual({ id: 'a_inv01', name: 'Ada', swarm_id: 's_inv01', status: 'asleep', version: null, adopted_at: null, previous_version_id: null, allowance_usd: 20 })
    expect(readPersonalMind({ mind: null })).toBeNull()
    expect(readPersonalMind({ mind: { id: 'a_inv01', name: '\u0007' } })).toBeNull()
    expect(readPersonalMind('nonsense')).toBeNull()
  })
  it('a version shows its name and scores only, never its model', () => {
    const v = readVersions({ current: { id: 'mv_1', label: 'v7 Wren', model: 'some/model-id', body_template: 'omega', score: { success: 0.86, steps: 7.4, cost_usd: 0.041 } }, best: null, candidates: [] })
    expect(v?.current).toEqual({ id: 'mv_1', label: 'v7 Wren', score: { success: 0.86, steps: 7.4, cost_usd: 0.041 }, measured_at: null, suite_run_id: null })
    expect(JSON.stringify(v)).not.toContain('model')
  })
  it('an inbox page keeps well-formed items only', () => {
    const page = readInboxPage({ items: [{ id: 'pi_1', turn_id: 't_1', created_at: '2026-10-08T20:00:00Z', words: 'w', answer: 'a', truncated: true }, { id: 'pi 2', turn_id: 't_2', created_at: '2026-10-08T20:00:00Z', words: 'w', answer: 'a' }], next: null })
    expect(page.items).toEqual([{ id: 'pi_1', turn_id: 't_1', at: Date.parse('2026-10-08T20:00:00Z'), words: 'w', answer: 'a', truncated: true }])
  })
  it('presence: working while it acts, else from its status', () => {
    expect(presenceOf('asleep', false)).toBe('asleep')
    expect(presenceOf('created', false)).toBe('asleep')
    expect(presenceOf('starting', false)).toBe('waking')
    expect(presenceOf('awake', false)).toBe('listening')
    expect(presenceOf('asleep', true)).toBe('working')
  })
})

describe('the sim: Ada’s invented personal mind', () => {
  it('default demo: a mind, held conversations, and versions not yet (404)', () => {
    const s = new SimPersonalMind()
    expect(s.get().mind?.name).toBe('Ada')
    expect(s.get().mind?.version).toBeNull()
    expect(s.items(null, 50).items).toHaveLength(3)
    expect(() => s.versions()).toThrow(ApiError)
  })
  it('rename, ack, and the absent fixtures', () => {
    const s = new SimPersonalMind()
    expect(s.rename('  Ada B ').mind.name).toBe('Ada B')
    expect(() => s.rename('')).toThrow(ApiError)
    const ids = s.items(null, 50).items.map((x) => x.id)
    expect(s.ack(ids.slice(0, 2))).toEqual({ deleted: 2 })
    expect(s.items(null, 50).items).toHaveLength(1)
    expect(() => new SimPersonalMind({ mind: 'absent' }).get()).toThrow(ApiError)
    expect(new SimPersonalMind({ mind: 'null' }).get()).toEqual({ mind: null })
    try {
      new SimPersonalMind({ mind: 'person' }).get()
    } catch (e) {
      expect((e as ApiError).status).toBe(403)
    }
  })
  it('versions fixture: adopt the best, roll back, and the refusals', () => {
    const s = new SimPersonalMind({ versions: true })
    const v = readVersions(s.versions())!
    expect(v.current?.label).toBe('v7 Wren')
    expect(v.best?.label).toBe('v9 Kestrel')
    expect(readPersonalMind(s.adopt('mv_kestrel9'))?.version?.label).toBe('v9 Kestrel')
    expect(() => s.adopt('mv_kestrel9')).toThrow(/already/)
    expect(readPersonalMind(s.rollback())?.version?.label).toBe('v7 Wren')
    expect(() => s.rollback()).toThrow(/no earlier version/)
    expect(() => s.adopt('mv_nope')).toThrow(ApiError)
  })
})

const turn = (op: string, events: TurnMeta['events'], state: TurnMeta['state'] = 'open', extra: Partial<TurnMeta> = {}): TurnMeta => ({
  op, you: 'Invented request', state, lastSeq: events.length, events, outcomes: {}, notes: [], steers: [], moves: 0, tookOver: false, presence: 0, ahead: [], ...extra,
})
const frame = (op: string, seq: number, rest: Record<string, unknown>) => ({ type: 'ask', operation_id: op, turn_id: `t_${op}`, seq, at: '2026-10-08T20:00:00Z', ...rest }) as unknown as TurnMeta['events'][number]
const accepted = (op: string, actingAs?: unknown) => frame(op, 1, { phase: 'accepted', thread: { id: 'th', mind: { id: 'a_x', name: 'X' }, budget_usd: 1, spent_usd: 0 }, ...(actingAs ? { acting_as: actingAs } : {}) })

describe('its hands: the thread’s acts when a turn acts as this mind', () => {
  it('a turn acting as the person’s mind shows its acts; another mind’s turn does not', () => {
    const mine = turn('op1', [accepted('op1', { mind_id: 'a_ada_own', name: 'Ada' }), frame('op1', 2, { phase: 'act', act: { act_id: 'x1', kind: 'navigate' } }), frame('op1', 3, { phase: 'act', act: { act_id: 'x2', kind: 'fill' } })], 'open', {
      outcomes: { 2: { kind: 'act', text: 'Opened the garden tasks', state: 'applied' }, 3: { kind: 'act', text: 'Filling “Due date”', state: 'applied' } },
    })
    const theirs = turn('op2', [accepted('op2')], 'done')
    const log: LogEntry[] = [{ kind: 'turn', op: 'op1' }, { kind: 'turn', op: 'op2' }]
    const h = handsOf(log, { op1: mine, op2: theirs }, 'a_ada_own')
    expect(h?.live).toBe(true)
    expect(h?.rows.map((r) => [r.text, r.state])).toEqual([
      ['Opened the garden tasks', 'done'],
      ['Filling “Due date”', 'now'],
    ])
    expect(handsOf(log, { op1: mine, op2: theirs }, 'a_other')).toBeNull()
    expect(lastActingAs(log, { op1: mine, op2: theirs })).toBeNull()
    expect(lastActingAs(log.slice(0, 1), { op1: mine })).toBe('a_ada_own')
  })
  it('after the person took over it is no longer live', () => {
    const t = turn('op1', [accepted('op1', { mind_id: 'a_ada_own', name: 'Ada' })], 'open', { tookOver: true })
    expect(handsOf([{ kind: 'turn', op: 'op1' }], { op1: t }, 'a_ada_own')?.live).toBe(false)
  })
  it('a malformed acting_as is ignored', () => {
    expect(readActingAs({ mind_id: 'a b', name: 'x' })).toBeNull()
    const t = turn('op1', [accepted('op1', { mind_id: 3 })])
    expect(handsOf([{ kind: 'turn', op: 'op1' }], { op1: t }, 'a_ada_own')).toBeNull()
  })
  it('handed on: every dispatched frame in the thread, newest first', () => {
    const t = turn('op1', [accepted('op1'), frame('op1', 2, { phase: 'dispatched', intent_id: 'i1', intent_kind: 'task', to: { kind: 'swarm', ref: 's_g', name: 'Garden' }, label: 'Order frost cloth' }), frame('op1', 3, { phase: 'dispatched', intent_id: 'i2', intent_kind: 'task', to: { kind: 'swarm', ref: 's_b' } })], 'done')
    expect(handedOn([{ kind: 'turn', op: 'op1' }], { op1: t }).map((h) => h.text)).toEqual(['task · s_b', 'Order frost cloth · Garden'])
  })
})

describe('r1.1 follow-up: the backup nudge sees forgetting too', () => {
  it('a forget marker or a forget everything changes the mark', async () => {
    const { memoryMark } = await import('./durability')
    const { forgetsOf } = await import('../../lib/askMemory')
    const base = { beliefs: [], talks: [] }
    const none = memoryMark({ ...base, forgets: forgetsOf([], 0) })
    expect(memoryMark({ ...base, forgets: forgetsOf([{ id: 'b_x', at: 5 }], 0) })).not.toBe(none)
    expect(memoryMark({ ...base, forgets: forgetsOf([], 9) })).not.toBe(none)
    expect(memoryMark({ ...base, forgets: forgetsOf([], 0) })).toBe(none)
  })
})
