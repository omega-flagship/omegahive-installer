import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * A task card says what the task is first (a tester, 10 November: "cant quite find what this task even is"): its
 * words sit under the title even when the card is closed, and whole first once it is open, then what a person decides
 * (re-open, done, failed, cancel, review) and its priority, which a person chooses there too. Who made it, its ID,
 * motivations, review history, attempts, code access and subtasks are folded under More about this task. The store is
 * replaced at its module; INVENTED tasks.
 */

const { stalled, open, tried, once } = vi.hoisted(() => {
  const base = {
    swarm_id: 's_lyra', parent_id: null, priority: 0.55, claimed_by: null, created_by: 'user:operator', result: null,
    created_at: '2026-11-09T20:00:00Z', updated_at: '2026-11-10T02:00:00Z', attempts: 3,
  }
  return {
    stalled: { ...base, id: 'g_scope', title: 'Book telescope time', status: 'stalled', detail: 'Ask the observatory for two hours on Friday night for the Sheliak eclipse; the login is in the shared folder.' },
    open: { ...base, id: 'g_dust', title: 'Sort the dust disk photos', status: 'open', detail: 'Group the photos by night and mark the blurred ones.', attempts: 0 },
    tried: { ...base, id: 'g_lens', title: 'Clean the lens', status: 'open', detail: 'Use the soft cloth only.', attempts: 2 },
    once: { ...base, id: 'g_cap', title: 'Find the lens cap', status: 'open', detail: 'It was last seen by the door.', attempts: 1 },
  }
})

vi.mock('../../store/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../store/store')>()
  const hive = {
    ...real.useHive.getState(),
    goals: { g_scope: stalled, g_dust: open, g_lens: tried, g_cap: once },
    goalsLoaded: { s_lyra: true },
    swarms: { s_lyra: { id: 's_lyra', name: 'Lyra', hue: 248 } },
    agents: {},
    loadGoals: async () => undefined,
    taskLinks: {},
    requests: {},
  }
  return { ...real, useHive: Object.assign((select: (s: unknown) => unknown) => select(hive), real.useHive) }
})

const { GoalsBoard } = await import('./GoalsBoard')
const board = (focus?: string) => renderToStaticMarkup(createElement(GoalsBoard, { swarmId: 's_lyra', focus, layout: 'list' }))
const card = (html: string, id: string) => {
  const at = html.indexOf(`data-goal="${id}"`)
  const end = html.indexOf('</article>', at)
  return html.slice(at, end)
}

describe('a task card', () => {
  it('shows what the task is under its title even while closed', () => {
    const closed = card(board(), 'g_dust')
    expect(closed).toMatch(/Sort the dust disk photos<\/h4>[^]*data-task-what="[^"]*">Group the photos by night and mark the blurred ones\.<\/p>/)
  })

  it('opens on what the task is, then what you decide and its priority, with everything else folded under More about this task', () => {
    const opened = card(board('g_scope'), 'g_scope')
    const what = opened.indexOf('data-task-what')
    const decide = opened.indexOf('Re-open…')
    const priority = opened.indexOf('aria-label="Priority"')
    const more = opened.indexOf('More about this task')
    expect(what).toBeGreaterThan(-1)
    expect(decide).toBeGreaterThan(what)
    expect(priority).toBeGreaterThan(decide)
    expect(more).toBeGreaterThan(priority)
    expect(opened).toMatch(/aria-expanded="false"[^>]*>(?:(?!<\/button>)[^])*More about this task/)
    for (const folded of ['aria-label="Task ID"', 'New subtask', 'data-task-more']) expect(opened, folded).not.toContain(folded)
    // the words show once, whole, in the open card (not also clipped under the title)
    expect(opened.match(/data-task-what/g)).toHaveLength(1)
  })

  it('adding a task shows no priority until one is being written, so Low, Normal and High never read as a filter', () => {
    // a tester picked High above the board and asked why the Failed list still showed a Normal task
    const html = board()
    const at = html.indexOf('data-tour="goals-add"')
    const add = html.slice(at, html.indexOf('</form>', at))
    expect(add).toContain('New task title')
    expect(add).not.toContain('role="radiogroup"')
    for (const level of ['Low</button>', 'Normal</button>', 'High</button>']) expect(add, level).not.toContain(level)
  })

  it('says in plain words what the tries badge counts', () => {
    const lens = card(board(), 'g_lens')
    expect(lens).toContain('title="2 tries ran out of time; after 3 the task stalls"')
    expect(lens).toContain('2 of 3 tries used')
    expect(card(board(), 'g_cap')).toContain('title="1 try ran out of time; after 3 the task stalls"')
    expect(card(board(), 'g_dust')).not.toContain('tries used')
  })
})
