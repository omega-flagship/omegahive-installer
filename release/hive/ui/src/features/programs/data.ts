import type { CSSProperties } from 'react'
import type { Program } from '../../api/types'
import { shown } from '../../lib/displayName'
import type { ResourceLike } from '../../screens/resourceFacts'
import { withResource } from '../../screens/resourceFacts'
import type { ScreenFacts, ScreenPlan } from '../../screens/screenSpace'

/**
 * What the Apps screens are told (programs.metta): the values they draw (bound by path) and this moment's facts
 * (counts and flags) from which MeTTa composes them. Each app is composed as its own small screen, and the programs
 * screen stacks them. Pure: composing, what this hive offers and the identity the person wears apps in are handed in.
 */
export type Compose = (screen: string, facts: ScreenFacts) => ScreenPlan
export interface Composed { data: Record<string, unknown>; facts: ScreenFacts }
/** One row of a stack: its id, the screen MeTTa composed for it, and the values that screen draws. */
/** One app's card; `look` is its identity (colour variables, type, motif) for the stack to wear. */
export interface StackItem { id: string; plan: ScreenPlan; data: Record<string, unknown>; look?: AppCardLook | null }
export type AppCardLook = { style?: CSSProperties; type?: string; motif?: string }
export type LookOf = (p: Program) => AppCardLook | null
/** What this hive offers here: the record of what apps did, and where each app runs. */
export interface Can { activity: boolean; access: boolean }
/** The title of the designed identity an app is shown in, or null when the person wears the app's own. */
export type IdentityOf = (p: Program) => string | null

/** What each capability lets an app do, in plain words; one the hive does not describe is shown as it is named. */
export const CAPABILITY_WORDS: Record<string, string> = {
  'commons:read': 'reads the swarm commons',
  'goals:read': 'reads tasks',
  'goals:write': 'posts tasks',
}
const capabilityWords = (c: string) => (Object.hasOwn(CAPABILITY_WORDS, c) ? CAPABILITY_WORDS[c] : c)

/** Where an app comes from, in plain words. */
export function sourceWords(source: string): string {
  return source === 'built-in' ? 'Built-in' : source === 'plugin-dir' ? 'Plugin dir' : source
}

/** The store's apps and its last failure, as the one standard resource state the screens read. */
export function programsResource(programs: Program[] | null, error: string | null): ResourceLike {
  const status = programs ? (programs.length ? 'ready' : 'empty') : error ? 'error' : 'loading'
  return { status, error: error ?? undefined }
}

export function appItem(p: Program, can: Can, identityOf: IdentityOf, compose: Compose, lookOf: LookOf = () => null): StackItem {
  const about = shown(p.description)
  const identity = identityOf(p)
  const caps = p.capabilities.map(capabilityWords)
  return {
    id: p.id,
    plan: compose('programs-app', {
      counts: { 'app.caps': caps.length },
      flags: {
        'app.broken': !!p.error,
        'app.enabled': p.enabled,
        'app.identity': !!identity,
        'app.described': about !== '',
        'can.access': can.access,
      },
    }),
    look: lookOf(p),
    data: {
      'app.tour': `program-card-${p.id}`,
      'app.icon': p.icon ?? 'spark',
      'app.lit': p.enabled && !p.error,
      'app.name': shown(p.name),
      'app.meta': `v${p.version} · ${sourceWords(p.source)} · ${p.id}`,
      'app.identity': identity ?? '',
      'app.about': about,
      'app.error': p.error ?? '',
      'app.caps': caps,
      'app.switch': [{ id: p.id, label: 'Use in this hive', on: p.enabled }],
    },
  }
}

/** The Apps screen: how reading the apps stands, every app as its own card, and what apps did lately. */
export function programsScreen(programs: Program[] | null, error: string | null, can: Can, identityOf: IdentityOf, compose: Compose, lookOf: LookOf = () => null): Composed {
  const apps = (programs ?? []).map((p) => appItem(p, can, identityOf, compose, lookOf))
  return withResource(programsResource(programs, error), {
    data: { 'programs.all': apps },
    facts: {
      counts: { 'programs.all': apps.length },
      flags: { 'can.activity': can.activity, 'can.access': can.access },
    },
  })
}

/** What a press on the Apps screens asks for: the app it came from is the first id in its scope (its card). */
export type Press = { kind: 'retry' } | { kind: 'switch'; id: string; on: boolean } | { kind: 'open'; id: string } | { kind: 'access'; id: string }
export function pressed(action: string, item: Record<string, unknown>, value?: boolean): Press | null {
  if (action === 'retry') return { kind: 'retry' }
  const id = Array.isArray(item.scope) && item.scope.length ? String(item.scope[0]) : ''
  if (!id) return null
  if (action === 'switch') return { kind: 'switch', id, on: value === true }
  if (action === 'open' || action === 'access') return { kind: action, id }
  return null
}
