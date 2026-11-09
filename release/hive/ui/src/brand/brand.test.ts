import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MARK_PATHS, MARK_VIEWBOX } from './markOutline'
import { OmegaGlyph } from './OmegaGlyph'
import { LiveOmega } from './LiveOmega'
import { LivingMark, MarkStill } from './LivingMark'
import { MARK_LOOKS, markLook, stillFor } from './stills'

const fsName = 'node:fs'   // the repo's way to read files in node tests without node types (shownStrings.testkit)
const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e?: 'utf8') => string }

/** Each `<LiveOmega …/>` element in a source file, whole: attributes and their nested JSX, ended by the `/>` (or `>`) at brace depth 0. */
function liveOmegaElements(src: string): string[] {
  const out: string[] = []
  for (let at = src.indexOf('<LiveOmega'); at >= 0; at = src.indexOf('<LiveOmega', at + 1)) {
    let depth = 0, i = at + 1
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (depth === 0 && c === '>') break
    }
    out.push(src.slice(at, i + 1))
  }
  return out
}

// The Omega mark rollout: one canonical shape everywhere (brand/markOutline), flat where it must be, living where it can.

describe('the one shape', () => {
  it('has three closed parts (left crescent, right crescent, base) inside the mark viewBox', () => {
    const [x0, y0, w, h] = MARK_VIEWBOX.split(' ').map(Number)
    for (const d of Object.values(MARK_PATHS)) {
      const nums = [...d.matchAll(/([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])
      expect(nums.length).toBeGreaterThan(40)
      for (const [x, y] of nums) { expect(x).toBeGreaterThanOrEqual(x0); expect(x).toBeLessThanOrEqual(x0 + w); expect(y).toBeGreaterThanOrEqual(y0); expect(y).toBeLessThanOrEqual(y0 + h) }
    }
    expect(Object.keys(MARK_PATHS)).toEqual(['left', 'right', 'base'])
  })
  it('the flat glyph is one welded group in the current colour, decorative unless titled', () => {
    const html = renderToStaticMarkup(createElement(OmegaGlyph, { className: 'size-9' }))
    expect(html).toContain('aria-hidden="true"')
    expect(html.match(/<path /g)?.length).toBe(3)
    expect(html).toContain('fill="currentColor"')
    expect(html).toContain('stroke="currentColor"')                     // same paint on fill and weld stroke: no seam
    const titled = renderToStaticMarkup(createElement(OmegaGlyph, { title: 'Omega' }))
    expect(titled).toContain('role="img"')
    expect(titled).toContain('<title>Omega</title>')
  })
})

describe('each mark wears what it stands for', () => {
  it('maps a look to its material, and anything unknown to the brand glass', () => {
    for (const k of MARK_LOOKS) expect(markLook(k)).toBe(k)
    expect(markLook('a-new-app')).toBe('brand')
    expect(markLook(null)).toBe('brand')
  })
  it('every look has its still and live texture shipped', () => {
    for (const k of MARK_LOOKS) {
      expect(stillFor(k)).toMatch(new RegExp(`brand/still-${k}\\.webp$`))
      expect(() => readFileSync(`public/brand/still-${k}.webp`)).not.toThrow()
      expect(() => readFileSync(`public/brand/tex-${k}.webp`)).not.toThrow()
    }
    for (const f of ['outline.json', 'rules.json', 'sdf.png']) expect(() => readFileSync(`public/brand/${f}`)).not.toThrow()
  })
  it('the renderer behaviour comes from MeTTa: every look has a living motion and a way to take over', () => {
    const rules = JSON.parse(readFileSync('public/brand/rules.json', 'utf8')) as { environments: Record<string, { living: string; style: string }>; source: string }
    expect(rules.source).toMatch(/omega-mark\.metta via PeTTa/)
    for (const k of MARK_LOOKS) { expect(rules.environments[k]?.living).toBeTruthy(); expect(rules.environments[k]?.style).toBeTruthy() }
    expect((rules as unknown as { time_jump: Record<string, string> }).time_jump).toEqual({ rewind: '1.21 GW', 'fast-forward': '1.21 GW' })   // the Easter egg, from MeTTa
  })
})

describe('fallbacks first', () => {
  it('a living mark renders its fallback before (and without) WebGL: the glyph in a corner, the still for a hero', () => {
    const corner = renderToStaticMarkup(createElement(LiveOmega, { look: 'still', size: 'corner', fallback: createElement(OmegaGlyph) }))
    expect(corner).toContain('aria-hidden="true"')
    expect(corner.match(/<path /g)?.length).toBe(3)
    expect(corner).toContain('opacity-100')
    const hero = renderToStaticMarkup(createElement(LivingMark, { look: 'cosmos' }))
    expect(hero).toContain('brand/still-cosmos.webp')
    expect(hero).toContain('alt=""')
  })
  it('a hero never stands in with the flat glyph: every hero mark\'s stand-in is its look\'s still', async () => {
    // the flat glyph is for corners, bars and line art; a hero without WebGL (or before it draws) shows the master still
    const { readdirSync } = (await import(/* @vite-ignore */ fsName)) as { readdirSync: (p: string, o: { recursive: true }) => string[] }
    const heroes = readdirSync('src', { recursive: true }).filter((f) => /\.tsx$/.test(f)).flatMap((f) => liveOmegaElements(readFileSync(`src/${f}`, 'utf8')).map((el) => ({ f, el })))
      .filter(({ el }) => /\bsize=(["']hero["']|\{[^}]*hero[^}]*\})/.test(el))
    expect(heroes.length).toBeGreaterThan(0)
    for (const { f, el } of heroes) expect(el, f).not.toMatch(/<OmegaGlyph\b|<OmegaMark\b/)
    expect(renderToStaticMarkup(createElement(MarkStill, { look: 'classic' }))).toContain('brand/still-classic.webp')
  })
  it('the hero scope reads one element: a corner glyph beside a hero passes, a glyph inside a hero fails', () => {
    const els = liveOmegaElements('<LiveOmega look="x" size="hero" fallback={<MarkStill look="x" />} pace={a ? \'awake\' : \'still\'} />\n<LiveOmega size="corner" fallback={<OmegaGlyph />} />\n<LiveOmega size={big ? \'hero\' : \'corner\'} fallback={<span><OmegaGlyph /></span>} />')
    expect(els).toHaveLength(3)
    expect(els[0]).toContain('MarkStill'); expect(els[0]).not.toContain('OmegaGlyph')
    expect(els[1]).toContain('corner'); expect(els[2]).toContain('OmegaGlyph')
  })
  it('no old Ω glyph is drawn as text where the mark belongs', () => {
    for (const f of ['src/experiences/OmegaMenu.tsx', 'src/features/power/OffScreen.tsx', 'src/experiences/professional/index.tsx']) {
      const src = readFileSync(f, 'utf8').split('\n').filter((l: string) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
      expect(src).not.toMatch(/>\s*Ω\s*</)
      expect(src).not.toMatch(/['"]Ω( BOOT)?['"]/)
    }
  })
})

describe('the 1.21 GW Easter egg (brand/timeJump)', () => {
  it('a rewind or a fast forward signals a time jump; an ordinary step forward does not', async () => {
    const seen: string[] = []
    const g = globalThis as unknown as { window?: { dispatchEvent: (e: { type: string }) => void } }
    const had = g.window
    g.window = { dispatchEvent: (e) => { seen.push(e.type) } }
    ;(globalThis as unknown as { CustomEvent?: unknown }).CustomEvent ??= class { type: string; detail: unknown; constructor(t: string, i?: { detail?: unknown }) { this.type = t; this.detail = i?.detail } }
    const { scrubbed } = await import('./timeJump')
    scrubbed(5, 6)                                   // one step forward: not a jump
    expect(seen).toEqual([])
    scrubbed(6, 2, 'step 3')                         // back: a rewind
    expect(seen).toEqual(['omega:timejump'])
    g.window = had
  })
})

describe('the shared renderer stays whole (brand/live)', () => {
  it('no // comment swallows code on the same line', () => {
    // this class shipped once (R1.2: a comment inserted mid-line commented out `const p = …`, so every morph threw)
    const code = /(\b(const|let|var)\s+[\w[{]|\bfor\s*\(|\bwhile\s*\(|\)\s*\{|\bthis\.\w+(\.\w+)*\s*=[^=]|;\s*\w+\s*[=(.]|\)\)\s*as\b)/
    const bad: string[] = []
    for (const f of ['src/brand/live/mark.ts', 'src/brand/live/fx.ts', 'src/brand/live/sound.ts', 'src/brand/askMark.ts', 'src/brand/LiveOmega.tsx', 'src/brand/AskLeadMark.tsx']) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const at = line.indexOf('//'); if (at < 0) return
        const before = line.slice(0, at); if (!before.trim()) return   // a whole-line comment swallows nothing
        if ((before.match(/'/g)?.length ?? 0) % 2 || (before.match(/`/g)?.length ?? 0) % 2 || /:\s*$/.test(before) || /https?:$/.test(before)) return   // inside a string, or a URL
        if (code.test(line.slice(at + 2))) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`)
      })
    }
    expect(bad).toEqual([])
  })
})

describe("the Ask's own Omega (brand/askMark)", () => {
  it('each frame means an activity; an act resolves through MeTTa', async () => {
    const { activityOf } = await import('./askMark')
    const rules = JSON.parse(readFileSync('public/brand/rules.json', 'utf8')) as { ask: { acts: Record<string, string>; shows: Record<string, Record<string, string>> } }
    const f = (phase: string, more: object = {}) => ({ type: 'ask', operation_id: 'o', turn_id: 't', seq: 1, at: 'x', phase, ...more }) as never
    expect(activityOf(f('thinking'), rules.ask.acts)).toBe('thinking')
    expect(activityOf(f('answer', { text: 'hi' }), rules.ask.acts)).toBe('answering')
    expect(activityOf(f('act', { act: { act_id: 'a', kind: 'fill', field: 'x', text: 'y' } }), rules.ask.acts)).toBe('writing')
    expect(activityOf(f('refused', { reason: 'x' }), rules.ask.acts)).toBe('failed')
    expect(activityOf(f('done', { outcome: 'complete' }), rules.ask.acts)).toBeNull()
    // and MeTTa decides how each look shows it: thinking in each look's own language
    expect(rules.ask.shows.construct.thinking).toBe('scan')
    expect(rules.ask.shows.cosmos.thinking).toBe('stars')
    expect(rules.ask.shows.flux.failed).toBe('glitch')
    // and each material behaves in its own idiom (MeTTa ask-behaves): grass gusts, sprouts, blooms, wilts; a galaxy spins up, goes nova
    const r2 = rules as unknown as { ask: { behaves: Record<string, Record<string, string>> } }
    expect(r2.ask.behaves.bush).toMatchObject({ thinking: 'gust', making: 'sprout', approved: 'bloom-burst', failed: 'wilt', answering: 'flower-talk' })
    expect(r2.ask.behaves.cosmos).toMatchObject({ thinking: 'spin-up', making: 'nova', failed: 'flicker-out' })
  })

  it('an approval reaches the mark: a confirmed act on the turn shows once, a waiting or declined one never', async () => {
    const { freshApprovals } = await import('./askMark')
    const seen = new Set<number>()
    const outcomes = { 3: { kind: 'confirm', state: 'waiting' }, 5: { kind: 'confirm', state: 'confirmed' }, 7: { kind: 'confirm', state: 'declined' }, 9: { kind: 'ui', state: 'preview' } }
    expect(freshApprovals(outcomes, seen)).toEqual([5])
    expect(freshApprovals(outcomes, seen)).toEqual([])                                  // shown once, not on every frame after
    expect(freshApprovals({ ...outcomes, 3: { kind: 'confirm', state: 'confirmed' } }, seen)).toEqual([3])
  })

  it('a rewind across a behaviour never inverts or overshoots it (behaviour levers clamp on the rewindable clock)', async () => {
    const { behaviourLevel } = await import('./live/mark')
    const held = { b: { dur: 0 }, t0: 10 }, oneOff = { b: { dur: 1.2 }, t0: 10 }, calming = { b: { dur: 0 }, t0: 1, out: 10 }
    for (const clock of [8, 9.9, 10, 10.1, 10.3, 11, 11.5, 12, 20]) for (const B of [held, oneOff, calming]) {
      const k = behaviourLevel(B, clock); expect(k).toBeGreaterThanOrEqual(0); expect(k).toBeLessThanOrEqual(1)
    }
    expect(behaviourLevel(held, 9)).toBe(0)                                               // rewound to before it began: off, not negative
    expect(behaviourLevel(held, 12)).toBe(1)
    expect(behaviourLevel(calming, 9)).toBe(1)                                            // rewound to before the calm: on, not over 1
  })
})

describe('a living mark is owned from construction (brand/LiveOmega initOwned)', () => {
  it('setup that rejects disposes the mark (no leaked WebGL context)', async () => {
    const { initOwned } = await import('./LiveOmega')
    let disposed = 0
    const ok = await initOwned({ init: () => Promise.reject(new Error('no texture')), dispose: () => { disposed++ } }, 'cosmos')
    expect(ok).toBe(false); expect(disposed).toBe(1)
  })
  it('setup that never finishes is timed out and disposed', async () => {
    const { initOwned } = await import('./LiveOmega')
    let disposed = 0
    const ok = await initOwned({ init: () => new Promise(() => {}), dispose: () => { disposed++ } }, 'cosmos', 20)
    expect(ok).toBe(false); expect(disposed).toBe(1)
  })
  it('setup that succeeds keeps the mark', async () => {
    const { initOwned } = await import('./LiveOmega')
    let disposed = 0
    expect(await initOwned({ init: async () => {}, dispose: () => { disposed++ } }, 'cosmos')).toBe(true); expect(disposed).toBe(0)
  })
})
