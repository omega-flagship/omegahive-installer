/** The Ask's words for the UI's named parts (read-only): what is matched, what is not, and what the space answers. */
import { describe, expect, it } from 'vitest'
import { effectOf, resolve } from './index'
import { uiPartsCandidates } from './uiParts'
import { answerParts } from '../../experiences/parts/answer'

const act = (t: string) => uiPartsCandidates(t)[0]?.act

describe('uiPartsCandidates', () => {
  it('lists the parts', () => {
    for (const t of ['list the parts', 'what parts are here?', 'Show me the UI parts', 'which parts are on screen', 'list all the named parts here']) expect(act(t), t).toEqual({ do: 'parts', op: 'list' })
  })
  it('asks what plays a role, here or in every look', () => {
    expect(act('what plays the apps role here?')).toEqual({ do: 'parts', op: 'role', role: 'apps', anywhere: false })
    expect(act('Which part plays the field role in any look')).toEqual({ do: 'parts', op: 'role', role: 'field', anywhere: true })
    expect(act('what plays the omega role')).toEqual({ do: 'parts', op: 'role', role: 'ω', anywhere: false })
    expect(act('who plays the pro gesture role everywhere')).toEqual({ do: 'parts', op: 'role', role: 'pro-gesture', anywhere: true })
  })
  it('explains a named part or role', () => {
    expect(act('explain the app orbit part')).toEqual({ do: 'parts', op: 'explain', name: 'app orbit' })
    expect(act('what is the field part?')).toEqual({ do: 'parts', op: 'explain', name: 'field' })
    expect(act('explain the power role')).toEqual({ do: 'parts', op: 'explain', name: 'power' })
  })
  it('never matches other words (a person’s words never become a query)', () => {
    for (const t of ['what plays the banana role', 'explain the weather part', 'explain the field', 'what is the power', 'list my swarms', 'parts of speech']) expect(uiPartsCandidates(t), t).toEqual([])
  })
  it('is a view effect, confident, and reaches the shared resolver', () => {
    const c = uiPartsCandidates('what plays the apps role here')[0]
    expect(c.confidence).toBeGreaterThanOrEqual(0.9)
    expect(effectOf(c.act)).toBe('view')
    const r = resolve('what plays the apps role here?', { experience: 'cosmos' }, { minds: [], swarms: [] } as never)
    expect(r.some((x) => x.act?.do === 'parts')).toBe(true)
  })
})

describe('answerParts (from the real MeTTa space)', () => {
  const cosmos = (state: 'rest' | 'awake' | 'pro' | null) => ({ look: 'cosmos', lookName: 'Cosmos', state })
  it('“what plays the apps role here?” awake in Cosmos: the app orbit, with what draws it', () => {
    const a = answerParts({ do: 'parts', op: 'role', role: 'apps', anywhere: false }, cosmos('awake'))
    expect(a).toMatch(/^Cosmos, awake: the apps role is played by app orbit/)
    expect(a).toContain('(UiPart cosmos awake app-orbit)')
    expect(a).toContain('three.js AppOrbit')
    expect(a).toContain('cosmos-rest-r1')
    expect(a).toMatch(/real MeTTa atoms/)
  })
  it('in Pro the apps role is the deck', () => {
    expect(answerParts({ do: 'parts', op: 'role', role: 'apps', anywhere: false }, cosmos('pro'))).toContain('(UiPart cosmos pro deck)')
  })
  it('at rest nothing plays apps, and it says where it is played instead', () => {
    const a = answerParts({ do: 'parts', op: 'role', role: 'apps', anywhere: false }, cosmos('rest'))
    expect(a).toMatch(/^Nothing plays the apps role at rest in Cosmos\. In Cosmos it is played awake by app orbit/)
  })
  it('the field here is the shell’s one Ask too', () => {
    const a = answerParts({ do: 'parts', op: 'role', role: 'field', anywhere: false }, cosmos('awake'))
    expect(a).toContain('(UiPart cosmos awake field)')
    expect(a).toContain('owned by (UiPart shell any field)')
    expect(a).toContain('(UiPart shell any field)')
  })
  it('lists what is on screen in the state', () => {
    const a = answerParts({ do: 'parts', op: 'list' }, cosmos('rest'))
    expect(a).toMatch(/^Cosmos, at rest: 4 named parts\./)
    expect(a).toContain('(UiPart cosmos rest apps)')
    expect(a).toContain('(UiPart cosmos rest question)')
    expect(a).toContain('(UiPart shell any phase)')
  })
  it('explains by part name or by role', () => {
    expect(answerParts({ do: 'parts', op: 'explain', name: 'app orbit' }, cosmos('awake'))).toMatch(/^app orbit \(cosmos, awake\) is \(UiPart cosmos awake app-orbit\); it plays apps; drawn by react CosmosAwake and three\.js AppOrbit; customisable: colour, density, material and motion/)
    expect(answerParts({ do: 'parts', op: 'explain', name: 'power' }, cosmos('awake'))).toContain('(UiPart cosmos awake power)')
  })
  it('a look without parts says so, and names the shared roles', () => {
    expect(answerParts({ do: 'parts', op: 'list' }, { look: 'unregistered-look', lookName: 'Unregistered look', state: null })).toMatch(/^Unregistered look has no named parts yet\. Shared roles: /)
  })
  it('Classic now names its native home and its shell-owned field in the real space', () => {
    const a = answerParts({ do: 'parts', op: 'list' }, { look: 'classic', lookName: 'Classic hive', state: null })
    expect(a).toMatch(/^Classic hive: 9 named parts\./)
    expect(a).toContain('(UiPart classic awake apps)')
    expect(a).toContain('(UiPart classic awake field)')
    expect(a).toContain('react ClassicHome')
    expect(a).toContain('react AskHost')
  })
  it('every look: the field role across looks', () => {
    const a = answerParts({ do: 'parts', op: 'role', role: 'field', anywhere: true }, { look: 'classic', lookName: 'Classic hive', state: null })
    expect(a).toMatch(/^The field role, in every look: field \(classic, awake\)/)
    expect(a).toContain('(UiPart classic awake field)')
    expect(a).toContain('(UiPart cosmos awake field)')
    expect(a).toContain('(UiPart cosmos pro field)')
    expect(a).toContain('(UiPart shell any field)')
  })
})

describe('r2: a parts-space failure is one calm sentence (Kimi r1 #9)', () => {
  it('the words carry no engine detail, and the runner says only them (the detail goes to the console)', async () => {
    const { PARTS_UNAVAILABLE } = await import('./uiParts')
    expect(PARTS_UNAVAILABLE).toMatch(/^The parts space couldn’t answer that just now\. Nothing changed\.$/)
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync(p: string, e: 'utf8'): string }
    const run = fs.readFileSync(new URL('../../features/ask/run.ts', import.meta.url).pathname, 'utf8')
    const block = run.slice(run.indexOf("case 'parts': {"), run.indexOf("case 'mind':"))
    expect(block).toMatch(/catch \(e\) \{\s*console\.warn\([^)]*e\)\s*if \(origin\.ok\(\)\) say\(PARTS_UNAVAILABLE\)\s*\}/)
    expect(block).not.toMatch(/e\.message|String\(e\)/)
  })
})
