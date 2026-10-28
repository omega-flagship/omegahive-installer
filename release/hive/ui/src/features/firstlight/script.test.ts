import { describe, expect, it } from 'vitest'
import { BEATS, FL_SCRIPT, FL_VOICE, R2_BEATS, choicesFor, stepsFor } from './script'
import { firstLightWords, demoFromSearch, useFlDoor } from './door'

// node's fs, the repo's way (the app's tsconfig carries no node types)
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readdirSync: (p: string) => string[]; readFileSync: (p: string, e: 'utf8') => string }
const DIR = new URL('.', import.meta.url).pathname
const sources = fs
  .readdirSync(DIR)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f))
  .map((f) => ({ f, src: fs.readFileSync(DIR + f, 'utf8') }))

describe('First Light R2: the script is data, for beats 1, 2, 3, 5, 6 and 8', () => {
  it('plays only this round’s beats; 4 and 7 come later', () => {
    expect(R2_BEATS).toEqual(['arrive', 'look', 'models', 'apps', 'ask', 'hello'])
    expect(new Set(FL_SCRIPT.steps.map((s) => s.beat))).toEqual(new Set(R2_BEATS))
    expect(BEATS.filter((b) => !b.r2).map((b) => b.n)).toEqual([4, 7])
  })

  it('every step names the R0.1 step it comes from, or says why R2 adds it', () => {
    for (const s of FL_SCRIPT.steps) expect(s.r0 || s.r2, s.id).toBeTruthy()
  })

  it('the owner path: own keys and own limit; no guest lines', () => {
    const ids = stepsFor('owner').map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining(['1.1', '1.2', '1.3', '2.1', '2.2', '3.1', '3.3', '3.4', '3.6', '8.2', '8.3', '8.4']))
    expect(ids.some((i) => i.endsWith('g'))).toBe(false)
  })

  it('the guest path: no key field, the host’s limit card, and the guest closing line', () => {
    const steps = stepsFor('guest')
    const ids = steps.map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining(['1.1g', '1.2g', '3.1g', '3.2g', '3.3g', '8.4g']))
    expect(steps.some((s) => s.wait?.for === 'key' || s.card === 'key' || s.card === 'own-limit')).toBe(false)
    expect(steps.filter((s) => s.beat === 'models').every((s) => s.card === 'guest-limit')).toBe(true)
  })

  it('Host friends is offered to owners only', () => {
    const role = FL_SCRIPT.steps.find((s) => s.id === '1.3')!
    expect(choicesFor(role, 'owner').map((c) => c.value)).toContain('admin')
    expect(choicesFor(role, 'guest').map((c) => c.value)).not.toContain('admin')
    expect(choicesFor(role, 'member').map((c) => c.value)).not.toContain('admin')
  })

  it('the person presses Wake themselves; the greeting is the mind’s own words, never scripted', () => {
    const wake = FL_SCRIPT.steps.find((s) => s.id === '8.2')!
    expect(wake.wait).toEqual({ for: 'wake' })
    const words = FL_SCRIPT.steps.find((s) => s.id === '8.3')!
    expect(words.voice).toBe('mind')
    expect(words.say).not.toMatch(/Hi |I’m awake/)
    // the closing lines only once the mind greeted
    expect(FL_SCRIPT.steps.filter((s) => s.id.startsWith('8.4')).every((s) => s.when === 'greeted')).toBe(true)
  })

  it('a line naming a limit as stopping minds is only said when the host says it is enforced', () => {
    for (const s of FL_SCRIPT.steps) if (/stops (your minds|them)/.test(s.say)) expect(s.when, s.id).toBe('limit-enforced')
  })

  it('owner words only: minds and swarms; never dots, teams, goals or boards', () => {
    for (const s of FL_SCRIPT.steps) expect(s.say, s.id).not.toMatch(/\b(dots?|teams?|goals?|boards?)\b/i)
  })
})

describe('First Light R2: captions only, and no Enter or implicit submit', () => {
  it('voice is off: nothing in First Light speaks', () => {
    expect(FL_VOICE).toBe(false)
    for (const { f, src } of sources) {
      expect(src, f).not.toMatch(/speechSynthesis|SpeechSynthesisUtterance|tour\/speech|useAskVoice/)
    }
  })

  it('no Enter handler and no form anywhere in First Light (nothing is sent or spent by an implicit submit)', () => {
    for (const { f, src } of sources) {
      expect(src, f).not.toMatch(/['"`](Numpad)?Enter['"`]|keyCode\s*===?\s*13\b|which\s*===?\s*13\b/)
      expect(src, f).not.toMatch(/<form\b|<m\.form\b|onSubmit=/)
    }
  })

  it('every button in the layer is type="button"', () => {
    const layer = sources.find((s) => s.f === 'FirstLightLayer.tsx')!.src
    const buttons = layer.match(/<button\b[^>]*>/g) ?? []
    expect(buttons.length).toBeGreaterThan(5)
    for (const b of buttons) expect(b).toMatch(/type="button"/)
  })
})

describe('First Light R2: the ways in', () => {
  it('the Ask’s words start it (the R0.1 triggers); anything else goes on to the Ask', () => {
    useFlDoor.getState().close()
    expect(firstLightWords('Show me First Light')).toBe(true)
    expect(useFlDoor.getState().asked).toMatchObject({ mode: 'live', persona: 'pip' })
    expect(firstLightWords('set me up as a guest')).toBe(true)
    expect(useFlDoor.getState().asked).toMatchObject({ persona: 'juno' })
    useFlDoor.getState().close()
    expect(firstLightWords('show me how belief revision works')).toBe(false)
    expect(useFlDoor.getState().asked).toBeNull()
  })

  it('the invented demo is asked for only on the simulator', () => {
    expect(demoFromSearch('?sim=1&firstlight=pip&flbeat=models&fllook=still')).toEqual({ mode: 'demo', persona: 'pip', beat: 'models', step: undefined, look: 'still' })
    expect(demoFromSearch('?sim=1&firstlight=juno&flstep=8.3')).toMatchObject({ persona: 'juno', step: '8.3' })
    expect(demoFromSearch('?firstlight=pip')).toBeNull()
    expect(demoFromSearch('?sim=1&firstlight=ada')).toBeNull()
    expect(demoFromSearch('?sim=1&firstlight=pip&flbeat=<x>')?.beat).toBeUndefined()
  })
})
