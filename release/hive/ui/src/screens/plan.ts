/**
 * Purpose: MeTTa's composed answer read into the plain plan screens/Screen.tsx draws. The page's screens space
 * (screens/screenSpace.ts) and each view a mind writes in MeTTa (features/views/mettaView.ts) compose with the same rules
 * (lib_screens.metta) and read the answer here, so the two can never draw a plan differently.
 */
import { isSym, show, type Val } from '../lib/mindSpace/atoms'
import { symName } from '../lib/metta/runner'

/** A screen, look, key or flag name as the rules accept it: a word, never text from a person. */
export const NAME = /^[a-z][a-z0-9_.-]*$/i

/** A bound value: filled from the page's data at draw time (`(bind tool.title)`). */
export interface Bound { bind: string }
export type PropValue = string | number | boolean | Bound | PropValue[] | { [key: string]: PropValue }
export type Props = Record<string, PropValue>

/** How MeTTa chose the block: named by the screen, the role's default, the look's choice, or a fallback. */
export type How = { kind: 'direct' } | { kind: 'role' } | { kind: 'look' } | { kind: 'fallback'; wanted: string } | { kind: 'unknown'; wanted: string }

/** Where a part sits: its layer and that layer's depth (0 = ground, higher = nearer the person). */
export interface Depth { layer: string; z: number }
/** Where a part sits: its region (main and aside on a page, usage in a look's frame) and the row it shares with its
 *  neighbours (null: a row of its own). */
export interface Place { region: 'main' | 'aside' | 'usage'; row: string | null }
export interface DrawnPart {
  order: number
  block: string | null
  how: How
  props: Props
  depth: Depth
  place: Place
}
export interface ScreenPlan {
  screen: string
  title: string | null
  look: string
  /** flat: layers show as elevation; 3d: the look places each part at its depth */
  space: 'flat' | '3d'
  parts: DrawnPart[]
  /** blocks a screen asked for that nothing draws yet: each is a build task */
  missing: { screen: string; order: number; wanted: string; drawnAs: string | null }[]
}

export class ScreensError extends Error {}

/** A props expression ((key value) …) into a plain object; (bind path) becomes { bind }. */
export function readProps(v: Val): Props {
  const out: Props = {}
  for (const pair of Array.isArray(v) ? v : []) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isSym(pair[0])) continue
    out[pair[0].sym] = readValue(pair[1])
  }
  return out
}
function readValue(v: Val): PropValue {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (isSym(v)) return v.sym
  if (Array.isArray(v)) {
    if (v.length === 2 && isSym(v[0], 'bind') && isSym(v[1])) return { bind: v[1].sym }
    return v.map(readValue)
  }
  return show(v)
}
function readHow(v: Val): How {
  if (isSym(v, 'direct')) return { kind: 'direct' }
  if (isSym(v, 'role')) return { kind: 'role' }
  if (isSym(v, 'look')) return { kind: 'look' }
  if (Array.isArray(v) && v.length === 2 && isSym(v[0], 'fallback')) return { kind: 'fallback', wanted: symName(v[1]) }
  if (Array.isArray(v) && v.length === 2 && isSym(v[0], 'unknown')) return { kind: 'unknown', wanted: symName(v[1]) }
  throw new ScreensError(`unexpected choice ${show(v).slice(0, 80)}`)
}
function readDrawn(v: Val): DrawnPart {
  // (Drawn order (Use block how) props (At layer z))
  if (!Array.isArray(v) || v.length !== 5 || !isSym(v[0], 'Drawn') || typeof v[1] !== 'number') throw new ScreensError(`unexpected part ${show(v).slice(0, 120)}`)
  const use = v[2]
  if (!Array.isArray(use) || use.length !== 3 || !isSym(use[0], 'Use')) throw new ScreensError(`unexpected block ${show(use).slice(0, 120)}`)
  const block = isSym(use[1], 'none') ? null : symName(use[1])
  const at = v[4]
  // (At layer z region row)
  if (!Array.isArray(at) || at.length !== 5 || !isSym(at[0], 'At') || typeof at[2] !== 'number') throw new ScreensError(`unexpected depth ${show(at).slice(0, 80)}`)
  const row = symName(at[4])
  return { order: v[1], block, how: readHow(use[2]), props: readProps(v[3]), depth: { layer: symName(at[1]), z: at[2] },
    place: { region: isSym(at[3], 'aside') ? 'aside' : isSym(at[3], 'usage') ? 'usage' : 'main', row: row === 'none' ? null : row } }
}

/**
 * lib_screens' `(Composed screen look named roled resource space)` answer and its `scr-title` answer, read into the plan
 * the renderer draws: every drawn part in order, the space the look draws in, and the blocks that fell back.
 */
export function readPlan(v: Val, screen: string, look: string, title: Val): ScreenPlan {
  if (!Array.isArray(v) || v.length !== 7 || !isSym(v[0], 'Composed')) throw new ScreensError(`unexpected ${show(v).slice(0, 120)}`)
  const parts = [v[3], v[4], v[5]].flatMap((xs) => (Array.isArray(xs) ? xs : [])).map(readDrawn).sort((a, b) => a.order - b.order)
  return {
    screen,
    look,
    space: isSym(v[6], '3d') ? '3d' : 'flat',
    title: typeof title === 'string' ? title : null,
    parts,
    missing: parts
      .filter((p) => p.how.kind === 'fallback' || p.how.kind === 'unknown')
      .map((p) => ({ screen, order: p.order, wanted: (p.how as { wanted: string }).wanted, drawnAs: p.block })),
  }
}
