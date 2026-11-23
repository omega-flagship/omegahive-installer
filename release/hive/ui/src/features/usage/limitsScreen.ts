// Purpose: what the Usage screen's spending limits (usage.metta) are told: the hive cap, each person's monthly allowance, the caps someone set and the old form defaults, each limit a row composed as its own usage-limit screen, the Add a cap form's choices, what each row's presses change, and the limits' state as the resource named limits. Pure: names, who may change what, the open editors and composing come in as arguments.
import type { KeyInfo } from '../../api/types'
import { hsl } from '../../lib/color'
import { shown } from '../../lib/displayName'
import { money } from '../../lib/format'
import { withResource, type ResourceLike } from '../../screens/resourceFacts'
import type { ScreenFacts, ScreenPlan } from '../../screens/screenSpace'
import { spentAndHeld } from './heldWords'
import type { LimitRowView, LimitsView, OldDefault, PersonLimits } from './limitsView'

export type Compose = (screen: string, facts: ScreenFacts) => ScreenPlan
/** One row of a stack: its id, the screen MeTTa composed for it, and the values that screen draws. */
export interface StackItem { id: string; plan: ScreenPlan; data: Record<string, unknown> }

/** A limit's period in words, after its figure ("$50.00 per month"). */
export const PERIOD: Record<string, string> = { day: 'per day', month: 'per month', total: 'in total', 'all-time': 'all time' }
/** Where a person's monthly allowance comes from, on their row. */
const ALLOWANCE_FROM: Record<PersonLimits['source'], string> = {
  set: 'their own',
  'member-default': 'member default',
  visitor: 'visitor limit',
  none: 'no allowance',
}
/** A person's colour on the limits (the people part's hue). */
const PERSON_HUE = 160

/** What a limit applies to, as its row names it: its kind, its name and its colour. */
export interface Who { kind: string; label: string; hue: number }
/** The names the limits are given: the hive's swarms, minds and keys. may_cap is the host's word on whether this viewer
 *  may cap a swarm or mind, its owner alone (hive/core/limits_view.py limit_refusal); absent from older hosts. */
export interface Names {
  swarms: Record<string, { name: string; hue: number; may_cap?: boolean }>
  agents: Record<string, { name: string; hue: number; may_cap?: boolean }>
  keys: Pick<KeyInfo, 'id' | 'label' | 'hint'>[]
}

/** A limit's scope ("hive", "swarm:s_kelp", "agent:a_nori06", "person:p_ada", "key:k1") as its row names it. */
export function whoOf(scope: string, people: PersonLimits[], names: Names): Who {
  const [kind, id = ''] = scope.split(/:(.*)/s)
  if (kind === 'hive') return { kind: 'Whole hive', label: 'All paid calls', hue: 252 }
  if (kind === 'every-mind') return { kind: 'Every mind', label: 'Each mind with no cap of its own', hue: 230 }
  if (kind === 'swarm') return { kind: 'Swarm', label: shown(names.swarms[id]?.name ?? id), hue: names.swarms[id]?.hue ?? 200 }
  if (kind === 'agent') return { kind: 'Mind', label: shown(names.agents[id]?.name ?? id), hue: names.agents[id]?.hue ?? 280 }
  if (kind === 'person') return { kind: 'Person', label: shown(people.find((p) => p.person_id === id)?.name ?? id), hue: PERSON_HUE }
  const k = names.keys.find((x) => x.id === id)
  return { kind: 'Key', label: k ? `${k.label} ${k.hint}` : id, hue: 262 }
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * A limit's meter as the progress block draws it: what is spent in the limit's colour, what calls not yet settled hold
 * in a striped paler one, then the room on the bare track, each as wide as its dollars and named by them for assistive
 * technology. Its colour turns amber past 70% used and red past 90%, as the hand-made Meter did.
 */
export function meterParts(spent: number, held: number, max: number, hue = 252): { label: string; n: number; color?: string }[] {
  const [s, h] = [Math.max(0, spent), Math.max(0, held)]
  const used = max > 0 ? (s + h) / max : 0
  const tone = used > 0.9 ? 356 : used > 0.7 ? 38 : hue
  return [
    { label: 'dollars spent', n: round2(s), color: `linear-gradient(90deg, ${hsl(tone, 90, 60)}, ${hsl(tone, 100, 75)})` },
    { label: 'dollars held', n: round2(h), color: `repeating-linear-gradient(135deg, ${hsl(tone, 90, 65, 0.55)} 0 3px, ${hsl(tone, 90, 65, 0.2)} 3px 6px)` },
    { label: 'dollars left', n: round2(Math.max(0, max - s - h)) },
  ]
}

/**
 * j0-fixes r1 (J0 live): the editor showed the raw float ("3.914502…"). It shows dollars and cents; saving the shown
 * figure unchanged changes nothing (the rounding alone never moves a limit). Returns the amount to save, or null. A
 * figure with no current value (null: an allowance or cap not set yet) starts empty, so nothing is saved that nobody typed.
 */
export const limitDraft = (usd: number): string => (Number.isFinite(usd) ? usd.toFixed(2) : '')
export function limitToSave(draft: string, current: number | null): number | null {
  if (current !== null && draft.trim() === limitDraft(current)) return null
  const n = Number(draft)
  return draft.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null
}

/** A limit's figures: "$1.20 + $0.30 held / $5.00 per month". */
const figuresWords = (row: LimitRowView) =>
  `${money(row.spent_usd)}${row.held_usd > 0 ? ` + ${money(row.held_usd)} held` : ''} / ${money(row.limit_usd)} ${PERIOD[row.period] ?? ''}`.trim()
/** What is spent and held against a limit, its room, and the month's pace where the page has one. */
const roomWords = (row: LimitRowView, pace?: number) =>
  `${spentAndHeld(row.spent_usd, row.held_usd)}. ${money(row.room_usd)} of room${pace !== undefined && pace > 0 ? `, at ${money(pace)} a day so far this month` : ''}.`

/**
 * What a row's presses change: the figure its editor starts from (null: one not set yet, so the editor starts empty),
 * the limit a save stores (its scope, period and the name the toast gives), and the rule a removal takes away, with what
 * follows from it. A row with no save cannot be changed here; one with no removal cannot be removed.
 */
export interface LimitAction {
  id: string
  current: number | null
  save?: { scope: string; period: string; label: string }
  remove?: { row: LimitRowView; label: string; after: string }
}

/** The Add a cap form while it is open: what is chosen and typed. */
export interface AddingCap { scope: string; period: string; limit: string }

export interface LimitsInput {
  /** the limits once read; undefined while loading, refused or failed */
  view: LimitsView | undefined
  names: Names
  canSet: boolean
  canRemove: boolean
  /** the hive lets a mind's own cap be changed, which removing a mind's old default needs */
  canPatchAgent: boolean
  /** the editors open now: a row's id (HIVE_EDITOR for the monthly hive cap to set) and what is typed in it */
  drafts: Record<string, string>
  adding: AddingCap | null
}

/** The editor's id for setting a monthly hive cap where there is none. */
export const HIVE_EDITOR = 'hive:set'

/** The old defaults' row ids, each the kind and id of what it caps. */
const oldId = (o: OldDefault) => `${o.kind}:${o.id}`

/**
 * The limits' data and facts, and what each row's presses change. Each limit row is composed here as its own usage-limit
 * screen (the hive cap, the server's all-time figure, each person, each cap set). Time: r compositions per call, r rows,
 * each one kept by the composer once its facts have been seen.
 */
export function limitsScreen(res: ResourceLike, input: LimitsInput, compose: Compose): { data: Record<string, unknown>; facts: ScreenFacts; actions: Record<string, LimitAction> } {
  const view = input.view
  const people = view?.people ?? []
  const actions: Record<string, LimitAction> = {}
  const row = (id: string, r: LimitRowView, who: Who, action: Omit<LimitAction, 'id' | 'current'>, pace?: number): StackItem => {
    actions[id] = { id, current: r.limit_usd, ...action }
    const editing = input.drafts[id] !== undefined
    // a mind's or swarm's cap is its owner's alone (may_change, the hive's own rule): others see it, unchangeable
    const badge = r.source === 'session' ? 'while a session runs' : r.may_change === false ? 'its owner’s to change' : ''
    return {
      id,
      plan: compose('usage-limit', {
        flags: { 'limit.badged': badge !== '', 'limit.figured': true, 'limit.changeable': action.save !== undefined, 'limit.editing': editing,
          'limit.removable': action.remove !== undefined, 'limit.holding': r.held_usd > 0 },
      }),
      data: {
        'limit.label': who.label, 'limit.kind': who.kind, 'limit.badge': badge, 'limit.hue': who.hue,
        'limit.figures': figuresWords(r), 'limit.parts': meterParts(r.spent_usd, r.held_usd, r.limit_usd, who.hue), 'limit.room': roomWords(r, pace),
        'limit.draft': input.drafts[id] ?? '', 'limit.remove.aria': 'Remove this limit',
      },
    }
  }
  const person = (p: PersonLimits): StackItem => {
    const id = `person:${p.person_id}`
    const label = shown(p.name)
    const a = p.allowance
    actions[id] = {
      id, current: a ? a.limit_usd : null,
      ...(input.canSet ? { save: { scope: `person:${p.person_id}`, period: 'month', label } } : {}),
      ...(p.source === 'set' && input.canRemove && a ? { remove: { row: a, label, after: 'Their allowance goes back to the member default.' } } : {}),
    }
    return {
      id,
      plan: compose('usage-limit', {
        flags: { 'limit.badged': true, 'limit.figured': a !== null, 'limit.changeable': input.canSet, 'limit.editing': input.drafts[id] !== undefined,
          'limit.removable': actions[id].remove !== undefined, 'limit.holding': (a?.held_usd ?? 0) > 0 },
      }),
      data: {
        'limit.label': label,
        'limit.kind': p.grants === 0 ? '' : p.grants === 1 ? 'plus a grant on an owner’s key' : `plus ${p.grants} grants on owners’ keys`,
        'limit.badge': ALLOWANCE_FROM[p.source], 'limit.hue': PERSON_HUE,
        'limit.figures': a ? figuresWords(a) : '', 'limit.parts': a ? meterParts(a.spent_usd, a.held_usd, a.limit_usd, PERSON_HUE) : [],
        'limit.room': a ? roomWords(a, p.pace_usd_per_day) : '',
        'limit.unset': `An admin with no allowance of their own: the hive cap holds what they spend on the hive’s money (${money(p.spent_usd)} this month).`,
        'limit.draft': input.drafts[id] ?? '', 'limit.remove.aria': `Remove ${label}’s own allowance`,
      },
    }
  }

  const cap = view?.hive.cap ?? null
  const allTime = view?.hive.all_time ?? null
  const hive = cap ? [row(cap.key, cap, whoOf('hive', people, input.names), input.canSet ? { save: { scope: 'hive', period: cap.period, label: 'Whole hive' } } : {}, view!.hive.pace_usd_per_day)] : []
  const server = allTime ? [row(`all-time:${allTime.key}`, allTime, { kind: 'Server setting', label: 'HIVE_BUDGET_USD, until the hive has a cap', hue: 252 }, {})] : []
  const caps = (view?.caps ?? []).map((r) => {
    const who = whoOf(r.scope, people, input.names)
    return row(r.key + (r.rule_id ?? ''), r, who, {
      ...(input.canSet && r.source === 'set' && r.may_change !== false ? { save: { scope: r.scope, period: r.period, label: who.label } } : {}),
      ...(r.source === 'set' && input.canRemove && r.may_change !== false ? { remove: { row: r, label: who.label, after: 'The hive cap and each payer’s allowance still hold this spending.' } } : {}),
    })
  })
  actions[HIVE_EDITOR] = { id: HIVE_EDITOR, current: null, ...(input.canSet ? { save: { scope: 'hive', period: 'month', label: 'Whole hive' } } : {}) }
  const olds = view?.old_defaults ?? []
  // only a mind's or swarm's owner removes its old default (may_change): the one action covers the viewer's own
  const mine = ownOldDefaults(view)
  const all = mine.length === olds.length
  const canRemoveOld = input.canRemove && input.canPatchAgent
  const adding = input.adding
  const everyMind = adding?.scope === 'every-mind'
  const { swarms, agents, keys } = input.names

  return {
    ...withResource(res, {
      data: {
        'limits.hive': hive,
        'limits.hive.all-time': server,
        'limits.hive.draft': input.drafts[HIVE_EDITOR] ?? '',
        'limits.people': people.map(person),
        'limits.caps': caps,
        'limits.old': olds.map((o) => ({
          id: oldId(o), change: o.change, reasons: o.reasons.join('; ') + (o.may_change === false ? ' · its owner’s to remove' : ''),
          action: canRemoveOld && o.may_change !== false ? 'Remove' : '', aria: `Remove the old default on ${o.name}`,
        })),
        'limits.old.all': all ? (mine.length === 1 ? 'Remove it' : `Remove all ${mine.length}`) : mine.length === 1 ? 'Remove yours' : `Remove your ${mine.length}`,
        'limits.add.scope': adding?.scope ?? '',
        'limits.add.period': everyMind ? 'month' : (adding?.period ?? 'month'),
        'limits.add.limit': adding?.limit ?? '',
        'limits.add.every-mind': everyMind,
        'limits.add.scopes': [
          // a cap on a swarm or a mind is its owner's alone (may_cap): only the viewer's own are offered
          ...Object.entries(swarms).filter(([, s]) => s.may_cap !== false).map(([id, s]) => ({ id: `swarm:${id}`, label: `Swarm · ${shown(s.name)}` })),
          ...Object.entries(agents).filter(([, a]) => a.may_cap !== false).map(([id, a]) => ({ id: `agent:${id}`, label: `Mind · ${shown(a.name)}` })),
          ...keys.map((k) => ({ id: `key:${k.id}`, label: `Key · ${k.label} ${k.hint}` })),
          { id: 'every-mind', label: 'Every mind with no cap of its own' },
          { id: 'hive', label: 'Whole hive' },
        ],
        'limits.add.periods': [{ id: 'day', label: 'per day' }, { id: 'month', label: 'per month' }, { id: 'total', label: 'in total' }],
      },
      facts: {
        counts: { 'limits.people': people.length, 'limits.caps': caps.length, 'limits.old': olds.length, 'limits.old.mine': mine.length },
        flags: {
          'limits.adding': adding !== null, 'limits.can-set': input.canSet, 'limits.can-remove-old': canRemoveOld,
          'limits.old.others': !all,
          'limits.hive-cap': cap !== null, 'limits.hive-all-time': allTime !== null, 'limits.hive.editing': input.drafts[HIVE_EDITOR] !== undefined,
        },
      },
    }, 'limits'),
    actions,
  }
}

/** The old form defaults as the page removes them: by the ids their rows carry. */
export const oldDefaultsById = (view: LimitsView | undefined): Record<string, OldDefault> =>
  Object.fromEntries((view?.old_defaults ?? []).map((o) => [oldId(o), o]))

/** The old form defaults this viewer may remove: those on their own minds and swarms (may_change). */
export const ownOldDefaults = (view: LimitsView | undefined): OldDefault[] =>
  (view?.old_defaults ?? []).filter((o) => o.may_change !== false)
