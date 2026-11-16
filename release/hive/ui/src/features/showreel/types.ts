/**
 * The demo showreel's step format (Surface demo D4): a guided-demo step (features/guided, played through the Ask
 * conductor's `tour.step`) plus what the showreel adds around it: where its cursor clicks, the conductor acts that do
 * the move, what it draws, its own answers to "why?", and its trace, the layers of "how" all the way down.
 *
 * The trace format is the live one's too: the layer viewer reads a `Trace` and knows nothing of where it came from.
 * Demo traces are written into the scripts (`source: 'synthetic'`, invented but in the real shapes); a live reader can
 * hand the viewer a `source: 'live'` trace later, and a layer nobody has read says "not available yet".
 */
import type { ConductorAct } from '../../api/ask'
import type { GuideStep, GuideTarget } from '../guided/types'
import type { Mark } from '../ink/ink'

/** A conductor act as a script writes it (the runner gives it its id). `route` may be read just before the act. */
type DOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type ScriptAct = DOmit<Exclude<ConductorAct, { kind: 'tour.step' }>, 'act_id'>
/**
 * A navigate whose address is only known on the page, read just before the move with the same read the page's own
 * control makes: a swarm's team room (its Chat button), or a design in Studio (its "pick up where you left off").
 */
export type PageMove = { kind: 'team-room'; swarm: string; label?: string } | { kind: 'design'; swarm: string; title: string; label?: string }

/** A warning the step opens with the page's own opener, and closes when it moves on (it never presses anything in it). */
export type DialogOpen = { kind: 'swarm-delete'; swarm: string; name: string }

/** A mark on the draw layer (shared with guided-play: features/ink). */
export type { Mark } from '../ink/ink'

export interface ShowStep {
  /** the guided step the conductor's tour.step shows (its caption, glow and controls) */
  guide: GuideStep
  /** where the demo cursor clicks first, when it is on screen (a nav item, a button) */
  cursor?: GuideTarget[]
  /** the conductor acts that do the move, before the tour step */
  before?: (ScriptAct | PageMove)[]
  /** a warning opened after the move, before the tour step (its preview is what the step shows) */
  dialog?: DialogOpen
  /** conductor acts after it (point, highlight) */
  after?: ScriptAct[]
  draw?: Mark[]
  /** "why?": the purpose of this step */
  why: string
  /** "what's that?": what is on screen */
  seeing: string
  /** "why did you click that?" (defaults to why) */
  click?: string
  trace: Trace
}

export interface Scene {
  /** the guided script id (registered for demo mode only, never in the list of demos) */
  id: string
  title: string
  steps: ShowStep[]
}

// ---------------------------------------------------------------- the layers of "how"

export const LAYERS = ['screen', 'code', 'hive', 'mind', 'atomspace', 'reasoning', 'memory', 'files'] as const
export type LayerKind = (typeof LAYERS)[number]
export const LAYER_NAMES: Record<LayerKind, string> = {
  screen: 'Screen',
  code: 'Code',
  hive: 'Hive',
  mind: 'Mind (MeTTa)',
  atomspace: 'AtomSpace',
  reasoning: 'Reasoning',
  memory: 'Memory',
  files: 'Files',
}

/** An atom in a small before/after graph: a node, or a link over other atoms (by id), with a truth value if it has one. */
export interface TraceAtom {
  id: string
  /** its MeTTa text, e.g. (Inheritance run-b fewer-failures) */
  text: string
  kind: 'node' | 'link'
  targets?: string[]
  stv?: [number, number]
}

export interface InferenceStep {
  /** the worked example (pln/cases.json) whose numbers this step shows */
  case: string
  /** what each premise is, in invented atoms, in the rule's order */
  premises: string[]
  conclusion: string
}

export interface Trace {
  source: 'synthetic' | 'live'
  screen?: { component: string; control: string; sent: string }
  code?: { file: string; line: number; symbol: string; excerpt: string }[]
  hive?: { method: string; route: string; handler: string; check: string }[]
  mind?: { skill: string; loop: string; metta: string }
  atomspace?: { space: string; before: TraceAtom[]; after: TraceAtom[] }
  reasoning?: InferenceStep[]
  memory?: { recalled: { text: string; why: string }[]; stored: string[] }
  files?: { path: string; change: 'added' | 'changed' | 'removed'; bytes: number; diff?: string }[]
}
