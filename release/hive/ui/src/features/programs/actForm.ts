import type { ParamSchema, ProgramAction } from '../../api/types'
import type { ScreenFacts, ScreenPlan } from '../../screens/screenSpace'
import type { PendingInput } from '../../store/programSession'

/**
 * An app's actions on its graph, as program.metta composes them: the actions that need no item (program-actions), and
 * the form that asks for an action's inputs (program-act, one program-act-field per input). Pure: the page hands in
 * the actions, what is asked, the values typed so far and its composer.
 *
 * An action declares each input as 0.1's words (what it means) or as one MCP elicitation form field (ParamSchema). The
 * page draws words as a text field and a form field by its shape; the app checks what it is sent, as an MCP server
 * checks an elicitation's answer, so the page marks nothing required and leaves a blank field out.
 */
export type Compose = (screen: string, facts: ScreenFacts) => ScreenPlan
export type FieldKind = 'text' | 'number' | 'choice' | 'ticks'
export interface Choice { id: string; label: string }
/** One input as the form draws it. `many`: several ticks may be on (a list is sent); otherwise one tick is yes or no. */
export interface Field {
  name: string
  kind: FieldKind
  label: string
  help: string
  choices: Choice[]
  many: boolean
  integer: boolean
  least?: number
  most?: number
  /** the declared default, filled in until the person changes it */
  start?: Value
}
export type Value = string | boolean | string[]
export type Values = Record<string, Value>

const titled = (list: { const?: unknown; title?: string }[] | undefined): Choice[] =>
  (Array.isArray(list) ? list : []).flatMap((o) => (o && typeof o.const === 'string' ? [{ id: o.const, label: o.title || o.const }] : []))
const plain = (list: unknown[] | undefined): Choice[] => (Array.isArray(list) ? list : []).flatMap((v) => (typeof v === 'string' ? [{ id: v, label: v }] : []))

/**
 * One input as a field, from how the app declared it: a choice when it lists choices (`oneOf` with titles, else
 * `enum`), ticks for a list of choices or a yes or no, a number for a number or an integer, words otherwise (0.1's
 * description, a string, or a shape the page does not draw, which the app then checks). A choice with no usable
 * value is dropped; with none left the field takes words.
 */
export function fieldOf(name: string, spec: string | ParamSchema | undefined, words: string): Field {
  const s: ParamSchema = typeof spec === 'object' && spec !== null && !Array.isArray(spec) ? spec : {}
  const label = s.title || name
  const base = { name, label, help: words && words !== label ? words : '', choices: [] as Choice[], many: false, integer: false }
  if (s.type === 'array') {
    const choices = s.items?.anyOf ? titled(s.items.anyOf) : plain(s.items?.enum)
    if (choices.length) {
      const start = Array.isArray(s.default) ? s.default.filter((d) => choices.some((c) => c.id === d)) : undefined
      return { ...base, kind: 'ticks', choices, many: true, ...(start ? { start } : {}) }
    }
    return { ...base, kind: 'text' }
  }
  const choices = s.oneOf ? titled(s.oneOf) : plain(s.enum)
  if (choices.length) return { ...base, kind: 'choice', choices, ...(typeof s.default === 'string' && choices.some((c) => c.id === s.default) ? { start: s.default } : {}) }
  if (s.type === 'boolean') return { ...base, kind: 'ticks', choices: [{ id: name, label: 'Yes' }], ...(typeof s.default === 'boolean' ? { start: s.default } : {}) }
  if (s.type === 'number' || s.type === 'integer') {
    return { ...base, kind: 'number', integer: s.type === 'integer', least: s.minimum, most: s.maximum, ...(typeof s.default === 'number' ? { start: String(s.default) } : {}) }
  }
  return { ...base, kind: 'text', ...(typeof s.default === 'string' ? { start: s.default } : {}) }
}

/** The fields of what is asked, in its order: every input but `items`, which the person selects on the stage. */
export function formFields(input: PendingInput, def: ProgramAction | undefined): Field[] {
  return Object.keys(input.needs).filter((k) => k !== 'items').map((k) => fieldOf(k, def?.params?.[k], input.needs[k]))
}

/** A value already sent for an input, as its field holds it; anything else is not one. */
function held(f: Field, v: unknown): Value | undefined {
  if (f.kind === 'ticks') return f.many ? (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined) : typeof v === 'boolean' ? v : undefined
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined
}

/** What the form starts with: what was sent before for each input (the app asked again), else its declared default. */
export function startValues(input: PendingInput, fields: Field[]): Values {
  const out: Values = {}
  for (const f of fields) {
    const v = held(f, input.params[f.name]) ?? f.start
    if (v !== undefined) out[f.name] = v
  }
  return out
}

/** A tick: a yes or no is set to it; one of several choices joins or leaves the list, kept in the declared order. */
export function ticked(values: Values, f: Field, choice: string, on: boolean): Values {
  if (!f.many) return { ...values, [f.name]: on }
  const now = Array.isArray(values[f.name]) ? (values[f.name] as string[]) : []
  const next = on ? [...now, choice] : now.filter((x) => x !== choice)
  return { ...values, [f.name]: f.choices.map((c) => c.id).filter((id) => next.includes(id)) }
}

/**
 * The params a Send carries: what was sent before (the app asked again), each field's value in the type its
 * declaration gives (a number as a number, ticks as yes or no or a list), and a blank field left out, so an app reads
 * an input it did not get as missing.
 */
export function sentParams(input: PendingInput, fields: Field[], values: Values): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input.params }
  for (const f of fields) {
    delete out[f.name]
    const v = values[f.name]
    if (v === undefined) continue
    if (f.kind === 'ticks') out[f.name] = f.many ? (Array.isArray(v) ? v : []) : v === true
    else if (typeof v !== 'string' || v.trim() === '') continue
    else if (f.kind === 'number') {
      const n = Number(v)
      if (Number.isFinite(n)) out[f.name] = n
    } else out[f.name] = v
  }
  return out
}

/** The form for what is asked: its words and one composed field per input, each holding its value. */
export function actForm(input: PendingInput, def: ProgramAction | undefined, fields: Field[], values: Values, compose: Compose): { plan: ScreenPlan; data: Record<string, unknown> } {
  const stack = fields.map((f) => {
    const v = values[f.name]
    return {
      id: f.name,
      plan: compose('program-act-field', { flags: { 'field.helped': f.help !== '' }, values: { 'field.kind': f.kind } }),
      data: {
        'field.label': f.label,
        'field.help': f.help,
        'field.value': typeof v === 'string' ? v : '',
        'field.options': f.choices,
        'field.ticks': f.kind === 'ticks' ? f.choices.map((c) => ({ id: c.id, label: c.label, on: f.many ? Array.isArray(v) && v.includes(c.id) : v === true })) : [],
        'field.least': f.least ?? '',
        'field.most': f.most ?? '',
        'field.step': f.kind === 'number' ? (f.integer ? '1' : 'any') : '',
      },
    }
  })
  return {
    plan: compose('program-act', { counts: { 'act.fields': stack.length }, flags: { 'act.asked': input.asked, 'act.said': !!input.message, 'act.items': 'items' in input.needs } }),
    data: { 'act.title': def?.label ?? input.action, 'act.message': input.message ?? '', 'act.items': input.needs.items ?? '', 'act.fields': stack },
  }
}

/** The actions that need no item, as rows: each one's words, and what it asks for when it declares its inputs. */
export function appActions(actions: ProgramAction[], compose: Compose): { plan: ScreenPlan; data: Record<string, unknown> } {
  const rows = actions.map((a) => {
    const asks = Object.entries(a.params ?? {}).map(([k, spec]) => (typeof spec === 'object' && spec?.title) || k)
    return { id: a.id, label: a.label ?? a.id, icon: 'bolt', takes: asks.length ? `Asks for ${asks.join(', ')}` : '' }
  })
  return { plan: compose('program-actions', { counts: { 'actions.none': rows.length } }), data: { 'actions.none': rows } }
}
