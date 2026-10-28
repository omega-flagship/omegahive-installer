import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { omegaDesign } from '../../api/sim/omegadesign'
import type { WorkGraph } from '../../api/types'
import { Deliver } from './Chrome'
import { addBlock, addImage, addText, commitRevision, current, describeElement, layer, nextRevision, openDoc, readSource, saveParams, sourceForSave, type Doc, type StudioSource } from './model'
import { liveEdits } from './native/live-edits.mjs'
import { createProject } from './native/project.mjs'
import { canonical, initial } from './native/scene.mjs'
import { verifySource } from './native/source.mjs'
import type { CanvasState } from './useCanvas'
import { DELIVER_NOTE, PICTURE_ACTION } from './words'

// Design's owner disposition (2026-10-06): the canvas reuses Design's pinned native primitives and every source it
// offers passes Design's own verifier. The native modules are Design 0.4.4-sharing's `tools/` files, vendored byte-exact
// into ./native (PIN.json); these tests run Design's actual `verifySource`, as Design's repro
// (omegadesign/poc/surface_model_trace_audit/reproduce.mjs) does. INVENTED scenes only.

const here = (f: string) => new URL(f, import.meta.url)
// node:fs through a variable, as the other form tests does (the app's tsconfig has no node types)
const fsName = 'node:fs'
type Fs = { readFileSync: (p: string | URL, e?: string) => string & Uint8Array; existsSync: (p: string | URL) => boolean }
const fs = (await import(/* @vite-ignore */ fsName)) as Fs
const readFileSync = fs.readFileSync
const existsSync = fs.existsSync
const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource))].map((b) => b.toString(16).padStart(2, '0')).join('')

describe('the vendored native modules are exactly Design’s pinned release', () => {
  it('every file matches PIN.json and, where the release is on this machine, its bundle.lock.json', async () => {
    const pin = JSON.parse(readFileSync(here('./native/PIN.json'), 'utf8')) as { files: Record<string, string> }
    const at = here('.').pathname
    const lockPath = at.includes('/.runtime/') ? `${at.slice(0, at.indexOf('/.runtime/'))}/.runtime/omegadesign-release/0.4.4-sharing/tools/bundle.lock.json` : ''
    const lock = lockPath && existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, 'utf8')) as { files: Record<string, string> }).files : null
    expect(Object.keys(pin.files).sort()).toEqual(['brief-change.mjs', 'live-edits.mjs', 'maker-trace.mjs', 'project.mjs', 'scene.mjs', 'source.mjs'])
    for (const [f, sha] of Object.entries(pin.files)) {
      expect(await sha256(readFileSync(here(`./native/${f}`)))).toBe(sha)
      if (lock) expect(lock[f]).toBe(sha)
    }
  })
})

/** A native source with an active revision and a retained redo, both with genuine native maker-trace receipts. */
async function tracedRedoSource(): Promise<StudioSource> {
  const scene = { schema: 'omega-scene-1', id: 'surface-trace-test', title: 'Invented native trace', width: 800, height: 600, background: '#ffffff', criteria: ['Preserve person work and retained trace'], elements: [{ id: 'headline', kind: 'text', x: 30, y: 30, width: 700, height: 120, text: 'Original source', fontSize: 32, color: '#123456', weight: 'normal' }] }
  const root = await initial(scene)
  const project = await createProject({ id: 'surface-trace-brief', purpose: 'Preserve trace when branching', audience: 'Synthetic local reviewer', criteria: scene.criteria })
  const maker = liveEdits({ streamId: 'synthetic-prior', sceneId: scene.id })
  const first = { stream_id: 'synthetic-prior', scene_id: scene.id, sequence: 1, changes: [{ op: 'set', element: 'headline', before: { text: 'Original source' }, patch: { text: 'Active source' } }] }
  const active = await maker.receive(root, first)
  const second = { stream_id: 'synthetic-prior', scene_id: scene.id, sequence: 2, changes: [{ op: 'set', element: 'headline', before: { text: 'Active source' }, patch: { text: 'Retained redo source' } }] }
  const redo = await maker.receive(active.current, second)
  const source = { schema: 'omega-studio-source-1', current: active.current, history: [root, active.current, redo.current], project, feedback: [], provenance: null, merge_sources: [], maker_trace: [{ event: first, receipt: active.receipt }, { event: second, receipt: redo.receipt }] }
  expect(await verifySource(source)).toEqual(source)   // a valid native baseline
  return source as unknown as StudioSource
}
const REF = { artifact_id: 'synthetic-trace-source', revision: 4, digest: 'sha256:' + 'c'.repeat(64) }

describe('a traced redo, branched by a local edit, is still a source Design accepts', () => {
  it('Design’s repro: the local revision discards the redo; the offered source keeps only the retained trace and verifies', async () => {
    const source = await tracedRedoSource()
    const before = JSON.stringify(source)
    const opened = openDoc(source, REF)
    const changed = commitRevision(opened, await nextRevision(opened, [{ op: 'set', element: 'headline', patch: { text: 'New local work' } }]))
    const offered = sourceForSave(changed)
    expect(offered.history).toHaveLength(3)
    expect(offered.maker_trace!).toHaveLength(1)   // the active entry; the redo's is gone with it
    expect(await verifySource(offered)).toEqual(offered)
    expect(JSON.stringify(source)).toBe(before)   // the opened source is never edited in place
    expect(changed.reference).toEqual(REF)
  })
  it('with the redo kept (a local edit after redoing), the whole trace stays and verifies', async () => {
    const source = await tracedRedoSource()
    let d: Doc = openDoc(source, REF)
    d = { ...d, cursor: 2 }   // as if redone on the canvas
    d = commitRevision(d, await nextRevision(d, [{ op: 'set', element: 'headline', patch: { text: 'After redo' } }]))
    const offered = sourceForSave(d)
    expect(offered.maker_trace!).toHaveLength(2)
    expect(await verifySource(offered)).toEqual(offered)
  })
  it('a source without a trace offers none (the key is not invented)', async () => {
    const graph = omegaDesign().view({} as never, `studio-source:${JSON.stringify({ artifact_id: 'ar_simstarter', revision: 1, digest: 'sha256:' + 'a'.repeat(64) })}`, 'unfold') as unknown as WorkGraph
    const got = readSource({ ...graph, links: [], groups: [], notes: [] })
    if (got.kind !== 'studio') throw new Error('fixture')
    const d = openDoc(got.source, got.reference)
    expect('maker_trace' in sourceForSave(d)).toBe(false)
  })
})

describe('every kind of canvas edit offers a source Design’s own verifier accepts', () => {
  it('the invented sim designs verify natively, and so does the offer after text, block, picture, layer, set and remove', async () => {
    for (const id of ['ar_simstarter', 'ar_simposter', 'ar_simtidecard']) {
      const graph = omegaDesign().view({} as never, `studio-source:${JSON.stringify({ artifact_id: id, revision: 1, digest: 'sha256:' + 'a'.repeat(64) })}`, 'unfold') as unknown as WorkGraph
      const got = readSource({ ...graph, links: [], groups: [], notes: [] })
      if (got.kind !== 'studio') throw new Error('fixture')
      expect(await verifySource(got.source)).toEqual(got.source)
      let d = openDoc(got.source, got.reference)
      const step = async (c: Parameters<typeof nextRevision>[1][number] | null) => {
        if (c) d = commitRevision(d, await nextRevision(d, [c]))
      }
      const s = () => current(d).scene
      const text = addText(s(), { x: 10, y: 10 })
      await step(text)
      await step(addBlock(s(), { x: 40, y: 40 }))
      await step(addImage(s(), { x: 0, y: 0 }, 'data:image/png;base64,iVBORw0KGgo=', 'my-photo.png'))
      await step(layer(s(), s().elements[0], 'front'))
      await step({ op: 'set', element: text.element, patch: { text: 'Changed', color: '#123456' } })
      await step({ op: 'remove', element: text.element })
      const offered = JSON.parse(saveParams(d).editable_source_json) as StudioSource
      expect(await verifySource(offered)).toEqual(offered)
      expect(canonical(offered.current)).toBe(canonical(current(d)))
    }
  })
})

describe('words: the picture is an unverified mirror; a device picture is never called generated or recovered', () => {
  it('Deliver names the SVG as an unverified mirror of Design’s drawing', async () => {
    const graph = omegaDesign().view({} as never, `studio-source:${JSON.stringify({ artifact_id: 'ar_simstarter', revision: 1, digest: 'sha256:' + 'a'.repeat(64) })}`, 'unfold') as unknown as WorkGraph
    const got = readSource({ ...graph, links: [], groups: [], notes: [] })
    if (got.kind !== 'studio') throw new Error('fixture')
    const doc = openDoc(got.source, got.reference)
    const s = { doc, scene: current(doc).scene, revision: current(doc), dirty: false, busy: null, keep: async () => undefined, download: async () => undefined } as unknown as CanvasState
    const html = renderToStaticMarkup(createElement(Deliver, { s, ask: () => undefined }))
    expect(html).toContain(PICTURE_ACTION)
    expect(PICTURE_ACTION).toMatch(/mirror/i)
    expect(PICTURE_ACTION).toMatch(/unverified/i)
    expect(html).toContain('not verified')
    expect(DELIVER_NOTE).toMatch(/not verified/i)
  })
  it('a picture from the device keeps the person’s own file name and an unknown origin', () => {
    const scene = { schema: 'omega-scene-1', id: 's', title: 't', width: 800, height: 600, background: '#ffffff', criteria: [], elements: [] }
    const c = addImage(scene, { x: 0, y: 0 }, 'data:image/png;base64,iVBORw0KGgo=', 'Holiday photo 2024.PNG')
    expect(c.op === 'add' && c.value.alt).toBe('Holiday photo 2024.PNG')
    const said = describeElement(c.op === 'add' ? c.value : (null as never))
    expect(said).toBe('Picture: Holiday photo 2024.PNG (origin not verified)')
    expect(said).not.toMatch(/generat|recover/i)
  })
  it('no word the canvas shows calls a picture generated or recovered, or the unsaved guard a recovery', () => {
    for (const f of ['words.ts', 'Chrome.tsx', 'Stage.tsx', 'DesignCanvas.tsx', 'useCanvas.ts', 'model.ts']) {
      const strings = [...readFileSync(here(`./${f}`), 'utf8').matchAll(/(['`"])((?:(?!\1).){8,})\1/g)].map((m) => m[2])
      for (const s of strings) expect(s, `${f}: ${s}`).not.toMatch(/\b(generated|recovered|recovery)\b/i)
    }
  })
})
