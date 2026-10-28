import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Goal, Motivation, MotivationRef, Swarm, TaskItem } from '../api/types'
import { SimClient } from '../api/sim/SimClient'
import { useHive } from '../store/store'
import * as lib from './motivations'
import { FluxCtx, type FluxApi } from '../experiences/flux/ctx'
import { Sheet } from '../experiences/flux/sheets'
import { SwarmPanel } from '../experiences/flux/panels'
import { Motivations as CanvasMotivations } from '../experiences/canvas/HivePanel'
import { GoalSlot } from '../experiences/canvas/slots'
import { BoardOutline } from '../experiences/canvas/BoardOutline'
import type { Outline } from '../experiences/canvas/outline'

/**
 * Stand-in r3 verdict item 5 (STANDIN_SURFACE_MOTIVATIONS_r3_VERDICT_20261007): behavioural revocation and person-switch
 * checks for Flux and Canvas, as Classic, Still, Cosmos and Construct have. The real views are rendered from the store
 * after the real data path (lib reads; for the person switch, the real store init and its sign-in observer over the
 * simulator). INVENTED DATA only.
 */
const at = '2026-10-07T00:00:00Z'
const SECRET_TITLE = 'Quiet aim only the first person may read'
const SECRET_WHY = 'A why nobody else should ever see on their screen'
const mo = (id: string, extra: Partial<Motivation> = {}): Motivation => ({ id, title: SECRET_TITLE, why: SECRET_WHY, owner: 'user:p_one', swarm_id: null, status: 'active', visibility: 'shared', rev: 1, parent_id: null, created_by: 'user:p_one', created_at: at, updated_at: at, status_changed_at: null, editable: false, ...extra })
const task = (id: string, refs: MotivationRef[]): TaskItem => ({ id, swarm_id: 's_a', parent_id: null, title: `task ${id}`, detail: '', priority: 0.5, status: 'open', created_by: 'user:operator', claimed_by: null, result: null, created_at: at, updated_at: at, motivations: refs, requests: [] })
const refOf = (m: Motivation): MotivationRef => ({ id: m.id, title: m.title, status: m.status })
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

const fluxApi = { world: {}, gpu: false, reduced: true, desktop: true, view: { kind: 'home' }, openSwarm: () => undefined, openMind: () => undefined, openDecision: () => undefined, closeDecision: () => undefined, home: () => undefined, sheet: null, openSheet: () => undefined } as unknown as FluxApi
const inFlux = (el: ReactElement) => renderToStaticMarkup(createElement(FluxCtx.Provider, { value: fluxApi }, el))
const outlineOf = (goals: Goal[], swarm: Swarm): Outline => ({ decisions: [], count: goals.length + 1, groups: [{ id: swarm.id, key: `swarm:${swarm.id}`, name: swarm.name, isSwarm: true, minds: [], goals: goals.map((g) => ({ id: g.id, key: `goal:${g.id}`, title: g.title, status: g.status, onBoard: true })) }] })
const noop = () => undefined

/** Every Flux and Canvas view that shows a motivation or its chips, rendered from the store as it is now. */
function renderAll(motivationId: string, swarmId: string, goalIds: string[]): Record<string, string> {
  now()
  const s = useHive.getState()
  const goals = goalIds.map((id) => s.goals[id]).filter(Boolean)
  const swarm = s.swarms[swarmId]
  return {
    'flux motivations sheet': inFlux(createElement(Sheet, { sheet: { page: 'motivations' } })),
    'flux tasks sheet, filtered to it': inFlux(createElement(Sheet, { sheet: { page: 'goals', motivation: motivationId } })),
    'flux tasks sheet, any': inFlux(createElement(Sheet, { sheet: { page: 'goals' } })),
    'flux swarm panel': inFlux(createElement(SwarmPanel, { id: swarmId })),
    'canvas motivations card': renderToStaticMarkup(createElement(CanvasMotivations)),
    'canvas stickies': goalIds.map((id) => renderToStaticMarkup(createElement(GoalSlot, { it: { key: `goal:${id}`, kind: 'goal', id, x: 0, y: 0, w: 200, h: 160 }, lod: 'detail', selected: false, mode: 'light', onSelect: noop, onFocusItem: noop }))).join(''),
    'canvas board outline': swarm ? renderToStaticMarkup(createElement(BoardOutline, { outline: outlineOf(goals, swarm), open: true, onClose: noop, onLocate: noop, onInspect: noop, onDecideGoal: noop, onTalk: noop, onAddGoal: noop })) : '',
  }
}

// A server render reads a zustand store's initial state (useSyncExternalStore's server snapshot). The views are rendered
// from the store as it is now, as the browser does: the initial-state object is pointed at the current state for the
// render and put back after each test.
const initial = useHive.getInitialState() as unknown as Record<string, unknown>
const pristine = { ...initial }
function now(): void {
  Object.assign(initial, useHive.getState())
}

beforeEach(() => {
  vi.stubGlobal('window', { location: { search: '' }, addEventListener: noop, removeEventListener: noop })
})
afterEach(() => {
  for (const k of Object.keys(initial)) if (!(k in pristine)) delete initial[k]
  Object.assign(initial, pristine)
  vi.unstubAllGlobals()
})

describe('item 5: Flux and Canvas forget a revoked motivation while open', () => {
  it('revoked: its title, why, id and every chip leave each Flux and Canvas view; a still-readable one stays', async () => {
    const secret = mo('mo_secret5')
    const kept = mo('mo_kept5', { title: 'An aim still shared with you', why: 'Still readable words', visibility: 'public' })
    const world = { shared: true }
    const swarm = { id: 's_a', name: 'Team A', owner: 'user:p_one', visibility: 'public', created_at: at } as unknown as Swarm
    useHive.setState({
      client: {
        listMotivations: async () => ({ items: world.shared ? [secret, kept] : [kept], cursor: null }),
        listTasks: async () => ({ items: [task('g_1', world.shared ? [refOf(secret), refOf(kept)] : [refOf(kept)]), task('g_2', world.shared ? [refOf(secret)] : [])], counts: { total: 2, by_status: {} }, cursor: null }),
      } as never,
      session: `test-${Math.random()}`,
      motivations: {}, motivationsLoaded: false, motivationsPartial: false, taskLinks: {}, taskLinksLoaded: false, taskLinksPartial: false,
      goals: {}, swarms: { s_a: swarm }, agents: {}, beliefs: {}, linksSeq: 0,
    } as never)
    await lib.loadMotivations()
    await lib.loadTaskLinks()

    const before = renderAll(secret.id, 's_a', ['g_1', 'g_2'])
    for (const [view, html] of Object.entries(before)) {
      if (view === 'flux tasks sheet, any' || view === 'flux swarm panel' || view === 'canvas stickies' || view === 'canvas board outline' || view.startsWith('flux tasks sheet, filtered')) expect(html, `${view} shows the chip first`).toContain(SECRET_TITLE.slice(0, 20))
      else expect(html, `${view} shows it first`).toContain(SECRET_TITLE)
    }
    expect(before['flux motivations sheet']).toContain(SECRET_WHY)
    expect(before['canvas motivations card']).toContain(SECRET_WHY)

    // it is made private for this person: the hive sends no event; the open view re-reads (focus, timer)
    world.shared = false
    await lib.revalidateMotivations()
    const after = renderAll(secret.id, 's_a', ['g_1', 'g_2'])
    for (const [view, html] of Object.entries(after)) {
      expect(html, `${view}: title gone`).not.toContain(SECRET_TITLE.slice(0, 20))
      expect(html, `${view}: why gone`).not.toContain(SECRET_WHY.slice(0, 20))
      expect(html, `${view}: no element refers to it`).not.toContain(secret.id)
    }
    expect(after['flux tasks sheet, filtered to it']).toContain('That motivation is not there for you')
    expect(after['flux motivations sheet']).toContain(kept.title)
    expect(after['canvas motivations card']).toContain(kept.title)
    expect(after['canvas stickies']).toContain(kept.title)
    expect(after['canvas board outline']).toContain(kept.title)
  })
})

describe('item 5: switching person in Flux and Canvas shows nothing of the previous person', () => {
  it('the operator reads a private team motivation; after signing in as Rowan (a member), no Flux or Canvas view holds any of it', async () => {
    const sim = new SimClient()
    await useHive.getState().init(sim)
    await flush(20)
    // as the operator: a private team motivation in Lyra, filed over two of its tasks (INVENTED)
    const lyra = [...Object.values(useHive.getState().goals)].filter((g) => g.swarm_id === 's_lyra' && !g.parent_id)
    for (const id of Object.keys(useHive.getState().swarms)) await useHive.getState().loadGoals(id).catch(() => undefined)
    const tasks = Object.values(useHive.getState().goals).filter((g) => g.swarm_id === 's_lyra' && !g.parent_id).slice(0, 2)
    expect(tasks.length + lyra.length).toBeGreaterThan(0)
    const made = await sim.createMotivation({ title: SECRET_TITLE, why: SECRET_WHY, owner: 'swarm:s_lyra', swarm_id: 's_lyra', visibility: 'private' })
    await sim.linkMotivation(made.id, { operation_id: 'op.r4b.1', op: 'link', goal_ids: tasks.map((g) => g.id), cascade: false, expected_to_rev: made.rev })
    await lib.loadMotivations(true)
    await lib.loadTaskLinks(true)
    const ids = tasks.map((g) => g.id)
    const before = renderAll(made.id, 's_lyra', ids)
    expect(before['flux motivations sheet'], 'the operator sees it first').toContain(SECRET_TITLE)
    expect(before['canvas motivations card'], 'the operator sees it first').toContain(SECRET_WHY)
    expect(before['canvas stickies']).toContain(SECRET_TITLE.slice(0, 20))
    const sessionBefore = useHive.getState().session

    // another person signs in on this tab (the store's sign-in observer starts a new session and reads again)
    sim.simSignInAs('member')
    expect(useHive.getState().session, 'a new store session').not.toBe(sessionBefore)
    // straight after the switch, before anything is read again: nothing of the operator's is held
    const instant = renderAll(made.id, 's_lyra', ids)
    for (const [view, html] of Object.entries(instant)) {
      expect(html, `${view} (at once): title gone`).not.toContain(SECRET_TITLE.slice(0, 20))
      expect(html, `${view} (at once): why gone`).not.toContain(SECRET_WHY.slice(0, 20))
      expect(html, `${view} (at once): id gone`).not.toContain(made.id)
    }
    await flush(40)
    await lib.loadMotivations(true)
    await lib.loadTaskLinks(true)
    for (const id of Object.keys(useHive.getState().swarms)) await useHive.getState().loadGoals(id).catch(() => undefined)
    const s = useHive.getState()
    expect(s.motivations[made.id], 'Rowan cannot read it').toBeUndefined()
    const after = renderAll(made.id, 's_lyra', ids)
    for (const [view, html] of Object.entries(after)) {
      expect(html, `${view}: title gone`).not.toContain(SECRET_TITLE.slice(0, 20))
      expect(html, `${view}: why gone`).not.toContain(SECRET_WHY.slice(0, 20))
      expect(html, `${view}: id gone`).not.toContain(made.id)
    }
    // Rowan's own view is there: the motivation shared with Rowan shows (liveness)
    expect(after['flux motivations sheet']).toContain('Explain the hive’s science to newcomers')
    expect(after['canvas motivations card']).toContain('Explain the hive’s science to newcomers')
    sim.simSignInAs('operator')
  })
})
