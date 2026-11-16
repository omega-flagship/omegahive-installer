import { FEATURES, GROUP_LABEL, type Feature, type FeatureGroup } from '../../features/registry'
import { create } from 'zustand'
import { openClassic, openFeature, openGallery, openPalette, useHive, type Route } from '../sdk'
import type { FluxApi } from './ctx'

/**
 * Flux's "Everything" sheet: every feature in the hive, poured out of the liquid pill. Native features open a liquid
 * sheet or act on the liquid; the rest open their classic page over the liquid (it wears the Flux chrome). Features
 * about one mind or one swarm use the drop or body you have open.
 */
export type SheetPage = 'index' | 'minds' | 'beliefs' | 'goals' | 'motivations' | 'decisions' | 'activity' | 'create' | 'usage' | 'help'
export type DotTab = 'chat' | 'mind' | 'memory' | 'schedule' | 'model'

export type Target =
  | { kind: 'page'; page: Exclude<SheetPage, 'index'>; tab?: 'history' | 'rules' }
  | { kind: 'scene'; what: 'home' | 'approvals' }
  /** A classic page about one mind: needs a mind (the focused one, or one you pick). */
  | { kind: 'mind'; tab: DotTab }
  /** A classic page about one system: the focused system's page, else the list. */
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
      return { kind: 'scene', what: 'home' }
    case 'swarms.beliefs':
      return { kind: 'page', page: 'beliefs' }
    // one swarm's place (its settings, vocabulary, connections, requests, lifecycle): the shared map
    // (experiences/targets.ts) says where (Review B1/B2)
    case 'swarms.edit':
    case 'swarms.vocabulary':
    case 'swarms.connections':
    case 'swarms.services':
    case 'swarms.requests':
    case 'swarms.lifecycle':
      return { kind: 'swarm' }
    case 'work.goals':
      return { kind: 'page', page: 'goals' }
    case 'work.motivations':
      return { kind: 'page', page: 'motivations' }
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

/** Every feature the Everything sheet lists (all of them that have any UI anywhere). */
export const NAV_FEATURES: string[] = FEATURES.filter((f) => targetFor(f) !== null).map((f) => f.id)

/** Features Flux draws in its own grammar (sheets, the liquid, its panels). */
export const FLUX_NATIVE: string[] = FEATURES.filter((f) => {
  const t = targetFor(f)
  return t && (t.kind === 'page' || t.kind === 'scene' || f.id === 'minds.traces' || f.id === 'hive.search' || f.id === 'hive.changeui')
}).map((f) => f.id)

export function sheetGroups(q: string): [FeatureGroup, string, Feature[]][] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const hit = (f: Feature) => words.every((w) => `${f.label} ${f.blurb} ${f.keywords ?? ''} ${GROUP_LABEL[f.group]}`.toLowerCase().includes(w))
  const by = new Map<FeatureGroup, Feature[]>()
  for (const f of FEATURES) if (NAV_FEATURES.includes(f.id) && hit(f)) by.set(f.group, [...(by.get(f.group) ?? []), f])
  return [...by.entries()].map(([g, list]) => [g, GROUP_LABEL[g], list])
}


/** Run one feature from Flux's own navigation. */
export function runFeature(f: Feature, api: FluxApi) {
  const t = targetFor(f)
  if (!t) return
  const v = api.view
  const mindId = v.kind === 'mind' ? v.id : null
  const swarmId = v.kind === 'swarm' ? v.id : v.kind === 'mind' ? (useHive.getState().agents[v.id]?.swarm_id ?? null) : null
  switch (t.kind) {
    case 'page':
      api.openSheet({ page: t.page, tab: t.tab, swarm: swarmId })
      return
    case 'scene':
      if (t.what === 'home') {
        api.openSheet(null)
        api.home()
      } else {
        api.openSheet(null)
        const first = Object.values(useHive.getState().approvals)
          .filter((a) => a.status === 'pending')
          .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
        api.openDecision(first?.id ?? '')
      }
      return
    case 'mind':
      if (mindId) openClassic({ name: 'dot', id: mindId, tab: t.tab })
      else api.openSheet({ page: 'minds', pickFor: t.tab })
      return
    case 'swarm':
      // the exact place on the open swarm; with none open, ask which (never the generic list, Review B1/B2)
      if (!swarmId || !openFeature(f, undefined, swarmId)) usePickSwarm.getState().pick(f)
      return
    case 'classic':
      if (!api.desktop) api.openSheet(null)
      openClassic(t.route)
      return
    case 'action':
      if (t.what === 'palette') openPalette()
      else if (t.what === 'changeui') openGallery(true)
      else useHive.getState().setStopAll(true)
  }
}


/** A swarm-scoped feature asked for with no swarm open: the shared directory asks which swarm. */
export const usePickSwarm = create<{ picking: Feature | null; pick(f: Feature | null): void }>()((set) => ({ picking: null, pick: (picking) => set({ picking }) }))
