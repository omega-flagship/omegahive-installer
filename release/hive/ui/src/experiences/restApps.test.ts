/**
 * Apps first in every look (Jon 2 Nov; Dot, MacBook Create retry 5 Nov): in each released phased look the rest draws one
 * visible "Your apps" press that wakes straight into the apps, so reaching an app (Create among them) from rest is never a
 * hidden step. Checked three ways: the parts space registers it in every look's rest, each look's source draws it shown at
 * rest, and the shell's wakeIntoApps wakes and lands focus on the first app that is actually shown.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { partsSpace } from './parts/space'
import { usePhase, wakeIntoApps } from '../shell/phase'

const LOOKS = ['construct', 'cosmos', 'professional', 'still'] as const
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
const src = (look: string) => fs.readFileSync(new URL(`./${look}/phases.tsx`, import.meta.url).pathname, 'utf8')

describe('every released phased look has apps one press away at rest', () => {
  const s = partsSpace()
  it.each(LOOKS)('%s registers a rest part meaning shell.apps, worded from the intents space', (look) => {
    const at = s.list(look, 'rest').find((p) => p.name === 'apps')
    expect(at, `${look} rest apps`).toBeTruthy()
    expect(s.intentsOf(at!)).toEqual(['shell.apps'])
    expect(s.say(look, 'shell.apps')).toBe(look === 'construct' ? 'apps' : 'Your apps')
  })
  it.each(LOOKS)('%s draws it, shown at rest (never hidden there), and it wakes into the apps', (look) => {
    const tag = src(look).match(/<button[\s\S]*?<\/button>/g)?.find((b: string) => b.includes(`data-ui-part="${look} rest apps"`))
    expect(tag, `${look} draws its rest apps press`).toBeTruthy()
    expect(tag).toContain('data-intent="shell.apps"')
    expect(tag).toMatch(/wakeIntoApps\(\)/)
    // hidden only outside rest, or not at all (Cosmos's rest layer is itself the rest)
    const hidden = tag!.match(/hidden=\{([^}]*)\}/)?.[1]
    expect(hidden === undefined || hidden === "phase !== 'rest'", `${look}: ${hidden}`).toBe(true)
  })
})

describe('wakeIntoApps', () => {
  type El = { attrs: Record<string, string>; parent: El | null; focused: boolean; focus(): void; closest(sel: string): El | null }
  const el = (attrs: Record<string, string>, parent: El | null = null): El => ({
    attrs, parent, focused: false,
    focus() { this.focused = true },
    closest(sel: string) {
      for (let n: El | null = this; n; n = n.parent) if (sel.split(',').some((q) => { const k = q.trim().match(/^\[([\w-]+)(?:="([^"]*)")?\]$/); return !!k && k[1] in n!.attrs && (k[2] === undefined || n!.attrs[k[1]] === k[2]) })) return n
      return null
    },
  })
  const glob = globalThis as unknown as Record<string, unknown>
  const saved: Record<string, unknown> = {}
  let buttons: El[] = []
  beforeAll(() => {
    for (const k of ['document', 'requestAnimationFrame']) saved[k] = glob[k]
    glob.document = { documentElement: { dataset: {} as Record<string, string> }, querySelectorAll: () => buttons }
    glob.requestAnimationFrame = (f: () => void) => { f(); return 0 }
  })
  afterAll(() => { for (const [k, v] of Object.entries(saved)) glob[k] = v })

  it('from rest: wakes, and the first app actually shown takes focus (an app inside a hidden or inert layer never does)', () => {
    usePhase.getState().setPhased(false)
    usePhase.getState().setPhased(true, 'professional')
    usePhase.setState({ phase: 'rest', identityRest: false })
    const hiddenLayer = el({ hidden: '' }), inertLayer = el({ inert: '' }), shown = el({})
    buttons = [el({ 'data-intent': 'apps.open' }, hiddenLayer), el({ 'data-intent': 'apps.open' }, inertLayer), el({ 'data-intent': 'apps.open' }, shown), el({ 'data-intent': 'apps.open' }, shown)]
    expect(wakeIntoApps()).toBe(true)
    expect(usePhase.getState().phase).toBe('awake')
    expect((glob.document as { documentElement: { dataset: Record<string, string> } }).documentElement.dataset.shellPhase).toBe('awake')
    expect(buttons.map((b) => b.focused)).toEqual([false, false, true, false])
  })

  it('awake: stays awake (never on to Pro) and focuses the first app; from Pro: nothing moves', () => {
    usePhase.getState().setPhased(false)
    usePhase.getState().setPhased(true, 'cosmos')
    usePhase.setState({ phase: 'awake', identityRest: false })
    buttons = [el({ 'data-intent': 'apps.open' })]
    expect(wakeIntoApps()).toBe(true)
    expect(usePhase.getState().phase).toBe('awake')
    expect(buttons[0].focused).toBe(true)
    usePhase.setState({ phase: 'pro' })
    buttons = [el({ 'data-intent': 'apps.open' })]
    expect(wakeIntoApps()).toBe(false)
    expect(usePhase.getState().phase).toBe('pro')
    expect(buttons[0].focused).toBe(false)
  })

  it('not phased (Classic): does nothing', () => {
    usePhase.getState().setPhased(false)
    buttons = [el({ 'data-intent': 'apps.open' })]
    expect(wakeIntoApps()).toBe(false)
    expect(buttons[0].focused).toBe(false)
  })
})
