import { ApiError } from '../../api/client'
import { PRESENCE_WORDS, type MindPresence, type MindVersion, type MindVersions, type PersonalMind } from '../../api/personalMind'
import type { HiveCapabilities, HiveMemory } from '../../lib/askMemory'
import { ago, money } from '../../lib/format'
import { plural } from '../../lib/plural'
import type { ResourceLike } from '../../screens/resourceFacts'
import { withResource } from '../../screens/resourceFacts'
import type { Compose, ScreenFacts, ScreenPlan } from '../../screens/screenSpace'
import { memoryStatus } from '../ask/words'
import type { HandedOn, Hands } from './hands'
import type { MindState } from './store'

/**
 * What the personal mind page's screens are told (mind.metta): the values they draw (bound by path) and this moment's
 * facts (counts, flags and known symbols) from which MeTTa composes them. Each card is composed as its own small screen
 * and the mind screen stacks them. Pure: composing is handed in, and nothing here decides what is on screen.
 */
export interface Composed { data: Record<string, unknown>; facts: ScreenFacts }
/** One row of a stack: its id, the screen MeTTa composed for it, and the values that screen draws. */
export interface StackItem { id: string; plan: ScreenPlan; data: Record<string, unknown> }

/** One conversation it collected from your swarm talk (this browser's memory). */
export interface TalkInput { id: string; words: string; answer: string; truncated: boolean; at: number; uses: number }

/** The versions read (GET /api/me/mind/versions): `later` is a hive without version choice (404, or no route at all). */
export type VersionsState = 'loading' | 'later' | 'ready' | 'error'

export interface MindInput {
  state: MindState
  mind: PersonalMind | null
  absentWhy: 'no_route' | 'person_required' | null
  rename: { editing: boolean; problem: string | null }
  memory: {
    ready: boolean
    signedIn: boolean
    hive: HiveMemory
    capabilities: HiveCapabilities | null
    notes: number
    talks: TalkInput[]
    talkRecall: boolean
  }
  /** the swarm-talk collector: its last state, whether it is collecting now, and whether a loss is newly worth saying */
  collect: { state: string | null; collecting: boolean; lost: boolean }
  hands: Hands | null
  handed: HandedOn[]
  versions: { state: VersionsState; data: MindVersions | null; busy: boolean; say: string | null; canAdopt: boolean; canRollback: boolean }
  /** the conversations opened in full, by id */
  openTalks: ReadonlySet<string>
  presence: MindPresence
}

const iso = (ms: number) => new Date(ms).toISOString()
const pct = (x: number) => `${Math.round(x * 100)}%`
const steps = (x: number) => x.toFixed(1)
const cost = (x: number) => `$${x.toFixed(3)}`
const SHORT = 180
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s)

/** Where reading the person's mind is: loading, read (a mind, or none for them), not here, not theirs, or failed. */
export function mindResource(state: MindState, mind: PersonalMind | null, why: MindInput['absentWhy']): ResourceLike {
  switch (state) {
    case 'ready': return mind ? { status: 'ready' } : { status: 'empty' }
    case 'none': return { status: 'empty' }
    // a hive without personal minds (404); an account that is not a named person (403)
    case 'absent': return why === 'person_required' ? { status: 'error', error: new ApiError(403, 'person_required', 'A personal mind belongs to a signed-in person.') } : { status: 'unsupported' }
    case 'error': return { status: 'error', error: new Error('Your personal mind could not be read just now.') }
    default: return { status: 'loading' }
  }
}

/** Where reading its versions is (a hive without version choice is "comes later", as unsupported). */
export function versionsResource(state: VersionsState, data: MindVersions | null): ResourceLike {
  if (state === 'later') return { status: 'unsupported' }
  if (state === 'loading') return { status: 'loading' }
  if (state === 'ready' && data) return { status: 'ready' }
  return { status: 'error', error: new Error('Its version could not be read just now.') }
}

/** The better version waiting, when there is one other than the one it runs. */
export function betterOf(data: MindVersions | null): MindVersion | null {
  const current = data?.current ?? null
  const best = data?.best ?? null
  return best && current && best.id !== current.id ? best : null
}

const STEP_MARKS: Record<Hands['rows'][number]['state'], string> = { done: 'check', now: 'live', refused: 'ban', waiting: 'clock' }

/** Its hands: what it is doing on this screen now, or did last. */
export function handsItem(hands: Hands | null, compose: Compose): StackItem {
  const rows = hands?.rows.slice(-8) ?? []
  return {
    id: 'hands',
    plan: compose('mind-hands', { flags: { 'hands.live': !!hands?.live, 'hands.seen': !!hands }, counts: { 'hands.steps': rows.length } }),
    data: { 'hands.steps': rows.map((r) => ({ id: r.id, text: r.text, mark: STEP_MARKS[r.state] })) },
  }
}

/** One conversation it collected. */
export function talkItem(t: TalkInput, open: boolean, compose: Compose): StackItem {
  return {
    id: t.id,
    plan: compose('mind-talk', { flags: { 'talk.open': open, 'talk.truncated': t.truncated }, counts: { 'talk.uses': t.uses } }),
    data: {
      'talk.words': t.words,
      'talk.label': t.words.slice(0, 60),
      'talk.answer': t.answer,
      'talk.short': short(t.answer, SHORT),
      'talk.used': `used ${plural(t.uses, 'time')} when you asked`,
      'talk.ago': ago(iso(t.at)),
      'talk.open': open,
    },
  }
}

/** What it remembers: its notes, the swarm talk it collected (newest first), and the person's choice about it. */
export function remembersItem(input: MindInput, compose: Compose): StackItem {
  const { memory, collect, openTalks } = input
  const lit = !!memory.capabilities?.memory || memory.hive === 'learning' || memory.hive === 'conductor'
  const talks = [...memory.talks].reverse().map((t) => talkItem(t, openTalks.has(t.id), compose))
  const say = collect.collecting ? 'collecting' : collect.lost ? 'lost' : collect.state === 'volatile' ? 'volatile' : collect.state === 'failed' ? 'failed' : 'quiet'
  return {
    id: 'remembers',
    plan: compose('mind-remembers', {
      flags: { 'memory.ready': memory.ready, 'talk.recall': memory.talkRecall, 'talk.unkept': collect.state === 'absent' },
      values: { 'memory.switch': lit ? 'lit' : memory.hive === 'off' ? 'dark' : 'plain', 'collect.say': say },
      counts: { 'memory.notes': memory.notes, 'talk.all': talks.length },
    }),
    data: {
      'memory.status': memoryStatus(memory.signedIn, memory.hive, memory.capabilities, memory.notes),
      'talk.choice': [{ id: 'talk-recall', label: 'Use my swarm talk in answers', on: memory.talkRecall }],
      'talk.all': talks,
    },
  }
}

/** Its version: the one it runs, a better one waiting with how they measured, and adopting it or rolling back. */
export function versionItem(input: MindInput, compose: Compose): StackItem {
  const { mind, versions } = input
  const current = versions.data?.current ?? null
  const better = betterOf(versions.data)
  const scored = !!(better && current?.score && better.score)
  const flags = {
    'version.current': !!current,
    'version.better': !!better,
    'version.scored': scored,
    'version.measured': !!better?.measured_at,
    'version.can_adopt': !!better && versions.canAdopt,
    'version.can_rollback': !!mind?.previous_version_id && versions.canRollback,
    'version.busy': versions.busy,
    'version.said': !!versions.say,
  }
  const vs = (now: string, best: string) => `${now} now · ${best} at best`
  const { data, facts } = withResource(versionsResource(versions.state, versions.data), {
    data: {
      'version.current': current?.label ?? '',
      'version.best': better?.label ?? '',
      'version.adopted': mind?.adopted_at ? `, adopted ${ago(mind.adopted_at)}` : '',
      'version.success': scored ? vs(pct(current!.score!.success), pct(better!.score!.success)) : '',
      'version.steps': scored ? vs(steps(current!.score!.steps), steps(better!.score!.steps)) : '',
      'version.cost': scored ? vs(cost(current!.score!.cost_usd), cost(better!.score!.cost_usd)) : '',
      'version.measured': better?.measured_at ? `${better.label}: measured ${ago(better.measured_at)}${better.suite_run_id ? ` · Lab run ${better.suite_run_id}` : ''}.` : '',
      'version.busy': versions.busy,
      'version.say': versions.say ?? '',
    },
    facts: { flags },
  })
  return { id: 'version', plan: compose('mind-version', facts), data }
}

/** What it handed on to a swarm, from this Ask thread. */
export function handedItem(handed: HandedOn[], compose: Compose): StackItem {
  const rows = handed.slice(0, 8)
  return {
    id: 'handed',
    plan: compose('mind-handed', { counts: { 'handed.all': rows.length } }),
    data: { 'handed.all': rows.map((h) => ({ id: h.id, text: h.text, at: ago(h.at) })) },
  }
}

/** The mind screen: who it is and its cards, or why there is none, or that it is being read. */
export function mindScreen(input: MindInput, compose: Compose): Composed {
  const { state, mind, absentWhy, rename, memory, versions, presence } = input
  const here = state === 'ready' && !!mind
  const version = versions.data?.current ?? mind?.version ?? null
  const remembers = `${plural(memory.notes, 'note')} · ${plural(memory.talks.length, 'talk')}`
  const card = (make: () => StackItem): StackItem[] => (here ? [make()] : [])
  return withResource(mindResource(state, mind, absentWhy), {
    data: {
      'mind.name': mind?.name ?? '',
      'mind.presence': PRESENCE_WORDS[presence],
      'mind.remembers': remembers,
      'mind.energy': mind?.allowance_usd != null ? `your allowance · ${money(mind.allowance_usd)} a month` : 'your allowance',
      'mind.version': version?.label ?? '',
      'mind.rename_problem': rename.problem ?? '',
      'hands.card': card(() => handsItem(input.hands, compose)),
      'remembers.card': card(() => remembersItem(input, compose)),
      'version.card': card(() => versionItem(input, compose)),
      'handed.card': card(() => handedItem(input.handed, compose)),
    },
    facts: {
      flags: { 'mind.here': here, 'mind.renaming': here && rename.editing, 'mind.rename_problem': here && !!rename.problem, 'mind.versioned': !!version },
    },
  })
}
