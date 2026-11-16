// Purpose: which tasks a Canvas island shows, as MeTTa arranges the board: a failed task stays in view.
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Agent, Goal, Swarm } from '../sdk'
import { boardInput, composeBoard } from './board'
import { goalHolder } from './data'
import { GoalSticky, Island } from './parts'

// A tester watched a task vanish from the Canvas when a reviewing mind failed it, while Tasks showed it under Failed:
// an island kept only the work still going and a few done tasks. INVENTED tasks.

const goal = (id: string, status: Goal['status'], updated = '2026-11-10T10:00:00Z', priority = 0.5): Goal =>
  ({ id, swarm_id: 's1', parent_id: null, title: `Task ${id}`, detail: '', priority, status, created_by: 'user:p_ada', claimed_by: null, result: null, created_at: updated, updated_at: updated }) as Goal
// which tasks an island shows is MeTTa's (board.metta): read from the island it arranges for one swarm
const swarm = { id: 's1', name: 'Home', hue: 120, coordinator_id: null, description: '', member_ids: [], created_at: '2026-10-01T00:00:00Z' } as unknown as Swarm
const island = (gs: Goal[]) => composeBoard(boardInput([], [swarm], gs, [], 1.6)).islands[0]
const ids = (gs: Goal[]) => island(gs).goals

describe('a Canvas island keeps a failed task', () => {
  it('shows it after the work still going, and leaves cancelled tasks off', () => {
    const gs = [goal('open1', 'open'), goal('failed1', 'failed'), goal('stuck', 'stalled'), goal('gone', 'cancelled'), goal('wip', 'claimed')]
    expect(ids(gs)).toEqual(['stuck', 'wip', 'open1', 'failed1'])
    expect(island(gs).doneHidden).toBe(1)
  })

  it('done tasks only fill an island with fewer than three; failed ones count among the three', () => {
    expect(ids([goal('f', 'failed'), goal('d1', 'done', '2026-11-10T09:00:00Z'), goal('d2', 'done', '2026-11-10T11:00:00Z')])).toEqual(['f', 'd2', 'd1'])
    expect(ids([goal('o1', 'open'), goal('o2', 'open'), goal('f', 'failed'), goal('d', 'done')])).toEqual(['o1', 'o2', 'f'])
  })

  it('past eight, a failed task waits in the island’s count like any other', () => {
    const open = Array.from({ length: 8 }, (_, i) => goal(`o${i}`, 'open'))
    const { goals, doneHidden } = island([...open, goal('f', 'failed')])
    expect(goals).not.toContain('f')
    expect(doneHidden).toBe(1)
  })
})

describe('the sticky and the island say it plainly', () => {
  const sticky = (status: Goal['status']) => renderToStaticMarkup(createElement(GoalSticky, {
    r: { x: 0, y: 0, w: 204, h: 156 }, goal: goal('g', status), lod: 'detail', holder: null, motivations: [], selected: false, mode: 'light',
    onSelect: () => undefined, onFocusItem: () => undefined,
  }))

  it('a failed task says Failed in red and is not crossed off; a done one is', () => {
    const failed = sticky('failed')
    expect(failed).toContain('Task: Task g. Failed.')
    expect(failed).toContain('color:#b42318')
    expect(failed).not.toContain('line-through')
    expect(sticky('done')).toContain('line-through')
  })

  it('zoomed out, a failed sticky still says Failed in red above its title; an open one carries no label', () => {
    const big = (status: Goal['status']) => renderToStaticMarkup(createElement(GoalSticky, {
      r: { x: 0, y: 0, w: 204, h: 156 }, goal: goal('g', status), lod: 'overview', holder: null, motivations: [], selected: false, mode: 'light',
      onSelect: () => undefined, onFocusItem: () => undefined,
    }))
    const failed = big('failed')
    expect(failed).toMatch(/data-cv-failed[^>]*color:#b42318[^>]*>Failed</)
    expect(failed).toContain('Task g')
    expect(failed).not.toContain('line-through')
    expect(big('open')).not.toContain('data-cv-failed')
    expect(big('done')).not.toContain('data-cv-failed')
  })

  it('zoomed in or out, the island says which of its tasks it counts', () => {
    // a tester saw 8 stickies and "+8 more tasks" zoomed in, then "10 tasks" zoomed out: 16 tasks, 10 of them open
    const island = (lod: 'far' | 'detail') => renderToStaticMarkup(createElement(Island, {
      r: { x: 0, y: 0, w: 900, h: 600 }, id: 's1', swarm: { id: 's1', name: 'Mega', description: '', hue: 120, member_ids: [], created_at: '2026-10-01T00:00:00Z' },
      name: 'Mega', hue: 120, mode: 'light', lod, members: [], goalCount: 16, openGoals: 10, beliefCount: 0, coordinator: null, selected: false,
      hidden: 8, onSelect: () => undefined, onFocusItem: () => undefined,
    })).replace(/<!-- -->/g, '')
    expect(island('far')).toMatch(/>10<\/span> open tasks/)
    expect(island('far')).not.toMatch(/>10<\/span> tasks/)
    expect(island('detail')).toContain('16 tasks, 10 open')
    expect(island('detail')).toContain('+8 more tasks')
  })

  it('a done task names the mind that claimed and did it, not Unclaimed', () => {
    const done = { ...goal('g', 'done'), claimed_by: 'a_judge' }
    expect(goalHolder(done)).toBe('a_judge')
    expect(goalHolder({ ...goal('g', 'failed'), claimed_by: 'agent:a_judge' })).toBe('a_judge')
    // given to a mind and never claimed: still that mind; nobody at all: nobody
    expect(goalHolder({ ...goal('g', 'done'), assignee: 'a_market' })).toBe('a_market')
    expect(goalHolder(goal('g', 'done'))).toBeNull()
    const holder = { id: 'a_judge', name: 'Judge', hue: 40 } as Agent
    const html = renderToStaticMarkup(createElement(GoalSticky, {
      r: { x: 0, y: 0, w: 204, h: 156 }, goal: done, lod: 'detail', holder, motivations: [], selected: false, mode: 'light',
      onSelect: () => undefined, onFocusItem: () => undefined,
    }))
    expect(html).toContain('Judge')
    expect(html).not.toContain('Unclaimed')
  })

  it('a stalled task still needs a person, so it reads Unclaimed though a mind once claimed it', () => {
    // its lease ran out on every try: the mind that claimed it is no longer working on it
    expect(goalHolder({ ...goal('g', 'stalled'), claimed_by: 'a_judge' })).toBeNull()
    expect(goalHolder({ ...goal('g', 'stalled'), claimed_by: 'a_judge', assignee: 'a_market' })).toBe('a_market')
    expect(goalHolder({ ...goal('g', 'open'), claimed_by: 'a_judge' })).toBeNull()
    // a task a mind is still working on names it, as before
    for (const status of ['claimed', 'waiting', 'submitted'] as const) expect(goalHolder({ ...goal('g', status), claimed_by: 'a_judge' })).toBe('a_judge')
  })

  it('the island counts what it leaves off as more tasks, not older ones', () => {
    const html = renderToStaticMarkup(createElement(Island, {
      r: { x: 0, y: 0, w: 600, h: 400 }, id: 's1', swarm: { id: 's1', name: 'Research', description: '', hue: 120, member_ids: [], created_at: '2026-10-01T00:00:00Z' },
      name: 'Research', hue: 120, mode: 'light', lod: 'detail', members: [], goalCount: 10, openGoals: 8, beliefCount: 0, coordinator: null, selected: false,
      hidden: 2, onSelect: () => undefined, onFocusItem: () => undefined,
    }))
    expect(html).toContain('+2 more tasks')
    expect(html).not.toContain('older tasks')
  })
})
