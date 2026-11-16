import { FEATURES, GROUP_LABEL, type Feature, type FeatureGroup } from '../../features/registry'
import { openClassic, openFeature, openGallery, openPalette, useHive, type Route } from '../sdk'
import type { CosmosLayout } from './layout'
import { useCosmos } from './state'

/**
 * The Cosmos flight deck: every feature in the hive, reached from Cosmos's own navigation. Native features open a
 * deck page or act on the scene; the rest open their classic page over the galaxy (it wears the Cosmos chrome).
 * Features that act on one mind or one system use the world or system you are at.
 */
export type DeckPage = 'index' | 'minds' | 'beliefs' | 'motivations' | 'goals' | 'decisions' | 'activity' | 'create' | 'usage' | 'help'
export type DotTab = 'chat' | 'mind' | 'memory' | 'schedule' | 'model'

export type Target =
  | { kind: 'page'; page: Exclude<DeckPage, 'index'>; tab?: 'history' | 'rules' }
  | { kind: 'scene'; what: 'galaxy' | 'approvals' }
  /** A classic page about one mind: needs a mind (the focused one, or one you pick). */
  | { kind: 'mind'; tab: DotTab }
  /** A classic place on one system (Review B1/B2): the focused system's, else Cosmos asks which system. */
  | { kind: 'swarm' }
  | { kind: 'classic'; route: Route }
  | { kind: 'action'; what: 'palette' | 'changeui' | 'stopall' }

const MIND_TAB: Record<string, DotTab> = {
  'minds.memory': 'memory',
  'minds.schedule': 'schedule',
  'minds.model': 'model',
  'minds.traces': 'mind',
  'minds.shares': 'memory',
  'minds.inventory': 'model', // Tools live in the mind panel's Model tab (DotPanel ModelSettings → MindTools), not Thinking
}

export function targetFor(f: Feature): Target | null {
  switch (f.id) {
    case 'minds.see':
    case 'minds.talk':
    case 'minds.wake':
      return { kind: 'page', page: 'minds' }
    case 'minds.create':
      return { kind: 'page', page: 'create' }
    case 'swarms.see':
      return { kind: 'scene', what: 'galaxy' }
    case 'swarms.beliefs':
      return { kind: 'page', page: 'beliefs' }
    // one swarm's place (its settings, vocabulary, connections, lifecycle): the shared map (experiences/targets.ts) says where
    case 'swarms.edit':
    case 'swarms.vocabulary':
    case 'swarms.connections':
    case 'swarms.services':
    case 'swarms.requests':
    case 'swarms.lifecycle':
      return { kind: 'swarm' }
    case 'work.motivations':
      return { kind: 'page', page: 'motivations' }
    case 'work.goals':
      return { kind: 'page', page: 'goals' }
    case 'decide.approvals':
      return { kind: 'scene', what: 'approvals' }
    case 'decide.history':
      return { kind: 'page', page: 'decisions', tab: 'history' }
    case 'decide.rules':
      return { kind: 'page', page: 'decisions', tab: 'rules' }
    case 'decide.stopall':
      return { kind: 'action', what: 'stopall' }
    case 'watch.activity':
      return { kind: 'page', page: 'activity' }
    case 'money.usage':
      return { kind: 'page', page: 'usage' }
    case 'hive.search':
      return { kind: 'action', what: 'palette' }
    case 'hive.changeui':
      return { kind: 'action', what: 'changeui' }
    case 'hive.help':
      return { kind: 'page', page: 'help' }
  }
  if (MIND_TAB[f.id]) return { kind: 'mind', tab: MIND_TAB[f.id] }
  return f.classic ? { kind: 'classic', route: f.classic } : null
}

/** Every feature the flight deck lists (all of them that have any UI anywhere). */
export const NAV_FEATURES: string[] = FEATURES.filter((f) => targetFor(f) !== null).map((f) => f.id)

/** Features Cosmos draws in its own grammar (deck pages, the scene, transmissions). */
export const COSMOS_NATIVE: string[] = FEATURES.filter((f) => {
  const t = targetFor(f)
  return t && (t.kind === 'page' || t.kind === 'scene' || f.id === 'minds.traces' || f.id === 'hive.search' || f.id === 'hive.changeui')
}).map((f) => f.id)

export function deckGroups(q: string): [FeatureGroup, string, Feature[]][] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const hit = (f: Feature) => words.every((w) => `${f.label} ${f.blurb} ${f.keywords ?? ''} ${GROUP_LABEL[f.group]}`.toLowerCase().includes(w))
  const by = new Map<FeatureGroup, Feature[]>()
  for (const f of FEATURES) if (NAV_FEATURES.includes(f.id) && hit(f)) by.set(f.group, [...(by.get(f.group) ?? []), f])
  return [...by.entries()].map(([g, list]) => [g, GROUP_LABEL[g], list])
}

/** Run one feature from Cosmos's own navigation. */
export function runFeature(f: Feature, layout: CosmosLayout, desktop: boolean) {
  const st = useCosmos.getState()
  const t = targetFor(f)
  if (!t) return
  const v = st.view
  const mindId = v.kind === 'mind' ? v.id : null
  const sysId = v.kind === 'system' ? v.id : v.kind === 'mind' ? (layout.planetById[v.id]?.systemId ?? null) : null
  switch (t.kind) {
    case 'page':
      st.setDeck(t.page, { tab: t.tab, swarm: sysId })
      return
    case 'scene':
      if (t.what === 'galaxy') {
        st.setDeck(null)
        st.home()
      } else st.setApprovals(true)
      return
    case 'mind':
      if (mindId) openClassic({ name: 'dot', id: mindId, tab: t.tab })
      else st.setDeck('minds', { pickFor: t.tab })
      return
    case 'swarm':
      // the exact place on the focused system; with none focused, ask which (never the generic list, Review B1/B2)
      if (!sysId || !openFeature(f, undefined, sysId)) st.pickSwarm(f)
      return
    case 'classic':
      if (!desktop) st.setDeck(null)
      openClassic(t.route)
      return
    case 'action':
      if (t.what === 'palette') openPalette()
      else if (t.what === 'changeui') openGallery(true)
      else useHive.getState().setStopAll(true)
  }
}

