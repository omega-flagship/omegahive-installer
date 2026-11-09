/**
 * Screens composed by MeTTa (screens/lib_screens.metta): one MeTTaScript AtomSpace holds the block vocabulary, each
 * look's preferences and every screen declared as atoms (`<feature>/<name>.metta`). To draw a screen the page states
 * this moment's facts (counts and flags, never a person's words), MeTTa answers which parts show, which block draws
 * each and what fell back, and the browser draws that answer (Screen.tsx). TypeScript only builds atoms and reads the
 * answer into plain values: it decides nothing about what is on screen.
 *
 * The same engine and version as the parts space (experiences/parts/space.ts) and the personal mind's space.
 */
import { E, S, ValueAtom, type Atom } from '@mettascript/hyperon'
import { isSym, show, type Val } from '../lib/mindSpace/atoms'
import { AtomRunner, symName } from '../lib/metta/runner'
import { noteMissing } from './buildTasks'
import { plural } from '../lib/plural'
import libScreens from './lib_screens.metta?raw'
import explain from './explain.metta?raw'
import looks from './looks.metta?raw'
import tools from '../features/tools/tools.metta?raw'
import artifacts from '../features/artifacts/artifacts.metta?raw'
import settings from '../features/settings/settings.metta?raw'
import health from '../features/health/health.metta?raw'
import roles from '../features/roles/roles.metta?raw'
import models from '../features/models/models.metta?raw'
import people from '../features/people/people.metta?raw'
import updates from '../features/updates/updates.metta?raw'
import tasks from '../features/tasks/tasks.metta?raw'
import motivations from '../features/tasks/motivations.metta?raw'
import swarms from '../features/swarm/swarms.metta?raw'
import programs from '../features/programs/programs.metta?raw'
import program from '../features/programs/program.metta?raw'
import lifecycle from '../features/lifecycle/lifecycle.metta?raw'
import profile from '../features/keys/profile.metta?raw'
import explore from '../features/explore/explore.metta?raw'
import flow from '../features/flow/flow.metta?raw'
import conversations from '../features/dot/conversations.metta?raw'
import setup from '../features/setup/setup.metta?raw'
import mind from '../features/mind/mind.metta?raw'
import plan from '../features/createPlan/plan.metta?raw'

/** Every source the screens space loads, in order: the rules, the looks, then each feature's screens. */
export const SCREEN_SOURCES: readonly (readonly [string, string])[] = [
  ['lib_screens', libScreens],
  ['explain', explain],
  ['looks', looks],
  ['tools', tools],
  ['artifacts', artifacts],
  ['settings', settings],
  ['health', health],
  ['roles', roles],
  ['models', models],
  ['people', people],
  ['updates', updates],
  ['tasks', tasks],
  ['motivations', motivations],
  ['swarms', swarms],
  ['programs', programs],
  ['program', program],
  ['lifecycle', lifecycle],
  ['profile', profile],
  ['explore', explore],
  ['flow', flow],
  ['conversations', conversations],
  ['setup', setup],
  ['mind', mind],
  ['plan', plan],
]

/** A bound value: filled from the page's data at draw time (`(bind tool.title)`). */
export interface Bound { bind: string }
export type PropValue = string | number | boolean | Bound | PropValue[] | { [key: string]: PropValue }
export type Props = Record<string, PropValue>

/** How MeTTa chose the block: named by the screen, the role's default, the look's choice, or a fallback. */
export type How = { kind: 'direct' } | { kind: 'role' } | { kind: 'look' } | { kind: 'fallback'; wanted: string } | { kind: 'unknown'; wanted: string }

/** Where a part sits: its layer and that layer's depth (0 = ground, higher = nearer the person). */
export interface Depth { layer: string; z: number }
/** Where a part sits on the page: its region, and the row it shares with its neighbours (null: a row of its own). */
export interface Place { region: 'main' | 'aside'; row: string | null }
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

/** This moment's facts: counts per source and flags. Values are numbers or booleans only. */
export interface ScreenFacts {
  counts?: Record<string, number>
  flags?: Record<string, boolean>
  values?: Record<string, string>
}

export class ScreensError extends Error {}

/** What the Ask can say about one part (explain.metta). */
export interface Explanation {
  screen: string
  order: number
  /** a block or role the screen names, or one of the shared resource pieces (waiting, failed, stale …) */
  declared: { kind: 'block' | 'role' | 'resource'; name: string }
  role: string
  words: string
  conditions: string[]
  region: string
  row: string | null
  layer: string
}

const NAME = /^[a-z][a-z0-9_.-]*$/i

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
    place: { region: isSym(at[3], 'aside') ? 'aside' : 'main', row: row === 'none' ? null : row } }
}

function factAtoms(f: ScreenFacts): Atom[] {
  const atoms: Atom[] = []
  for (const [k, n] of Object.entries(f.counts ?? {})) {
    if (!NAME.test(k) || !Number.isInteger(n) || n < 0) throw new ScreensError(`bad count ${k}`)
    atoms.push(E(S('Fact'), E(S('count'), S(k)), ValueAtom(n)))
  }
  for (const [k, b] of Object.entries(f.flags ?? {})) {
    if (!NAME.test(k)) throw new ScreensError(`bad flag ${k}`)
    atoms.push(E(S('Fact'), S(k), S(b ? 'yes' : 'no')))
  }
  for (const [k, s] of Object.entries(f.values ?? {})) {
    // a value is matched as a known symbol only (is k v): never source text from a person's words
    if (!NAME.test(k) || !NAME.test(s)) throw new ScreensError(`bad value ${k}`)
    atoms.push(E(S('Fact'), S(k), E(S('Val'), S(s))))
  }
  return atoms
}

export class ScreensSpace {
  private readonly runner: AtomRunner

  private constructor(sources: readonly (readonly [string, string])[]) {
    this.runner = new AtomRunner(sources, ScreensError)
  }
  get loadMs(): number { return this.runner.loadMs }
  private get m() { return this.runner.m }

  /** The page's space (every screen), or a space of the given sources (tests). */
  static open(sources: readonly (readonly [string, string])[] = SCREEN_SOURCES): ScreensSpace {
    return new ScreensSpace(sources)
  }

  private query(head: string, ...args: Atom[]): Val {
    return this.runner.query(head, ...args)
  }

  /** Every block MeTTa can choose (the renderer must draw each). */
  blocks(): string[] {
    const v = this.query('scr-blocks')
    return (Array.isArray(v) ? v : []).map(symName).sort()
  }

  /**
   * Why one part is on a screen, for the Ask: what it is in plain words, its role, what it needs to show, and where it
   * sits. The same atoms the composer decides with, so the answer cannot disagree with what was drawn. null when the
   * screen has no such part.
   */
  explain(screen: string, order: number): Explanation | null {
    if (!NAME.test(screen) || !Number.isInteger(order)) throw new ScreensError('bad screen or part')
    const v = this.query('scr-explain', S(screen), ValueAtom(order))
    if (!Array.isArray(v) || v.length !== 10 || !isSym(v[0], 'Why')) throw new ScreensError(`unexpected ${show(v).slice(0, 120)}`)
    const [, , , declared, role, words, conditions, region, row, layer] = v
    if (isSym(declared, 'none')) return null
    const d = Array.isArray(declared) ? declared : []
    return {
      screen, order,
      declared: { kind: isSym(d[0], 'role') ? 'role' : isSym(d[0], 'resource') ? 'resource' : 'block', name: symName(d[1]) },
      role: symName(role),
      words: typeof words === 'string' ? words : symName(words),
      conditions: (Array.isArray(conditions) ? conditions : []).map((c) => show(c)),
      region: symName(region),
      row: isSym(row, 'none') ? null : symName(row),
      layer: symName(layer),
    }
  }

  /** The code editor's ink for a look worn on a surface scheme (looks.metta: scr-code-ink): `paper` or `night`. */
  codeInk(look: string, scheme: 'light' | 'dark'): 'paper' | 'night' {
    if (!NAME.test(look)) return scheme === 'light' ? 'paper' : 'night'
    const v = this.query('scr-code-ink', S(look), S(scheme))
    return isSym(v, 'paper') ? 'paper' : 'night'
  }

  /** Every look id the screen rules name. */
  looks(): string[] {
    const v = this.query('scr-looks')
    const ids = Array.isArray(v) ? [...(Array.isArray(v[1]) ? v[1] : []), ...(Array.isArray(v[2]) ? v[2] : [])] : []
    return [...new Set(ids.map(symName))].sort()
  }

  /** Every island a screen places: its screen and its name. */
  islands(): { screen: string; name: string }[] {
    const v = this.query('scr-islands')
    return (Array.isArray(v) ? v : []).flatMap((x) => {
      if (!Array.isArray(x) || x.length !== 2) return []
      const name = readProps(x[1]).name
      return typeof name === 'string' ? [{ screen: symName(x[0]), name }] : []
    })
  }

  /**
   * Every part order `screen` has, sorted: its own parts and those its resource declaration takes (tests check that
   * each can be reached).
   */
  orders(screen: string): number[] {
    if (!NAME.test(screen)) throw new ScreensError('bad screen name')
    const v = this.query('scr-orders', S(screen))
    const all = Array.isArray(v) ? v.slice(1).flatMap((xs) => (Array.isArray(xs) ? xs : [])) : []
    return [...new Set(all.filter((o): o is number => typeof o === 'number'))].sort((a, b) => a - b)
  }

  screens(): string[] {
    const v = this.query('scr-screens')
    return (Array.isArray(v) ? v : []).map(symName).sort()
  }

  /**
   * MeTTa composes `screen` for `look` from these facts. The facts live in the space only for this call (synchronous,
   * so no other call sees them) and are removed before it returns, whatever happens.
   */
  compose(screen: string, look: string, facts: ScreenFacts = {}): ScreenPlan {
    if (!NAME.test(screen) || !NAME.test(look)) throw new ScreensError('bad screen or look name')
    const atoms = factAtoms(facts)
    const space = this.m.space()
    for (const a of atoms) space.addAtom(a)
    let gone: number
    let plan: ScreenPlan
    try {
      const v = this.query('scr-compose', S(screen), S(look))
      // (Composed screen look named roled resource space)
      if (!Array.isArray(v) || v.length !== 7 || !isSym(v[0], 'Composed')) throw new ScreensError(`unexpected ${show(v).slice(0, 120)}`)
      const parts = [v[3], v[4], v[5]].flatMap((xs) => (Array.isArray(xs) ? xs : [])).map(readDrawn).sort((a, b) => a.order - b.order)
      const t = this.query('scr-title', S(screen))
      plan = {
        screen,
        look,
        space: isSym(v[6], '3d') ? '3d' : 'flat',
        title: typeof t === 'string' ? t : null,
        parts,
        missing: parts
          .filter((p) => p.how.kind === 'fallback' || p.how.kind === 'unknown')
          .map((p) => ({ screen, order: p.order, wanted: (p.how as { wanted: string }).wanted, drawnAs: p.block })),
      }
    } finally {
      gone = space.removeAtoms(atoms)
    }
    // a fact left behind would change every later composition: refuse rather than draw from a dirty space
    if (gone !== atoms.length) throw new ScreensError(`removed ${gone} of ${plural(atoms.length, 'fact')}`)
    return plan
  }

  /** Guards: each must be empty (the build checks them). */
  guards(): Record<'unknownBlocks' | 'rolesWithoutDefault' | 'badLookPrefs' | 'orphanConditions' | 'undeclaredScreens' | 'badDepths' | 'badRegions' | 'badConditions' | 'rolesWithoutWords' | 'badResources', string[]> {
    const list = (head: string) => {
      const v = this.query(head)
      return (Array.isArray(v) ? v : []).map((x) => show(x))
    }
    // (Bad undeclared twice options clashes): one list of every resource declaration that cannot draw as declared
    const bad = this.query('scr-bad-resources')
    const badResources = (Array.isArray(bad) ? bad.slice(1) : []).flatMap((xs) => (Array.isArray(xs) ? xs : [])).map((x) => show(x))
    return {
      unknownBlocks: list('scr-unknown-blocks'),
      rolesWithoutDefault: list('scr-roles-without-default'),
      badLookPrefs: list('scr-bad-look-prefs'),
      orphanConditions: list('scr-orphan-conditions'),
      undeclaredScreens: list('scr-undeclared-screens'),
      badDepths: list('scr-bad-depths'),
      badRegions: list('scr-bad-regions'),
      badConditions: list('scr-bad-conditions'),
      rolesWithoutWords: list('scr-roles-without-words'),
      badResources: [...new Set(badResources)],
    }
  }
}

let shared: ScreensSpace | null = null
/** The page's one screens space, opened on first use. */
export function screensSpace(): ScreensSpace {
  return (shared ??= ScreensSpace.open())
}

/** How a page asks for a screen: the screen and this moment's facts (the look is bound by the caller). */
export type Compose = (screen: string, facts: ScreenFacts) => ScreenPlan

/** A screen that could not be composed: one plain notice in place of the page, so a fault never takes the page down. */
export function unavailablePlan(screen: string, look: string): ScreenPlan {
  return {
    screen, look, space: 'flat', title: null, missing: [],
    parts: [{ order: 0, block: 'notice', how: { kind: 'direct' }, depth: { layer: 'raised', z: 2 }, place: { region: 'main', row: null },
      props: { tone: 'bad', text: 'This part of the hive could not be drawn just now. Reload the page to try again.' } }],
  }
}

const KEPT = 256
/**
 * The same facts always compose the same screen, so each answer is kept (up to KEPT, oldest dropped): typing in a
 * search box or a page of many rows asks MeTTa once per distinct shape. A composition that throws gives the plain
 * unavailable notice instead, and is not kept, so the next call tries again.
 */
export function rememberedCompose(look: string, space: () => ScreensSpace = screensSpace): Compose {
  const kept = new Map<string, ScreenPlan>()
  return (screen, facts) => {
    const key = `${screen}|${JSON.stringify(facts)}`
    const hit = kept.get(key)
    if (hit) return hit
    let plan: ScreenPlan
    try {
      plan = space().compose(screen, look, facts)
    } catch (e) {
      console.error(`screen ${screen} could not be composed`, e)
      return unavailablePlan(screen, look)
    }
    noteMissing(plan)
    if (kept.size >= KEPT) kept.delete(kept.keys().next().value as string)
    kept.set(key, plan)
    return plan
  }
}
