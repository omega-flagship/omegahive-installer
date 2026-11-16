/**
 * Purpose: one open view's MeTTa. A mind writes a view as MeTTa declarations (lib_view.metta); this holds them in a
 * space of their own beside the hive's screen rules (screens/lib_screens.metta, looks.metta), composes the view's one
 * screen for the person's look, works out its values, and turns the person's typing and presses into the next plan.
 * It runs inside the view's worker (viewSandbox.worker.ts); the page only draws what it answers (screens/Screen.tsx).
 *
 * Nothing in a view's text runs as it loads: a line starting with ! is refused, and the rest are added to the space as
 * atoms. Every call into the space is built as atoms and evaluated on a step budget (FUEL), so a rule that loops ends
 * as an error the frame shows. A view sees only its own space: the page's screens and other views are elsewhere.
 */
import { Atom, E, S, ValueAtom, atomToJs } from '@mettascript/hyperon'
import { gfloat, parseAll, standardTokenizer } from '@mettascript/core'
import { AtomRunner, symName } from '../../lib/metta/runner'
import { isSym, show, toAtom, toVal, type Val } from '../../lib/mindSpace/atoms'
import { plural } from '../../lib/plural'
import { NAME, readPlan, readProps, ScreensError, type ScreenPlan } from '../../screens/plan'
import libScreens from '../../screens/lib_screens.metta?raw'
import looks from '../../screens/looks.metta?raw'
import libView from './lib_view.metta?raw'

/** What the page draws for a view: the composed plan, the values its parts bind, and words for the maker. */
export interface ViewFrame {
  plan: ScreenPlan
  data: Record<string, unknown>
  /** words a press asked to put in the maker's message box (`say`), for the person to send or not */
  says: string[]
}

/** A mistake in the view itself, said so the person (and the mind they tell) can act on it. */
export class ViewProblem extends Error {}

/** MeTTaScript's own default step budget for one call (DEFAULT_FUEL): far above what a view's composition or a value
 *  takes, and a loop ends as (Error … StackOverflow) instead of running on. */
export const FUEL = 100_000

const NUMBER = /^-?\d+(\.\d+)?$/

/** A key named by an argument atom: a symbol's name, or a string as itself. */
const keyOf = (a: Atom | undefined): string => (a ? symName(toVal(a)) : '')

/** A number from what the person typed or a value worked out: "" and anything not a number are 0. */
function numberOf(a: Atom | undefined): number {
  const v = a ? atomToJs(a) : 0
  const n = typeof v === 'number' ? v : typeof v === 'string' && NUMBER.test(v.trim()) ? Number(v.trim()) : 0
  return Number.isFinite(n) ? n : 0
}

/** A number as MeTTa's decimal: MeTTaScript divides two whole numbers as whole numbers ((/ 15 100) is 0), so what a
 *  person types reads as a decimal, and a tip of 15 out of 100 is 0.15. */
const decimal = (n: number): Atom => Atom.fromCAtom(gfloat(n))

/**
 * `n` as text with `digits` decimals, rounded half away from zero on its decimal value: 84.5 x 0.15 is stored as
 * 12.674999999999999, which toFixed alone writes as 12.67; read to 15 significant digits it is 12.675, written 12.68
 * (the exponent shift of MDN's decimalAdjust, so no multiplication adds binary noise of its own).
 */
export function roundedText(n: number, digits: number): string {
  if (!Number.isFinite(n)) return ''
  const [mantissa, exponent = '0'] = String(Number(n.toPrecision(15))).split('e')
  const shifted = Number(`${mantissa}e${Number(exponent) + digits}`)
  const [wholeMantissa, wholeExponent = '0'] = String(Math.sign(shifted) * Math.round(Math.abs(shifted))).split('e')
  return Number(`${wholeMantissa}e${Number(wholeExponent) - digits}`).toFixed(digits)
}

/** A value as data for the page: a record ((key value) …) becomes an object, a list an array, a symbol its name. */
function toData(v: Val): unknown {
  if (Array.isArray(v)) {
    const record = v.length > 0 && v.every((x) => Array.isArray(x) && x.length === 2 && isSym(x[0]))
    return record ? readProps(v) : v.map(toData)
  }
  return isSym(v) ? v.sym : v
}

/** One piece of a `say`: words as written, a number or a symbol as text. */
const piece = (v: Val): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : isSym(v) ? v.sym : show(v))

/**
 * The facts lib_screens' conditions read, stated from the view's values: a list gives (count key) its length, a text
 * gives (count key) 1 when it is not empty, a whole number n >= 0 gives (count key) n, True or False gives the flag,
 * and a number (also one typed as text) or a one-word text or symbol gives (is key value).
 */
export function viewFacts(values: ReadonlyMap<string, Val>): Atom[] {
  const fact = (k: Atom, v: Atom) => E(S('Fact'), k, v)
  const count = (k: string, n: number) => fact(E(S('count'), S(k)), ValueAtom(n))
  const is = (k: string, v: Atom) => fact(S(k), E(S('Val'), v))
  const out: Atom[] = []
  for (const [k, v] of values) {
    if (!NAME.test(k)) continue
    if (Array.isArray(v)) out.push(count(k, v.length))
    else if (typeof v === 'boolean') out.push(fact(S(k), S(v ? 'yes' : 'no')))
    else if (typeof v === 'number') {
      out.push(is(k, ValueAtom(v)))
      if (Number.isInteger(v) && v >= 0) out.push(count(k, v))
    } else if (typeof v === 'string') {
      out.push(count(k, v === '' ? 0 : 1))
      if (NUMBER.test(v.trim())) out.push(is(k, ValueAtom(Number(v.trim()))))
      else if (NAME.test(v)) out.push(is(k, S(v)))
    } else if (isSym(v) && NAME.test(v.sym)) out.push(is(k, S(v.sym)))
  }
  return out
}

/** The press a view hears: its intent, the item's id (or chosen value) when it has one, and on or off for a tick. */
export interface Press {
  intent: string
  item?: { id?: unknown; value?: unknown }
  on?: boolean
}

export class MettaView {
  private readonly runner: AtomRunner
  /** the blocks a view may use, read before any of the view's atoms are in the space, so a view cannot add one */
  private readonly blocks: ReadonlySet<string>
  private program: Atom[] = []
  private screen = ''
  private starts = new Map<string, Atom>()
  private valueKeys: string[] = []
  /** what the person changed, or a press set, by key */
  private readonly typed = new Map<string, Atom>()

  constructor() {
    this.runner = new AtomRunner([['lib_screens', libScreens], ['looks', looks], ['lib_view', libView]], ViewProblem, FUEL)
    const m = this.runner.m
    // registered before a view is parsed, so its (state …), (num …) and (fixed …) read as these operations
    m.registerOperation('state', ([k]) => [this.stateOf(keyOf(k))])
    m.registerOperation('num', ([x]) => [decimal(numberOf(x))])
    m.registerOperation('fixed', ([x, d]) => [ValueAtom(roundedText(numberOf(x), Math.min(20, Math.max(0, Math.trunc(numberOf(d))))))])
    this.blocks = new Set(this.list('view-blocks').map(symName))
  }

  /** Load a view's MeTTa; a ViewProblem says why it cannot be drawn. */
  load(source: string): void {
    this.install(this.parse(source))
  }

  /**
   * Take up a new revision of the view, keeping what the person changed for every key the new one still starts. When
   * the new one cannot be drawn, the one before stays, and the ViewProblem says why.
   */
  replace(source: string, look: string): ViewFrame {
    const next = this.parse(source)
    const before = this.program
    try {
      this.install(next)
      const frame = this.render(look)
      for (const k of [...this.typed.keys()]) if (!this.starts.has(k)) this.typed.delete(k)
      return frame
    } catch (e) {
      this.install(before)
      throw e
    }
  }

  /** The person typed or picked `text` for `key`. */
  input(key: string, text: string): void {
    if (!NAME.test(key)) throw new ViewProblem(`it binds a value named ${JSON.stringify(key).slice(0, 40)}, which is not a name`)
    this.typed.set(key, ValueAtom(text))
  }

  /** A press: the view's (on …) rule for it answers what to do. A press nothing handles does nothing. */
  press({ intent, item, on }: Press): string[] {
    if (!NAME.test(intent)) throw new ViewProblem(`a press names ${JSON.stringify(intent).slice(0, 40)}, which is not a name`)
    const args: Atom[] = [S(intent)]
    const id = item?.id ?? item?.value
    if (typeof id === 'string' && id !== '') args.push(NAME.test(id) ? S(id) : ValueAtom(id))
    else if (typeof id === 'number' && Number.isFinite(id)) args.push(ValueAtom(id))
    if (typeof on === 'boolean') args.push(S(on ? 'True' : 'False'))
    const call = E(S('on'), ...args)
    const out = this.runner.m.evaluateAtom(call, FUEL)
    if (out.length === 0) return []
    if (out.length > 1) throw new ViewProblem(`a press on ${intent} has ${plural(out.length, 'answer')}, and one is needed`)
    const v = toVal(out[0])
    if (show(v) === show(toVal(call))) return []   // no rule for this press
    if (Array.isArray(v) && isSym(v[0], 'Error')) throw new ViewProblem(`a press on ${intent} went wrong: ${show(v).slice(0, 200)}`)
    if (!Array.isArray(v)) throw new ViewProblem(`a press on ${intent} answers ${show(v).slice(0, 80)}, not a list of what to do`)
    const says: string[] = []
    for (const effect of v) {
      if (Array.isArray(effect) && effect.length === 3 && isSym(effect[0], 'set') && isSym(effect[1]) && NAME.test(effect[1].sym)) {
        this.typed.set(effect[1].sym, toAtom(effect[2]))
      } else if (Array.isArray(effect) && effect.length >= 2 && isSym(effect[0], 'say')) {
        says.push(effect.slice(1).map(piece).join(''))
      } else {
        throw new ViewProblem(`a press on ${intent} asks for ${show(effect).slice(0, 80)}, and a view can only set a value or say words`)
      }
    }
    return says
  }

  /** Compose the view's screen for `look` from its values as they stand. */
  render(look: string): ViewFrame {
    if (!NAME.test(look)) throw new ViewProblem(`the look ${JSON.stringify(look).slice(0, 40)} is not a name`)
    const values = new Map<string, Val>()
    for (const k of new Set([...this.starts.keys(), ...this.valueKeys, ...this.typed.keys()])) values.set(k, this.valueOf(k))
    const facts = viewFacts(values)
    const space = this.runner.m.space()
    for (const f of facts) space.addAtom(f)
    let plan: ScreenPlan | null = null
    let fault: unknown = null
    try {
      plan = readPlan(this.runner.query('scr-compose', S(this.screen), S(look)), this.screen, look, this.runner.query('scr-title', S(this.screen)))
    } catch (e) {
      fault = e instanceof ScreensError ? new ViewProblem(`its screen could not be composed: ${e.message}`) : e
    }
    // a fact left behind would change every later composition, so the facts go whatever happened
    const cleared = space.removeAtoms(facts) === facts.length
    if (fault !== null || plan === null) throw fault ?? new ViewProblem('its screen could not be composed')
    if (!cleared) throw new ViewProblem('its facts could not be cleared')
    for (const part of plan.parts) {
      if (part.block === null) throw new ViewProblem(`part ${part.order} asks for ${'wanted' in part.how ? part.how.wanted : 'a block'}, which nothing draws`)
      if (!this.blocks.has(part.block)) throw new ViewProblem(`part ${part.order} uses the ${part.block} block, which a view may not use`)
    }
    return { plan, data: Object.fromEntries([...values].map(([k, v]) => [k, toData(v)])), says: [] }
  }

  /** The view's text as atoms, or the reason it cannot be read; a line that would run as it loads is refused. */
  private parse(source: string): Atom[] {
    try {
      if (parseAll(source, standardTokenizer()).some((top) => top.bang)) {
        throw new ViewProblem('a line in it starts with !, and a view holds declarations only')
      }
      return this.runner.m.parseAll(source)
    } catch (e) {
      throw e instanceof ViewProblem ? e : new ViewProblem(`its MeTTa could not be read: ${(e as Error)?.message ?? String(e)}`)
    }
  }

  /** Put `atoms` in the space in place of the view's last ones, and read what they declare. */
  private install(atoms: Atom[]): void {
    const space = this.runner.m.space()
    if (this.program.length && space.removeAtoms(this.program) !== this.program.length) throw new ViewProblem('its last version could not be cleared')
    for (const a of atoms) space.addAtom(a)
    this.program = atoms
    const screens = this.list('view-screens').map(symName)
    if (screens.length !== 1) throw new ViewProblem(screens.length ? `it names ${plural(screens.length, 'screen')}, and a view has one` : 'it names no screen: (Screen <name> "Title")')
    this.screen = screens[0]
    if (!NAME.test(this.screen)) throw new ViewProblem(`its screen is named ${JSON.stringify(this.screen).slice(0, 40)}, which is not a name`)
    const stray = this.runner.query('view-stray', S(this.screen))
    const lost = Array.isArray(stray) ? stray.slice(1).flatMap((xs) => (Array.isArray(xs) ? xs : [])) : []
    if (lost.length) throw new ViewProblem(`it has parts on a screen it does not name: ${lost.map(show).join(', ').slice(0, 120)}`)
    this.starts = new Map()
    for (const pair of this.list('view-starts')) {
      if (Array.isArray(pair) && pair.length === 2 && isSym(pair[0]) && NAME.test(pair[0].sym)) this.starts.set(pair[0].sym, toAtom(pair[1]))
    }
    this.valueKeys = this.list('view-values').filter((k): k is { sym: string } => isSym(k) && NAME.test(k.sym)).map((k) => k.sym)
  }

  /** A key's value as it stands: what the person changed, else where the view starts it, else empty text. */
  private stateOf(key: string): Atom {
    return this.typed.get(key) ?? this.starts.get(key) ?? ValueAtom('')
  }

  /** A key's value: its (value …) rule's one answer when the view has one, else its state. */
  private valueOf(key: string): Val {
    if (!this.valueKeys.includes(key)) return toVal(this.stateOf(key))
    try {
      return this.runner.query('value', S(key))
    } catch (e) {
      throw new ViewProblem(`its value ${key} cannot be worked out: ${(e as Error).message}`)
    }
  }

  private list(head: string): Val[] {
    const v = this.runner.query(head)
    return Array.isArray(v) ? v : []
  }
}
