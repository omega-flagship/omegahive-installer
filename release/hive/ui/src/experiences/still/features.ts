/**
 * Every hive feature, in Still's words: what a person might type for it, and where Still takes them. Pure, so the
 * intent field's understanding of the whole hive can be proved without a browser (still/nav.test.ts).
 */
import { FEATURES, GROUP_LABEL, type Feature, type FeatureGroup } from '../../features/registry'
// the plain words for every feature live in the shared fast path now (lib/intent, Surface universal Ask phase 1)
export { matchFeatures, phrasesOf } from '../../lib/intent/features'

/** Where Still does a feature itself: a sheet (a quiet full page), a passage of the main page, or a host window. */
export type Place =
  | { sheet: SheetKind }
  | { scroll: 'needs' | 'now' | 'learned' | 'everything' }
  | { host: 'gallery' | 'search' | 'stopall' }

export type SheetKind = 'create' | 'beliefs' | 'goals' | 'motivations' | 'decided' | 'activity' | 'usage' | 'people'

export const STILL_PLACE: Record<string, Place> = {
  'minds.see': { scroll: 'now' },
  'minds.talk': { scroll: 'now' },
  'minds.wake': { scroll: 'now' },
  'minds.create': { sheet: 'create' },
  'swarms.see': { sheet: 'beliefs' },
  'swarms.beliefs': { sheet: 'beliefs' },
  'work.goals': { sheet: 'goals' },
  'work.motivations': { sheet: 'motivations' },
  'decide.approvals': { scroll: 'needs' },
  'decide.history': { sheet: 'decided' },
  'decide.rules': { sheet: 'decided' },
  'watch.activity': { sheet: 'activity' },
  'money.usage': { sheet: 'usage' },
  'people.manage': { sheet: 'people' },
  'hive.help': { scroll: 'everything' },
  'hive.search': { host: 'search' },
  'hive.changeui': { host: 'gallery' },
  'decide.stopall': { host: 'stopall' },
}

/** Feature ids Still does in its own grammar (its line in experiences/coverage.ts NATIVE). Stop-all uses the host's confirm. */
export const STILL_NATIVE = Object.keys(STILL_PLACE).filter((id) => id !== 'decide.stopall')

export const groupsInOrder = (): [FeatureGroup, string, Feature[]][] => {
  const by = new Map<FeatureGroup, Feature[]>()
  for (const f of FEATURES) by.set(f.group, [...(by.get(f.group) ?? []), f])
  return [...by.entries()].map(([g, list]) => [g, GROUP_LABEL[g], list])
}
