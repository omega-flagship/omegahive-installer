import { describe, expect, it } from 'vitest'
import type { WorkGraph } from '../../api/types'
import { omegaDesign, sha256HexSync } from '../../api/sim/omegadesign'
import {
  addBlock,
  addImage,
  addText,
  canonical,
  canRedo,
  canUndo,
  commitRevision,
  contrast,
  current,
  describeElement,
  digest,
  inkFor,
  isDirty,
  layer,
  moveTo,
  nextRevision,
  openDoc,
  paletteOf,
  readSource,
  recolour,
  redo,
  resizeStep,
  resizeTo,
  retext,
  saveParams,
  savedReference,
  sceneProblem,
  sourceFocus,
  toggleWeight,
  undo,
  type Scene,
  type StudioSource,
} from './model'
import { pictureName, sceneSvg, wrapText } from './render'
import { apply as nativeApply, initial } from './native/scene.mjs'

/** A scene after native changes (Design's own `apply`, through the canvas's plain words). */
async function applyChanges(scene: Scene, changes: Parameters<typeof nextRevision>[1]): Promise<Scene> {
  const root = await initial(scene)
  try {
    return (await nativeApply(root, root.digest, changes)).scene as Scene
  } catch (e) {
    const { plain } = await import('./model')
    throw new Error(plain(e), { cause: e })
  }
}

// INVENTED designs only: the sim's stand-in for Design (api/sim/omegadesign.ts). Nothing here reaches a hive.

function loaded() {
  const p = omegaDesign()
  const starter = (p.view({} as never, `studio-source:${JSON.stringify({ artifact_id: 'ar_simstarter', revision: 1, digest: 'sha256:' + 'a'.repeat(64) })}`, 'unfold') as unknown) as WorkGraph
  const got = readSource({ ...starter, links: [], groups: [], notes: [] })
  if (got.kind !== 'studio') throw new Error(`not readable: ${JSON.stringify(got)}`)
  return got
}

describe('reading Design’s view', () => {
  it('reads an editable studio source and its exact reference from the item data', () => {
    const got = loaded()
    expect(got.source.schema).toBe('omega-studio-source-1')
    expect(got.reference.artifact_id).toBe('ar_simstarter')
    expect(current(openDoc(got.source, got.reference)).scene.title).toBe('Lantern walk by the river')
  })
  it('names a deck, a missing source, a missing reference and an invalid scene in one sentence each', () => {
    const item = (data: unknown) => ({ revision: 'r', items: [{ id: 'editable-source', kind: 'status', label: 'x', data }], links: [], groups: [], notes: [] }) as unknown as WorkGraph
    expect(readSource(item({ source: { schema: 'omega-scene-deck-1' }, reference: null })).kind).toBe('deck')
    expect(readSource({ revision: 'r', items: [], links: [], groups: [], notes: [] })).toEqual({ kind: 'unreadable', why: 'Design did not return an editable source for this work.' })
    const s = loaded().source
    expect(readSource(item({ source: s, reference: { artifact_id: 'a', revision: 1, digest: 'sha1:x' } }))).toMatchObject({ kind: 'unreadable', why: expect.stringMatching(/exact reference/) })
    const broken = structuredClone(s)
    broken.current.scene.elements[0].x = 5000
    expect(readSource(item({ source: broken, reference: { ...loaded().reference } }))).toMatchObject({ kind: 'unreadable', why: 'An element reaches outside the artboard.' })
  })
  it('asks Design for exactly one source revision', () => {
    expect(sourceFocus({ artifact_id: 'ar_1', revision: 2, digest: 'sha256:' + 'b'.repeat(64) })).toBe(`studio-source:{"artifact_id":"ar_1","revision":2,"digest":"sha256:${'b'.repeat(64)}"}`)
  })
})

describe('Design’s canonical digest', () => {
  it('sorts keys at every depth and matches an independent SHA-256 of the same text', async () => {
    const v = { b: [3, { z: 1, a: 'é' }], a: null }
    expect(canonical(v)).toBe('{"a":null,"b":[3,{"a":"é","z":1}]}')
    expect(await digest(v)).toBe(`sha256:${sha256HexSync(canonical(v))}`)
    expect(sha256HexSync('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('every revision of the invented designs carries the digest of its own scene (as Design’s inspection requires)', async () => {
    const s = loaded().source
    for (const r of s.history) expect(await digest(r.scene)).toBe(r.digest)
  })
})

describe('local edits are Design’s native changes', () => {
  const scene = (): Scene => structuredClone(loaded().source.current.scene) as Scene
  it('adds, removes, layers and sets, and refuses what Design would refuse (native apply)', async () => {
    const s = scene()
    const add = addText(s, { x: 1270, y: 710 })
    const withText = await applyChanges(s, [add])
    const el = withText.elements.at(-1)!
    expect(el.x + el.width).toBeLessThanOrEqual(s.width)   // clamped inside the artboard
    expect(el.y + el.height).toBeLessThanOrEqual(s.height)
    expect((await applyChanges(withText, [{ op: 'remove', element: el.id }])).elements).toHaveLength(s.elements.length)
    const front = await applyChanges(s, [layer(s, s.elements[0], 'front')!])
    expect(front.elements.at(-1)!.id).toBe(s.elements[0].id)
    expect(layer(s, s.elements.at(-1)!, 'front')).toBeNull()   // already in front: nothing to change
    await expect(applyChanges(s, [{ op: 'set', element: 'headline', patch: { radius: 3 } as never }])).rejects.toThrow('That change is not one the design accepts.')
    await expect(applyChanges(s, [{ op: 'set', element: 'headline', patch: { x: 1200 } }])).rejects.toThrow('An element reaches outside the artboard.')
    await expect(applyChanges(s, [{ op: 'remove', element: 'nope' }])).rejects.toThrow('That element is no longer there.')
    await expect(applyChanges(s, [add, add])).rejects.toThrow('That element already exists.')
  })
  it('builds each ring control’s change, and nothing when nothing would change', () => {
    const s = scene()
    const head = s.elements.find((e) => e.id === 'headline')!
    const sun = s.elements.find((e) => e.id === 'sun')!
    expect(moveTo(s, head, -50, 99999)).toEqual({ op: 'set', element: 'headline', patch: { x: 0, y: s.height - head.height } })
    expect(moveTo(s, head, head.x, head.y)).toBeNull()
    expect(resizeStep(s, head, 1.12)).toEqual({ op: 'set', element: 'headline', patch: { fontSize: Math.round(head.fontSize! * 1.12) } })
    expect(resizeTo(s, sun, { x: sun.x, y: sun.y, width: 120, height: 200 })).toBeNull()   // its radius (100) would no longer fit
    expect(recolour(head, '#C8553D')).toEqual({ op: 'set', element: 'headline', patch: { color: '#C8553D' } })
    expect(recolour(sun, '#c8553d')).toEqual({ op: 'set', element: 'sun', patch: { fill: '#c8553d' } })
    expect(recolour(head, head.color!)).toBeNull()
    expect(recolour(head, 'red')).toBeNull()
    expect(retext(head, 'Hello')).toEqual({ op: 'set', element: 'headline', patch: { text: 'Hello' } })
    expect(retext(sun, 'x')).toBeNull()
    expect(toggleWeight(head)).toEqual({ op: 'set', element: 'headline', patch: { weight: 'normal' } })
    expect(addBlock(s, { x: 10, y: 10 }, '#C8553D')).toMatchObject({ op: 'add', value: { kind: 'rect', fill: '#C8553D' } })
    expect(() => addImage(s, { x: 0, y: 0 }, 'data:image/svg+xml;base64,AAAA', 'x')).toThrow('Only PNG or JPEG pictures can go on the design.')
    const img = addImage(s, { x: 0, y: 0 }, 'data:image/png;base64,iVBORw0KGgo=', 'seedling.png', { width: 200, height: 100 })
    expect(img).toMatchObject({ op: 'add', value: { kind: 'image', width: 400, height: 200, alt: 'seedling.png' } })
  })
  it('offers the design’s own colours, most used first, and legible ink', () => {
    const s = scene()
    const pal = paletteOf(s)
    expect(pal).toContain(s.background.toUpperCase())
    expect(new Set(pal).size).toBe(pal.length)
    expect(contrast(inkFor(s.background), s.background)).toBeGreaterThan(7)
    expect(contrast(inkFor('#14213D'), '#14213D')).toBeGreaterThan(7)
    expect(describeElement(s.elements.find((e) => e.id === 'headline')!)).toBe('Text “Bring a lantern. Walk the river with us.”')
    expect(describeElement({ ...s.elements[0], kind: 'image', alt: 'a seedling' })).toBe('Picture: a seedling (origin not verified)')
    expect(describeElement(s.elements[0])).toBe('Block')
  })
})

describe('revisions, undo and the save that leaves the canvas', () => {
  it('commits one native revision per edit with Design’s parent rule; undo never goes behind the opened revision', async () => {
    const { source, reference } = loaded()
    let d = openDoc(source, reference)
    expect(isDirty(d)).toBe(false)
    expect(canUndo(d)).toBe(false)
    const before = current(d)
    const rev = await nextRevision(d, [{ op: 'set', element: 'headline', patch: { fontSize: 80 } }])
    expect(rev.revision).toBe(before.revision + 1)
    expect(rev.parent).toEqual({ scene_id: before.scene.id, revision: before.revision, digest: before.digest })
    expect(rev.digest).toBe(await digest(rev.scene))
    d = commitRevision(d, rev)
    expect(isDirty(d)).toBe(true)
    d = undo(d)
    expect(isDirty(d)).toBe(false)
    expect(undo(d)).toBe(d)
    expect(canRedo(d)).toBe(true)
    d = redo(d)
    // a new edit after an undo drops the redo branch, never the opened revision
    d = undo(d)
    d = commitRevision(d, await nextRevision(d, [{ op: 'set', element: 'headline', patch: { fontSize: 70 } }]))
    expect(d.history.some((r) => r.digest === source.current.digest)).toBe(true)
    expect(d.history).toHaveLength(source.history.length + 1)
  })
  it('sends save-source exactly one editable source and the exact reference it was opened from', async () => {
    const { source, reference } = loaded()
    let d = openDoc(source, reference)
    d = commitRevision(d, await nextRevision(d, [{ op: 'set', element: 'sun', patch: { fill: '#C8553D' } }]))
    const p = saveParams(d)
    expect(Object.keys(p).sort()).toEqual(['editable_source_json', 'source'])   // Design's source-save wire: exact JSON text
    expect(p.source).toEqual(reference)
    const sent = JSON.parse(p.editable_source_json) as StudioSource
    expect(sent.current.revision).toBe(source.current.revision + 1)
    expect(sent.history.map((r) => r.digest)).toContain(source.current.digest)
    expect(sent.project).toEqual(source.project)   // brief and directions travel unchanged
    expect((source as StudioSource).current.scene.elements.find((e) => e.id === 'sun')!.fill).toBe('#E9A23B')   // the loaded source is never edited in place
    expect(savedReference({ status: 'done', data: { output: { artifact_id: 'ar_x', revision: 2, digest: 'sha256:' + 'c'.repeat(64) } } })).toEqual({ artifact_id: 'ar_x', revision: 2, digest: 'sha256:' + 'c'.repeat(64) })
    expect(savedReference({ status: 'done', data: { output: { artifact_id: 'ar_x', revision: 0, digest: 'x' } } })).toBeNull()
  })
})

describe('drawing: Design’s own wrapping and SVG', () => {
  it('wraps conservatively, keeps explicit breaks, and reports overflow', () => {
    expect(wrapText({ text: 'one two three four', fontSize: 10, width: 60, height: 100 }).lines).toEqual(['one two', 'three', 'four'])
    expect(wrapText({ text: 'a\nb', fontSize: 10, width: 500, height: 5 })).toEqual({ lines: ['a', 'b'], overflow: true })
  })
  it('exports a standalone SVG with every text escaped, and refuses an invalid scene', () => {
    const s = structuredClone(loaded().source.current.scene) as Scene
    s.elements[1].text = '<b>&"x"</b>'
    s.title = 'Lantern <walk>'
    const svg = sceneSvg(s)
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"')).toBe(true)
    expect(svg).toContain('&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;')
    expect(svg).toContain('<title>Lantern &lt;walk&gt;</title>')
    expect(svg).not.toContain('<b>')
    expect(pictureName(s)).toBe('lantern-walk.svg')
    expect(() => sceneSvg({ ...s, width: 50 })).toThrow()
    expect(sceneProblem({ ...s, background: 'red' })).toMatch(/background/)
  })
})
