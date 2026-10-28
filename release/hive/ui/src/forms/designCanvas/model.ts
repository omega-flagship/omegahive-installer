import type { WorkGraph, WorkItem } from '../../api/types'
import type { CreationReference } from '../../lib/router'
import { sourceSaveParams } from './source-save-wire.mjs'
import { retainedMakerTrace, type MakerTraceEntry } from './native/maker-trace.mjs'
import { apply as nativeApply, canonical as nativeCanonical, clone as nativeClone, digest as nativeDigest, validate as nativeValidate, validFontFamily as nativeValidFontFamily } from './native/scene.mjs'

/**
 * The Design living canvas's model (Surface, piece 1). Design's data contract, read as it is:
 *
 *  - Read: `view(focus = "studio-source:" + JSON(reference))` returns one item whose `data` is `{source, reference}`,
 *    the editable source (`omega-studio-source-1`) at that exact artifact revision (omegadesign program/source_io.py
 *    `view_source`).
 *  - Write: `act("save-source", [], {editable_source_json, source: reference})`, a person_activity action, so the host's
 *    confirm token is minted only after the person confirms (§9d). Design re-inspects every save and refuses one that
 *    drops the loaded revision, the brief or the hard criteria.
 *
 * Design's owner asked for reuse of its native primitives, not a second implementation (disposition 2026-10-06). The
 * edit format, the revision rule and fingerprint (`apply`, `digest`, `canonical`), the scene validator (`validate`) and
 * the maker-trace projection (`retainedMakerTrace`) are Design 0.4.4's own modules, vendored byte-exact in ./native
 * (PIN.json). What stays here is the canvas's own bookkeeping (the cursor, Undo/Redo, the hold while a Keep is in
 * flight), the person's edit builders (each produces a native change that `apply` checks), and plain-language words for
 * Design's error messages. Design's save re-verifies everything.
 */

export const SOURCE_SCHEMA = 'omega-studio-source-1'
export const DECK_SCHEMA = 'omega-scene-deck-1'
export const SCENE_SCHEMA = 'omega-scene-1'
export const MAX_ELEMENTS = 200
export const MAX_IMAGE_FILE = 10 * 1024 * 1024
export const SETTABLE = ['x', 'y', 'width', 'height', 'text', 'fontSize', 'fontFamily', 'color', 'weight', 'fill', 'src', 'alt'] as const
export type Settable = (typeof SETTABLE)[number]

export type ElementKind = 'text' | 'rect' | 'image'
export interface SceneElement {
  id: string
  kind: ElementKind
  x: number
  y: number
  width: number
  height: number
  text?: string
  fontSize?: number
  fontFamily?: string
  color?: string
  weight?: 'normal' | 'bold'
  fill?: string
  radius?: number
  src?: string
  alt?: string
  [extra: string]: unknown
}
export interface Scene {
  schema: string
  id: string
  title: string
  width: number
  height: number
  background: string
  criteria: string[]
  elements: SceneElement[]
  [extra: string]: unknown
}
export interface SceneParent {
  scene_id: string
  revision: number
  digest: string
}
export type Change =
  | { op: 'add'; element: string; value: SceneElement }
  | { op: 'remove'; element: string }
  | { op: 'layer'; element: string; position: 'front' | 'back' }
  | { op: 'set'; element: string; patch: Partial<Pick<SceneElement, Settable>> }
export interface Revision {
  scene: Scene
  revision: number
  digest: string
  parent: SceneParent | null
  changes: Change[] | unknown[]
  [extra: string]: unknown
}
export interface Direction {
  id: string
  label: string
  rationale?: string
  scene: Scene
  scene_digest?: string
  assessment?: string
  [extra: string]: unknown
}
export interface Brief {
  id?: string
  purpose?: string
  audience?: string
  criteria?: string[]
  [extra: string]: unknown
}
export interface StudioSource {
  schema: string
  current: Revision
  history: Revision[]
  feedback?: unknown[]
  project?: { brief?: Brief; directions?: Direction[]; selection?: string | null; [extra: string]: unknown }
  /** Design's retained maker trace (native `maker-trace.mjs`); projected on save so it only names retained revisions */
  maker_trace?: unknown[]
  provenance?: { kind?: string; source_reference?: CreationReference; assessment?: string; adopted?: boolean; [extra: string]: unknown } | null
  [extra: string]: unknown
}

export type Loaded =
  | { kind: 'studio'; source: StudioSource; reference: CreationReference }
  | { kind: 'deck'; reference: CreationReference | null }
  | { kind: 'unreadable'; why: string }

// ------------------------------------------------------------------ canonical form and digest (Design's own rule)

/** Design's canonical JSON (native `canonical`). */
export const canonical = (value: unknown): string => nativeCanonical(value)
/** Design's fingerprint: "sha256:" over the canonical JSON (native `digest`). */
export const digest = (value: unknown): Promise<string> => nativeDigest(value)
export const clone = <T,>(v: T): T => nativeClone(v)

// ------------------------------------------------------------------ validation (the native bounds)

export const isColour = (c: unknown): c is string => typeof c === 'string' && /^#[a-fA-F0-9]{6}$/.test(c)
export const validFontFamily = (v: unknown): boolean => nativeValidFontFamily(v)
const IMAGE_SRC = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/

/** Design's own error messages (scene.mjs `validate`, `apply`), in plain words for the person. */
const PLAIN: Record<string, string> = {
  'Invalid scene': 'The design is not a scene this canvas can read.',
  'Invalid canvas': 'The design’s artboard size or background is not readable.',
  'Invalid criteria': 'The design’s criteria are not readable.',
  'Invalid elements': `A design holds at most ${MAX_ELEMENTS} elements.`,
  'Invalid element identity': 'An element of the design has no readable identity.',
  'Element outside canvas': 'An element reaches outside the artboard.',
  'Invalid text': 'A text element is not readable.',
  'Invalid font family': 'A text element names a font this canvas cannot use.',
  'Invalid fill': 'A block has no readable colour.',
  'Invalid rectangle radius': 'A block’s corner radius is out of range.',
  'Image must be an embedded PNG or JPEG': 'An image must be an embedded PNG or JPEG with a description.',
  'Stale or altered revision': 'The design changed underneath that edit; nothing was changed.',
  'Invalid change batch': 'Nothing to change.',
  'Duplicate element': 'That element already exists.',
  'Missing element': 'That element is no longer there.',
  'Invalid layer change': 'That element is no longer there.',
  'Invalid element change': 'That change is not one the design accepts.',
  'Unknown operation': 'That change is not one the design accepts.',
}
export const plain = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e)
  return PLAIN[m] ?? `Design did not accept that: ${m}.`
}

/** The scene's problem in one plain sentence (Design's native `validate`), or null when it is a valid native scene. */
export function sceneProblem(scene: unknown): string | null {
  try {
    nativeValidate(scene)
    return null
  } catch (e) {
    return plain(e)
  }
}

// ------------------------------------------------------------------ reading the source from Design's view

/** The view focus that reads one exact editable source (Design's `studio-source:` prefix). */
export const sourceFocus = (ref: CreationReference): string => `studio-source:${JSON.stringify({ artifact_id: ref.artifact_id, revision: ref.revision, digest: ref.digest })}`

/** What Design's view returned for a source focus: the studio source, a deck (not drawn here yet), or why not. */
export function readSource(graph: WorkGraph | null | undefined): Loaded {
  const item = graph?.items.find((i) => {
    const data = (i as WorkItem & { data?: unknown }).data as { source?: unknown } | undefined
    return !!data && typeof data === 'object' && 'source' in data
  }) as (WorkItem & { data: { source: unknown; reference?: unknown } }) | undefined
  if (!item) return { kind: 'unreadable', why: 'Design did not return an editable source for this work.' }
  const source = item.data.source as StudioSource
  const reference = exactRef(item.data.reference)
  if (!source || typeof source !== 'object') return { kind: 'unreadable', why: 'Design returned a source this canvas cannot read.' }
  if (source.schema === DECK_SCHEMA) return { kind: 'deck', reference }
  if (source.schema !== SOURCE_SCHEMA) return { kind: 'unreadable', why: 'This work is not a design this canvas can draw yet.' }
  if (!reference) return { kind: 'unreadable', why: 'Design returned the source without its exact reference, so it cannot be kept safely.' }
  if (!source.current || !Array.isArray(source.history)) return { kind: 'unreadable', why: 'The design’s revision history is missing.' }
  const problem = sceneProblem(source.current.scene)
  if (problem) return { kind: 'unreadable', why: problem }
  if (cursorOf(source) < 0) return { kind: 'unreadable', why: 'The design’s current revision is not in its own history.' }
  return { kind: 'studio', source, reference }
}

function exactRef(v: unknown): CreationReference | null {
  const r = v as CreationReference | null
  if (!r || typeof r !== 'object' || typeof r.artifact_id !== 'string' || !Number.isInteger(r.revision) || r.revision < 1 || typeof r.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(r.digest)) return null
  return { artifact_id: r.artifact_id, revision: r.revision, digest: r.digest }
}

export const cursorOf = (s: StudioSource): number => s.history.findIndex((r) => r.digest === s.current.digest && r.revision === s.current.revision)

// ------------------------------------------------------------------ local revisions (Design's native change shape)

export interface Doc {
  /** The loaded source (never edited in place). */
  base: StudioSource
  reference: CreationReference
  history: Revision[]
  cursor: number
  /** The loaded revision's index: Undo never goes behind what was opened, so a save always retains it. */
  floor: number
  /**
   * Review B1: the index of the revision a Keep in flight is saving. While it is set, Undo never goes behind it and no
   * edit drops it, so the Keep's answer always finds the revision it saved in the working history.
   */
  hold?: number | null
}

export function openDoc(source: StudioSource, reference: CreationReference): Doc {
  const cursor = cursorOf(source)
  return { base: source, reference, history: clone(source.history), cursor, floor: cursor }
}
export const current = (d: Doc): Revision => d.history[d.cursor]
/** The canvas shows something the hive does not hold: a revision other than the one opened (a redo branch alone is not). */
export const isDirty = (d: Doc): boolean => d.cursor !== d.floor
export const canUndo = (d: Doc): boolean => d.cursor > Math.max(d.floor, d.hold ?? -1)
export const canRedo = (d: Doc): boolean => d.cursor < d.history.length - 1

/** The next revision after the cursor: Design's native `apply` (edit format, checks, fingerprint, parent). Throws a plain sentence. */
export async function nextRevision(d: Doc, changes: Change[]): Promise<Revision> {
  const cur = current(d)
  try {
    return (await nativeApply(cur, cur.digest, changes)) as unknown as Revision
  } catch (e) {
    throw new Error(plain(e), { cause: e })
  }
}

/** The doc with `rev` committed after the cursor (a redo branch is dropped, never the loaded revision). */
export function commitRevision(d: Doc, rev: Revision): Doc {
  return { ...d, history: [...d.history.slice(0, d.cursor + 1), rev], cursor: d.cursor + 1 }
}
export const undo = (d: Doc): Doc => (canUndo(d) ? { ...d, cursor: d.cursor - 1 } : d)
export const redo = (d: Doc): Doc => (canRedo(d) ? { ...d, cursor: d.cursor + 1 } : d)

/** The revision a Keep is about to save, held so the edits made while it is in flight cannot drop it. */
export const holdForKeep = (d: Doc): Doc => ({ ...d, hold: d.cursor })
/** The Keep did not land (refused, unknown, cancelled): the hold goes; the work, newer edits included, stays as it is. */
export const releaseHold = (d: Doc): Doc => (d.hold == null ? d : { ...d, hold: null })

/**
 * Review B1: adopt a kept revision into the working doc as it is NOW. The kept source (exactly what was sent) becomes the
 * base and its exact reference the one the next save builds on; the floor moves to the kept revision. Edits made after
 * the Keep began are untouched and stay not-kept (dirty), because the cursor is past the floor. Null when the working
 * history does not hold the kept revision (it then cannot be adopted; the caller keeps the work as it is).
 */
export function adoptKept(now: Doc, kept: { source: StudioSource; revision: Revision; reference: CreationReference }): Doc | null {
  const idx = now.history.findIndex((r) => r.digest === kept.revision.digest && r.revision === kept.revision.revision)
  if (idx < 0 || idx > now.cursor) return null
  return { ...now, base: kept.source, reference: { ...kept.reference }, floor: idx, hold: null }
}

/** The editable source a save sends: the loaded source with this history and current revision. */
export function sourceForSave(d: Doc): StudioSource {
  const out: StudioSource = { ...clone(d.base), current: clone(current(d)), history: clone(d.history) }
  // Design's disposition (traced redo): a trace entry whose revision left the history goes with it (native projection)
  if (Array.isArray(d.base.maker_trace)) out.maker_trace = retainedMakerTrace(clone(d.base.maker_trace) as MakerTraceEntry[], out.history)
  return out
}
/** save-source's params, exactly: one editable source and the exact reference it was loaded from. */
export function saveParams(d: Doc): { editable_source_json: string; source: CreationReference } {
  return sourceSaveParams(sourceForSave(d), { ...d.reference })
}

/** The exact output reference Design's save returned (`data.output`), or null. */
export function savedReference(result: unknown): CreationReference | null {
  const out = (result as { data?: { output?: unknown } } | null)?.data?.output
  return exactRef(out)
}

// ------------------------------------------------------------------ edits as native changes

let seq = 0
/** A fresh element id (the native id rule). */
export const newId = (kind: string): string => `${kind}-${Date.now().toString(36)}${(seq++).toString(36)}`

const clampBox = (scene: Scene, x: number, y: number, w: number, h: number) => {
  const width = Math.max(1, Math.min(Math.round(w), scene.width))
  const height = Math.max(1, Math.min(Math.round(h), scene.height))
  return { x: Math.max(0, Math.min(Math.round(x), scene.width - width)), y: Math.max(0, Math.min(Math.round(y), scene.height - height)), width, height }
}

/** A text element the person adds where they pointed (artboard coordinates), clamped inside the artboard. */
export function addText(scene: Scene, at: { x: number; y: number }, colour?: string): Change {
  const id = newId('text')
  const box = clampBox(scene, at.x, at.y, Math.min(520, scene.width * 0.6), Math.min(120, scene.height * 0.3))
  return { op: 'add', element: id, value: { id, kind: 'text', ...box, text: 'Your words here', fontSize: Math.max(8, Math.min(300, Math.round(scene.height / 20))), color: isColour(colour) ? colour : inkFor(scene.background), weight: 'normal' } }
}
export function addBlock(scene: Scene, at: { x: number; y: number }, fill?: string): Change {
  const id = newId('block')
  const box = clampBox(scene, at.x, at.y, Math.min(260, scene.width * 0.3), Math.min(160, scene.height * 0.3))
  return { op: 'add', element: id, value: { id, kind: 'rect', ...box, fill: isColour(fill) ? fill : '#DCCEB7' } }
}
export function addImage(scene: Scene, at: { x: number; y: number }, src: string, alt: string, natural?: { width: number; height: number }): Change {
  if (!IMAGE_SRC.test(src)) throw new Error('Only PNG or JPEG pictures can go on the design.')
  const id = newId('image')
  const w0 = Math.min(400, scene.width * 0.5)
  const ratio = natural && natural.width > 0 && natural.height > 0 ? natural.height / natural.width : 0.75
  const box = clampBox(scene, at.x, at.y, w0, w0 * ratio)
  return { op: 'add', element: id, value: { id, kind: 'image', ...box, src, alt: alt.slice(0, 200) || 'Picture' } }
}

/** Move to (x, y), kept inside the artboard. Null when nothing would change. */
export function moveTo(scene: Scene, el: SceneElement, x: number, y: number): Change | null {
  const nx = Math.max(0, Math.min(Math.round(x), scene.width - el.width))
  const ny = Math.max(0, Math.min(Math.round(y), scene.height - el.height))
  return nx === el.x && ny === el.y ? null : { op: 'set', element: el.id, patch: { x: nx, y: ny } }
}
/** A new box (from a resize), kept inside the artboard with at least 8 units each way. */
export function resizeTo(scene: Scene, el: SceneElement, box: { x: number; y: number; width: number; height: number }): Change | null {
  const width = Math.max(8, Math.min(Math.round(box.width), scene.width))
  const height = Math.max(8, Math.min(Math.round(box.height), scene.height))
  const x = Math.max(0, Math.min(Math.round(box.x), scene.width - width))
  const y = Math.max(0, Math.min(Math.round(box.y), scene.height - height))
  const patch: Partial<SceneElement> = {}
  if (x !== el.x) patch.x = x
  if (y !== el.y) patch.y = y
  if (width !== el.width) patch.width = width
  if (height !== el.height) patch.height = height
  if (!Object.keys(patch).length) return null
  // a block's radius must still fit its smaller side (native rule); radius is not settable, so refuse rather than break it
  if (el.kind === 'rect' && el.radius !== undefined && el.radius > Math.min(width, height) / 2) return null
  return { op: 'set', element: el.id, patch }
}
/** Size: text grows or shrinks by its type size; a block or picture by its box (about its centre). */
export function resizeStep(scene: Scene, el: SceneElement, factor: number): Change | null {
  if (el.kind === 'text') {
    const fontSize = Math.max(8, Math.min(300, Math.round((el.fontSize ?? 24) * factor)))
    return fontSize === el.fontSize ? null : { op: 'set', element: el.id, patch: { fontSize } }
  }
  const w = el.width * factor
  const h = el.height * factor
  return resizeTo(scene, el, { x: el.x + (el.width - w) / 2, y: el.y + (el.height - h) / 2, width: w, height: h })
}
export function recolour(el: SceneElement, colour: string): Change | null {
  if (!isColour(colour)) return null
  if (el.kind === 'text') return colour.toLowerCase() === el.color?.toLowerCase() ? null : { op: 'set', element: el.id, patch: { color: colour } }
  if (el.kind === 'rect') return colour.toLowerCase() === el.fill?.toLowerCase() ? null : { op: 'set', element: el.id, patch: { fill: colour } }
  return null
}
export function retext(el: SceneElement, text: string): Change | null {
  if (el.kind !== 'text') return null
  const t = text.slice(0, 10000)
  return t === el.text ? null : { op: 'set', element: el.id, patch: { text: t } }
}
export function toggleWeight(el: SceneElement): Change | null {
  return el.kind === 'text' ? { op: 'set', element: el.id, patch: { weight: el.weight === 'bold' ? 'normal' : 'bold' } } : null
}
export function layer(scene: Scene, el: SceneElement, position: 'front' | 'back'): Change | null {
  const i = scene.elements.findIndex((e) => e.id === el.id)
  if (i < 0) return null
  if ((position === 'front' && i === scene.elements.length - 1) || (position === 'back' && i === 0)) return null
  return { op: 'layer', element: el.id, position }
}
export const remove = (el: SceneElement): Change => ({ op: 'remove', element: el.id })

// ------------------------------------------------------------------ colour and words

/** The design's own colours (in use, then the background), most used first: the ring offers these. */
export function paletteOf(scene: Scene): string[] {
  const count = new Map<string, number>()
  for (const e of scene.elements) {
    const c = e.kind === 'text' ? e.color : e.kind === 'rect' ? e.fill : undefined
    if (isColour(c)) count.set(c.toUpperCase(), (count.get(c.toUpperCase()) ?? 0) + 1)
  }
  const out = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
  if (!out.includes(scene.background.toUpperCase())) out.push(scene.background.toUpperCase())
  return out.slice(0, 8)
}
const lum = (hex: string) => {
  const ch = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5)
}
export const contrast = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
/** Dark ink on a light artboard, light ink on a dark one. */
export const inkFor = (bg: string): string => (isColour(bg) && lum(bg) > 0.35 ? '#1C2A22' : '#F7F1E6')

/** How a person reads an element: "Headline text “Plant something…”", "Block", "Picture: a seedling". */
export function describeElement(e: SceneElement): string {
  if (e.kind === 'text') {
    const t = (e.text ?? '').replace(/\s+/g, ' ').trim()
    return `Text “${t.length > 40 ? t.slice(0, 39) + '…' : t || 'empty'}”`
  }
  // a picture's origin is not proved by the canvas: the person's own file name, and an unknown origin
  if (e.kind === 'image') return `Picture${e.alt ? `: ${e.alt.length > 60 ? e.alt.slice(0, 59) + '…' : e.alt}` : ''} (origin not verified)`
  return 'Block'
}
