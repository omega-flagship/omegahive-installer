import type { Feature } from '../features/registry'
import { navigate, type DotTab, type Route, type SwarmTab } from '../lib/router'
import { openGallery } from '../shell/uiVariant'
import { useHive } from '../store/store'
import { useIntro } from '../tour/introStore'

/**
 * Where a feature actually lives, so any experience can open it. Several features have no page of their own in the
 * classic UI: they live in a mind's panel (memory, schedule, model…) or behind a host action (search, Change UI,
 * the kill switch, help). Opening those as the route 'hive' does nothing inside an experience (the experience is the
 * hive), which is how features went missing; this map opens the real place instead.
 */
export type FeatureTarget =
  | { kind: 'route'; route: Route }
  /** Lives in a mind's panel: ask which mind, then open that tab. */
  | { kind: 'mind'; tab: DotTab }
  /** Lives on one swarm's page: ask which swarm, then open that place (a tab, its settings, or its lifecycle). */
  | { kind: 'swarm'; tab?: SwarmTab; lifecycle?: true }
  | { kind: 'action'; run: () => void }
  /** The experience itself (its home view). */
  | { kind: 'home' }

const MIND_TAB: Record<string, DotTab> = {
  'minds.talk': 'chat',
  'minds.wake': 'chat',
  'minds.memory': 'memory',
  'minds.shares': 'memory',
  'minds.schedule': 'schedule',
  'minds.model': 'model',
  'minds.traces': 'mind',
  'minds.inventory': 'model', // Tools live in the mind panel's Model tab (DotPanel ModelSettings → MindTools), not Thinking
}

/** Swarm-scoped features (Review B1/B2: a generic swarms list is not the feature). */
const SWARM_PLACE: Record<string, { tab?: SwarmTab; lifecycle?: true }> = {
  'swarms.beliefs': { tab: 'commons' },
  'swarms.vocabulary': { tab: 'vocab' },
  'swarms.connections': { tab: 'connections' },
  'swarms.services': { tab: 'connections' },
  'swarms.requests': { tab: 'requests' },
  'swarms.edit': { tab: 'settings' },
  'swarms.lifecycle': { lifecycle: true },
}

const ACTIONS: Record<string, () => void> = {
  'hive.changeui': () => openGallery(true),
  'hive.search': () => useHive.getState().setPalette(true),
  'hive.help': () => useIntro.getState().setHelp(true),
  'decide.stopall': () => useHive.getState().setStopAll(true),
}

export function targetFor(f: Feature): FeatureTarget | null {
  if (ACTIONS[f.id]) return { kind: 'action', run: ACTIONS[f.id] }
  if (MIND_TAB[f.id]) return { kind: 'mind', tab: MIND_TAB[f.id] }
  if (SWARM_PLACE[f.id]) return { kind: 'swarm', ...SWARM_PLACE[f.id] }
  if (!f.classic) return null
  if (f.classic.name === 'hive') return { kind: 'home' }
  return { kind: 'route', route: f.classic }
}

/** Open a feature from anywhere. A mind- or swarm-scoped feature needs `mind` / `swarm`; without one it reports false (ask first). */
export function openFeature(f: Feature, mind?: string, swarm?: string): boolean {
  const t = targetFor(f)
  if (!t) return false
  if (t.kind === 'action') t.run()
  else if (t.kind === 'route') navigate(t.route)
  else if (t.kind === 'home') navigate({ name: 'hive' })
  else if (t.kind === 'swarm') {
    if (!swarm) return false
    navigate(t.lifecycle ? { name: 'lifecycle', swarm } : { name: 'swarm', id: swarm, tab: t.tab })
  } else if (mind) navigate({ name: 'dot', id: mind, tab: t.tab })
  else return false
  return true
}
