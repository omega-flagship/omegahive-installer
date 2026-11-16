// Purpose: Jon on #364: the Ask's sizes and its mark are a screen MeTTa composes for every look (screens/ask.metta),
// drawn through features/ask/askScreen.ts with nothing placed by hand. For every look the registry offers, at every
// size on every kind of screen, MeTTa places the look's own Ask in its one region and the mark only while the Ask is
// collapsed and drawn; the Ask's own small space answers exactly as the whole space does; the engine's guards stay
// clean; and no component but the screens' mark block draws the mark, nothing but askScreen.ts composes the Ask, and
// AskHost hands the screen its look's Ask as the island. A look added to the registry is checked here with no edit.
import { describe, expect, it, vi } from 'vitest'

// INVENTED data, no network: a page's window as the look settings read it
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: { platform: 'Linux' } })
// MeTTa opens the whole screens space and composes the Ask against it 126 times: about 3x the worst measured under load
// (api/sim/simTimeouts.test.ts MEASURED)
vi.setConfig({ testTimeout: 32_000 })

const { ASK_SOURCES, composeAsk } = await import('./askScreen')
const { ScreensSpace } = await import('../../screens/screenSpace')
const { ASK_SIZES } = await import('../../shell/uiVariant')

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string; readdirSync: (p: string, o?: { recursive?: boolean }) => string[] }
const SRC = new URL('../..', import.meta.url).pathname
const read = (p: string) => fs.readFileSync(`${SRC}${p}`, 'utf8')

/** Every look the registry offers, read from its source, so a new look is checked with no edit here. */
const LOOKS = [...read('experiences/registry.ts').matchAll(/^\s+id: '([a-z]+)',/gm)].map((m) => m[1]).sort()
const MODES = ['desktop', 'landscape', 'phone'] as const
/** The region of the look's own Ask for each size on each kind of screen (Jon, 16 Nov: "100% the vision"). */
const REGION: Record<string, Record<(typeof MODES)[number], string>> = {
  collapsed: { desktop: 'mark', landscape: 'mark', phone: 'mark' },
  bubble: { desktop: 'bubble', landscape: 'bubble', phone: 'bubble' },
  half: { desktop: 'half-left', landscape: 'half-left', phone: 'sheet' },
}
const cases = ASK_SIZES.flatMap((size) => MODES.flatMap((mode) => [true, false].map((drawn) => ({ size, mode, drawn }))))

describe('the Ask is a screen MeTTa composes for every look (Jon on #364)', () => {
  it('reads every look the registry offers, and every size the person can choose', () => {
    expect(LOOKS.length).toBeGreaterThan(5)
    expect([...ASK_SIZES].sort()).toEqual(Object.keys(REGION).sort())
  })

  it.each(LOOKS)('%s: the look’s own Ask in one region at every size on every screen, the mark only while collapsed and drawn', (look) => {
    for (const { size, mode, drawn } of cases) {
      const { plan, region } = composeAsk(look, size, mode, drawn)
      const at = `${size} ${mode} ${drawn ? 'drawn' : 'not drawn'}`
      expect(region, at).toBe(REGION[size][mode])
      expect(plan.missing, at).toEqual([])
      const parts = plan.parts.map((p) => [p.block, p.block === 'island' ? p.props.name : p.props.glyph])
      expect(parts, at).toEqual(size === 'collapsed' && drawn ? [['mark', 'ask-glyph'], ['island', 'ask']] : [['island', 'ask']])
    }
  })

  it('the Ask’s own space, opened at the first paint, answers exactly as the whole space does', () => {
    expect(ASK_SOURCES.map(([name]) => name)).toEqual(['lib_screens', 'looks', 'ask'])
    const whole = ScreensSpace.open()
    const own = ScreensSpace.open(ASK_SOURCES)
    for (const look of LOOKS) {
      for (const { size, mode, drawn } of cases) {
        const facts = { values: { 'ask.size': size, 'ask.mode': mode }, flags: { 'ask.drawn': drawn } }
        expect(own.compose('ask', look, facts), `${look} ${size} ${mode} ${drawn}`).toEqual(whole.compose('ask', look, facts))
      }
    }
    expect(Object.values(whole.guards()).flat()).toEqual([])
  })

  it('places nothing by hand: the mark is the screens’ block, only askScreen composes the Ask, and AskHost hands it the look’s Ask', () => {
    const files = fs.readdirSync(SRC, { recursive: true }).filter((p) => /\.tsx?$/.test(p) && !/\.(test|testkit)\./.test(p))
    expect(files.filter((p) => /\bcompose\('ask',/.test(read(p)))).toEqual(['features/ask/askScreen.ts'])
    // the mark's control (data-ask-mark-open) is drawn by the mark block alone
    expect(files.filter((p) => /data-ask-mark-open=/.test(read(p)))).toEqual(['screens/Screen.tsx'])
    const host = read('features/ask/AskHost.tsx')
    expect(host).toMatch(/<InlineParts plan=\{ask\.plan\} host=\{askScreenHost\(\{[^]*?island: <LookAsk skin=\{skin\}/)
    // every look's Ask is drawn by LookAsk, which AskHost renders nowhere but as that island
    expect(host.match(/<LookAsk\b/g)).toHaveLength(1)
    for (const skin of ['ClassicAsk', 'ConstructLine', 'FloatingAsk', 'ProfessionalAskSkin', 'StillLine']) {
      expect(host.match(new RegExp(`<${skin}\\b`, 'g')), skin).toHaveLength(1)
      expect(host.indexOf(`<${skin} `), skin).toBeGreaterThan(host.indexOf('export function LookAsk('))
    }
    // the function library and the hand-placed mark this replaced are gone
    expect(fs.existsSync(`${SRC}features/ask/lib_ask_size.metta`)).toBe(false)
    expect(fs.existsSync(`${SRC}features/ask/AskSizeControls.tsx`)).toBe(false)
    expect(files.filter((p) => /askRegion|ask-region|\bAskMark\b/.test(read(p)))).toEqual([])
  })
})
