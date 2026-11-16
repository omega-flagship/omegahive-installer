import { describe, expect, it } from 'vitest'
import { outsideOf, planInert, type TreeNode } from '../../lib/modalContainment'
import { stillModal } from './containment'

// close-home r4: Still's reading room and sheets contain only while Still is in front (route home). Before r4 they
// contained whatever was open, so a mind panel or shared page opened from them ("Everything about <mind>") was made
// inert and its X could not be clicked (smoke 2026-10-08: elementFromPoint at the X hit .st-read-scroll, [inert]).

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
const src = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('stillModal: Still holds the page only while it is in front', () => {
  it('on Home, an open reading room or sheet is modal (contained, aria-modal, focus restored on close)', () => {
    expect(stillModal('hive')).toEqual({ active: true, ariaModal: true })
    expect(stillModal('hive', true)).toEqual({ active: true, ariaModal: true })
  })
  it('a closed reading room is never modal', () => {
    expect(stillModal('hive', false).active).toBe(false)
  })
  it.each(['dot', 'tasks', 'settings', 'swarm', 'program', 'code', 'usage'] as const)(
    'with %s open on top: not contained, not aria-modal, and focus is not pulled back into Still',
    (route) => {
      expect(stillModal(route)).toEqual({ active: false, ariaModal: false, restoreFocus: false })
      expect(stillModal(route, true).active).toBe(false)
    },
  )
})

describe('what that means for the inert set (the real planner)', () => {
  type N = { id: string; parentElement: N | null; children: N[] } & TreeNode
  const node = (id: string, children: N[] = []): N => {
    const n = { id, parentElement: null as N | null, children } as N
    for (const c of children) (c as { parentElement: N | null }).parentElement = n
    return n
  }
  const tree = () => {
    const room = node('st-read')
    const still = node('still', [node('still-scroll'), room])
    const panel = node('mind-panel')
    const root = node('body', [still, panel, node('ask-root')])
    return { root, room, panel }
  }
  const inertFor = (route: Parameters<typeof stillModal>[0]) => {
    const t = tree()
    const want = stillModal(route).active ? outsideOf([t.room], t.root) : []
    return { ...t, inert: new Set(planInert(new Set<N>(), want, () => false).set) }
  }
  it('on Home, everything outside the reading room is inert (as before)', () => {
    const { inert, panel } = inertFor('hive')
    expect([...inert].map((n) => n.id).sort()).toEqual(['ask-root', 'mind-panel', 'still-scroll'])
    expect(inert.has(panel)).toBe(true)
  })
  it('with the mind panel opened from the reading room (#/dot/…), nothing is inert: its X is clickable', () => {
    const { inert, panel } = inertFor('dot')
    expect(inert.size).toBe(0)
    expect(inert.has(panel)).toBe(false)
  })
})

describe('both Still layers use the gate', () => {
  it.each([
    ['reading room', './Reading.tsx', /const modal = stillModal\(useRoute\(\)\.name, !!agent\)/],
    ['sheets', './Sheets.tsx', /const modal = stillModal\(useRoute\(\)\.name\)/],
  ])('%s: containment and aria-modal follow stillModal', (_n, file, gate) => {
    const s = src(file)
    expect(s).toMatch(gate)
    expect(s).toMatch(/useModalContainment\(page, \{ active: modal\.active, restoreFocus: modal\.restoreFocus \}\)/)
    expect(s).toMatch(/aria-modal=\{modal\.ariaModal\}/)
    expect(s).not.toMatch(/aria-modal="true"/)
    expect(s.match(/useModalContainment\(/g)).toHaveLength(1)
  })
})
