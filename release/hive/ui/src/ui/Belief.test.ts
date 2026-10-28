import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RAW_NOTATION } from '../lib/beliefSentence'
import { AsWritten, BeliefSentence, PlainText, Sureness } from './Belief'
import { BeliefRow } from '../experiences/cosmos/Panels'
import { ThreadLog } from '../features/ask/Thread'
import type { Belief } from '../api/types'
import type { AskRow } from '../store/ask'

// node's file system, the repo's way (no Node types in the app's tsconfig): a dynamic import, typed locally
interface Dirent { name: string; isDirectory(): boolean }
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as {
  readdirSync: (p: string, o: { withFileTypes: true }) => Dirent[]
  readFileSync: (p: string, e: 'utf8') => string
}

/**
 * uifix-r3 (UI review 2026-10-12 S3, a11y-07): what people see of a belief. Rendered: the sentence and the sureness word
 * show, the notation and the bare numbers do not, and "Show as written" is there, closed. Standing guard: no component
 * renders a belief statement, a bare "f … c …" or the old notation renderers directly.
 */

/** The visible text of server markup: tags dropped, entities decoded; attributes (titles, aria) are not visible text. */
const visible = (html: string) =>
  html
    // a closed "Show as written" is in the markup, hidden (uifix-r3.1): hidden is not visible
    .replace(/<code[^>]*\bhidden=""[^>]*>[\s\S]*?<\/code>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
/** The screen-reader-only spans hold the numbers on purpose; what is drawn on screen is everything else. */
const drawn = (html: string) => visible(html.replace(/<span class="sr-only">[^<]*<\/span>/g, ''))

const vega: Belief = { swarm_id: 's_lyra', statement: '(--> vega star)', tv: { f: 0.58, c: 0.47 }, sources: ['a', 'b'], stamp: [], updated_at: '2026-10-12T00:00:00Z' } as unknown as Belief

describe('a belief, rendered', () => {
  it('BeliefSentence: the sentence and how sure, the notation closed behind "Show as written"', () => {
    const html = renderToStaticMarkup(createElement(BeliefSentence, { statement: vega.statement, tv: vega.tv }))
    expect(drawn(html)).toBe('Vega is a star. · tentative Show as written')
    expect(visible(html)).not.toMatch(RAW_NOTATION)
    expect(html).toContain('aria-expanded="false"')
    // the notation is only inside the closed, hidden disclosure
    expect(html.replace(/<code[^>]*\bhidden=""[^>]*>[\s\S]*?<\/code>/g, '')).not.toContain('<code')
    // the numbers are one step away: on hover and for screen readers, labelled in words
    expect(html).toContain('title="likelihood 0.58, confidence 0.47"')
    expect(html).toContain('<span class="sr-only"> (likelihood 0.58, confidence 0.47)</span>')
  })
  it('BeliefSentence with the adverb in the sentence, and with the disclosure left to the caller', () => {
    expect(drawn(renderToStaticMarkup(createElement(BeliefSentence, { statement: vega.statement, tv: { f: 0.95, c: 0.9 }, adverb: true, written: false })))).toBe('Vega is almost certainly a star.')
  })
  it('Sureness: a word, never bare numbers on screen', () => {
    const html = renderToStaticMarkup(createElement(Sureness, { tv: { f: 0.2, c: 0.9 } }))
    expect(drawn(html)).toBe('doubts it')
  })
  it('AsWritten: a closed button that names what it reveals', () => {
    const html = renderToStaticMarkup(createElement(AsWritten, { text: '(--> vega star)' }))
    expect(drawn(html)).toBe('Show as written')
    expect(visible(html)).not.toContain('(--> vega star)')
  })
  it('AsWritten: aria-controls always names an element; closed, the written form is hidden, not unmounted (uifix-r3.1)', () => {
    const html = renderToStaticMarkup(createElement(AsWritten, { text: '(--> vega star)' }))
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1]
    expect(controls).toBeTruthy()
    const code = html.match(new RegExp(`<code id="${controls}"[^>]*>([^<]*)</code>`))
    expect(code, 'the controlled element is in the DOM').not.toBeNull()
    expect(code![0]).toMatch(/\bhidden=""/)
    expect(code![0]).not.toMatch(/class="[^"]*\bblock\b/)
    expect(code![1]).toBe('(--&gt; vega star)')
  })
  it('PlainText: a message with notation reads as words, and offers the exact message', () => {
    const html = renderToStaticMarkup(createElement(PlainText, { text: 'I revised (--> rr-lyrae variable) to f 0.89, c 0.71' }))
    expect(drawn(html)).toBe('I revised “‘rr-lyrae’ is variable” to “confident” Show as written')
    const plain = renderToStaticMarkup(createElement(PlainText, { text: 'Nothing to translate.' }))
    expect(drawn(plain)).toBe('Nothing to translate.')
  })
  it('Cosmos belief row: sentence, sureness, source count; no F/C letters or numbers drawn', () => {
    const html = renderToStaticMarkup(createElement(BeliefRow, { b: vega }))
    const text = drawn(html)
    expect(text).toContain('Vega is a star.')
    expect(text).toContain('tentative · 2 sources')
    expect(text).not.toMatch(RAW_NOTATION)
    expect(text).not.toMatch(/\bf 0\.|\bc 0\./)
  })
  it('the Ask: an answer with notation in it reads as words, the exact answer as written', () => {
    const row = { id: 'r1', kind: 'answer', text: 'Strongest: (--> vega star) ⟨f 0.95, c 0.90⟩.\n\nThe commons has it at f 0.58, c 0.47.', who: 'Vega' } as AskRow
    const html = renderToStaticMarkup(createElement(ThreadLog, { rows: [row], variant: 'glass' }))
    const text = drawn(html)
    expect(text).toContain('Strongest: “Vega is a star” (near certain).')
    expect(text).toContain('The commons has it at “tentative”.')
    expect(text).toContain('Show as written')
    expect(text).not.toMatch(RAW_NOTATION)
    const plain = renderToStaticMarkup(createElement(ThreadLog, { rows: [{ ...row, text: 'Kelp is recovering.' }], variant: 'glass' }))
    expect(drawn(plain)).not.toContain('Show as written')
  })
})

// ------------------------------------------------------------------ the standing guard, over the source

const SRC = new URL('..', import.meta.url).pathname
const files: string[] = []
const walk = (dir: string) => {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}${d.name}`
    if (d.isDirectory()) walk(`${p}/`)
    else if (/\.tsx$/.test(d.name) && !/\.test\./.test(d.name)) files.push(p)
  }
}
walk(SRC)

/** What would put notation in front of people: a statement as JSX text or a title, bare f/c numbers, the old renderers. */
const RAW: [string, RegExp][] = [
  ['a statement as JSX text', />\s*\{[\w.?]*\.statement\}|(?<!\$)\{[\w.?]+\.statement \?\? /],
  ['a statement as a hover title', /title=\{[\w.?]*\.statement\}/],
  ['bare f and c numbers', /\bf \{[^}]*\.f\.toFixed|>\s*f\s*<|\bc \{[^}]*\.c\.toFixed/],
  ['the old free-text notation renderer', /\bRichText\b/],
  ['a belief statement through the notation renderer', /<MeTTa src=\{[\w.?]*statement\}/],
]
/** Exact file:line, the line's text, and why it is not a belief shown to people. */
const ALLOW: { at: string; has: string; why: string }[] = [
  { at: 'features/keys/AskMemorySection.tsx:76', has: '{b.statement}', why: 'the Ask\'s own memories: sentences the person wrote, not notation' },
]

describe('standing guard: no belief reaches the screen as notation (uifix-r3)', () => {
  const hits = () => {
    const out: { at: string; rule: string; text: string }[] = []
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      lines.forEach((l, i) => {
        for (const [rule, re] of RAW) if (re.test(l)) out.push({ at: `${f.slice(SRC.length)}:${i + 1}`, rule, text: l.trim().slice(0, 100) })
      })
    }
    return out
  }
  it('scans the whole tree', () => {
    expect(files.length).toBeGreaterThan(200)
  })
  it('nothing outside the allowlist', () => {
    const allowed = new Set(ALLOW.map((a) => a.at))
    expect(hits().filter((h) => !allowed.has(h.at)), 'say it with lib/beliefSentence or ui/Belief, or allow it here with a reason').toEqual([])
  })
  it('every allowance is current and has a reason', () => {
    const found = new Map(hits().map((h) => [h.at, h.text]))
    for (const a of ALLOW) {
      expect(found.get(a.at)?.includes(a.has), `stale: ${a.at}`).toBe(true)
      expect(a.why.length).toBeGreaterThan(10)
    }
  })
})

// uifix-r3.3 (Kimi, r3.2) and uifix-r3.4 (Kimi 3 on r3.3, Platform): colour, meters and words that say how sure a
// belief is use the one shared NAL expectation (lib/color surenessColor / surenessRgb, lib/beliefSentence expectation
// and truthWords), never likelihood (f) alone or confidence (c) alone. The constellation is no exception any more.
const read = (rel: string) => fs.readFileSync(`${SRC}${rel}`, 'utf8')
describe('sureness colour follows the sureness word (uifix-r3.3, r3.4)', () => {
  it('the swarm belief table dot is coloured by the sureness decision', () => {
    const src = read('features/swarm/SwarmView.tsx')
    expect(src).toContain('style={{ background: surenessColor(b.tv) }}')
    expect(src).not.toMatch(/freqColor\(/)
  })
  it('the constellation: core and glow coloured by expectation, the legend says colour is how sure', () => {
    const src = read('features/swarm/Constellation.tsx')
    expect(src).toContain('const color = surenessColor(s.b.tv)')
    expect(src).toContain('const glow = surenessBucket(s.b.tv)')
    expect(src).toContain('fill={`url(#sg-${glow})`}')
    expect(src).not.toMatch(/tv\.f\b/)
  })
  it('the constellation legend, rendered: colour is how sure (doubts it … near certain), brightness is evidence', async () => {
    const { ConstellationLegend } = await import('../features/swarm/Constellation')
    const text = visible(renderToStaticMarkup(createElement(ConstellationLegend, {})))
    expect(text).toContain('Colour: how sure')
    expect(text).toMatch(/doubts it\s+near certain/)
    expect(text).toContain('Brightness: how much evidence')
    expect(text).not.toMatch(/Likelihood|Confidence/)
  })
  it('Flux: both lists draw the bar beside the sureness word with the shared SurenessMeter (r3.6)', () => {
    expect(read('experiences/flux/panels.tsx')).toContain('<SurenessMeter tv={b.tv} />')
    // r3.7: the meters have no time dimension (the r3.6 width spring could read 80% beside "tentative")
    for (const f of ['experiences/flux/SurenessMeter.tsx', 'experiences/still/StillMeter.tsx']) expect(read(f)).not.toMatch(/framer-motion|transition|animate|requestAnimationFrame|setTimeout/)
    expect(read('experiences/flux/sheets.tsx')).toContain('<SurenessMeter tv={b.tv} />')
    for (const f of ['experiences/flux/panels.tsx', 'experiences/flux/sheets.tsx']) expect(read(f)).not.toContain('linear-gradient(90deg, #ff6fa8')
  })
  it('Still: the meter beside the sureness word is expectation, and the held list sorts by it', () => {
    for (const f of ['experiences/still/Sheets.tsx', 'experiences/still/Learned.tsx']) expect(read(f)).toContain('<StillMeter tv={b.tv} />')
    expect(read('experiences/still/Sheets.tsx')).toContain('.sort((a, b) => compareSureness(b.tv, a.tv))')
  })
  it('Cosmos: the scene colours a belief by expectation; the panel bars are named likelihood and confidence', () => {
    expect(read('experiences/cosmos/Scene.tsx')).toContain('const rgb = clumpColour(b.tv)')
    const p = read('experiences/cosmos/Panels.tsx')
    expect(p).toContain('<span>LIKELIHOOD</span>')
    expect(p).toContain('<span>CONFIDENCE</span>')
    expect(p).toContain('<Bar value={b.tv.f} hue={212} label="likelihood" />')
  })
  it('Canvas: the two bars are named likelihood and confidence', () => {
    const p = read('experiences/canvas/HivePanel.tsx')
    expect(p).toMatch(/<span>likelihood<\/span>\s*<Bar value=\{b\.tv\.f\} \/>\s*<span>confidence<\/span>/)
  })
  it('Programs: the result glyph is coloured by the expectation of value and confidence', () => {
    expect(read('features/programs/parts.tsx')).toContain('const col = surenessColor({ f: Math.min(1, Math.max(0, value)), c: Math.min(1, Math.max(0, conf)) })')
  })
  it('the map scene: belief motes and assertions in flight are coloured by expectation', () => {
    const src = read('scene/engine.ts')
    expect(src).toContain('const [r, g, b] = surenessRgb({ f: m.f, c: m.c })')
    expect(src).toContain('const [r, g, b] = surenessRgb({ f: p.f, c: p.c })')
    expect(src).toContain('          c: a.tv.c,')
    // r3.6: the adopt sparks are the swarm's identity colour (they used to be blue for any adopted belief)
    expect(src).toContain('ctx.drawImage(glowSprite(e.hue, 100), x - S, y - S, S * 2, S * 2)')
    expect(src).toContain("this.coreEffect(p.swarmId, p.outcome ?? 'revised', p.hue, p.f !== undefined && p.c !== undefined ? surenessOf({ f: p.f, c: p.c }).tone : null)")
  })
  it('belief lists shown beside their sureness word order by the one sureness order (r3.6), never c alone', () => {
    expect(read('experiences/flux/sheets.tsx')).toContain('out.sort((a, b) => compareSureness(b.b.tv, a.b.tv))')
    expect(read('experiences/cosmos/Deck.tsx')).toContain('out.sort((a, b) => compareSureness(b.b.tv, a.b.tv))')
    expect(read('experiences/cosmos/Panels.tsx').match(/sort\(\(a, b\) => compareSureness\(b\.tv, a\.tv\)/g)?.length).toBe(2)
    expect(read('experiences/canvas/HivePanel.tsx')).toContain('sort((a, b) => compareSureness(b.tv, a.tv) || b.updated_at')
    expect(read('features/swarm/SwarmView.tsx')).toContain("sort.k === 'sure' ? compareSureness(a.tv, b.tv)")
    expect(read('experiences/construct/model.ts')).toContain('compareSureness(b.tv, a.tv)')
    expect(read('forms/commons/model.ts')).toContain('compareSureness(b.truth, a.truth)')
  })
  it('the Ask memory says how sure with the shared words', () => {
    expect(read('features/keys/AskMemorySection.tsx')).toContain('{truthWords({ f: b.truth.frequency, c: b.truth.confidence })}')
  })
  it('surenessColor is the sureness decision on the diverging scale: neutral whenever the word is tentative (r3.5)', async () => {
    const { freqColor, surenessColor, surenessRgb, freqRgb } = await import('../lib/color')
    expect(surenessColor({ f: 0, c: 0 })).toBe(freqColor(0.5)) // no evidence reads neutral, never red
    // uifix-r3.5 (stand-in P1 on r3.4): below the floor nothing is directional (r3.4 pinned freqColor(0.46) here)
    expect(surenessColor({ f: 0.1, c: 0.1 })).toBe(freqColor(0.5))
    expect(surenessColor({ f: 0, c: 0.29 })).toBe(freqColor(0.5))
    expect(surenessColor({ f: 1, c: 0.29 })).toBe(freqColor(0.5))
    expect(surenessColor({ f: 0.1, c: 0.9 })).toBe(freqColor(0.14))
    expect(surenessRgb({ f: 1, c: 1 })).toEqual(freqRgb(1))
  })
})

// The standing sweep (uifix-r3.4): every .ts and .tsx outside tests. A hit is colour or wording that says how sure from
// f alone or c alone. Labelled number displays (a "Likelihood" bar beside a "Confidence" bar, the numbers in text) are
// not sureness and do not match.
const allFiles: string[] = []
const walkAll = (dir: string) => {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}${d.name}`
    if (d.isDirectory()) walkAll(`${p}/`)
    else if (/\.tsx?$/.test(d.name) && !/\.test\./.test(d.name)) allFiles.push(p)
  }
}
walkAll(SRC)
const SURENESS_FROM_ONE: [string, RegExp][] = [
  ['colour from likelihood alone', /(freqColor|freqRgb|[hH]ue)\([^)]*\.f\b|truthHue|url\(#sg-\$\{[^}]*\.f\b/],
  ['a bar beside the sureness word from likelihood alone', /`\$\{[\w.]*\.tv\.f \* 100\}%`/],
  ['a meter from confidence alone', /scale[XY]?\(\$\{[^}]*\.tv\.c\b/],
  ['a sureness order from c·f', /\.c \* [\w.]+\.f\b|\.f \* [\w.]+\.c\b/],
  ['sureness words from c or f alone', /\b(sureWords|trueWords)\b/],
  ['a number named "sure" or "true"', /<span>(sure|SURE|true|LIKELY)<\/span>/],
  ['sureness carried in a hue (r3.6: an explicit tone field instead)', /freqRgb\(-1|-1 - (sure|tone|e)\b|e\.hue < 0/],
  ['a fixed directional gradient on a sureness meter (r3.6)', /linear-gradient\(90deg, #ff6fa8/],
  ['a certainty visual from raw expectation (r3.5: use surenessColor / surenessMeter / surenessBucket)', /(freqColor|freqRgb)\(expectation\(|expectation\([^)]*\)\s*\*|\*\s*expectation\(|scale[XY]?\(\$\{[^}]*expectation\(/],
]
describe('standing sweep: how sure is never said by f alone or c alone (uifix-r3.4)', () => {
  it('scans every source file', () => {
    expect(allFiles.length).toBeGreaterThan(400)
  })
  it('no hits', () => {
    const out: string[] = []
    for (const f of allFiles) {
      // the sureness decision itself (surenessOf) is the one place that reads expectation to decide
      if (f.endsWith('lib/beliefSentence.ts')) continue
      fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
        for (const [rule, re] of SURENESS_FROM_ONE) if (re.test(l)) out.push(`${f.slice(SRC.length)}:${i + 1} ${rule}: ${l.trim().slice(0, 90)}`)
      })
    }
    expect(out, 'say how sure with surenessColor / expectation / truthWords').toEqual([])
  })
})
