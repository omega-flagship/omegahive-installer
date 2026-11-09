import type { Me, Person } from '../../api/client'
import type { Agent, Goal, Motivation, MotivationRef, MotivationStatus, Swarm, Visibility } from '../../api/types'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import {
  atLeast,
  createRights,
  creatorLine,
  isUnsorted,
  LINK_MEANS,
  linkable,
  ownerKind,
  ownerLine,
  PARTIAL_WORDS,
  progressOf,
  sortMotivations,
  STATUS_ORDER,
  STATUS_WORDS,
  tasksOf,
  VISIBILITY_CHOICES,
  VISIBILITY_WORDS,
  visibilityProblem,
  WORDS,
  type Progress,
} from '../../lib/motivations'
import type { Compose, ScreenFacts } from '../../screens/screenSpace'
import { withResource, type ResourceLike } from '../../screens/resourceFacts'

/**
 * What the Motivations screens are told (motivations.metta): the values they draw (bound by path) and this moment's
 * facts (counts, flags and known values), from which MeTTa composes them. Pure: the hive's data and the page's own
 * state come in as arguments. A card, the new-motivation form, a motivation's own card, its people box and its
 * file-tasks box are each a small screen of their own, composed here and stacked by the screen around them.
 */
type Names = { me?: Pick<Me, 'principal'> | null; agents: Record<string, Agent>; swarms: Record<string, Swarm> }
type Screened = { data: Record<string, unknown>; facts: ScreenFacts }

/** A status's badge tone (Screen.tsx tones): live in green, paused in amber, done and retired quiet. */
export const STATUS_TONE: Record<MotivationStatus, string> = { active: 'good', paused: 'warn', achieved: 'low', retired: 'info' }

/** The parts of a motivation's tasks, each counted once, as the progress block draws them (cancelled ones not counted). */
export function progressParts(p: Progress): { n: number; label: string; color: string }[] {
  return [
    { n: p.done, label: 'done', color: '#4ade80' },
    { n: p.review, label: 'awaiting review', color: '#a78bfa' },
    { n: p.working, label: 'in progress', color: '#7dd3fc' },
    { n: p.open, label: 'open', color: '#a5b4fc' },
    { n: p.failed, label: 'failed', color: '#fb7185' },
  ]
}

/** "2 of 5 tasks done · 1 failed · …": done of (all but cancelled), so failures show; a partial read says so. */
export function progressWords(p: Progress, partial: boolean): string {
  const base = p.total - p.cancelled
  return (
    `${p.done} of ${base} task${base === 1 ? '' : 's'} done` +
    (p.failed ? ` · ${p.failed} failed` : '') +
    (p.review ? ` · ${p.review} awaiting review` : '') +
    (p.cancelled ? ` · ${p.cancelled} cancelled, not counted` : '') +
    (partial ? ` · ${PARTIAL_WORDS}` : '')
  )
}

const metaLine = (m: Motivation, names: Names, now: number) => `${ownerLine(m, names)} · ${creatorLine(m, names)} · ${ago(m.created_at, now)}`

// ---------------------------------------------------------------- the people a motivation is shared with

export interface PeopleRead {
  /** the people list as read (null while reading) */
  read: Person[] | null
  /** this hive can list people (when it cannot, nobody is read, and only those already named are shown) */
  canList: boolean
}

/**
 * Everyone signed in to this hive but you, ticked by principal, plus anyone already named who is not on that list (so
 * saving never drops them silently). While the list is being read, nothing is offered yet.
 */
export function peopleChoices(people: PeopleRead, me: Pick<Me, 'principal'> | null | undefined, value: readonly string[]) {
  const read = people.canList ? people.read : []
  const known = (read ?? []).map((p) => ({ principal: `user:${p.id}`, name: p.name || p.email || p.id })).filter((p) => p.principal !== me?.principal)
  const extra = value.filter((p) => !known.some((k) => k.principal === p)).map((p) => ({ principal: p, name: p.replace(/^user:/, '') }))
  return { reading: read === null, items: [...known, ...extra].map((p) => ({ id: p.principal, label: p.name, on: value.includes(p.principal) })) }
}

// ---------------------------------------------------------------- the list

/** The new-motivation form as the person has filled it so far. */
export interface CreateDraft {
  title: string
  why: string
  /** a pick of whose it is, or null for the default this person's rights give */
  picked: string | null
  /** a pick of who can see it, or null for the default (a swarm's is public, a person's private) */
  visibility: Visibility | null
  people: string[]
  busy: boolean
  error: string | null
}
export const NEW_DRAFT: CreateDraft = { title: '', why: '', picked: null, visibility: null, people: [], busy: false, error: null }

/** Whose it is ('me', 'me:<swarm>' or 'team:<swarm>'), who can see it, and why it cannot be made yet. */
export function createChoice(draft: CreateDraft, me: Me | undefined, swarms: Record<string, Swarm>) {
  const rights = createRights(me, swarms)
  const whose = draft.picked ?? (rights.personal.may ? 'me' : rights.teams[0] ? `team:${rights.teams[0].id}` : '')
  const team = whose.startsWith('team:')
  const visibility: Visibility = draft.visibility ?? (team ? 'public' : 'private')
  const problem = visibilityProblem(visibility, draft.people)
  const held = !draft.title.trim() || draft.busy || !whose || !!problem
  return { rights, whose, team, visibility, problem, held }
}

export interface ListInput {
  motivations: Record<string, Motivation>
  links: Record<string, MotivationRef[]>
  goals: Record<string, Goal>
  me: Me | undefined
  agents: Record<string, Agent>
  swarms: Record<string, Swarm>
  /** the hive keeps motivations */
  supported: boolean
  /** they have been read */
  loaded: boolean
  /** a read of motivations or task links stopped early */
  partial: boolean
  /** the new-motivation form is open, and what is in it */
  making: boolean
  draft: CreateDraft
  people: PeopleRead
  /** OmegaEvolve's objective is offered */
  evolveShown: boolean
  now: number
}

export function motivationsScreen(input: ListInput, compose: Compose): Screened {
  const { motivations, links, goals, me, agents, swarms, supported, loaded, partial, now } = input
  const names: Names = { me, agents, swarms }
  const rights = createRights(me, swarms)
  const mayMake = rights.personal.may || rights.teams.length > 0
  const all = sortMotivations(Object.values(motivations))
  const mine = all.filter((m) => me && m.owner === me.principal)
  const rest = all.filter((m) => !mine.includes(m))
  const groups = {
    mine,
    team: rest.filter((m) => ownerKind(m.owner) === 'team'),
    mind: rest.filter((m) => ownerKind(m.owner) === 'mind'),
    people: rest.filter((m) => ownerKind(m.owner) === 'person'),
  }
  const card = (m: Motivation) => {
    const p = progressOf(tasksOf(m.id, links), goals)
    const facts: ScreenFacts = { counts: { 'card.tasks': p.total }, flags: { 'card.why': !!m.why, 'counts.partial': partial } }
    return {
      id: m.id,
      plan: compose('motivation-card', facts),
      data: {
        'card.title': m.title,
        'card.status': STATUS_WORDS[m.status],
        'card.tone': STATUS_TONE[m.status],
        'card.quiet': m.status !== 'active',
        'card.why': m.why,
        'card.progress': progressParts(p),
        'card.progress.text': progressWords(p, partial),
        'counts.partial': partial,
        'card.meta': metaLine(m, names, now),
      },
    }
  }
  const unsorted = Object.values(goals).filter((g) => isUnsorted(links, g.id) && g.status !== 'done' && g.status !== 'cancelled' && g.status !== 'failed').length

  // the new-motivation form, as its own small screen
  const c = createChoice(input.draft, me, swarms)
  const people = peopleChoices(input.people, me, input.draft.people)
  const form = input.making
    ? [{
        id: 'new',
        plan: compose('motivation-new', {
          counts: { 'people.all': people.items.length },
          flags: { 'new.problem': !!c.problem, 'new.rights': !c.rights.personal.may && !!c.rights.personal.why, 'new.failed': !!input.draft.error, 'people.reading': people.reading },
          values: { 'new.visibility': c.visibility },
        }),
        data: {
          'new.visibility': c.visibility,
          'vis.private': VISIBILITY_WORDS.private[c.team ? 'team' : 'personal'],
          'vis.shared': VISIBILITY_WORDS.shared[c.team ? 'team' : 'personal'],
          'vis.public': VISIBILITY_WORDS.public[c.team ? 'team' : 'personal'],
          'new.people': people.items,
          'new.problem': c.problem ?? '',
          'new.rights': c.rights.personal.why ?? '',
          'new.error': input.draft.error ?? '',
          'new.save': input.draft.busy ? 'Making…' : 'Make it',
          'new.held': c.held,
        },
      }]
    : []

  const res: ResourceLike = { status: !supported ? 'unsupported' : !loaded ? 'loading' : 'ready' }
  return withResource(res, {
    data: {
      'create.form': form,
      'group.mine': mine.length,
      'group.team': groups.team.length,
      'group.mind': groups.mind.length,
      'group.people': groups.people.length,
      'group.mine.cards': groups.mine.map(card),
      'group.team.cards': groups.team.map(card),
      'group.mind.cards': groups.mind.map(card),
      'group.people.cards': groups.people.map(card),
      'unsorted.text': `${unsorted} live task${unsorted === 1 ? ' is' : 's are'} under no motivation you can see`,
      'partial.words': PARTIAL_WORDS,
    },
    facts: {
      counts: {
        'motivations.all': all.length,
        'tasks.unsorted': unsorted,
        'group.mine': groups.mine.length,
        'group.team': groups.team.length,
        'group.mind': groups.mind.length,
        'group.people': groups.people.length,
      },
      flags: { 'create.may': mayMake, making: input.making, 'evolve.shown': input.evolveShown, 'counts.partial': partial },
    },
  })
}

// ---------------------------------------------------------------- one motivation

/** The words being edited, against the revision seen when editing began. */
export interface WordsDraft {
  seen: Motivation
  title: string
  why: string
  busy: boolean
  error: string | null
}
/** Choosing the people it is shared with, against the motivation as it was when opened. */
export interface SharingDraft {
  seen: Motivation
  people: string[]
}
/** The file-tasks box. */
export interface FileDraft {
  open: boolean
  query: string
  picked: string[]
  withSubs: boolean
  busy: boolean
  message: { tone: 'ok' | 'bad'; text: string } | null
}
/** What a press on one of a motivation's two choosers does (each choice is a write, so the page carries it out). */
export type ChooserPress = { kind: 'status'; status: MotivationStatus } | { kind: 'visibility'; visibility: Visibility } | { kind: 'open-sharing' }

/**
 * A press on the Status or Who-can-see-it chooser (set-status, set-visibility, with the chosen `value`): its status
 * written, or who can see it written, except Shared, which opens the people box rather than writing at once (shared is
 * never made private). Nothing while a change is being saved, for the value it already has, or for a value it cannot take.
 */
export function chooserPress(action: string, value: unknown, m: Pick<Motivation, 'status' | 'visibility'>, busy: boolean): ChooserPress | null {
  if (busy || typeof value !== 'string') return null
  if (action === 'set-status') return (STATUS_ORDER as readonly string[]).includes(value) && value !== m.status ? { kind: 'status', status: value as MotivationStatus } : null
  if (action !== 'set-visibility' || !(VISIBILITY_CHOICES as readonly string[]).includes(value)) return null
  if (value === 'shared') return { kind: 'open-sharing' }
  return value !== m.visibility ? { kind: 'visibility', visibility: value as Visibility } : null
}

export const NEW_FILE: FileDraft = { open: false, query: '', picked: [], withSubs: true, busy: false, message: null }

/** Tasks that may be filed under it: top-level, not under it yet, in its swarm (when it has one), newest first. */
export function fileCandidates(m: Pick<Motivation, 'swarm_id'>, goals: Record<string, Goal>, linked: Set<string>, swarms: Record<string, Swarm>, query: string): Goal[] {
  const needle = query.trim().toLowerCase()
  return Object.values(goals)
    .filter((g) => !g.parent_id && !linked.has(g.id) && (!m.swarm_id || g.swarm_id === m.swarm_id) && !swarms[g.swarm_id]?.archived_at && (!needle || g.title.toLowerCase().includes(needle)))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 60)
}

export interface DetailInput {
  /** the motivation, when this person can read it */
  m: Motivation | undefined
  supported: boolean
  /** read, and not there for this person */
  gone: boolean
  links: Record<string, MotivationRef[]>
  goals: Record<string, Goal>
  names: Names
  /** a read behind the counts stopped early (the store's, or this view's own read of its tasks) */
  partial: boolean
  now: number
  words: WordsDraft | null
  /** someone changed it since editing began (its revision moved) */
  wordsChanged: boolean
  controls: { busy: boolean; error: string | null }
  sharing: SharingDraft | null
  people: PeopleRead
  file: FileDraft
}

export interface DetailScreen extends Screened {
  /** the page frame's words */
  frame: { label: string; eyebrow: string; title: string; info?: 'motivations' }
  /** the tasks under it */
  ids: Set<string>
}

export function motivationScreen(input: DetailInput, compose: Compose): DetailScreen {
  const { m, supported, gone, links, goals, names, partial, now, words, controls, sharing, file } = input
  const ids = new Set(m ? tasksOf(m.id, links) : [])
  const res: ResourceLike = { status: !supported ? 'unsupported' : !m && !gone ? 'loading' : 'ready' }
  const frame = m
    ? { label: m.title, eyebrow: WORDS.motivation, title: m.title, info: 'motivations' as const }
    : { label: WORDS.motivation, eyebrow: WORDS.motivations, title: supported && !gone ? '…' : WORDS.motivation }
  if (!m) {
    const s = withResource(res, { data: {}, facts: { flags: { 'motivation.found': false, 'motivation.gone': supported && gone } } })
    return { ...s, frame, ids }
  }

  const editable = !!m.editable
  const kind = ownerKind(m.owner) === 'person' ? 'personal' : 'team'
  const progress = progressOf(ids, goals)
  const sharedWith = m.visibility === 'shared' && m.shared_with?.length ? `: ${m.shared_with.map((p) => p.replace(/^user:/, '')).join(', ')}` : ''

  // the people box, while choosing who it is shared with
  const people = peopleChoices(input.people, names.me, sharing?.people ?? [])
  const shareProblem = sharing ? visibilityProblem('shared', sharing.people) : null
  const sharingForm = sharing
    ? [{
        id: 'sharing',
        plan: compose('motivation-sharing', { counts: { 'people.all': people.items.length }, flags: { 'people.reading': people.reading, 'share.problem': !!shareProblem } }),
        data: {
          'share.people': people.items,
          'share.problem': shareProblem ?? '',
          'share.save': controls.busy ? 'Saving…' : 'Share with these people',
          'share.held': controls.busy || !!shareProblem,
        },
      }]
    : []

  const about = {
    id: m.id,
    plan: compose('motivation-about', {
      counts: { 'm.tasks': progress.total },
      flags: {
        editable,
        editing: !!words,
        'words.changed': !!words && input.wordsChanged,
        'words.failed': !!words?.error,
        'm.why': !!m.why,
        'counts.partial': partial,
        sharing: !!sharing,
        'controls.failed': !!controls.error,
      },
      values: { 'm.visibility': m.visibility },
    }),
    data: {
      'm.status': STATUS_WORDS[m.status],
      'm.tone': STATUS_TONE[m.status],
      'm.meta': metaLine(m, names, now),
      'm.why': m.why,
      'm.progress': progressParts(progress),
      'm.progress.text': progressWords(progress, partial),
      'counts.partial': partial,
      'm.visibility': `${VISIBILITY_WORDS[m.visibility][kind]}${sharedWith}`,
      'words.error': words?.error ?? '',
      'words.save': words?.busy ? 'Saving…' : 'Save',
      'words.held': !words || words.busy || !words.title.trim(),
      'controls.busy': controls.busy,
      // the two choosers: the current status and who can see it, and each visibility choice in words for whose it is
      'status.value': m.status,
      'visibility.value': m.visibility,
      ...Object.fromEntries(VISIBILITY_CHOICES.map((v) => [`visibility.${v}`, VISIBILITY_WORDS[v][kind]])),
      'controls.error': controls.error ?? '',
      'sharing.form': sharingForm,
    },
  }

  // the file-tasks box
  const fileMay = editable && linkable(m)
  const candidates = fileCandidates(m, goals, ids, names.swarms, file.query)
  const hasSubs = file.picked.some((id) => Object.values(goals).some((g) => g.parent_id === id))
  const n = file.picked.length
  const fileForm = file.open
    ? [{
        id: 'file',
        plan: compose('motivation-file', { counts: { 'file.candidates': candidates.length }, flags: { 'file.has-subtasks': hasSubs } }),
        data: {
          'file.query': file.query,
          'file.candidates': candidates.map((g) => ({ id: g.id, label: `${g.title} · ${shown(names.swarms[g.swarm_id]?.name)} · ${g.status}`, on: file.picked.includes(g.id) })),
          'file.none': `No other tasks ${m.swarm_id ? `in ${shown(names.swarms[m.swarm_id]?.name) || 'its swarm'}` : ''} to file.`,
          'file.subtasks': [{ id: 'subtasks', label: 'with their subtasks', on: file.withSubs }],
          'file.means': LINK_MEANS,
          'file.label': file.busy ? 'Filing…' : `File ${n || ''} task${n === 1 ? '' : 's'}`,
          'file.held': !n || file.busy,
        },
      }]
    : []

  const s = withResource(res, {
    data: {
      about: [about],
      'tasks.count': atLeast(ids.size, partial),
      'partial.words': PARTIAL_WORDS,
      'file.message': file.message?.text ?? '',
      'file.form': fileForm,
    },
    facts: {
      flags: {
        'motivation.found': true,
        'motivation.gone': false,
        'counts.partial': partial,
        'file.may': fileMay,
        filing: file.open,
        'file.ok': file.message?.tone === 'ok',
        'file.failed': file.message?.tone === 'bad',
      },
    },
  })
  return { ...s, frame, ids }
}

// ---------------------------------------------------------------- OmegaEvolve's objective

export function evolveScreen(o: { state: 'none' | 'reading' | 'read'; title: string | null; swarm: string | null }): Screened {
  return {
    data: { 'evolve.title': o.title ?? '…' },
    facts: { flags: { 'evolve.on': o.state !== 'none', 'evolve.home': !!o.swarm } },
  }
}
