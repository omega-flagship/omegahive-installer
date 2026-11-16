// The layers of "how" (Surface demo D4): the viewer is generic (a trace in, eight layers out), says "Synthetic trace"
// for demo traces and "Not available yet" for a layer a trace does not carry; the Reasoning layer shows the rule, the
// typeset formula, the numbers plugged in and the conclusion; every Code reference points at real code (anchored by its excerpt).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LayerStack } from './LayerStack'
import { layerBody } from './layerBody'
import { changes } from './atomChanges'
import { PLAYLIST } from './scenes'
import { LAYERS, type Trace } from './types'

// The sources a Code reference may point at, read at build time (vite), keyed by their repo path (hive/core/app.py, …).
const HERE = 'file:///repo/hive/ui/src/features/showreel/'
const SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>(['../../../../core/*.py', '../../**/*.{ts,tsx}', '!../../**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }),
  ).map(([k, v]) => [new URL(k, HERE).pathname.slice('/repo/'.length), v]),
)

const ROOM = PLAYLIST.find((p) => p.scene.id === 'showreel-team-room' && p.i === 1)!
const html = (t: Trace, at: (typeof LAYERS)[number]) =>
  renderToStaticMarkup(createElement(LayerStack, { trace: t, title: 'A step', at, deepest: 0, onAt: () => undefined, onDeeper: () => undefined, onBackUp: () => undefined, onClose: () => undefined }))
const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

describe('the layer viewer', () => {
  it('a breadcrumb of all eight layers, the current one marked, and a synthetic trace said as such', () => {
    const t = ROOM.step.trace
    const h = html(t, 'hive')
    for (const name of ['Screen', 'Code', 'Hive', 'Mind (MeTTa)', 'AtomSpace', 'Reasoning', 'Memory', 'Files']) expect(text(h)).toContain(name)
    expect(h).toMatch(/aria-current="step"[^>]*>Hive</)
    expect(text(h)).toContain('Synthetic trace')
    expect(text(h)).toContain('Deeper: Mind (MeTTa)')
    expect(text(h)).toContain('Back up and carry on')
  })
  it('a layer the trace does not carry says so, and invents nothing (a live trace with nothing read yet)', () => {
    const live: Trace = { source: 'live' }
    for (const k of LAYERS) {
      const t = text(html(live, k))
      expect([k, t.includes('Not available yet.')]).toEqual([k, true])
      expect(t).not.toContain('Synthetic trace')
    }
  })
  it('every layer of every step renders', () => {
    for (const { scene, i, step } of PLAYLIST) for (const k of LAYERS) expect([`${scene.id}#${i}`, k, text(renderToStaticMarkup(createElement('div', null, layerBody(k, step.trace)))).length > 10]).toEqual([`${scene.id}#${i}`, k, true])
  })
  it('the AtomSpace layer marks what the step wrote', () => {
    const t = ROOM.step.trace.atomspace!
    expect(changes(t.before, t.after)).toMatchObject({ p: 'same', q: 'changed', pq: 'same' })
    expect(text(html(ROOM.step.trace, 'atomspace'))).toContain('changed observe-binaries-early')
  })
})

describe('the Reasoning layer shows the maths', () => {
  it('rule, source line, formula, the same formula with numbers, and the conclusion (stv f c) with its evidence', () => {
    const t = text(html(ROOM.step.trace, 'reasoning'))
    expect(t).toContain('Modus Ponens (PLN)')
    expect(t).toContain('Truth__ModusPonens · lib_pln.metta:105')
    expect(t).toContain('The formula (lib_pln.metta:105)')
    expect(t).toContain('With the numbers')
    // plugged in: 0.9 · 0.8 + 0.02 · (1 − 0.9)
    expect(t).toMatch(/0\.9 · 0\.8 \+ 0\.02 · \( 1 − 0\.9 \)/)
    expect(t).toMatch(/Conclusion observe-binaries-early \(stv 0\.722 0\.5832\) ≈ w = 1\.3992/)
    expect(t).toContain('w = c / (1 − c)')
  })
  it('a revision names the 0.99 (lib_nal) and 1.0 (lib_pln) caps, and shows both on inputs where they differ', () => {
    const lab = PLAYLIST.find((p) => p.scene.id === 'showreel-lab' && p.i === 0)!
    const t = text(html(lab.step.trace, 'reasoning'))
    expect(t).toContain('lib_pln’s Truth__Revision caps the confidence at 1.0, lib_nal’s Truth_Revision at 0.99')
    expect(t).toMatch(/lib_pln Truth__Revision \(lib_pln\.metta:117\) gives \(stv 0\.8678 0\.9916\)/)
    expect(t).toMatch(/lib_nal Truth_Revision \(lib_nal\.metta:92\) gives \(stv 0\.8678 0\.99\)/)
    // the chain: step 2's premise is step 1's conclusion
    expect(t).toContain('the conclusion of step 1')
  })
})

describe('the Code layer points at real code', () => {
  // A reference is anchored by its excerpt, not by its line number: ordinary edits above it move the line, and that
  // must not fail CI. The test fails only when an excerpt is no longer in its file (the reference is truly broken).
  // A line hint that has drifted is reported with the fix: `node scripts/showreel-lines.mjs --write` re-derives it.
  it('each reference’s excerpt is in that file in this tree', () => {
    const missing: string[] = []
    const drifted: string[] = []
    for (const { scene, i, step } of PLAYLIST) {
      for (const c of step.trace.code ?? []) {
        const src = SOURCES[c.file]
        if (src === undefined) {
          missing.push(`${scene.id}#${i} ${c.file} (${c.symbol}): file not in this tree (or outside the sources this test reads)`)
          continue
        }
        const at = src.split('\n').flatMap((l, n) => (l.includes(c.excerpt) ? [n + 1] : []))
        if (!at.length) missing.push(`${scene.id}#${i} ${c.file} (${c.symbol}): excerpt not in the file`)
        else if (!at.includes(c.line)) drifted.push(`${scene.id}#${i} ${c.file}:${c.line} (${c.symbol}) → now line ${at.join(', ')}`)
      }
    }
    if (drifted.length) console.warn(`showreel line hints drifted (run node scripts/showreel-lines.mjs --write):\n${drifted.join('\n')}`)
    expect(missing).toEqual([])
  })
})
