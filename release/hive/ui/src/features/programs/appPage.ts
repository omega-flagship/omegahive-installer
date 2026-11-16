import { ACTION_LABEL, PERSON_APP_REASONS } from '../../api/personApps'
import type { FormId } from '../../forms/contract'
import type { PersonAppState } from '../../lib/personAppOpen'
import type { PropValue, ScreenFacts, ScreenPlan } from '../../screens/screenSpace'
import type { HomesState } from './homesLookup'

/**
 * What one app's page is told (program.metta): the values its screens draw (bound by path) and this moment's facts
 * (counts, flags and known symbols) from which MeTTa composes the notes over the app, the states before it opens, which
 * of the app's own surfaces show, and its Ω menu entries. Pure: the page hands in where it stands.
 */
export interface Composed { data: Record<string, unknown>; facts: ScreenFacts }
/** A swarm as the page names it. */
export interface Place { id: string; name: string }
export interface AppPageState {
  /** the app's name as the page shows it */
  name: string
  /** the swarm the app is open in, and its name */
  swarm: string | null
  swarmName: string
  /** it has its own interface; the form built for it, if any; it is Create; it is a person app */
  ui: boolean
  form: FormId | null
  create: boolean
  person: boolean
  personState: PersonAppState
  /** the views asked for: the graph, the app's own interface over its form, a Create bench, where it runs */
  view: { graph: boolean; own: boolean; code: boolean; flow: boolean; make?: boolean; access: boolean }
  /** this hive keeps a record of where apps run */
  canAccess: boolean
  homesState: HomesState
  /** the swarms it is set up in that the person can see */
  homesKnown: Place[]
  /** the swarm the page would open by itself: undefined while it cannot tell, null when nothing qualifies */
  pick: string | null | undefined
  /** the swarms the person may pick from when nothing qualifies */
  choices: Place[]
  /** every swarm the person sees, by name */
  swarms: Place[]
}

const BENCHES = [{ id: 'studio', label: 'Studio' }, { id: 'make', label: 'Make' }, { id: 'code', label: 'Code' }, { id: 'flow', label: 'Flow' }]

/** One app's page: the facts its three screens compose from (program, program-stage, program-menu) and their values. */
export function appPage(s: AppPageState): Composed {
  const { graph, own, code, flow, access } = s.view
  const make = !!s.view.make
  const current = !!s.swarm
  const homes = s.homesState.kind === 'known' ? s.homesState.homes : null
  const ready = s.personState.kind === 'ready' ? s.personState : null
  const failed = s.personState.kind === 'failed' ? s.personState : null
  const values: Record<string, string> = {
    homes: s.homesState.kind,
    pick: s.pick === null ? 'nowhere' : s.pick === undefined ? 'pending' : 'chosen',
  }
  if (s.form) values['form.kind'] = s.form
  if (s.person) values.person = s.personState.kind
  if (ready) values['person.helpers'] = ready.helpers
  if (failed) {
    values['person.reason'] = failed.reason
    values['person.action'] = PERSON_APP_REASONS[failed.reason].action
  }
  const flags = {
    'app.current': current,
    'app.ui': s.ui,
    'app.form': !!s.form,
    'app.create': s.create,
    'app.person': s.person,
    'view.graph': graph,
    'view.own': own,
    'bench.code': code,
    'bench.flow': flow,
    'bench.make': make,
    'view.access': access,
    'can.access': s.canAccess,
    'homes.here': !!homes?.some((h) => h.swarm_id === s.swarm),
    'homes.denied': s.homesState.kind === 'failed' && s.homesState.denied,
    'swarms.several': s.swarms.length > 1,
    'person.key': !!ready && (ready.helpers === 'key' || ready.needs.length > 0),
    'person.monthly': !!ready && ready.needs.includes('monthly_total'),
  }
  const elsewhere = !code && !flow && !make
  return {
    facts: { counts: { 'homes.all': homes?.length ?? 0, 'swarms.choices': s.choices.length }, flags, values },
    data: {
      // the flags again, for the parts that stay mounted but hidden under another view (hidden-when)
      ...flags,
      'app.name': s.name,
      'app.swarm': s.swarm ?? '',
      'swarm.name': s.swarmName,
      'homes.known': s.homesKnown,
      'swarms.choices': s.choices,
      'swarms.menu': s.swarms.map((w) => ({ id: w.id, label: w.name })),
      benches: BENCHES,
      bench: code ? 'code' : flow ? 'flow' : make ? 'make' : 'studio',
      'person.reason_text': failed ? PERSON_APP_REASONS[failed.reason].text : '',
      'person.action_label': failed ? ACTION_LABEL[PERSON_APP_REASONS[failed.reason].action] : '',
      // which view the menu marks as shown
      'menu.form': elsewhere && !graph && !(s.ui && own),
      'menu.own': elsewhere && !graph && (!s.form || own),
      'menu.graph': elsewhere && graph,
    },
  }
}

export type ClosedState = 'opening' | 'unlisted' | 'unreadable'
/** The page for an app this person may not open here, or not yet known to be one: it names nothing of the app. */
export function closedPage(state: ClosedState, canRetry: boolean): Composed {
  return { data: {}, facts: { flags: { 'can.retry': canRetry }, values: { state } } }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const sym = (p: PropValue | undefined): string => (typeof p === 'string' ? p : '')
const isBound = (p: PropValue | undefined): p is { bind: string } => typeof p === 'object' && p !== null && !Array.isArray(p) && typeof (p as { bind?: unknown }).bind === 'string'
/** A label: itself, its bound value, or `(words …)` joined. */
function words(p: PropValue | undefined, data: Record<string, unknown>): string {
  if (isBound(p)) return str(data[p.bind])
  if (Array.isArray(p) && p[0] === 'words') return p.slice(1).map((w) => words(w, data)).join('')
  return str(p)
}

/** One of the app's Ω entries: its words, whether it is marked, and the press it sends (with the item it names). */
export interface MenuEntry { label: string; checked?: boolean; action: string; item: Record<string, unknown> }
export interface MenuSection { title?: string; items: MenuEntry[] }

/**
 * The menu MeTTa composed (program-menu) as the Ω menu's sections, in order: a part's (section "…") names its section
 * (none: the app's own, first); a buttons part gives one entry per button, marked when it names a (checked flag); a
 * list part gives one entry per item, marked when it is the (current …) one. The page turns each entry's press into
 * its own act.
 */
export function menuSections(plan: ScreenPlan, data: Record<string, unknown>): MenuSection[] {
  const sections: MenuSection[] = []
  const into = (title: string | undefined) => {
    let at = sections.find((x) => x.title === title)
    if (!at) sections.push((at = title === undefined ? { items: [] } : { title, items: [] }))
    return at.items
  }
  for (const part of plan.parts) {
    const p = part.props
    const items = into(typeof p.section === 'string' ? p.section : undefined)
    if (part.block === 'buttons') {
      for (const b of Array.isArray(p.items) ? p.items : []) {
        if (!Array.isArray(b) || b[0] !== 'button') continue
        const opts: Record<string, PropValue> = {}
        for (const o of Array.isArray(b[3]) ? b[3] : []) if (Array.isArray(o) && o.length === 2 && typeof o[0] === 'string') opts[o[0]] = o[1]
        const entry: MenuEntry = { label: words(b[1], data), action: sym(b[2]), item: {} }
        if (opts.checked !== undefined) entry.checked = data[sym(opts.checked)] === true
        items.push(entry)
      }
    } else if (part.block === 'list') {
      const list = data[sym(p.source)]
      const chosen = p.current !== undefined ? words(p.current, data) : null
      for (const it of Array.isArray(list) ? (list as Record<string, unknown>[]) : []) {
        const entry: MenuEntry = { label: str(it[sym(p.title)]), action: sym(p.open), item: it }
        if (chosen !== null) entry.checked = str(it.id) === chosen
        items.push(entry)
      }
    }
  }
  return sections.filter((x) => x.items.length > 0)
}
