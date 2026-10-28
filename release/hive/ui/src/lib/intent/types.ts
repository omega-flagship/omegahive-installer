/**
 * The shared fast path's shapes (Surface universal Ask, phase 1; UNIVERSAL_ASK_DESIGN §2). One engine, used by every
 * experience; experiences add vocabulary only (vocab.ts). Everything here is data: a candidate says what it would do
 * as a declarative act, and only features/ask/run.ts performs it.
 *
 * There is deliberately no app action here. An app act only ever arrives from the host as `action-needs-confirm`
 * and is decided in the DecisionDialog (Host §3); experiences/ask.test.ts fails the build if this module grows one.
 */
import type { Route } from '../router'
import type { Act, Named, Suggestion, World as StillWorld } from './understand'
import type { AccentName } from './palette'
import type { MapHive, MapOp } from './hiveMap'

/** What running a candidate does to the world, for the policy (§2.4). */
export type Effect =
  /** moves the view: navigate, open, scroll, search; Back undoes it */
  | 'view'
  /** changes the person's own look; Undo restores it */
  | 'look'
  /** a hive action the person typed (send, wake, sleep, goal): Still's exact preview, then Enter, behind the arming gate */
  | 'own-action'
  /** a decision or money feature: opens its existing dialog or page; the Ask never decides */
  | 'open-decision'
  /** nothing local: hand the words to the swarm's orchestrator (POST /api/ask) */
  | 'mind'

/** A change of look the person typed. Data only; lib/intent/look.ts turns it into prefs against the current look. */
export type LookPatch =
  | { kind: 'darker' }
  /** colour temperature: surfaces, ink and accent toward amber or sea blue (lib/intent/palette) */
  | { kind: 'warmth'; warmth: 'warmer' | 'cooler' }
  | { kind: 'contrast'; contrast: 'more' | 'less' }
  | { kind: 'accent'; accent: AccentName }
  /** text size and room together: the whole rem scale (shell/uiVariant applyLook) */
  | { kind: 'density'; density: 'compact' | 'regular' | 'roomy' }
  | { kind: 'motion'; motion: 'none' | 'calm' | 'lively' }
  | { kind: 'radius'; radius: 'square' | 'soft' | 'round' | 'pill' }
  | { kind: 'layout'; layout: 'rail' | 'topbar' | 'dock' }
  | { kind: 'variant'; id: string }
  | { kind: 'experience'; id: string | null }
  | { kind: 'reset' }

/** Every act the fast path can produce: Still's own acts, plus routes, looks, scoped features and the hand-off. */
export type IntentAct =
  | Act
  /** a feature that lives on one mind's or swarm's page, with the subject resolved */
  | { do: 'scoped'; id: string; mind?: string; swarm?: string }
  | { do: 'route'; route: Route; label: string }
  | { do: 'look'; patch: LookPatch; label: string }
  | { do: 'mind'; text: string }
  /** a guided demo: the words are matched again when it runs (features/guided/match) */
  | { do: 'guide'; text: string }
  /** a swarm with its minds: opens the warning, which needs the swarm's exact name typed before anything is deleted */
  | { do: 'deleteSwarm'; swarm: Named }
  /** the hive map's view only (lib/intent/hiveMap): show a hive, zoom, or put the hives back; changes nothing else */
  | { do: 'map'; op: MapOp; label: string; hive?: string }

/** A chip offered with a clarifying question: picking it fills the field or runs a resolved act. */
export interface Chip {
  key: string
  label: string
  /** who it is (swarm, short id) */
  who?: string
  act?: IntentAct
  fill?: string
}

export interface Candidate extends Omit<Suggestion, 'act'> {
  act?: IntentAct
  effect?: Effect
  /** 0..1 (§2.3) */
  confidence: number
  /** A slot is missing: one clarifying question, with chips (never about phrasing). */
  clarify?: { question: string; chips: Chip[] }
  /** A paid row's line: who pays and what limit holds (features/ask/words paysLine; j0-fixes r1). Plain text. */
  pays?: string
}

/** What the fast path knows of the hive: Still's world, plus apps and what this build offers. */
export interface World extends StillWorld {
  apps?: Named[]
  /** The experiences this build offers (id, name). */
  experiences?: { id: string; name: string }[]
  /** The seed looks a person can name. */
  looks?: { id: string; name: string }[]
  /** Archived swarms an admin can name for "delete the Forge swarm" (the hive leaves them out of `swarms`). */
  archivedSwarms?: Named[]
  /** The hives on the hive map, as this viewer may name them (scene/visibleSet's shown set only). */
  hives?: MapHive[]
}

/** Where the person is asking from: the experience and anything it adds. */
export interface IntentScope {
  experience: string
  /** The swarm the page is about, when there is one ("this swarm"). */
  swarm?: string
}

export type { Act, Named, Suggestion }
