import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SimClient } from '../../api/sim/SimClient'
import { designStarter } from '../../api/sim/omegadesign'
import type { Program, ProgramDescription, WorkGraph } from '../../api/types'
import { finalAsResult, HostConfirmController } from '../../features/programs/HostConfirm'
import { needsConfirm, prepareConfirm } from '../../lib/hostConfirm'
import { useHive } from '../../store/store'
import { FORM_OVER_FRAME, formFor, FORMS, NATIVE_GRAMMARS } from '../contract'
import { Compare, Deliver, Drawer, Empty, ErrorState, Skeleton, TopLine } from './Chrome'
import DesignCanvas from './DesignCanvas'
import { commitRevision, current, nextRevision, openDoc, readSource, saveParams, savedReference, sourceFocus, type Doc, type StudioSource } from './model'
import { ScenePicture } from './Stage'
import type { CanvasState } from './useCanvas'
import { saveSentence, SUGGESTIONS } from './words'

// The Design living canvas against the simulator's stand-in for Design (INVENTED designs; api/sim/omegadesign.ts).
// "Mounted" here is the repo's server-render pattern (react-dom/server, as caseFile/oneDialog.test.ts): the states and
// parts are rendered as markup and checked for what a person and a screen reader get. Nothing leaves the test.

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)) }
let a: SimClient
let d: ProgramDescription
const SWARM = 's_lyra'
beforeEach(async () => {
  vi.stubGlobal('window', { location: { search: '' } })
  a = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
  await useHive.getState().init(a)
  d = (await a.program('omegadesign')).describe as ProgramDescription
})
afterEach(() => {
  a.disconnect()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function openStarter(): Promise<Doc> {
  const g = (await a.programView('omegadesign', { swarm_id: SWARM, focus: sourceFocus(designStarter()) })) as WorkGraph
  const got = readSource(g)
  if (got.kind !== 'studio') throw new Error('starter not readable')
  return openDoc(got.source, got.reference)
}
async function edited(): Promise<Doc> {
  const doc = await openStarter()
  return commitRevision(doc, await nextRevision(doc, [{ op: 'set', element: 'headline', patch: { color: '#C8553D' } }]))
}
/** The host's side of the canvas's Keep, exactly as ProgramForm does it for a person_activity action. */
async function keepThroughHost(doc: Doc, press: boolean) {
  const c = new HostConfirmController({ programId: 'omegadesign', swarmId: SWARM })
  c.attach()
  const shown: unknown[] = []
  const stop = c.subscribe(() => shown.push(c.snapshot()))
  const mint = vi.spyOn(a, 'confirmAct')
  const deliver = vi.spyOn(a.programsHost, 'act')
  const p = prepareConfirm('omegadesign', { swarm_id: SWARM, action: 'save-source', items: [], params: saveParams(doc) as unknown as Record<string, unknown>, base_revision: 'semantic-candidate-v1' }, d)
  if (!p.ok) throw new Error(p.message)
  const f = c.ask(p.intent, {})
  await flush()
  const view = c.snapshot() as { seq: number } | null
  if (press && view) await c.confirm(view.seq)
  else if (view) c.close(view.seq)
  const final = await f
  stop()
  return { final, shown: shown.filter(Boolean), mint, deliver }
}

describe('Design opens as the living canvas, over Design’s own contract', () => {
  it('omegadesign maps to the canvas form, which opens over its own frame; the frame stays one choice away', () => {
    expect(formFor('omegadesign', d)).toBe('design-canvas')
    expect(FORM_OVER_FRAME.has('omegadesign')).toBe(true)
    expect(FORMS['design-canvas']).toBeDefined()
    expect(NATIVE_GRAMMARS['design-canvas']).toEqual(['classic'])
  })
  it('keeping a version is Design’s person_activity save-source: it always takes the host’s confirm', () => {
    const save = d.actions.find((x) => x.id === 'save-source')!
    expect(save.person_activity).toBe(true)
    expect(needsConfirm(d, 'save-source')).toBe(true)
    expect(d.actions.filter((x) => x.person_activity).map((x) => x.id)).toEqual(['save-source'])
  })
})

describe('keeping a version leaves the canvas only through the host confirm', () => {
  it('the host asks once and nothing is minted or sent until the person presses Confirm; Cancel sends nothing', async () => {
    a.simSession = 'person'
    const h = await keepThroughHost(await edited(), false)
    expect(h.shown).toHaveLength(1)
    expect(h.mint).not.toHaveBeenCalled()
    expect(h.deliver).not.toHaveBeenCalled()
    const r = finalAsResult(h.final)
    expect(r).toMatchObject({ status: 'refused', message: 'You cancelled. Nothing was sent.' })
    expect(saveSentence(r)).toEqual({ text: 'Not kept. Your changes are still here.', tone: 'warn' })
  })
  it('a signed-in person’s confirmed Keep is one mint and one delivery, and returns the new exact revision', async () => {
    a.simSession = 'person'
    const doc = await edited()
    const h = await keepThroughHost(doc, true)
    expect(h.mint).toHaveBeenCalledTimes(1)
    expect(h.deliver).toHaveBeenCalledTimes(1)
    const r = finalAsResult(h.final)
    expect(r.status).toBe('done')
    const ref = savedReference(r)
    expect(ref).toMatchObject({ artifact_id: 'ar_simstarter', revision: 2 })
    // reading the kept revision back gives exactly what was kept
    const back = readSource((await a.programView('omegadesign', { swarm_id: SWARM, focus: sourceFocus(ref!) })) as WorkGraph)
    expect(back.kind).toBe('studio')
    if (back.kind === 'studio') expect(current(openDoc(back.source, back.reference)).scene.elements.find((e) => e.id === 'headline')!.color).toBe('#C8553D')
    expect(saveSentence(r).tone).toBe('ok')
  })
  it('the operator (not a named person) is refused in one sentence with a way forward', async () => {
    const h = await keepThroughHost(await edited(), true)
    const r = finalAsResult(h.final)
    expect(r.status).not.toBe('done')
    expect(h.deliver).not.toHaveBeenCalled()
    expect(saveSentence(r).text).toBe('Keeping a version needs a signed-in person. Sign in, then keep it again.')
  })
  it('Design refuses a save that drops the opened revision or the brief (the sim mirrors its rule)', async () => {
    a.simSession = 'person'
    const doc = await edited()
    const p = saveParams(doc)
    const src = JSON.parse(p.editable_source_json) as StudioSource
    const wire = (s: StudioSource) => ({ editable_source_json: JSON.stringify(s), source: p.source })
    await expect(a.programsHost.act('omegadesign', SWARM, 'save-source', [], wire({ ...src, history: src.history.slice(-1) }) as never, null, { person: true })).rejects.toThrow(/retain the loaded source revision/)
    await expect(a.programsHost.act('omegadesign', SWARM, 'save-source', [], wire({ ...src, project: { ...src.project, brief: { purpose: 'changed' } } }) as never, null, { person: true })).rejects.toThrow(/hard criteria and brief/)
    // Design's decode rule: exactly one of the object and the JSON text
    await expect(a.programsHost.act('omegadesign', SWARM, 'save-source', [], { ...p, editable_source: src } as never, null, { person: true })).rejects.toThrow(/Exactly one editable source/)
  })
  it('an outcome that is not known is never read as "nothing changed"', () => {
    expect(saveSentence({ status: 'error', message: 'x', unknown: true })).toEqual({ text: 'The hive did not say whether this version was kept. Check the version list before keeping it again.', tone: 'warn' })
  })
})

describe('the Ask is the main way in', () => {
  it('on an empty canvas, asking to make something opens a first draft (sim orchestrator: a navigate proposal)', async () => {
    const acc = await a.ask({ operation_id: 'op-design-1', text: SUGGESTIONS[0].ask, context: { route: 'programs/omegadesign', experience: 'classic', program: 'omegadesign', swarm_id: SWARM, view: { refs: [], acts: [] } } } as never)
    expect(acc).toBeTruthy()
    const turn = await (async () => {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 120))
        const t = await a.askTurn('op-design-1')
        if ((t as { state?: string }).state === 'done') return t
      }
      return a.askTurn('op-design-1')
    })()
    const nav = (turn as { events: { phase: string; proposal?: { kind: string; route: string } }[] }).events.find((e) => e.phase === 'proposal')
    expect(nav?.proposal?.kind).toBe('navigate')
    expect(nav?.proposal?.route).toContain('#/program/omegadesign/')
    expect(decodeURIComponent(nav!.proposal!.route)).toContain('"artifact_id":"ar_simstarter"')
  }, 10_000)
})

// ------------------------------------------------------------------ mounted: the states and parts as markup

const program = { id: 'omegadesign', name: 'OmegaDesign' } as Program
const base = { program, describe: null, graph: { revision: 'r', items: [], links: [], groups: [], notes: [] }, grammar: 'classic' as const, act: async () => ({ status: 'done' as const }), focus: () => undefined }
function stateFor(doc: Doc, over: Partial<CanvasState> = {}): CanvasState {
  return {
    phase: { kind: 'ready' }, doc, scene: current(doc).scene, revision: current(doc), selected: null, select: () => undefined, mode: 'make', setMode: () => undefined, drawer: false, setDrawer: () => undefined,
    notice: null, setNotice: () => undefined, receipts: [], busy: null, dirty: doc.cursor !== doc.floor, recent: null, commit: async () => true, undo: () => undefined, redo: () => undefined,
    canUndo: doc.cursor > doc.floor, canRedo: false, keep: async () => undefined, download: async () => undefined, retry: () => undefined, ...over,
  } as CanvasState
}

describe('mounted: what a person and a screen reader get', () => {
  it('nothing open: the empty canvas asks what to make and offers three suggestions, all buttons', () => {
    const html = renderToStaticMarkup(createElement(DesignCanvas, { ...base }))
    expect(html).toContain('role="region"')
    expect(html).toContain('the living canvas')
    expect(html).toContain('What would you like to make?')
    expect(html.match(/class="dc-suggestion"/g)).toHaveLength(3)
    for (const sug of SUGGESTIONS) expect(html).toContain(sug.label)
    expect(html).toContain('role="status"')   // the notice line is a polite live region
  })
  it('a design being opened: the soft skeleton, announced', () => {
    const html = renderToStaticMarkup(createElement(DesignCanvas, { ...base, source: designStarter() }))
    expect(html).toContain('class="dc-skeleton"')
    expect(html).toContain('aria-label="Opening the design"')
    expect(html).not.toContain('What would you like to make?')
  })
  it('an error is one sentence with a way forward', () => {
    const html = renderToStaticMarkup(createElement(ErrorState, { text: 'That version of the design is no longer in the hive.', actions: [{ label: 'Try again', run: () => undefined }] }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('<p>That version of the design is no longer in the hive.</p>')
    expect(html).toContain('>Try again</button>')
    expect(renderToStaticMarkup(createElement(Skeleton, { reduced: true }))).toContain('data-still="true"')
  })
  it('the empty canvas lists recent designs from the host’s artifact list (a read only)', () => {
    const html = renderToStaticMarkup(createElement(Empty, { ask: () => undefined, askReady: true, recent: [{ artifact_id: 'ar_simposter', kind: 'studio-source', title: 'Night-sky festival poster', revision: 4, digest: 'sha256:' + 'd'.repeat(64), created_at: 'c', revised_at: 'r' }], scope: SWARM }))
    expect(html).toContain('Or pick up where you left off')
    expect(html).toContain('Night-sky festival poster')
  })
  it('the top line: the three states as one radio group, undo/redo labelled, and the unsaved state said in words', async () => {
    const doc = await edited()
    const html = renderToStaticMarkup(createElement(TopLine, { s: stateFor(doc), zoom: 0.98, onFit: () => undefined, onZoom: () => undefined, phone: false }))
    expect(html).toContain('role="radiogroup"')
    expect(html.match(/role="radio"/g)).toHaveLength(3)
    expect(html).toMatch(/aria-checked="true"[^>]*>Make</)
    expect(html).toContain('aria-label="Undo"')
    expect(html).toContain('Changes not kept yet')
    expect(html).toContain('98%')
  })
  it('Compare shows the current design and every direction side by side, each a labelled picture', async () => {
    const doc = await openStarter()
    const html = renderToStaticMarkup(createElement(Compare, { s: stateFor(doc), ask: () => undefined }))
    expect(html.match(/role="img"/g)).toHaveLength(1 + (doc.base.project?.directions?.length ?? 0))
    expect(html).toContain('As it is now')
    expect(html).toContain('Night river')
    expect(html).toContain('Continue with this one')
  })
  it('Deliver is one card; Keep is disabled when there is nothing new to keep, and every way out says it asks first', async () => {
    const clean = renderToStaticMarkup(createElement(Deliver, { s: stateFor(await openStarter()), ask: () => undefined }))
    expect(clean).toMatch(/<button[^>]*disabled=""[^>]*>Already kept<\/button>/)
    const dirty = renderToStaticMarkup(createElement(Deliver, { s: stateFor(await edited()), ask: () => undefined }))
    expect(dirty).toContain('Keep this version in the hive')
    expect(dirty).toContain('Save a picture (SVG, unverified mirror)')
    expect(dirty).toContain('ask you to confirm first')
  })
  it('the drawer holds the brief, versions, sources, custody receipts and tools; its handle says what it opens', async () => {
    const doc = await edited()
    const closed = renderToStaticMarkup(createElement(Drawer, { s: stateFor(doc), open: false, onOpen: () => undefined, onClose: () => undefined }))
    expect(closed).toContain('aria-expanded="false"')
    expect(closed).toContain('Brief, versions &amp; sources')
    const ref = { artifact_id: 'ar_simstarter', revision: 2, digest: 'sha256:' + 'e'.repeat(64) }
    const open = renderToStaticMarkup(createElement(Drawer, { s: stateFor(doc, { receipts: [{ at: new Date(0).toISOString(), what: 'Kept revision 4 in the hive', reference: ref, outcome: 'kept' }] }), open: true, onOpen: () => undefined, onClose: () => undefined }))
    for (const h of ['The want', 'Versions', 'Where this came from', 'Custody receipts', 'Tools']) expect(open).toContain(h)
    expect(open).toContain('Invite neighbours to an evening lantern walk along the river')
    expect(open).toContain('not kept yet')
    expect(open).toContain('ar_simstarter r2')
    expect(open).toMatch(/aria-current="true"/)
  })
  it('a still picture of a scene is one labelled image with the design’s own words', async () => {
    const scene = current(await openStarter()).scene
    const html = renderToStaticMarkup(createElement(ScenePicture, { scene, label: 'The design' }))
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="The design"')
    expect(html).toContain('Bring a lantern.')
  })
})

it('Review: Keep accepts native fractional geometry through the exact host confirmation wire', async () => {
 const doc=await openStarter();
 const fractional=commitRevision(doc,await nextRevision(doc,[{op:'set',element:'headline',patch:{x:0.5}}]));
 const p=prepareConfirm('omegadesign',{swarm_id:SWARM,action:'save-source',items:[],params:saveParams(fractional) as unknown as Record<string,unknown>,base_revision:'semantic-candidate-v1'},d);
 expect(p.ok).toBe(true);
});

describe('r4: native fractional geometry, read → edit → confirm → save → read back, on the exact host wire', () => {
  it('a 0.5 offset is confirmed once, kept by the (simulated) Design save, and reads back exactly, native-valid', async () => {
    const { verifySource } = await import('./native/source.mjs')
    a.simSession = 'person'
    const doc = await openStarter()
    const fractional = commitRevision(doc, await nextRevision(doc, [{ op: 'set', element: 'headline', patch: { x: 0.5, y: 120.25 } }]))
    const wire = saveParams(fractional)
    expect(typeof wire.editable_source_json).toBe('string')   // the fractions travel inside JSON text, never in the canonical envelope
    const h = await keepThroughHost(fractional, true)
    expect(h.mint).toHaveBeenCalledTimes(1)
    expect(h.deliver).toHaveBeenCalledTimes(1)
    const r = finalAsResult(h.final)
    expect(r.status).toBe('done')
    const back = readSource((await a.programView('omegadesign', { swarm_id: SWARM, focus: sourceFocus(savedReference(r)!) })) as WorkGraph)
    if (back.kind !== 'studio') throw new Error('not readable')
    const headline = current(openDoc(back.source, back.reference)).scene.elements.find((e) => e.id === 'headline')!
    expect([headline.x, headline.y]).toEqual([0.5, 120.25])   // no rounding anywhere
    expect(await verifySource(back.source)).toEqual(back.source)
    expect(JSON.stringify(back.source)).toBe(wire.editable_source_json)   // the kept bytes are the confirmed bytes
  })
})
