// INVENTED data only. Request helpers on the hive map: finished ones fold into one quiet orb per team, live ones stay.
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '../api/types'
import { shown } from '../lib/displayName'
import { buildLayout } from '../experiences/cosmos/layout'
import { HelperGroupButton, HelperGroupOrbButton } from './HelperGroupButton'
import { groupHelpers, helperFinished, helperGroupId, helperGroupWords, helperLabels, HELPER_STALE_MS, isHelper } from './helperGroups'
import { useHelperGroups } from './helperGroupsStore'

const NOW = Date.parse('2026-11-08T12:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const min = 60_000
let n = 0
function mind(over: Partial<Agent> & Pick<Agent, 'id' | 'name'>): Agent {
  n++
  return {
    kind: 'omega', swarm_id: 's_code', model: 'mock/echo', persona: '', hue: 200, status: 'awake', driver: 'local', budget_usd: 1, spent_usd: 0,
    connected: true, last_active_at: iso(min), created_at: iso((100 - n) * min), ...over,
  }
}

const team = () => [
  mind({ id: 'a_lead', name: 'Vega', created_at: iso(500 * min) }),
  mind({ id: 'a_h1', name: 'foundation.code-helper.v1 3a7c', status: 'stopped', created_at: iso(90 * min) }),
  mind({ id: 'a_h2', name: 'foundation.code-helper.v1 91be', status: 'asleep', created_at: iso(80 * min) }),
  mind({ id: 'a_h3', name: 'foundation.code-helper.v1 c04d', status: 'error', created_at: iso(70 * min) }),
  mind({ id: 'a_h4', name: 'foundation.code-helper.v1 d71f', status: 'awake', created_at: iso(10 * min), last_active_at: iso(20_000) }),
  mind({ id: 'a_h5', name: 'foundation.code-helper.v1 5f12', status: 'starting', created_at: iso(1 * min), last_active_at: null }),
]

beforeEach(() => useHelperGroups.setState({ expanded: new Set() }))

describe('which minds are request helpers', () => {
  it('is the host child name shape (<template id> <4 hex>), for any registered template, never a plain name', () => {
    expect(isHelper({ name: 'foundation.code-helper.v1 3a7c' })).toBe(true)
    expect(isHelper({ name: 'person.code-helper.v1 0f0f' })).toBe(true)
    expect(isHelper({ name: 'acme:flow.v2 beef' })).toBe(true)
    for (const name of ['Vega', 'Helper 3', 'Ada 1a2b', 'foundation.code-helper.v1', 'foundation.code-helper.v1 3A7C', 'foundation.code-helper.v1 3a7c9', 'x.y 12'])
      expect(isHelper({ name }), name).toBe(false)
  })
})

describe('groupHelpers', () => {
  it('folds finished or asleep helpers into one group per team; live helpers and members stay drawn', () => {
    const { shown: drawn, groups } = groupHelpers(team(), NOW)
    expect(groups).toEqual([{ id: helperGroupId('s_code'), teamId: 's_code', memberIds: ['a_h1', 'a_h2', 'a_h3'], expanded: false }])
    expect(drawn.map((a) => a.id)).toEqual(['a_lead', 'a_h4', 'a_h5'])
  })

  it('keeps teams apart, and never groups a helper without a team', () => {
    const other = [
      mind({ id: 'a_o1', name: 'foundation.flow.v1 aaaa', swarm_id: 's_flow', status: 'stopped' }),
      mind({ id: 'a_free', name: 'foundation.code-helper.v1 bbbb', swarm_id: null, status: 'stopped' }),
    ]
    const { shown: drawn, groups } = groupHelpers([...team(), ...other], NOW)
    expect(groups.map((g) => [g.teamId, g.memberIds])).toEqual([['s_code', ['a_h1', 'a_h2', 'a_h3']], ['s_flow', ['a_o1']]])
    expect(drawn.map((a) => a.id)).toContain('a_free')
  })

  it('a live helper silent past any request is folded with the finished ones; a starting one never is', () => {
    const quiet = mind({ id: 'a_q', name: 'foundation.code-helper.v1 cafe', status: 'awake', last_active_at: iso(HELPER_STALE_MS + min) })
    expect(helperFinished(quiet, NOW)).toBe(true)
    expect(helperFinished({ ...quiet, status: 'starting' }, NOW)).toBe(false)
    expect(groupHelpers([...team(), quiet], NOW).groups[0].memberIds).toContain('a_q')
  })

  it('a helper label is "Helper <n>" by birth within its team, never the template id', () => {
    const minds = team()
    const labels = helperLabels(minds)
    expect([...labels.entries()]).toEqual([['a_h1', 'Helper 1'], ['a_h2', 'Helper 2'], ['a_h3', 'Helper 3'], ['a_h4', 'Helper 4'], ['a_h5', 'Helper 5']])
    const { shown: drawn } = groupHelpers(minds, NOW, { expanded: new Set([helperGroupId('s_code')]) })
    for (const a of drawn) expect(a.name).not.toMatch(/code-helper/)
    expect(drawn.find((a) => a.id === 'a_lead')!.name).toBe('Vega')
    // anywhere else the name is shown, the host name reads "Helper", never the template id
    expect(shown('foundation.code-helper.v1 3a7c')).toBe('Helper')
    expect(shown('OmegaDesign')).toBe('Design')
  })

  it('an open group draws its helpers and stays, to close again; a revealed (opened) helper opens its group', () => {
    const id = helperGroupId('s_code')
    const open = groupHelpers(team(), NOW, { expanded: new Set([id]) })
    expect(open.groups[0].expanded).toBe(true)
    expect(open.shown.map((a) => a.id)).toEqual(['a_lead', 'a_h1', 'a_h2', 'a_h3', 'a_h4', 'a_h5'])
    const revealed = groupHelpers(team(), NOW, { reveal: 'a_h2' })
    expect(revealed.groups[0].expanded).toBe(true)
    expect(revealed.shown.map((a) => a.id)).toContain('a_h2')
    expect(groupHelpers(team(), NOW, { reveal: 'a_lead' }).groups[0].expanded).toBe(false)
  })

  it('says how many, whose, and what a press does', () => {
    const g = groupHelpers(team(), NOW).groups[0]
    expect(helperGroupWords(g, 'Create · Code')).toEqual({ label: '+3 helpers', aria: '3 finished helpers of Create · Code, show them' })
    expect(helperGroupWords({ ...g, expanded: true }, 'Create · Code')).toEqual({ label: 'Hide 3 helpers', aria: '3 finished helpers of Create · Code, hide them' })
    expect(helperGroupWords({ memberIds: ['x'], expanded: false }, 'Lyra').label).toBe('+1 helper')
  })
})

describe('the group orb button (keyboard)', () => {
  const tracked: [unknown, string | null][] = []
  const engine = { track: (el: HTMLElement, id: string | null) => void tracked.push([el, id]) }
  const button = (expanded: ReadonlySet<string>) => {
    const g = groupHelpers(team(), NOW, { expanded }).groups[0]
    const props = { engine, group: g, team: 'Create · Code', reduced: true, onToggle: () => useHelperGroups.getState().toggle(g.id) }
    return { html: renderToStaticMarkup(createElement(HelperGroupButton, props)), props }
  }
  // the rendered button's own onClick, pressed as Enter / Space / a click would (a native button fires onClick for all)
  const press = (props: Parameters<typeof HelperGroupButton>[0]) => (HelperGroupOrbButton(props) as ReactElement<{ onClick: () => void }>).props.onClick()

  it('is a real button with a spoken label; pressing it opens the group, pressing again closes it', () => {
    const closed = button(useHelperGroups.getState().expanded)
    expect(closed.html).toContain('<button type="button"')
    expect(closed.html).toContain('aria-label="3 finished helpers of Create · Code, show them"')
    expect(closed.html).toContain('aria-expanded="false"')
    expect(closed.html).toContain('+3 helpers')
    expect(closed.html).not.toContain('transition')   // reduced motion: no fade
    press(closed.props)
    const open = button(useHelperGroups.getState().expanded)
    expect(open.html).toContain('aria-label="3 finished helpers of Create · Code, hide them"')
    expect(open.html).toContain('aria-expanded="true"')
    expect(groupHelpers(team(), NOW, { expanded: useHelperGroups.getState().expanded }).shown).toHaveLength(6)
    press(open.props)
    expect(button(useHelperGroups.getState().expanded).html).toContain('aria-expanded="false"')
    expect(groupHelpers(team(), NOW, { expanded: useHelperGroups.getState().expanded }).shown).toHaveLength(3)
  })
})

describe('Cosmos draws by the same rule', () => {
  it('folded helpers are one small world in their system, open ones are worlds labelled "Helper <n>"', () => {
    const agents = Object.fromEntries(team().map((a) => [a.id, a]))
    const swarms = { s_code: { id: 's_code', name: 'Create · Code', description: '', hue: 200, member_ids: Object.keys(agents), created_at: iso(900 * min) } }
    const closed = buildLayout(swarms, agents, { now: NOW })
    expect(closed.systems[0].members).toEqual(['a_lead', 'a_h4', 'a_h5'])
    const group = closed.planets.find((p) => p.group)!
    expect(group).toMatchObject({ id: helperGroupId('s_code'), systemId: 's_code' })
    expect(group.size).toBeLessThan(Math.min(...closed.planets.filter((p) => !p.group).map((p) => p.size)))
    expect(closed.planetById.a_h4.label).toBe('Helper 4')
    expect(closed.planetById.a_lead.label).toBeUndefined()
    const open = buildLayout(swarms, agents, { now: NOW, expanded: new Set([helperGroupId('s_code')]) })
    expect(open.systems[0].members).toHaveLength(6)
    expect(open.planets.find((p) => p.group)!.group!.expanded).toBe(true)
  })
})
