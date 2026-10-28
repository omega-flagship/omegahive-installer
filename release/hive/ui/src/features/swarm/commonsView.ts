import type { SwarmTab } from '../../lib/router'

export type View = 'sky' | 'list' | 'goals' | 'connections' | 'requests'
export type Tab = 'commons' | 'members' | 'vocab' | 'connections'

/** The section a swarm page shows for its `?tab=`: requests sit with the team; settings is a dialog over the commons. */
export const initialTab = (startTab: SwarmTab | undefined): Tab =>
  startTab === 'requests' ? 'members' : startTab && startTab !== 'settings' ? startTab : 'commons'

/**
 * The commons view a swarm page opens on: the table, unless the link asks for the commons itself (`?tab=commons`: the
 * Beliefs feature, the guided demos' "drawn as a sky"), which opens its constellation; requests on desktop.
 */
export const initialView = (startTab: SwarmTab | undefined, desktop: boolean): View =>
  startTab === 'requests' && desktop ? 'requests' : startTab === 'commons' ? 'sky' : 'list'

/**
 * Where a change of the route's `?tab=` on the open swarm page moves it: its section, and the commons view it names.
 * Nothing when the route's tab did not change (the same `?tab=` again never undoes the person's own choice of view,
 * Kimi r1 #5), and nothing for none or settings.
 */
export function followTabLink(prev: SwarmTab | undefined, startTab: SwarmTab | undefined, desktop: boolean): { tab?: Tab; view?: View } {
  if (startTab === prev || !startTab || startTab === 'settings') return {}
  return { tab: initialTab(startTab), ...(startTab === 'commons' || (startTab === 'requests' && desktop) ? { view: initialView(startTab, desktop) } : {}) }
}
