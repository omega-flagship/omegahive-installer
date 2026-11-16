import { isColour, type Change, type Scene, type SceneElement } from './model'

/**
 * Piece 2's seam (Universal Ask Phase 2a, contract r3 §1 and §3.3): the qualified draft-op vocabulary translated into
 * this canvas's native changes, with the frame-side checks the contract gives the receiver. Nothing here talks to the
 * hive, holds a stream, sends a receipt or decides an epoch: piece 2's receiver owns those, and calls this to learn
 * whether one op applies to the scene on screen, and as which native change. Pure, and tested.
 *
 * - Logical ids are stream-scoped; `owned` maps each to the native element id it created (only stream-owned elements
 *   can be set, selected or pointed at).
 * - `add-*` requires exact absence; `set-element` requires the exact prior value of every field it sets.
 * - Fields must fit the element's kind: geometry for every kind; text, fontSize, color, weight for text; fill for rect.
 * - The artboard decides the rest: x + width ≤ scene.width, y + height ≤ scene.height, radius ≤ min side / 2, ≤ 200
 *   elements.
 */

export const QUALIFIED = ['add-shape', 'add-text', 'set-element', 'select-element', 'cursor'] as const
export type QualifiedOp = (typeof QUALIFIED)[number]
export type Refusal = 'precondition' | 'unknown-element' | 'out-of-bounds' | 'invalid' | 'limit'

export type Translation =
  | { kind: 'change'; change: Change; owns?: { logical: string; native: string } }
  | { kind: 'select'; native: string }
  | { kind: 'cursor'; x: number; y: number; caption?: string; near?: string }
  | { kind: 'refused'; reason: Refusal }

const LOGICAL = /^[a-z0-9][a-z0-9-]{0,47}$/
const GEOMETRY = ['x', 'y', 'width', 'height'] as const
const TEXT_ONLY = ['text', 'fontSize', 'color', 'weight'] as const
const SETTABLE_2A = [...GEOMETRY, ...TEXT_ONLY, 'fill'] as const
type Args = Record<string, unknown>

const num = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const exactKeys = (o: Args, required: string[], optional: string[] = []) => required.every((k) => k in o) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k))

function fieldValid(k: string, v: unknown): boolean {
  if (k === 'x' || k === 'y') return num(v, 0, 4000)
  if (k === 'width' || k === 'height') return num(v, 1, 4000)
  if (k === 'text') return typeof v === 'string' && v.length <= 2000 && ![...v].some((c) => c !== '\n' && (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
  if (k === 'fontSize') return num(v, 8, 300)
  if (k === 'color' || k === 'fill') return isColour(v)
  if (k === 'weight') return v === 'normal' || v === 'bold'
  return false
}
const fits = (el: Pick<SceneElement, 'kind'>, k: string) => (GEOMETRY as readonly string[]).includes(k) || ((TEXT_ONLY as readonly string[]).includes(k) ? el.kind === 'text' : k === 'fill' ? el.kind === 'rect' : false)
const inBounds = (scene: Scene, b: { x: number; y: number; width: number; height: number }) => b.x + b.width <= scene.width && b.y + b.height <= scene.height

/** Translate one qualified op. `nativeIdFor` names the element an add creates (default: `ask-<logical>`). */
export function translate(scene: Scene, owned: ReadonlyMap<string, string>, op: string, args: Args, nativeIdFor = (logical: string) => `ask-${logical}`): Translation {
  const refuse = (reason: Refusal): Translation => ({ kind: 'refused', reason })
  if (!(QUALIFIED as readonly string[]).includes(op) || !args || typeof args !== 'object') return refuse('invalid')
  const native = (logical: unknown) => (typeof logical === 'string' ? owned.get(logical) : undefined)
  const live = (id: string | undefined) => (id ? scene.elements.find((e) => e.id === id) : undefined)

  if (op === 'cursor') {
    if (!exactKeys(args, ['x', 'y'], ['caption', 'near']) || !num(args.x, 0, 1) || !num(args.y, 0, 1)) return refuse('invalid')
    if (args.caption !== undefined && (typeof args.caption !== 'string' || args.caption.length > 120)) return refuse('invalid')
    const near = args.near !== undefined ? live(native(args.near))?.id : undefined
    return { kind: 'cursor', x: args.x, y: args.y, ...(typeof args.caption === 'string' ? { caption: args.caption } : {}), ...(near ? { near } : {}) }
  }

  if (op === 'select-element') {
    if (!exactKeys(args, ['id']) || typeof args.id !== 'string' || !LOGICAL.test(args.id)) return refuse('invalid')
    const el = live(native(args.id))
    return el ? { kind: 'select', native: el.id } : refuse('unknown-element')
  }

  if (op === 'add-shape' || op === 'add-text') {
    const req = op === 'add-shape' ? ['id', 'kind', 'x', 'y', 'width', 'height', 'fill', 'absent'] : ['id', 'x', 'y', 'width', 'height', 'text', 'fontSize', 'color', 'weight', 'absent']
    if (!exactKeys(args, req, op === 'add-shape' ? ['radius'] : []) || args.absent !== true || typeof args.id !== 'string' || !LOGICAL.test(args.id)) return refuse('invalid')
    if (op === 'add-shape' && args.kind !== 'rect') return refuse('invalid')
    for (const k of req) if (!['id', 'kind', 'absent'].includes(k) && !fieldValid(k, args[k])) return refuse('invalid')
    if (op === 'add-shape' && args.radius !== undefined && !num(args.radius, 0, 1000)) return refuse('invalid')
    if (owned.has(args.id)) return refuse('precondition')   // exact absence: this stream already made it
    const id = nativeIdFor(args.id)
    if (scene.elements.some((e) => e.id === id)) return refuse('precondition')
    if (scene.elements.length >= 200) return refuse('limit')
    const box = { x: args.x as number, y: args.y as number, width: args.width as number, height: args.height as number }
    if (!inBounds(scene, box)) return refuse('out-of-bounds')
    if (op === 'add-shape') {
      if (args.radius !== undefined && (args.radius as number) > Math.min(box.width, box.height) / 2) return refuse('out-of-bounds')
      const value: SceneElement = { id, kind: 'rect', ...box, fill: args.fill as string, ...(args.radius !== undefined ? { radius: args.radius as number } : {}) }
      return { kind: 'change', change: { op: 'add', element: id, value }, owns: { logical: args.id, native: id } }
    }
    const value: SceneElement = { id, kind: 'text', ...box, text: args.text as string, fontSize: args.fontSize as number, color: args.color as string, weight: args.weight as 'normal' | 'bold' }
    return { kind: 'change', change: { op: 'add', element: id, value }, owns: { logical: args.id, native: id } }
  }

  // set-element
  if (!exactKeys(args, ['id', 'prior', 'value']) || typeof args.id !== 'string' || !LOGICAL.test(args.id)) return refuse('invalid')
  const prior = args.prior as Args
  const value = args.value as Args
  if (!prior || !value || typeof prior !== 'object' || typeof value !== 'object') return refuse('invalid')
  const keys = Object.keys(value)
  const same = keys.length > 0 && keys.length === Object.keys(prior).length && keys.every((k) => k in prior)
  if (!same || keys.length > 24 || keys.some((k) => !(SETTABLE_2A as readonly string[]).includes(k) || !fieldValid(k, value[k]) || !fieldValid(k, prior[k]))) return refuse('invalid')
  const el = live(native(args.id))
  if (!el) return refuse('unknown-element')
  if (keys.some((k) => !fits(el, k))) return refuse('invalid')
  if (keys.some((k) => el[k] !== prior[k])) return refuse('precondition')
  const next = { x: el.x, y: el.y, width: el.width, height: el.height, ...(value as Partial<SceneElement>) }
  if (!inBounds(scene, next as { x: number; y: number; width: number; height: number })) return refuse('out-of-bounds')
  if (el.kind === 'rect' && el.radius !== undefined && el.radius > Math.min(next.width as number, next.height as number) / 2) return refuse('out-of-bounds')
  return { kind: 'change', change: { op: 'set', element: el.id, patch: value as Partial<SceneElement> } }
}
