import { readIntentPhrase } from '../../inventory/nativeWords'
/**
 * The UI's named parts in a real MeTTa AtomSpace (Surface one-experience r1, CANDIDATE; read-only this round).
 *
 * One MeTTaScript runner (the same engine and version the personal mind's space and the simulator's commons run,
 * lib/mindSpace) holds lib_ui (the rules) and the parts of the shell and of every look that has them (Cosmos so far),
 * loaded from the .metta files kept next to each experience, and the hive's intents (inventory/intents.metta: the words
 * every look says for a part, contract R1 §4). Every list and every explanation is a MeTTa query over
 * those atoms (match/collapse in lib_ui); TypeScript only builds the query atoms (E/S, never source text from a
 * person's words: a role, state or look is matched against the known words first) and reads the answers into plain
 * values and sentences. There is no TypeScript copy of the registry.
 *
 * Runs on the page's thread, loaded only when the Ask is asked about the parts (one small space, a few ms).
 */
import { E, S, type Atom } from '@mettascript/hyperon'
import { AtomRunner, symName } from '../../lib/metta/runner'
import { isSym, show, type Val } from '../../lib/mindSpace/atoms'
import libUi from './lib_ui.metta?raw'
import shellParts from './shell.metta?raw'
import cosmosParts from '../cosmos/parts.metta?raw'
import classicParts from '../classic/parts.metta?raw'
import professionalParts from '../professional/parts.metta?raw'
import constructParts from '../construct/parts.metta?raw'
import stillParts from '../still/parts.metta?raw'
import intents from '../../inventory/intents.metta?raw'

export const UI_SOURCES: readonly (readonly [string, string])[] = [
  ['lib_ui', libUi],
  ['intents', intents],
  ['shell', shellParts],
  ['cosmos', cosmosParts],
  ['classic', classicParts],
  ['professional', professionalParts],
  ['still', stillParts],
  ['construct', constructParts],
]
export const ENGINE = 'MeTTaScript-3.4.0'

/** A part's identity: (UiPart look state name). */
export interface PartId {
  look: string
  state: string
  name: string
}
export interface Explained {
  part: PartId
  roles: string[]
  states: string[]
  impls: { library: string; component: string }[]
  slots: string[]
  doc: string | null
  owners: PartId[]
  history: { round: string; what: string; when: string }[]
  counterparts: PartId[]
}

export class UiPartsError extends Error {}

function readPart(v: Val): PartId | null {
  if (Array.isArray(v) && v.length === 4 && isSym(v[0], 'UiPart')) return { look: symName(v[1]), state: symName(v[2]), name: symName(v[3]) }
  return null
}
export const partAtom = (p: PartId): Atom => E(S('UiPart'), S(p.look), S(p.state), S(p.name))
export const partName = (p: PartId): string => `(UiPart ${p.look} ${p.state} ${p.name})`

export class UiPartsSpace {
  private readonly runner = new AtomRunner(UI_SOURCES, UiPartsError)
  get loadMs(): number { return this.runner.loadMs }
  /** The runner's MeTTa: for the guard tests, which load probe atoms into a fresh space. */
  get m() { return this.runner.m }

  private constructor() {}

  static open(): UiPartsSpace {
    return new UiPartsSpace()
  }

  /** Evaluate one read-only call (built as atoms) in this page's own parts space and read its single answer. */
  private query(head: string, ...args: Atom[]): Val {
    return this.runner.query(head, ...args)
  }
  private parts(head: string, ...args: Atom[]): PartId[] {
    const v = this.query(head, ...args)
    return (Array.isArray(v) ? v : []).map(readPart).filter((p): p is PartId => !!p).sort(byPart)
  }
  private words(head: string, ...args: Atom[]): string[] {
    const v = this.query(head, ...args)
    return (Array.isArray(v) ? v : []).map(symName)
  }

  /** The look's parts in one state (null: every state). */
  list(look: string, state: string | null = null): PartId[] {
    return state ? this.parts('ui-parts', S(look), S(state)) : this.parts('ui-parts-of-look', S(look))
  }
  /** What is on screen in a state: the look's parts and the shell's (the one Ask, …). */
  onScreen(look: string, state: string): PartId[] {
    return this.parts('ui-on-screen', S(look), S(state))
  }
  /** The parts playing a role: in a look (and state), or in every look. */
  playing(role: string, look: string | null, state: string | null = null): PartId[] {
    if (!look) return this.parts('ui-playing-anywhere', S(role))
    return state ? this.parts('ui-playing-in', S(look), S(state), S(role)) : this.parts('ui-playing', S(look), S(role))
  }
  sharedRoles(): string[] {
    return this.words('ui-shared-roles').sort()
  }
  next(from: string): { to: string; transition: string }[] {
    const v = this.query('ui-next', S(from))
    return (Array.isArray(v) ? v : []).map((x) => (Array.isArray(x) ? { to: symName(x[0]), transition: symName(x[1]) } : null)).filter((x): x is { to: string; transition: string } => !!x)
  }
  /** Everything the space links to one part (roles, states, what draws it, its slots, owner, history, counterparts). */
  explain(p: PartId): Explained {
    const v = this.query('ui-explain', partAtom(p))
    if (!Array.isArray(v) || !isSym(v[0], 'UiExplained') || v.length !== 10) throw new UiPartsError(`unexpected ${show(v).slice(0, 120)}`)
    const list = (x: Val): Val[] => (Array.isArray(x) ? x : [])
    const [, , roles, states, impls, slots, docs, owners, history, others] = v
    return {
      part: p,
      roles: list(roles).map(symName).sort(),
      states: list(states).map(symName).sort(),
      impls: list(impls)
        .filter(Array.isArray)
        .map((x) => ({ library: symName((x as Val[])[0]), component: symName((x as Val[])[1]) }))
        .sort((a, b) => `${a.library} ${a.component}`.localeCompare(`${b.library} ${b.component}`)),
      slots: list(slots).map(symName).sort(),
      doc: (list(docs).find((d) => typeof d === 'string') as string | undefined) ?? null,
      owners: list(owners).map(readPart).filter((x): x is PartId => !!x),
      history: list(history)
        .filter(Array.isArray)
        .map((x) => ({ round: symName((x as Val[])[0]), what: symName((x as Val[])[1]), when: symName((x as Val[])[2]) })),
      counterparts: list(others).map(readPart).filter((x): x is PartId => !!x).sort(byPart),
    }
  }
  /** The intents a part means (UiIntent; contract R1 §4). */
  intentsOf(p: PartId): string[] {
    return this.words('ui-intents-of', partAtom(p)).sort()
  }
  /** What a look says for a part: its own phrase for each intent the part means, else the default (say-for). */
  wordsFor(look: string, p: PartId): string[] {
    const v = this.query('ui-words', S(look), partAtom(p))
    return (Array.isArray(v) ? v : []).map((x) => (typeof x === 'string' ? x : show(x)))
  }
  /**
   * What `look` says for `intent` (inventory/intents.metta say-for: its own phrase, else the default), for a look's
   * awake words (Codex 3 Nov: one space, no text table). null for an intent the space does not define, or a retired one.
   */
  say(look: string, intent: string): string | null {
    return readIntentPhrase((head, ...args) => this.query(head, ...args), look, intent)
  }
  /** Guard: rest and awake parts playing a shared role with no intent (must be empty). */
  unboundPartRoles(): PartId[] {
    return this.parts('ui-unbound-part-role')
  }
  /** Guard: parts bound to an intent that inventory/intents.metta does not define (must be empty). */
  unknownIntents(): string[] {
    const v = this.query('ui-unknown-intent')
    return (Array.isArray(v) ? v : []).map((x) => show(x))
  }
  /** Every (UiImpl … component) with its (UiSource component path), for the source check. */
  sources(): { component: string; path: string | null }[] {
    const names = [...new Set(this.words('ui-components'))].sort()
    return names.map((c) => {
      const v = this.query('ui-source', S(c))
      const path = Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null
      return { component: c, path }
    })
  }
}

const STATE_ORDER: Record<string, number> = { rest: 0, awake: 1, pro: 2, any: 3 }
function byPart(a: PartId, b: PartId): number {
  return a.look.localeCompare(b.look) || (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || a.name.localeCompare(b.name)
}

let shared: UiPartsSpace | null = null
/** The page's one parts space (opened on first use). */
export function partsSpace(): UiPartsSpace {
  if (!shared) shared = UiPartsSpace.open()
  return shared
}
