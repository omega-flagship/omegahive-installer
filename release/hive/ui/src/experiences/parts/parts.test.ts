/**
 * The UI's named parts are real atoms in a real MeTTa space (MeTTaScript), and they match what is drawn:
 *  - list / role / explain answer from the space (no TypeScript copy of the registry);
 *  - every part name used in the DOM (`data-ui-part="look state name"`) is registered, and every registered DOM part
 *    of Cosmos's rest and awake is drawn;
 *  - every (UiImpl … component) names a component declared at its (UiSource component "path").
 */
import { describe, expect, it } from 'vitest'
import { partsSpace, UiPartsSpace, type PartId } from './space'

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
const SRC = new URL('../..', import.meta.url).pathname
const read = (p: string) => fs.readFileSync(`${SRC}/${p}`, 'utf8')
const id = (look: string, state: string, name: string): PartId => ({ look, state, name })

describe('the parts space (real MeTTa)', () => {
  const s = partsSpace()

  it('opens from the .metta sources', () => {
    expect(s).toBeInstanceOf(UiPartsSpace)
    expect(s.list('cosmos', 'rest').map((p) => p.name)).toEqual(['apps', 'question', 'ω'])
  })

  it('lists a look in a state, and what is on screen there (the shell field included)', () => {
    expect(s.list('cosmos', 'awake').map((p) => p.name)).toEqual(['app-orbit', 'field', 'name', 'power', 'pro-gesture', 'ω'])
    const on = s.onScreen('cosmos', 'awake').map((p) => `${p.look} ${p.name}`)
    expect(on).toContain('shell field')
    expect(on).toContain('cosmos app-orbit')
    expect(s.onScreen('cosmos', 'rest').map((p) => `${p.look} ${p.name}`)).not.toContain('shell field')
  })

  it('answers what plays a role, here and in any look', () => {
    expect(s.playing('apps', 'cosmos', 'awake')).toEqual([id('cosmos', 'awake', 'app-orbit')])
    expect(s.playing('apps', 'cosmos').map((p) => p.name)).toEqual(['app-orbit', 'deck'])
    expect(s.playing('field', null).map((p) => `${p.look} ${p.state}`)).toEqual(['classic awake', 'construct rest', 'construct awake', 'construct pro', 'cosmos awake', 'cosmos pro', 'professional awake', 'shell any', 'still rest', 'still awake', 'still pro'])
    expect(s.playing('pro-gesture', 'cosmos').map((p) => p.name)).toEqual(['pro-gesture', 'back'])
  })

  it('explains a part from its links', () => {
    const e = s.explain(id('cosmos', 'awake', 'app-orbit'))
    expect(e.roles).toEqual(['apps'])
    expect(e.states).toEqual(['awake'])
    expect(e.impls).toEqual([
      { library: 'react', component: 'CosmosAwake' },
      { library: 'three.js', component: 'AppOrbit' },
    ])
    expect(e.slots).toEqual(['colour', 'density', 'material', 'motion'])
    expect(e.doc).toMatch(/real apps/)
    expect(e.history).toEqual([{ round: 'cosmos-rest-r1', what: 'added', when: '2026-10-17' }])
    expect(e.counterparts).toEqual([id('classic', 'awake', 'apps'), id('construct', 'awake', 'apps'), id('professional', 'awake', 'apps'), id('still', 'awake', 'apps')])
    const f = s.explain(id('cosmos', 'awake', 'field'))
    expect(f.owners).toEqual([id('shell', 'any', 'field')])
    // the field's counterparts: other looks' (the shell's) parts playing the field role
    expect(f.counterparts).toEqual([id('classic', 'awake', 'field'), id('construct', 'rest', 'field'), id('construct', 'awake', 'field'), id('construct', 'pro', 'field'), id('professional', 'awake', 'field'), id('shell', 'any', 'field'), id('still', 'rest', 'field'), id('still', 'awake', 'field'), id('still', 'pro', 'field')])
  })

  it('registers every Classic phase part and draws each owned part with the one renderer', () => {
    expect(s.list('classic', 'rest').map((p) => p.name)).toEqual(['question', 'ω'])
    expect(s.list('classic', 'awake').map((p) => p.name)).toEqual(['apps', 'field', 'name', 'power', 'pro', 'ω'])
    const source = read('experiences/classic/phases.tsx')
    for (const part of s.list('classic').filter((p) => p.name !== 'field')) {
      expect(source).toContain(`classic ${part.state} ${part.name}`)
    }
    expect(s.explain(id('classic', 'awake', 'field')).owners).toEqual([id('shell', 'any', 'field')])
    expect(s.intentsOf(id('classic', 'awake', 'apps'))).toEqual(['apps.open'])
  })

  it('Professional registers its plain native home with the one shell field', () => {
    expect(s.list('professional', 'rest').map((p) => p.name)).toEqual(['apps', 'question', 'ω'])
    expect(s.list('professional', 'awake').map((p) => p.name)).toEqual(['apps', 'field', 'name', 'power', 'pro', 'ω'])
    const source = read('experiences/professional/phases.tsx')
    for (const part of s.list('professional').filter((p) => p.name !== 'field')) {
      expect(source).toContain(`professional ${part.state} ${part.name}`)
    }
    expect(s.explain(id('professional', 'awake', 'field')).owners).toEqual([id('shell', 'any', 'field')])
  })

  it('Still names its actual paper field in every phase, including the question at rest', () => {
    expect(s.list('still', 'rest').map(p => p.name)).toEqual(['apps', 'field', 'ω'])
    expect(s.list('still', 'awake').map(p => p.name)).toEqual(['apps', 'field', 'power', 'pro', 'ω'])
    expect(s.list('still', 'pro').map(p => p.name)).toEqual(['back', 'field'])
    for (const state of ['rest', 'awake', 'pro']) {
      const field = s.explain(id('still', state, 'field'))
      expect(field.owners).toEqual([id('shell', 'any', 'field')])
      expect(field.impls).toEqual([{ library: 'react', component: 'Ask' }, { library: 'react', component: 'StillLine' }])
    }
    expect(s.playing('question', 'still', 'rest')).toEqual([id('still', 'rest', 'field')])
    expect(s.say('still', 'shell.pro')).toBe('Show everything')
    const source = read('experiences/still/phases.tsx')
    for (const part of s.list('still').filter(p => p.name !== 'field')) expect(source).toContain(`still ${part.state} ${part.name}`)
    expect(read('experiences/still/Ask.tsx')).toContain('data-ui-part={part}')
    expect(read('features/ask/StillLine.tsx')).toContain('data-ui-part={part}')
  })

  it('knows the shell states and their transitions, and the shared roles', () => {
    expect(s.next('rest')).toEqual([{ to: 'awake', transition: 'wake' }])
    expect(s.next('awake').map((x) => x.transition).sort()).toEqual(['fly-out', 'settle'])
    expect(s.sharedRoles()).toEqual(['apps', 'field', 'power', 'pro-gesture', 'question', 'ω'].sort())
  })

  it('an unknown part explains as nothing (no invented links)', () => {
    const e = s.explain(id('cosmos', 'awake', 'nonesuch'))
    expect(e.roles).toEqual([])
    expect(e.impls).toEqual([])
    expect(e.doc).toBeNull()
  })

  it('every UiImpl component is declared at its UiSource', () => {
    const src = s.sources()
    expect(src.length).toBeGreaterThan(8)
    for (const { component, path } of src) {
      expect(path, `${component} has a UiSource`).not.toBeNull()
      const text = read(path!)
      const declared = new RegExp(`(function|const|class) ${component}\\b`).test(text)
      expect(declared, `${component} is declared in ${path}`).toBe(true)
    }
  })

  it('every data-ui-part drawn is registered, and every Cosmos rest/awake part is drawn', () => {
    const files = ['experiences/cosmos/phases.tsx', 'experiences/cosmos/index.tsx']
    const drawn = new Set<string>()
    for (const f of files) for (const m of read(f).matchAll(/data-ui-part="([^"]+)"/g)) drawn.add(m[1])
    const registered = new Set([...s.list('cosmos'), ...s.list('shell')].map((p) => `${p.look} ${p.state} ${p.name}`))
    for (const d of drawn) expect(registered.has(d), `${d} is registered`).toBe(true)
    // the DOM parts of rest and awake (the field is the shell's Ask, drawn by AskHost)
    for (const p of [...s.list('cosmos', 'rest'), ...s.list('cosmos', 'awake')].filter((p) => p.name !== 'field')) expect(drawn.has(`cosmos ${p.state} ${p.name}`), `cosmos ${p.state} ${p.name} is drawn`).toBe(true)
  })
})

describe('parts and intents in one space (Ask-and-apps contract R1 §4)', () => {
  const s = partsSpace()

  it('every rest and awake part playing a shared role means an intent, and every intent is defined', () => {
    expect(s.unboundPartRoles()).toEqual([])
    expect(s.unknownIntents()).toEqual([])
  })

  it('the guards catch a part with no intent and an intent nobody defined (a fresh space, not the page’s)', () => {
    const t = UiPartsSpace.open()
    const m = (t as unknown as { m: { run(src: string): unknown[] } }).m
    m.run('(UiPart probe awake tiles) (UiRole (UiPart probe awake tiles) apps) (UiIn (UiPart probe awake tiles) awake)')
    m.run('(UiPart probe awake go) (UiRole (UiPart probe awake go) pro-gesture) (UiIn (UiPart probe awake go) awake) (UiIntent (UiPart probe awake go) shell.nowhere)')
    m.run('(UiPart probe pro list) (UiRole (UiPart probe pro list) apps) (UiIn (UiPart probe pro list) pro)')
    expect(t.unboundPartRoles()).toEqual([id('probe', 'awake', 'tiles')])
    expect(t.unknownIntents().join(' ')).toMatch(/probe awake go.*shell\.nowhere/)
  })

  it('a part says its intent in the look’s own words, else the default', () => {
    expect(s.intentsOf(id('cosmos', 'awake', 'pro-gesture'))).toEqual(['shell.pro'])
    expect(s.wordsFor('cosmos', id('cosmos', 'awake', 'pro-gesture'))).toEqual(['Fly out'])
    expect(s.wordsFor('construct', id('cosmos', 'awake', 'pro-gesture'))).toEqual([':pro'])
    expect(s.wordsFor('professional', id('cosmos', 'awake', 'pro-gesture'))).toEqual(['Pro'])
    expect(s.wordsFor('classic', id('shell', 'any', 'field'))).toEqual(['Ask'])
    expect(s.wordsFor('cosmos', id('cosmos', 'awake', 'app-orbit'))).toEqual(['Your apps'])
  })

  it('the inventory guards hold in the same engine: every intent has a default phrase; OmegaTown is retired', () => {
    const m = (s as unknown as { m: { run(src: string): unknown[] } }).m
    expect(JSON.stringify(m.run('!(collapse (no-default))'))).not.toMatch(/\.[a-z]/)
    expect(String(m.run('!(is-retired experience.omegatown)'))).toMatch(/True/)
  })
})

describe('the say facade (Codex 3 Nov): a look reads its awake words from the same space', () => {
  const s = partsSpace()
  it('a look’s own phrase, else the default; null for an unknown or a retired intent', () => {
    expect(s.say('cosmos', 'shell.pro')).toBe('Fly out')
    expect(s.say('classic', 'shell.pro')).toBe('Pro')
    expect(s.say('construct', 'apps.more')).toBe('apps --all')
    expect(s.say('classic', 'apps.open')).toBe('Your apps')
    expect(s.say('classic', 'shell.nowhere')).toBeNull()
    expect(s.say('classic', 'experience.omegatown')).toBeNull()
  })
})
